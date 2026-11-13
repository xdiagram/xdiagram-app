//! "Related data": the rows a row references, and the rows that reference it, fetched several
//! tables at a time on one connection. Each lookup is an equality on key columns (checked against
//! the catalog) with bound values, compared in the column's own type so indexes serve it.

use serde::{Deserialize, Serialize};

use super::browse::{cap_rows, BrowseColumn, BrowseFilter};
use super::sql::Dialect;

/// Lookups per request (one expansion of one card).
pub const MAX_LOOKUPS: usize = 64;
/// Rows per lookup.
pub const MAX_RELATED_LIMIT: u32 = 100;
/// Key columns per lookup.
const MAX_FILTERS: usize = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLookup {
    pub schema: String,
    pub table: String,
    /// Equality on every filter; values must not be NULL (a NULL key references nothing).
    pub filters: Vec<BrowseFilter>,
    pub limit: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedRequest {
    pub lookups: Vec<RowLookup>,
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

/// One lookup's rows, or why it failed (the other lookups of the request still run).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub columns: Vec<BrowseColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub has_more: bool,
    pub truncated_cells: u32,
    pub error: Option<String>,
}

impl LookupResult {
    pub fn failed(message: impl Into<String>) -> Self {
        LookupResult { error: Some(message.into()), ..Default::default() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedResult {
    pub results: Vec<LookupResult>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub sql: String,
    pub params: Vec<String>,
}

/// What to do for one lookup: run a query, or answer at once (an error, or nothing can match).
#[derive(Debug)]
pub enum Step {
    Run(Planned),
    Done(LookupResult),
}

/// The SELECT for one lookup. `Err` = the lookup is invalid; `Ok(None)` = no row can match (a
/// value that does not fit the column's type), so there is nothing to run.
pub fn plan(d: Dialect, qualified: &str, columns: &[BrowseColumn], l: &RowLookup) -> Result<Option<Planned>, String> {
    if l.filters.is_empty() {
        return Err("A lookup needs at least one key column".into());
    }
    if l.filters.len() > MAX_FILTERS {
        return Err(format!("At most {MAX_FILTERS} key columns per lookup"));
    }
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    for f in &l.filters {
        let col = columns.iter().find(|c| c.name == f.column).ok_or_else(|| format!("Unknown column {}", f.column))?;
        let value = f.value.as_ref().ok_or_else(|| format!("{} is NULL", f.column))?;
        if !d.value_fits(&col.type_name, value) {
            return Ok(None);
        }
        params.push(value.clone());
        conditions.push(d.eq_key(&d.quote(&col.name), &col.type_name, params.len()));
    }
    let select = columns.iter().map(|c| d.select_text(&d.quote(&c.name), &c.type_name)).collect::<Vec<_>>().join(", ");
    let limit = l.limit.clamp(1, MAX_RELATED_LIMIT);
    // No ORDER BY: `WHERE fk = ? ORDER BY pk LIMIT n` can make the planner walk the primary key.
    let sql = format!("SELECT {select} FROM {qualified} WHERE {}{}", conditions.join(" AND "), d.paging("", limit + 1, 0));
    Ok(Some(Planned { sql, params }))
}

/// `plan`, with a missing table and invalid lookups answered directly.
pub fn step(d: Dialect, qualified: &str, label: &str, columns: &[BrowseColumn], l: &RowLookup) -> Step {
    if columns.is_empty() {
        return Step::Done(LookupResult::failed(format!("Table {label} not found")));
    }
    match plan(d, qualified, columns, l) {
        Ok(Some(p)) => Step::Run(p),
        Ok(None) => Step::Done(finish(columns, Vec::new(), l.limit)),
        Err(e) => Step::Done(LookupResult::failed(e)),
    }
}

/// A lookup's result from the rows its query returned (up to `limit + 1`).
pub fn finish(columns: &[BrowseColumn], rows: Vec<Vec<Option<String>>>, limit: u32) -> LookupResult {
    let (rows, has_more, truncated_cells) = cap_rows(rows, limit.clamp(1, MAX_RELATED_LIMIT) as usize);
    LookupResult { columns: columns.to_vec(), rows, has_more, truncated_cells, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(spec: &[(&str, &str)]) -> Vec<BrowseColumn> {
        spec.iter().map(|(n, t)| BrowseColumn { name: n.to_string(), type_name: t.to_string() }).collect()
    }

    fn lookup(filters: &[(&str, Option<&str>)], limit: u32) -> RowLookup {
        RowLookup {
            schema: "public".into(),
            table: "memberships".into(),
            filters: filters.iter().map(|(c, v)| BrowseFilter { column: c.to_string(), value: v.map(str::to_string) }).collect(),
            limit,
        }
    }

    #[test]
    fn composite_key_lookup_per_dialect() {
        let l = lookup(&[("org_id", Some("7")), ("user_id", Some("42"))], 10);
        let pg = plan(Dialect::Postgres, "\"public\".\"memberships\"", &cols(&[("org_id", "integer"), ("user_id", "integer"), ("role", "text")]), &l)
            .unwrap()
            .unwrap();
        assert_eq!(
            pg.sql,
            "SELECT (\"org_id\")::text, (\"user_id\")::text, (\"role\")::text FROM \"public\".\"memberships\" \
             WHERE \"org_id\" = ($1::text)::integer AND \"user_id\" = ($2::text)::integer LIMIT 11 OFFSET 0"
        );
        assert_eq!(pg.params, vec!["7".to_string(), "42".to_string()]);

        let my = plan(Dialect::Mysql, "`app`.`memberships`", &cols(&[("org_id", "int(11)"), ("user_id", "bigint unsigned")]), &l).unwrap().unwrap();
        assert_eq!(my.sql, "SELECT `org_id`, `user_id` FROM `app`.`memberships` WHERE `org_id` = CAST(? AS SIGNED) AND `user_id` = CAST(? AS UNSIGNED) LIMIT 11 OFFSET 0");

        let ms = plan(Dialect::Mssql, "[dbo].[memberships]", &cols(&[("org_id", "int"), ("user_id", "int")]), &l).unwrap().unwrap();
        assert_eq!(
            ms.sql,
            "SELECT CONVERT(NVARCHAR(MAX), [org_id]), CONVERT(NVARCHAR(MAX), [user_id]) FROM [dbo].[memberships] \
             WHERE [org_id] = @P1 AND [user_id] = @P2 ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 11 ROWS ONLY"
        );

        let lite = plan(Dialect::Sqlite, "\"memberships\"", &cols(&[("org_id", "integer"), ("user_id", "integer")]), &l).unwrap().unwrap();
        assert_eq!(lite.sql, "SELECT \"org_id\", \"user_id\" FROM \"memberships\" WHERE \"org_id\" = ?1 AND \"user_id\" = ?2 LIMIT 11 OFFSET 0");
    }

    #[test]
    fn invalid_lookups() {
        let c = cols(&[("id", "integer")]);
        let q = "\"public\".\"t\"";
        assert!(plan(Dialect::Postgres, q, &c, &lookup(&[], 10)).unwrap_err().contains("at least one"));
        assert!(plan(Dialect::Postgres, q, &c, &lookup(&[("nope", Some("1"))], 10)).unwrap_err().contains("Unknown column nope"));
        assert!(plan(Dialect::Postgres, q, &c, &lookup(&[("id", None)], 10)).unwrap_err().contains("NULL"));
        // A value that cannot be an integer matches nothing (instead of MySQL matching id 0).
        assert_eq!(plan(Dialect::Mysql, "`t`", &cols(&[("id", "int")]), &lookup(&[("id", Some("abc"))], 10)), Ok(None));
        match step(Dialect::Postgres, q, "public.t", &[], &lookup(&[("id", Some("1"))], 10)) {
            Step::Done(r) => assert_eq!(r.error.as_deref(), Some("Table public.t not found")),
            Step::Run(_) => panic!("missing table must not run"),
        }
    }

    #[test]
    fn limits_and_quoting() {
        let c = cols(&[("we\"ird", "text")]);
        let p = plan(Dialect::Postgres, "\"s\".\"t\"", &c, &lookup(&[("we\"ird", Some("x"))], 10_000)).unwrap().unwrap();
        assert!(p.sql.contains("WHERE \"we\"\"ird\" = ($1::text)::text"));
        assert!(p.sql.ends_with("LIMIT 101 OFFSET 0"));
    }

    #[test]
    fn finish_caps_rows() {
        let c = cols(&[("id", "integer")]);
        let rows: Vec<Vec<Option<String>>> = (0..11).map(|i| vec![Some(i.to_string())]).collect();
        let r = finish(&c, rows, 10);
        assert_eq!(r.rows.len(), 10);
        assert!(r.has_more);
        let r = finish(&c, vec![vec![Some("x".repeat(5000))]], 10);
        assert!(!r.has_more);
        assert_eq!(r.truncated_cells, 1);
    }
}
