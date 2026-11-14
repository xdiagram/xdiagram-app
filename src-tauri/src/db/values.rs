//! The values of one column with how often each occurs, among the rows matching a filter: what
//! the value picker offers. Counted over the first `SAMPLE` matching rows so a huge table answers
//! quickly (the result says when it was a sample), plus the smallest and largest value for
//! numbers and dates. Both statements are optional: a timeout is a result, not an error.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::browse::{truncate_cell, ALIAS};
use super::catalog::{not_found, Catalog, TableMeta};
use super::filter::{where_clause, BoolOp, FilterNode, Op, Render, Scope};
use super::run::{Ran, Stmt};
use super::sql::{ColKind, Dialect};
use crate::error::AppError;

/// Matching rows looked at, at most.
pub const SAMPLE: u64 = 200_000;
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuesRequest {
    pub schema: String,
    pub table: String,
    pub column: String,
    /// The rows to look at (usually the current filter without the condition being edited).
    #[serde(default)]
    pub filter: Option<FilterNode>,
    /// Only values whose text (as the grid shows it) holds this.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

impl ValuesRequest {
    fn limit(&self) -> u32 {
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
    }
    fn timeout(&self) -> u32 {
        self.timeout_secs.unwrap_or(10).clamp(1, 600)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCount {
    /// As the grid shows it; `None` is NULL.
    pub value: Option<String>,
    pub count: u64,
    /// Shortened (too long to filter by).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuesResult {
    /// Most frequent first (ties by value).
    pub values: Vec<ValueCount>,
    /// More distinct values exist than listed.
    pub more: bool,
    /// Rows looked at.
    pub rows: u64,
    /// Only the first `SAMPLE` matching rows were looked at.
    pub sampled: bool,
    /// Smallest and largest value (numbers, dates and times).
    pub min: Option<String>,
    pub max: Option<String>,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

fn ordered(kind: ColKind) -> bool {
    matches!(kind, ColKind::Int | ColKind::Decimal | ColKind::Float | ColKind::Date | ColKind::Time | ColKind::Timestamp | ColKind::Timestamptz)
}

fn meta_of<'a>(cat: &'a Catalog, req: &ValuesRequest) -> Result<&'a TableMeta, AppError> {
    cat.get(&(req.schema.clone(), req.table.clone())).ok_or_else(|| not_found(&req.schema, &req.table))
}

/// Two statements: the top values with counts, then rows looked at (and min / max).
pub fn plan_values(d: Dialect, cat: &Catalog, req: &ValuesRequest) -> Result<Vec<Stmt>, AppError> {
    let meta = meta_of(cat, req)?;
    let col = meta.column(&req.column).ok_or_else(|| AppError::Invalid(format!("Unknown column {}", req.column)))?;
    // Values whose text (as shown) holds the search: "12" also finds 112 in a number column.
    let search = req.search.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|text| FilterNode::Cond {
        id: "values-search".into(),
        column: col.name.clone(),
        op: Op::Contains,
        args: vec![text.into()],
        cs: false,
    });
    let filter = match (req.filter.clone(), search) {
        (Some(f), Some(s)) => Some(FilterNode::Group { id: "values".into(), op: BoolOp::And, not: false, items: vec![f, s] }),
        (f, s) => f.or(s),
    };
    let alias = d.quote(ALIAS);
    let expr = format!("{alias}.{}", d.quote(&col.name));
    let from = meta.qualified.as_str();
    let n = req.limit() + 1;
    let mut statements = Vec::new();

    // Each statement binds its own copy of the filter's parameters.
    let sample = |select: String| -> Result<(String, Vec<String>), AppError> {
        let mut r = Render::new(d);
        let wher = where_clause(&mut r, &Scope::new(meta, ALIAS).with_catalog(cat), filter.as_ref())?.map(|c| format!(" WHERE {c}")).unwrap_or_default();
        let sql = match d {
            Dialect::Mssql => format!("SELECT TOP ({SAMPLE}) {select} FROM {from} AS {alias}{wher}"),
            _ => format!("SELECT {select} FROM {from} AS {alias}{wher} LIMIT {SAMPLE}"),
        };
        Ok((sql, r.params))
    };

    let (inner, params) = sample(format!("{} AS v", d.select_text(&expr, &col.type_name)))?;
    let top = match d {
        Dialect::Mssql => format!("SELECT TOP ({n}) v, CONVERT(NVARCHAR(30), COUNT_BIG(*)) FROM ({inner}) AS s GROUP BY v ORDER BY COUNT_BIG(*) DESC, v"),
        Dialect::Postgres => format!("SELECT v, (count(*))::text FROM ({inner}) AS s GROUP BY v ORDER BY count(*) DESC, v LIMIT {n}"),
        Dialect::Mysql | Dialect::Sqlite => format!("SELECT v, count(*) FROM ({inner}) AS s GROUP BY v ORDER BY count(*) DESC, v LIMIT {n}"),
    };
    statements.push(Stmt { sql: top, params, timeout_s: req.timeout(), optional: true });

    let (inner, params) = sample(format!("{expr} AS v"))?;
    let count = match d {
        Dialect::Mssql => "CONVERT(NVARCHAR(30), COUNT_BIG(*))".to_string(),
        Dialect::Postgres => "(count(*))::text".to_string(),
        _ => "count(*)".to_string(),
    };
    let stats = if ordered(col.kind) && d.sortable(col.kind, &col.type_name) {
        format!("SELECT {count}, {}, {} FROM ({inner}) AS s", d.select_text("min(v)", &col.type_name), d.select_text("max(v)", &col.type_name))
    } else {
        format!("SELECT {count} FROM ({inner}) AS s")
    };
    statements.push(Stmt { sql: stats, params, timeout_s: req.timeout(), optional: true });
    Ok(statements)
}

pub fn finish_values(req: &ValuesRequest, ran: Vec<Ran>, started: Instant) -> Result<ValuesResult, AppError> {
    let mut ran = ran.into_iter();
    let mut out = ValuesResult { values: Vec::new(), more: false, rows: 0, sampled: false, min: None, max: None, timed_out: false, elapsed_ms: 0 };
    match ran.next() {
        Some(Ran::Rows(rows)) => {
            let limit = req.limit() as usize;
            out.more = rows.len() > limit;
            out.values = rows
                .into_iter()
                .take(limit)
                .map(|r| {
                    let mut r = r.into_iter();
                    let value = r.next().flatten();
                    let count = r.next().flatten().and_then(|c| c.parse().ok()).unwrap_or(0);
                    let (value, cut) = match value.map(truncate_cell) {
                        Some((v, cut)) => (Some(v), cut),
                        None => (None, false),
                    };
                    ValueCount { value, count, cut }
                })
                .collect();
        }
        Some(Ran::Failed(e)) => return Err(e),
        _ => out.timed_out = true,
    }
    match ran.next() {
        Some(Ran::Rows(rows)) => {
            let mut r = rows.into_iter().next().unwrap_or_default().into_iter();
            out.rows = r.next().flatten().and_then(|c| c.parse().ok()).unwrap_or(0);
            out.min = r.next().flatten();
            out.max = r.next().flatten();
            out.sampled = out.rows >= SAMPLE;
        }
        // The values are what matters; missing statistics are not an error.
        Some(Ran::Failed(_)) | Some(Ran::TimedOut) | Some(Ran::Skipped) | None => {}
    }
    out.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::browse::BrowseColumn;

    fn catalog(d: Dialect, cols: &[(&str, &str)]) -> Catalog {
        let meta = TableMeta {
            qualified: d.qualified("public", "t"),
            schema: "public".into(),
            table: "t".into(),
            columns: cols.iter().map(|(n, t)| BrowseColumn::named(d, n, t)).collect(),
            primary_key: vec!["id".into()],
            row_id: None,
            row_estimate: 0.0,
            is_view: false,
        };
        let mut c = Catalog::new();
        c.insert(("public".into(), "t".into()), meta);
        c
    }

    fn req(column: &str) -> ValuesRequest {
        ValuesRequest { schema: "public".into(), table: "t".into(), column: column.into(), filter: None, search: None, limit: Some(10), timeout_secs: None }
    }

    #[test]
    fn plans_top_values_and_stats_per_dialect() {
        let pg = catalog(Dialect::Postgres, &[("id", "bigint"), ("role", "text")]);
        let mut r = req("role");
        r.filter = Some(FilterNode::Cond { id: "c".into(), column: "id".into(), op: Op::Gt, args: vec!["5".into()], cs: false });
        let st = plan_values(Dialect::Postgres, &pg, &r).unwrap();
        assert_eq!(
            st[0].sql,
            "SELECT v, (count(*))::text FROM (SELECT (\"t0\".\"role\")::text AS v FROM \"public\".\"t\" AS \"t0\" WHERE \"t0\".\"id\" > ($1::text)::bigint LIMIT 200000) AS s GROUP BY v ORDER BY count(*) DESC, v LIMIT 11"
        );
        assert_eq!(st[0].params, vec!["5"]);
        assert_eq!(st[1].sql, "SELECT (count(*))::text FROM (SELECT \"t0\".\"role\" AS v FROM \"public\".\"t\" AS \"t0\" WHERE \"t0\".\"id\" > ($1::text)::bigint LIMIT 200000) AS s");
        assert_eq!(st[1].params, vec!["5"]);
        assert!(st.iter().all(|s| s.optional));

        let st = plan_values(Dialect::Postgres, &pg, &req("id")).unwrap();
        assert_eq!(st[1].sql, "SELECT (count(*))::text, (min(v))::text, (max(v))::text FROM (SELECT \"t0\".\"id\" AS v FROM \"public\".\"t\" AS \"t0\" LIMIT 200000) AS s");

        let ms = catalog(Dialect::Mssql, &[("id", "int"), ("at", "datetime2")]);
        let st = plan_values(Dialect::Mssql, &ms, &req("at")).unwrap();
        assert_eq!(
            st[0].sql,
            "SELECT TOP (11) v, CONVERT(NVARCHAR(30), COUNT_BIG(*)) FROM (SELECT TOP (200000) CONVERT(NVARCHAR(MAX), [t0].[at], 126) AS v FROM [public].[t] AS [t0]) AS s GROUP BY v ORDER BY COUNT_BIG(*) DESC, v"
        );
        assert_eq!(
            st[1].sql,
            "SELECT CONVERT(NVARCHAR(30), COUNT_BIG(*)), CONVERT(NVARCHAR(MAX), min(v), 126), CONVERT(NVARCHAR(MAX), max(v), 126) FROM (SELECT TOP (200000) [t0].[at] AS v FROM [public].[t] AS [t0]) AS s"
        );

        let my = catalog(Dialect::Mysql, &[("id", "int"), ("name", "varchar(20)")]);
        let mut r = req("name");
        r.search = Some(" ann ".into());
        let st = plan_values(Dialect::Mysql, &my, &r).unwrap();
        assert_eq!(st[0].sql, "SELECT v, count(*) FROM (SELECT `t0`.`name` AS v FROM `public`.`t` AS `t0` WHERE `t0`.`name` LIKE ? ESCAPE '!' LIMIT 200000) AS s GROUP BY v ORDER BY count(*) DESC, v LIMIT 11");
        assert_eq!(st[0].params, vec!["%ann%"]);

        assert!(plan_values(Dialect::Mysql, &my, &req("nope")).is_err());
    }

    #[test]
    fn finishes_with_counts_and_flags() {
        let r = req("x");
        let mut rows: Vec<Vec<Option<String>>> = (0..11).map(|i| vec![Some(format!("v{i}")), Some(format!("{}", 100 - i))]).collect();
        rows[3][0] = None;
        rows[4][0] = Some("x".repeat(5000));
        let ran = vec![Ran::Rows(rows), Ran::Rows(vec![vec![Some("200000".into()), Some("1".into()), Some("9".into())]])];
        let out = finish_values(&r, ran, Instant::now()).unwrap();
        assert_eq!(out.values.len(), 10);
        assert!(out.more && out.sampled);
        assert_eq!(out.values[0], ValueCount { value: Some("v0".into()), count: 100, cut: false });
        assert_eq!(out.values[3].value, None);
        assert!(out.values[4].cut);
        assert_eq!((out.min.as_deref(), out.max.as_deref(), out.rows), (Some("1"), Some("9"), 200_000));

        let out = finish_values(&r, vec![Ran::TimedOut, Ran::Skipped], Instant::now()).unwrap();
        assert!(out.timed_out && out.values.is_empty() && !out.sampled);
    }

    /// The statements run on SQLite and count the right rows.
    #[test]
    fn counts_values_on_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, role TEXT, score REAL);
             INSERT INTO t VALUES (1, 'admin', 1), (2, 'member', 5), (3, 'member', 2), (4, NULL, NULL), (5, 'member', 9), (6, 'admin', 3);",
        )
        .unwrap();
        let run = |r: &ValuesRequest| {
            crate::db::run::run_sqlite(&conn, vec![("main".into(), "t".into())], |d, cat| plan_values(d, cat, r), |_, _, ran| finish_values(r, ran, Instant::now())).unwrap()
        };
        let pairs = |out: &ValuesResult| out.values.iter().map(|v| (v.value.clone().unwrap_or("NULL".into()), v.count)).collect::<Vec<_>>();
        let mut r = ValuesRequest { schema: "main".into(), ..req("role") };
        let out = run(&r);
        assert_eq!(pairs(&out), vec![("member".into(), 3), ("admin".into(), 2), ("NULL".into(), 1)]);
        assert_eq!((out.rows, out.more, out.sampled), (6, false, false));

        r.filter = Some(FilterNode::Cond { id: "c".into(), column: "score".into(), op: Op::Ge, args: vec!["3".into()], cs: false });
        assert_eq!(pairs(&run(&r)), vec![("member".into(), 2), ("admin".into(), 1)]);
        r.filter = None;
        r.search = Some("adm".into());
        assert_eq!(pairs(&run(&r)), vec![("admin".into(), 2)]);
        let mut r = ValuesRequest { schema: "main".into(), ..req("id") };
        r.search = Some("2".into());
        let mut ids = run(&r).values.into_iter().map(|v| v.value.unwrap()).collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["2"], "a number column is searched by its text");

        let out = run(&ValuesRequest { schema: "main".into(), ..req("score") });
        assert!(out.min.as_deref().is_some_and(|m| m.starts_with('1')) && out.max.as_deref().is_some_and(|m| m.starts_with('9')), "{out:?}");
    }
}
