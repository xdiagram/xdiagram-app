//! Read-only data browsing: a page of rows from one table, filtered (see `filter.rs`) and sorted
//! by any number of columns, with the primary key as tie-breaker so pages never overlap. The
//! planners here are pure (see `run.rs` for running them on each engine). Identifiers are
//! checked against the catalog before being quoted into SQL; values are always bound parameters.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

use super::catalog::{not_found, Catalog, TableMeta};
use super::filter::{combine, where_clause, FilterNode, Render, Scope};
use super::run::{Ran, Stmt};
use super::sql::{ColKind, Dialect};
use crate::error::AppError;

pub const MAX_LIMIT: u32 = 500;
/// Longer cell values are cut (with a marker) so one huge JSON/text value can't stall the UI.
pub const MAX_CELL_CHARS: usize = 4000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseFilter {
    pub column: String,
    /// `None` means `IS NULL`.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBy {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// One sort key (several make a multi-column sort).
pub type SortKey = OrderBy;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRequest {
    pub schema: String,
    pub table: String,
    /// Equality filters (FK navigation); AND-ed with `filter`.
    #[serde(default)]
    pub filters: Vec<BrowseFilter>,
    /// The filter tree (see `filter.rs`).
    #[serde(default)]
    pub filter: Option<FilterNode>,
    /// Older single-column sort; `sort` wins when both are set.
    pub order_by: Option<OrderBy>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u64,
    /// Statement time limit in seconds (default 10).
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

/// A sort key as applied: `tie` marks primary-key columns added so that paging is stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSort {
    pub column: String,
    pub desc: bool,
    pub tie: bool,
}

impl BrowseRequest {
    pub fn timeout(&self) -> u32 {
        self.timeout_secs.unwrap_or(10).clamp(1, 600)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseColumn {
    pub name: String,
    /// The type as the engine's catalog names it.
    pub type_name: String,
    /// What the column holds (decides the filter operators and how values are compared).
    pub kind: ColKind,
    pub nullable: bool,
    /// The allowed values of an enum column, in their declared order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

impl BrowseColumn {
    /// A column known only by name and type (tests, join previews): nullable, kind from the type.
    pub fn named(d: super::sql::Dialect, name: &str, type_name: &str) -> Self {
        BrowseColumn { name: name.into(), type_name: type_name.into(), kind: super::sql::classify(d, type_name), nullable: true, enum_values: None }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub columns: Vec<BrowseColumn>,
    /// Values as text (`None` = SQL NULL), in column order.
    pub rows: Vec<Vec<Option<String>>>,
    pub has_more: bool,
    /// Planner estimate of the table's row count.
    pub row_estimate: f64,
    /// The order actually applied (requested columns, then the primary key).
    pub ordered_by: Vec<String>,
    pub sort: Vec<AppliedSort>,
    /// False when the table has neither a primary key nor a row id: pages may repeat rows.
    pub stable_order: bool,
    pub truncated_cells: u32,
    /// `[row, column]` of every value cut to `MAX_CELL_CHARS` (never usable as a filter value).
    pub truncated_at: Vec<[usize; 2]>,
    pub elapsed_ms: u64,
}

/// Cuts a value to `MAX_CELL_CHARS` characters, appending `…`; returns whether it was cut.
pub fn truncate_cell(value: String) -> (String, bool) {
    match value.char_indices().nth(MAX_CELL_CHARS) {
        Some((cut, _)) => (format!("{}…", &value[..cut]), true),
        None => (value, false),
    }
}

/// Keeps the first `limit` rows (queries ask for one more to learn whether there are more) and
/// shortens long values. Returns the rows, whether more exist, and how many values were cut.
pub fn cap_rows(rows: Vec<Vec<Option<String>>>, limit: usize) -> (Vec<Vec<Option<String>>>, bool, u32) {
    let (rows, has_more, cut) = cap_rows_at(rows, limit);
    (rows, has_more, cut.len() as u32)
}

/// `cap_rows`, with the `[row, column]` of each value that was cut.
pub fn cap_rows_at(rows: Vec<Vec<Option<String>>>, limit: usize) -> (Vec<Vec<Option<String>>>, bool, Vec<[usize; 2]>) {
    let has_more = rows.len() > limit;
    let mut cut_at = Vec::new();
    let rows = rows
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(ri, r)| {
            r.into_iter()
                .enumerate()
                .map(|(ci, v)| {
                    v.map(|s| {
                        let (s, cut) = truncate_cell(s);
                        if cut {
                            cut_at.push([ri, ci]);
                        }
                        s
                    })
                })
                .collect()
        })
        .collect();
    (rows, has_more, cut_at)
}

/// The alias of the browsed table in its statements.
pub const ALIAS: &str = "t0";
pub const MAX_SORT: usize = 8;

fn meta_of<'a>(cat: &'a Catalog, req: &BrowseRequest) -> Result<&'a TableMeta, AppError> {
    cat.get(&(req.schema.clone(), req.table.clone())).ok_or_else(|| not_found(&req.schema, &req.table))
}

/// The ORDER BY of a page: the requested keys, then the primary key (else the row id) so that
/// pages never overlap. Also returns the applied keys and whether the order is stable.
pub fn page_order(d: Dialect, meta: &TableMeta, req: &BrowseRequest) -> Result<(String, Vec<AppliedSort>, bool), AppError> {
    let keys: Vec<SortKey> = if req.sort.is_empty() { req.order_by.iter().cloned().collect() } else { req.sort.clone() };
    if keys.len() > MAX_SORT {
        return Err(AppError::Invalid(format!("Rows can be sorted by {MAX_SORT} columns at most")));
    }
    let alias = d.quote(ALIAS);
    let column = |name: &str| format!("{alias}.{}", d.quote(name));
    let mut items = Vec::new();
    let mut applied: Vec<AppliedSort> = Vec::new();
    for k in keys {
        let col = meta.column(&k.column).ok_or_else(|| AppError::Invalid(format!("Unknown column {}", k.column)))?;
        if !d.sortable(col.kind, &col.type_name) {
            return Err(AppError::Invalid(format!("Rows cannot be sorted by “{}” ({})", col.name, col.type_name)));
        }
        if applied.iter().any(|a| a.column == col.name) {
            continue;
        }
        items.push(d.order_item(&column(&col.name), k.desc, col.nullable));
        applied.push(AppliedSort { column: col.name.clone(), desc: k.desc, tie: false });
    }
    let mut stable = true;
    if !meta.primary_key.is_empty() {
        for pk in &meta.primary_key {
            if applied.iter().any(|a| &a.column == pk) {
                continue;
            }
            let nullable = meta.column(pk).is_some_and(|c| c.nullable);
            items.push(d.order_item(&column(pk), false, nullable));
            applied.push(AppliedSort { column: pk.clone(), desc: false, tie: true });
        }
    } else if let Some(row_id) = &meta.row_id {
        items.push(format!("{alias}.{row_id}"));
    } else {
        stable = false;
    }
    Ok((items.join(", "), applied, stable))
}

/// The statement for one page of rows (`limit + 1` rows, to learn whether there are more).
pub fn plan_page(d: Dialect, cat: &Catalog, req: &BrowseRequest) -> Result<Stmt, AppError> {
    let meta = meta_of(cat, req)?;
    let mut r = Render::new(d);
    let filter = combine(req.filter.as_ref(), &req.filters);
    let cond = where_clause(&mut r, &Scope { meta, alias: ALIAS.into() }, filter.as_ref())?;
    let (order, _, _) = page_order(d, meta, req)?;
    let alias = d.quote(ALIAS);
    let select = meta.columns.iter().map(|c| d.select_text(&format!("{alias}.{}", d.quote(&c.name)), &c.type_name)).collect::<Vec<_>>().join(", ");
    let mut sql = format!("SELECT {select} FROM {} AS {alias}", meta.qualified);
    if let Some(c) = cond {
        sql.push_str(&format!(" WHERE {c}"));
    }
    sql.push_str(&d.paging(&order, req.limit.clamp(1, MAX_LIMIT) + 1, req.offset));
    Ok(Stmt { sql, params: r.params, timeout_s: req.timeout(), optional: false })
}

/// The page's rows and what was applied.
pub fn finish_page(d: Dialect, cat: &Catalog, req: &BrowseRequest, ran: Vec<Ran>, started: Instant) -> Result<BrowseResult, AppError> {
    let meta = meta_of(cat, req)?;
    let (_, sort, stable_order) = page_order(d, meta, req)?;
    let rows = match ran.into_iter().next() {
        Some(Ran::Rows(rows)) => rows,
        Some(Ran::Failed(e)) => return Err(e),
        _ => return Err(AppError::Invalid("The rows could not be read".into())),
    };
    let (rows, has_more, truncated_at) = cap_rows_at(rows, req.limit.clamp(1, MAX_LIMIT) as usize);
    Ok(BrowseResult {
        columns: meta.columns.clone(),
        rows,
        has_more,
        row_estimate: meta.row_estimate,
        ordered_by: sort.iter().map(|s| s.column.clone()).collect(),
        sort,
        stable_order,
        truncated_cells: truncated_at.len() as u32,
        truncated_at,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Columns of a table, view or foreign table, in attribute order (empty when it does not exist),
/// with the relation's kind (`r`, `p`, `v`, `m`, `f`). A domain is classified by its base type;
/// enums (also behind a domain) carry their labels.
pub async fn pg_columns_and_relkind(client: &Client, schema: &str, table: &str) -> Result<(Vec<BrowseColumn>, String), AppError> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                    bt.typtype::text, format_type(bt.oid, NULL), c.relkind::text,
                    CASE WHEN bt.typtype = 'e' THEN
                      (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = bt.oid)
                    END
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_type t ON t.oid = a.atttypid
             JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
             WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await?;
    let relkind = rows.first().map(|r| r.get::<_, String>(5)).unwrap_or_default();
    let columns = rows
        .iter()
        .map(|r| {
            let enum_values: Option<Vec<String>> = r.get(6);
            let base: String = r.get(4);
            BrowseColumn {
                name: r.get(0),
                type_name: r.get(1),
                kind: if r.get::<_, String>(3) == "e" { ColKind::Enum } else { super::sql::classify(super::sql::Dialect::Postgres, &base) },
                nullable: !r.get::<_, bool>(2),
                enum_values,
            }
        })
        .collect();
    Ok((columns, relkind))
}

/// Columns of a table, view or foreign table, in attribute order (empty when it does not exist).
pub async fn pg_table_columns(client: &Client, schema: &str, table: &str) -> Result<Vec<BrowseColumn>, AppError> {
    Ok(pg_columns_and_relkind(client, schema, table).await?.0)
}

/// Primary-key columns in key order (empty without a primary key).
pub async fn pg_primary_key(client: &Client, schema: &str, table: &str) -> Result<Vec<String>, AppError> {
    Ok(client
        .query(
            "SELECT a.attname::text FROM pg_index ix
             JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
             WHERE n.nspname = $1 AND c.relname = $2 AND ix.indisprimary ORDER BY k.ord",
            &[&schema, &table],
        )
        .await?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect())
}

/// Planner estimate of a table's row count (0 when never analysed).
pub async fn pg_row_estimate(client: &Client, schema: &str, table: &str) -> Result<f64, AppError> {
    Ok(client
        .query_opt(
            "SELECT GREATEST(c.reltuples, 0)::float8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await?
        .map(|r| r.get(0))
        .unwrap_or(0.0))
}

/// Runs one SELECT whose columns are all text, in a read-only transaction with a timeout.
pub async fn pg_fetch_text(client: &mut Client, sql: &str, params: &[String], timeout_s: u32) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let values: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let tx = client.transaction().await?;
    tx.batch_execute(&format!("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '{timeout_s}s'")).await?;
    let result = tx.query(sql, &values).await;
    tx.rollback().await?;
    Ok(result?.iter().map(|r| (0..r.len()).map(|i| r.get::<_, Option<String>>(i)).collect()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::filter::Op;
    use crate::db::sql::classify;

    fn catalog(d: Dialect, cols: &[(&str, &str, bool)], pk: &[&str], row_id: Option<&str>) -> Catalog {
        let meta = TableMeta {
            qualified: d.qualified("public", "users"),
            schema: "public".into(),
            table: "users".into(),
            columns: cols.iter().map(|(n, t, nullable)| BrowseColumn { name: n.to_string(), type_name: t.to_string(), kind: classify(d, t), nullable: *nullable, enum_values: None }).collect(),
            primary_key: pk.iter().map(|s| s.to_string()).collect(),
            row_id: row_id.map(str::to_string),
            ..Default::default()
        };
        Catalog::from([(("public".to_string(), "users".to_string()), meta)])
    }

    fn request() -> BrowseRequest {
        BrowseRequest { schema: "public".into(), table: "users".into(), limit: 100, offset: 200, ..Default::default() }
    }

    #[test]
    fn page_per_engine_with_filters_and_stable_order() {
        let mut req = request();
        req.filters = vec![BrowseFilter { column: "org_id".into(), value: Some("7".into()) }];
        req.filter = Some(FilterNode::Cond { id: "c".into(), column: "role".into(), op: Op::Contains, args: vec!["adm".into()], cs: false });
        req.sort = vec![SortKey { column: "role".into(), desc: true }];
        let pg = catalog(Dialect::Postgres, &[("id", "integer", false), ("org_id", "integer", true), ("role", "text", true)], &["id"], Some("ctid"));
        let st = plan_page(Dialect::Postgres, &pg, &req).unwrap();
        assert_eq!(
            st.sql,
            "SELECT (\"t0\".\"id\")::text, (\"t0\".\"org_id\")::text, (\"t0\".\"role\")::text FROM \"public\".\"users\" AS \"t0\" \
             WHERE (\"t0\".\"org_id\" = ($1::text)::integer AND \"t0\".\"role\" ILIKE $2 ESCAPE '!') \
             ORDER BY \"t0\".\"role\" DESC NULLS LAST, \"t0\".\"id\" LIMIT 101 OFFSET 200"
        );
        assert_eq!(st.params, vec!["7", "%adm%"]);
        let my = catalog(Dialect::Mysql, &[("id", "int(11)", false), ("org_id", "int(11)", true), ("role", "varchar(20)", true)], &["id"], None);
        assert_eq!(
            plan_page(Dialect::Mysql, &my, &req).unwrap().sql,
            "SELECT `t0`.`id`, `t0`.`org_id`, `t0`.`role` FROM `public`.`users` AS `t0` \
             WHERE (`t0`.`org_id` = CAST(? AS SIGNED) AND `t0`.`role` LIKE ? ESCAPE '!') \
             ORDER BY `t0`.`role` DESC, `t0`.`id` LIMIT 101 OFFSET 200"
        );
        let ms = catalog(Dialect::Mssql, &[("id", "int", false), ("org_id", "int", true), ("role", "nvarchar", true)], &["id"], None);
        assert_eq!(
            plan_page(Dialect::Mssql, &ms, &req).unwrap().sql,
            "SELECT CONVERT(NVARCHAR(MAX), [t0].[id]), CONVERT(NVARCHAR(MAX), [t0].[org_id]), CONVERT(NVARCHAR(MAX), [t0].[role]) FROM [public].[users] AS [t0] \
             WHERE ([t0].[org_id] = @P1 AND [t0].[role] LIKE @P2 ESCAPE '!') \
             ORDER BY [t0].[role] DESC, [t0].[id] OFFSET 200 ROWS FETCH NEXT 101 ROWS ONLY"
        );
        let lite = catalog(Dialect::Sqlite, &[("id", "integer", false), ("org_id", "integer", true), ("role", "text", true)], &[], Some("rowid"));
        req.sort = vec![SortKey { column: "org_id".into(), desc: false }];
        assert!(plan_page(Dialect::Sqlite, &lite, &req).unwrap().sql.ends_with("ORDER BY \"t0\".\"org_id\" ASC NULLS LAST, \"t0\".rowid LIMIT 101 OFFSET 200"));
    }

    #[test]
    fn sort_keys_tie_breakers_and_limits() {
        let pg = catalog(Dialect::Postgres, &[("a", "integer", false), ("b", "integer", false), ("doc", "json", true)], &["a", "b"], None);
        let mut req = request();
        req.sort = vec![SortKey { column: "b".into(), desc: true }];
        let (order, applied, stable) = page_order(Dialect::Postgres, &pg[&("public".to_string(), "users".to_string())], &req).unwrap();
        assert_eq!(order, "\"t0\".\"b\" DESC, \"t0\".\"a\"");
        assert_eq!(applied, vec![AppliedSort { column: "b".into(), desc: true, tie: false }, AppliedSort { column: "a".into(), desc: false, tie: true }]);
        assert!(stable);
        req.sort = vec![SortKey { column: "doc".into(), desc: false }];
        assert!(plan_page(Dialect::Postgres, &pg, &req).unwrap_err().to_string().contains("cannot be sorted"));
        req.sort = vec![SortKey { column: "nope".into(), desc: false }];
        assert!(plan_page(Dialect::Postgres, &pg, &req).is_err());
        req.sort = (0..=MAX_SORT).map(|_| SortKey { column: "a".into(), desc: false }).collect();
        assert!(plan_page(Dialect::Postgres, &pg, &req).is_err());
        // No key, no row id: SQL Server still needs an ORDER BY for paging, and the order is unstable.
        let ms = catalog(Dialect::Mssql, &[("x", "int", true)], &[], None);
        let req = request();
        assert!(plan_page(Dialect::Mssql, &ms, &req).unwrap().sql.ends_with("ORDER BY (SELECT NULL) OFFSET 200 ROWS FETCH NEXT 101 ROWS ONLY"));
        assert!(!page_order(Dialect::Mssql, &ms[&("public".to_string(), "users".to_string())], &req).unwrap().2);
    }

    #[test]
    fn truncation() {
        let (s, cut) = truncate_cell("x".repeat(MAX_CELL_CHARS + 10));
        assert!(cut);
        assert_eq!(s.chars().count(), MAX_CELL_CHARS + 1);
        let (s, cut) = truncate_cell("é".repeat(10));
        assert!(!cut);
        assert_eq!(s, "é".repeat(10));
        let (rows, more, at) = cap_rows_at(vec![vec![Some("a".into()), Some("x".repeat(MAX_CELL_CHARS + 1))], vec![None, None]], 1);
        assert_eq!((rows.len(), more, at), (1, true, vec![[0, 1]]));
    }
}
