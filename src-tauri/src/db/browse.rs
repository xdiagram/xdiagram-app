//! Read-only data browsing: a page of rows from one table, optionally filtered by equality on
//! columns (how foreign-key navigation works) and sorted. Identifiers are checked against the
//! catalog before being quoted into SQL; values are always bound parameters.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

use super::advisor::{qualified, quote_ident};
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filters: Vec<BrowseFilter>,
    pub order_by: Option<OrderBy>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u64,
    /// Statement time limit in seconds (default 10).
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

impl BrowseRequest {
    pub fn timeout(&self) -> u32 {
        self.timeout_secs.unwrap_or(10).clamp(1, 600)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseColumn {
    pub name: String,
    pub type_name: String,
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
    /// The order actually applied (requested column, else the primary key).
    pub ordered_by: Vec<String>,
    pub truncated_cells: u32,
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
    let has_more = rows.len() > limit;
    let mut truncated = 0u32;
    let rows = rows
        .into_iter()
        .take(limit)
        .map(|r| {
            r.into_iter()
                .map(|v| {
                    v.map(|s| {
                        let (s, cut) = truncate_cell(s);
                        truncated += cut as u32;
                        s
                    })
                })
                .collect()
        })
        .collect();
    (rows, has_more, truncated)
}

/// The SELECT for a validated request. `$1..$n` bind the non-null filter values in order.
pub fn build_query(req: &BrowseRequest, columns: &[BrowseColumn], order: &[(String, bool)]) -> String {
    let select = columns.iter().map(|c| format!("{}::text", quote_ident(&c.name))).collect::<Vec<_>>().join(", ");
    let mut conditions = Vec::new();
    let mut param = 0;
    for f in &req.filters {
        match f.value {
            Some(_) => {
                param += 1;
                conditions.push(format!("{}::text = ${param}", quote_ident(&f.column)));
            }
            None => conditions.push(format!("{} IS NULL", quote_ident(&f.column))),
        }
    }
    let mut sql = format!("SELECT ARRAY[{select}] FROM {}", qualified(&req.schema, &req.table));
    if !conditions.is_empty() {
        sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }
    if !order.is_empty() {
        let keys = order
            .iter()
            .map(|(c, desc)| format!("{}{}", quote_ident(c), if *desc { " DESC NULLS LAST" } else { "" }))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" ORDER BY {keys}"));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit.clamp(1, MAX_LIMIT) + 1, req.offset));
    sql
}

/// Columns of a table, view or foreign table, in attribute order (empty when it does not exist).
pub async fn pg_table_columns(client: &Client, schema: &str, table: &str) -> Result<Vec<BrowseColumn>, AppError> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod)
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await?;
    Ok(rows.iter().map(|r| BrowseColumn { name: r.get(0), type_name: r.get(1) }).collect())
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

pub async fn browse_postgres(client: &mut Client, req: &BrowseRequest) -> Result<BrowseResult, AppError> {
    let started = Instant::now();
    let columns = pg_table_columns(client, &req.schema, &req.table).await?;
    if columns.is_empty() {
        return Err(AppError::Invalid(format!("Table {}.{} not found", req.schema, req.table)));
    }
    let known = |c: &str| columns.iter().any(|x| x.name == c);
    for f in &req.filters {
        if !known(&f.column) {
            return Err(AppError::Invalid(format!("Unknown column {}", f.column)));
        }
    }
    let order: Vec<(String, bool)> = match &req.order_by {
        Some(o) if known(&o.column) => vec![(o.column.clone(), o.desc)],
        Some(o) => return Err(AppError::Invalid(format!("Unknown column {}", o.column))),
        None => {
            // Stable paging: order by the primary key when there is one.
            client
                .query(
                    "SELECT a.attname::text FROM pg_index ix
                     JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                     JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
                     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                     WHERE n.nspname = $1 AND c.relname = $2 AND ix.indisprimary ORDER BY k.ord",
                    &[&req.schema, &req.table],
                )
                .await?
                .iter()
                .map(|r| (r.get::<_, String>(0), false))
                .collect()
        }
    };
    let estimate = pg_row_estimate(client, &req.schema, &req.table).await?;

    let sql = build_query(req, &columns, &order);
    let values: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = req
        .filters
        .iter()
        .filter_map(|f| f.value.as_ref().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)))
        .collect();

    let tx = client.transaction().await?;
    tx.batch_execute(&format!("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '{}s'", req.timeout())).await?;
    let result = tx.query(sql.as_str(), &values).await;
    tx.rollback().await?;
    let result = result?;

    let limit = req.limit.clamp(1, MAX_LIMIT) as usize;
    let has_more = result.len() > limit;
    let mut truncated = 0;
    let rows = result
        .iter()
        .take(limit)
        .map(|r| {
            r.get::<_, Vec<Option<String>>>(0)
                .into_iter()
                .map(|v| {
                    v.map(|s| {
                        let (s, cut) = truncate_cell(s);
                        truncated += cut as u32;
                        s
                    })
                })
                .collect()
        })
        .collect();

    Ok(BrowseResult {
        columns,
        rows,
        has_more,
        row_estimate: estimate,
        ordered_by: order.into_iter().map(|(c, _)| c).collect(),
        truncated_cells: truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<BrowseColumn> {
        names.iter().map(|n| BrowseColumn { name: n.to_string(), type_name: "text".into() }).collect()
    }

    #[test]
    fn query_with_filters_and_order() {
        let req = BrowseRequest {
            schema: "public".into(),
            table: "users".into(),
            filters: vec![
                BrowseFilter { column: "org_id".into(), value: Some("7".into()) },
                BrowseFilter { column: "deleted_at".into(), value: None },
                BrowseFilter { column: "role".into(), value: Some("admin".into()) },
            ],
            order_by: None,
            limit: 100,
            offset: 200,
            timeout_secs: None,
        };
        let sql = build_query(&req, &cols(&["id", "org_id", "role", "deleted_at"]), &[("id".into(), false)]);
        assert_eq!(
            sql,
            "SELECT ARRAY[\"id\"::text, \"org_id\"::text, \"role\"::text, \"deleted_at\"::text] FROM \"public\".\"users\" \
             WHERE \"org_id\"::text = $1 AND \"deleted_at\" IS NULL AND \"role\"::text = $2 ORDER BY \"id\" LIMIT 101 OFFSET 200"
        );
    }

    #[test]
    fn limits_and_quoting() {
        let req = BrowseRequest {
            schema: "we\"ird".into(),
            table: "t".into(),
            filters: vec![],
            order_by: None,
            limit: 10_000,
            offset: 0,
            timeout_secs: None,
        };
        let sql = build_query(&req, &cols(&["a"]), &[("a".into(), true)]);
        assert!(sql.contains("FROM \"we\"\"ird\".\"t\""));
        assert!(sql.ends_with("ORDER BY \"a\" DESC NULLS LAST LIMIT 501 OFFSET 0"));
    }

    #[test]
    fn truncation() {
        let (s, cut) = truncate_cell("x".repeat(MAX_CELL_CHARS + 10));
        assert!(cut);
        assert_eq!(s.chars().count(), MAX_CELL_CHARS + 1);
        let (s, cut) = truncate_cell("é".repeat(10));
        assert!(!cut);
        assert_eq!(s, "é".repeat(10));
    }
}
