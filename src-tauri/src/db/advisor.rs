//! FK & index advisor (X-ray, PostgreSQL).
//!
//! - `check_relation`: before turning a discovered relationship into a foreign key, count the rows
//!   that would violate it and generate the migration SQL.
//! - `index_advice`: unindexed foreign keys, selective filters on large tables without an index,
//!   unused and duplicate indexes.
//!
//! Only reads. Generated SQL is returned as text and never executed.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

use super::introspect::schema_filter;
use super::workload_db::Endpoint;
use crate::error::AppError;

const MAX_IDENT: usize = 63;

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn column_list(columns: &[String]) -> String {
    columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ")
}

/// `table_col1_col2_suffix`, truncated to PostgreSQL's 63-byte identifier limit.
pub fn derived_name(table: &str, columns: &[String], suffix: &str) -> String {
    let base = format!("{}_{}", table, columns.join("_"));
    let room = MAX_IDENT.saturating_sub(suffix.len() + 1);
    let mut cut = base.len().min(room);
    while !base.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}_{}", &base[..cut], suffix)
}

// ---------------------------------------------------------------------------------------------
// Index catalog
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct IndexInfo {
    pub schema: String,
    pub table: String,
    pub name: String,
    /// Key columns in order; `None` for an expression.
    pub columns: Vec<Option<String>>,
    pub unique: bool,
    pub primary: bool,
    pub valid: bool,
    pub partial: bool,
    pub backs_constraint: bool,
    pub scans: i64,
    pub size_bytes: i64,
    /// Creation order proxy: the older of two duplicates is kept.
    pub oid: i64,
    /// Same value ⇔ same table, keys, operator classes, expressions and predicate.
    pub signature: String,
}

impl IndexInfo {
    /// The index can serve lookups on exactly these columns (they are its leading keys, any order).
    pub fn leads_with(&self, columns: &[String]) -> bool {
        if !self.valid || self.partial || columns.is_empty() || self.columns.len() < columns.len() {
            return false;
        }
        let lead: HashSet<&str> = self.columns[..columns.len()].iter().filter_map(|c| c.as_deref()).collect();
        lead.len() == columns.len() && columns.iter().all(|c| lead.contains(c.as_str()))
    }

    /// Usable as the referenced key of a foreign key: unique, immediate, plain columns, no predicate.
    pub fn is_unique_key_for(&self, columns: &[String]) -> bool {
        (self.unique || self.primary) && self.columns.len() == columns.len() && self.leads_with(columns)
    }
}

pub async fn load_indexes(client: &Client, schemas: &[String]) -> Result<Vec<IndexInfo>, AppError> {
    let sql = format!(
        r#"
        SELECT n.nspname::text, t.relname::text, i.relname::text,
               ARRAY(
                 SELECT (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ix.indkey[k.pos])
                 FROM generate_series(0, ix.indnkeyatts - 1) AS k(pos) ORDER BY k.pos
               ) AS cols,
               ix.indisunique, ix.indisprimary, ix.indisvalid, ix.indpred IS NOT NULL AS partial,
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid) AS backs_constraint,
               COALESCE(s.idx_scan, 0)::int8 AS scans,
               pg_relation_size(ix.indexrelid)::int8 AS size_bytes,
               ix.indexrelid::oid::int8 AS oid,
               ix.indrelid::text || '|' || ix.indkey::text || '|' || ix.indclass::text || '|' ||
                 COALESCE(pg_get_expr(ix.indexprs, ix.indrelid), '') || '|' || COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '') AS signature
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
        WHERE t.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND {filter}
        ORDER BY n.nspname, t.relname, i.relname
        "#,
        filter = schema_filter("n.nspname"),
    );
    let rows = client.query(sql.as_str(), &[&schemas]).await?;
    rows.iter()
        .map(|r| {
            Ok(IndexInfo {
                schema: r.try_get(0)?,
                table: r.try_get(1)?,
                name: r.try_get(2)?,
                columns: r.try_get(3)?,
                unique: r.try_get(4)?,
                primary: r.try_get(5)?,
                valid: r.try_get(6)?,
                partial: r.try_get(7)?,
                backs_constraint: r.try_get(8)?,
                scans: r.try_get(9)?,
                size_bytes: r.try_get(10)?,
                oid: r.try_get(11)?,
                signature: r.try_get(12)?,
            })
        })
        .collect()
}

pub async fn stats_reset(client: &Client) -> Result<Option<String>, AppError> {
    let row = client
        .query_opt("SELECT stats_reset::text FROM pg_stat_database WHERE datname = current_database()", &[])
        .await?;
    Ok(row.and_then(|r| r.get::<_, Option<String>>(0)))
}

// ---------------------------------------------------------------------------------------------
// Index advice
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexAdvice {
    /// "fk_unindexed" | "filter_seq_scan" | "unused" | "duplicate"
    pub kind: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub index_name: Option<String>,
    pub reason: String,
    /// Calls that would benefit (joins, filters) or bytes held by an unused index.
    pub impact: i64,
    pub sql: String,
}

/// A foreign key (declared or found in queries) whose child columns may need an index.
#[derive(Debug, Clone)]
pub struct FkColumns {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub parent: String,
    pub calls: i64,
    pub declared: bool,
}

/// Facts the advice rules need about a table.
#[derive(Debug, Clone, Copy, Default)]
pub struct TableStats {
    pub rows: f64,
    pub seq_scan: i64,
    pub idx_scan: i64,
}

/// Rows above which a sequential scan for a selective filter is worth an index.
pub const LARGE_TABLE_ROWS: f64 = 10_000.0;
/// Distinct values below which an equality filter is not selective enough for a b-tree.
pub const MIN_DISTINCT: f64 = 100.0;
/// Rows below which an unindexed foreign key is only flagged when joins actually use it.
pub const SMALL_TABLE_ROWS: f64 = 1_000.0;

pub struct AdviceInput<'a> {
    pub indexes: &'a [IndexInfo],
    pub fks: &'a [FkColumns],
    /// `(schema, table, column)` → calls of statements filtering on it.
    pub filters: &'a BTreeMap<(String, String, String), i64>,
    pub tables: &'a HashMap<(String, String), TableStats>,
    /// `(schema, table, column)` → (`n_distinct`, `null_frac`) from `pg_stats`.
    pub column_stats: &'a HashMap<(String, String, String), (f64, f64)>,
    pub stats_reset: Option<&'a str>,
}

fn distinct_values(n_distinct: f64, rows: f64) -> f64 {
    if n_distinct < 0.0 { -n_distinct * rows } else { n_distinct }
}

fn human_bytes(b: i64) -> String {
    let b = b as f64;
    if b >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} GB", b / 1024.0 / 1024.0 / 1024.0)
    } else if b >= 1024.0 * 1024.0 {
        format!("{:.1} MB", b / 1024.0 / 1024.0)
    } else {
        format!("{:.0} kB", (b / 1024.0).max(1.0))
    }
}

fn create_index_sql(schema: &str, table: &str, columns: &[String]) -> String {
    format!(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS {} ON {} ({});",
        quote_ident(&derived_name(table, columns, "idx")),
        qualified(schema, table),
        column_list(columns)
    )
}

/// Some valid index on the table starts with exactly these columns.
fn covered(indexes: &[IndexInfo], schema: &str, table: &str, columns: &[String]) -> bool {
    indexes.iter().any(|i| i.schema == schema && i.table == table && i.leads_with(columns))
}

pub fn index_advice(input: &AdviceInput) -> Vec<IndexAdvice> {
    let mut out = Vec::new();
    let covered = |s: &str, t: &str, cols: &[String]| covered(input.indexes, s, t, cols);

    // 1. Foreign keys without an index on the referencing columns.
    let mut seen = HashSet::new();
    for fk in input.fks {
        if !seen.insert((fk.schema.clone(), fk.table.clone(), fk.columns.clone())) {
            continue;
        }
        let rows = input.tables.get(&(fk.schema.clone(), fk.table.clone())).map(|t| t.rows).unwrap_or(0.0);
        if covered(&fk.schema, &fk.table, &fk.columns) || (rows < SMALL_TABLE_ROWS && fk.calls == 0) {
            continue;
        }
        let what = if fk.declared { "Foreign key" } else { "Relationship found in queries" };
        out.push(IndexAdvice {
            kind: "fk_unindexed".into(),
            schema: fk.schema.clone(),
            table: fk.table.clone(),
            columns: fk.columns.clone(),
            index_name: None,
            reason: format!(
                "{what} {}({}) → {} has no index starting with these columns; joins{} scan ~{} rows.",
                fk.table,
                fk.columns.join(", "),
                fk.parent,
                if fk.declared { " and deletes on the parent" } else { "" },
                rows.round() as i64
            ),
            impact: fk.calls,
            sql: create_index_sql(&fk.schema, &fk.table, &fk.columns),
        });
    }

    // 2. Selective filters on large, sequentially scanned tables without an index.
    let mut per_table: BTreeMap<(String, String), Vec<(String, i64, f64)>> = BTreeMap::new();
    for ((schema, table, column), calls) in input.filters {
        let Some(stats) = input.tables.get(&(schema.clone(), table.clone())) else { continue };
        if stats.rows < LARGE_TABLE_ROWS || stats.seq_scan == 0 {
            continue;
        }
        let distinct = input
            .column_stats
            .get(&(schema.clone(), table.clone(), column.clone()))
            .map(|(nd, _)| distinct_values(*nd, stats.rows));
        if distinct.is_some_and(|d| d < MIN_DISTINCT) {
            continue;
        }
        if covered(schema, table, std::slice::from_ref(column)) || out.iter().any(|a| a.schema == *schema && a.table == *table && a.columns == [column.clone()]) {
            continue;
        }
        per_table.entry((schema.clone(), table.clone())).or_default().push((column.clone(), *calls, distinct.unwrap_or(-1.0)));
    }
    for ((schema, table), mut cols) in per_table {
        let stats = input.tables[&(schema.clone(), table.clone())];
        cols.sort_by(|a, b| b.1.cmp(&a.1));
        for (column, calls, distinct) in cols.into_iter().take(3) {
            let distinct_text = if distinct >= 0.0 { format!(", ~{} distinct values", distinct.round() as i64) } else { String::new() };
            out.push(IndexAdvice {
                kind: "filter_seq_scan".into(),
                schema: schema.clone(),
                table: table.clone(),
                columns: vec![column.clone()],
                index_name: None,
                reason: format!(
                    "Queries filter {table}.{column} ({calls} calls{distinct_text}) and the table (~{} rows) had {} sequential vs {} index scans.",
                    stats.rows.round() as i64, stats.seq_scan, stats.idx_scan
                ),
                impact: calls,
                sql: create_index_sql(&schema, &table, std::slice::from_ref(&column)),
            });
        }
    }

    // 3. Duplicate indexes (keep the one backing a constraint, else a unique one, else the oldest).
    let mut flagged: HashSet<(String, String)> = HashSet::new();
    let mut groups: BTreeMap<&str, Vec<&IndexInfo>> = BTreeMap::new();
    for i in input.indexes.iter().filter(|i| i.valid) {
        groups.entry(i.signature.as_str()).or_default().push(i);
    }
    for list in groups.values().filter(|l| l.len() > 1) {
        let keep = list
            .iter()
            .copied()
            .find(|i| i.primary || i.backs_constraint)
            .or_else(|| list.iter().copied().find(|i| i.unique))
            .unwrap_or_else(|| list.iter().copied().min_by_key(|i| i.oid).unwrap_or(list[0]));
        for dup in list.iter().filter(|i| i.name != keep.name && !i.primary && !i.backs_constraint) {
            flagged.insert((dup.schema.clone(), dup.name.clone()));
            out.push(IndexAdvice {
                kind: "duplicate".into(),
                schema: dup.schema.clone(),
                table: dup.table.clone(),
                columns: dup.columns.iter().map(|c| c.clone().unwrap_or_else(|| "(expression)".into())).collect(),
                index_name: Some(dup.name.clone()),
                reason: format!("Same definition as {} ({}); every write maintains both.", keep.name, human_bytes(dup.size_bytes)),
                impact: dup.size_bytes,
                sql: format!("DROP INDEX CONCURRENTLY IF EXISTS {};", qualified(&dup.schema, &dup.name)),
            });
        }
    }

    // 4. Indexes never used since the statistics were reset.
    for i in input.indexes {
        if i.scans > 0 || i.unique || i.primary || i.backs_constraint || !i.valid || flagged.contains(&(i.schema.clone(), i.name.clone())) {
            continue;
        }
        let since = input.stats_reset.map(|s| format!(" since {}", &s[..s.len().min(10)])).unwrap_or_default();
        out.push(IndexAdvice {
            kind: "unused".into(),
            schema: i.schema.clone(),
            table: i.table.clone(),
            columns: i.columns.iter().map(|c| c.clone().unwrap_or_else(|| "(expression)".into())).collect(),
            index_name: Some(i.name.clone()),
            reason: format!(
                "Never used for a scan{since} ({}). Check replicas and rare jobs before dropping.",
                human_bytes(i.size_bytes)
            ),
            impact: i.size_bytes,
            sql: format!("DROP INDEX CONCURRENTLY IF EXISTS {};", qualified(&i.schema, &i.name)),
        });
    }

    out.sort_by(|a, b| {
        let rank = |k: &str| match k {
            "fk_unindexed" => 0,
            "filter_seq_scan" => 1,
            "duplicate" => 2,
            _ => 3,
        };
        rank(&a.kind).cmp(&rank(&b.kind)).then(b.impact.cmp(&a.impact))
    });
    out
}

// ---------------------------------------------------------------------------------------------
// Relationship check
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationCheckRequest {
    pub child: EndpointInput,
    pub parent: EndpointInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInput {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationCheck {
    pub child_rows_estimate: f64,
    /// Rows actually examined (a sample on very large tables).
    pub checked_rows: i64,
    pub sampled: bool,
    pub timed_out: bool,
    /// Rows with a NULL in any child column (never checked by a foreign key).
    pub null_rows: i64,
    /// Rows whose key has no match in the parent.
    pub orphan_rows: i64,
    pub orphan_samples: Vec<String>,
    pub parent_unique: bool,
    pub child_indexed: bool,
    pub constraint_name: String,
    pub sql: String,
}

/// Rows above which the orphan count runs on a ~1M-row `TABLESAMPLE`.
const SAMPLE_ABOVE_ROWS: f64 = 5_000_000.0;

async fn assert_columns(client: &Client, e: &EndpointInput) -> Result<(), AppError> {
    let found: i64 = client
        .query_one(
            "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = ANY($3) AND a.attnum > 0 AND NOT a.attisdropped",
            &[&e.schema, &e.table, &e.columns],
        )
        .await?
        .get(0);
    if e.columns.is_empty() || found as usize != e.columns.len() {
        return Err(AppError::Invalid(format!("{}.{}({}) does not exist", e.schema, e.table, e.columns.join(", "))));
    }
    Ok(())
}

pub async fn check_relation(client: &mut Client, req: &RelationCheckRequest) -> Result<RelationCheck, AppError> {
    let (child, parent) = (&req.child, &req.parent);
    if child.columns.len() != parent.columns.len() {
        return Err(AppError::Invalid("Both sides need the same number of columns".into()));
    }
    assert_columns(client, child).await?;
    assert_columns(client, parent).await?;

    let schemas = vec![child.schema.clone(), parent.schema.clone()];
    let indexes = load_indexes(client, &schemas).await?;
    let parent_unique = indexes
        .iter()
        .any(|i| i.schema == parent.schema && i.table == parent.table && i.is_unique_key_for(&parent.columns));
    let child_indexed = indexes.iter().any(|i| i.schema == child.schema && i.table == child.table && i.leads_with(&child.columns));
    let rows: f64 = client
        .query_one(
            "SELECT GREATEST(c.reltuples, 0)::float8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
            &[&child.schema, &child.table],
        )
        .await?
        .get(0);

    let sampled = rows > SAMPLE_ABOVE_ROWS;
    let sample = if sampled { format!(" TABLESAMPLE SYSTEM ({:.4})", (100.0 * 1_000_000.0 / rows).min(100.0)) } else { String::new() };
    let any_null = child.columns.iter().map(|c| format!("c.{} IS NULL", quote_ident(c))).collect::<Vec<_>>().join(" OR ");
    let all_set = child.columns.iter().map(|c| format!("c.{} IS NOT NULL", quote_ident(c))).collect::<Vec<_>>().join(" AND ");
    let matches = child
        .columns
        .iter()
        .zip(&parent.columns)
        .map(|(c, p)| format!("p.{} = c.{}", quote_ident(p), quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let orphan = format!("{all_set} AND NOT EXISTS (SELECT 1 FROM {} p WHERE {matches})", qualified(&parent.schema, &parent.table));
    let child_table = qualified(&child.schema, &child.table);
    let counts_sql = format!(
        "SELECT count(*)::int8, (count(*) FILTER (WHERE {any_null}))::int8, (count(*) FILTER (WHERE {orphan}))::int8 FROM {child_table} c{sample}"
    );
    let key_text = if child.columns.len() == 1 {
        format!("c.{}::text", quote_ident(&child.columns[0]))
    } else {
        format!("ROW({})::text", child.columns.iter().map(|c| format!("c.{}", quote_ident(c))).collect::<Vec<_>>().join(", "))
    };
    let samples_sql = format!("SELECT DISTINCT {key_text} FROM {child_table} c{sample} WHERE {orphan} LIMIT 5");

    let tx = client.transaction().await?;
    tx.batch_execute("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s'").await?;
    let (mut checked, mut nulls, mut orphans, mut samples, mut timed_out) = (0i64, 0i64, 0i64, Vec::new(), false);
    match tx.query_one(counts_sql.as_str(), &[]).await {
        Ok(row) => {
            checked = row.get(0);
            nulls = row.get(1);
            orphans = row.get(2);
            if orphans > 0 {
                samples = tx.query(samples_sql.as_str(), &[]).await?.iter().map(|r| r.get::<_, String>(0)).collect();
            }
        }
        Err(e) if e.as_db_error().is_some_and(|d| d.code().code() == "57014") => timed_out = true,
        Err(e) => return Err(e.into()),
    }
    tx.rollback().await?;

    let mut result = RelationCheck {
        child_rows_estimate: rows,
        checked_rows: checked,
        sampled,
        timed_out,
        null_rows: nulls,
        orphan_rows: orphans,
        orphan_samples: samples,
        parent_unique,
        child_indexed,
        constraint_name: derived_name(&child.table, &child.columns, "fkey"),
        sql: String::new(),
    };
    result.sql = relation_sql(req, &result);
    Ok(result)
}

/// The migration that turns a discovered relationship into a foreign key, safely:
/// index first (CONCURRENTLY), `NOT VALID` so existing rows aren't scanned under lock, then
/// `VALIDATE` (kept commented out while orphan rows exist).
pub fn relation_sql(req: &RelationCheckRequest, check: &RelationCheck) -> String {
    let (c, p) = (&req.child, &req.parent);
    let child = qualified(&c.schema, &c.table);
    let parent = qualified(&p.schema, &p.table);
    let mut out = vec![format!(
        "-- Foreign key {}.{}({}) → {}.{}({}), generated by xdiagram. Review before running.",
        c.schema,
        c.table,
        c.columns.join(", "),
        p.schema,
        p.table,
        p.columns.join(", ")
    )];
    if check.timed_out {
        out.push("-- The orphan check timed out; run VALIDATE only after checking the data yourself.".into());
    } else {
        out.push(format!(
            "-- Checked {} rows{}: {} orphan(s), {} with NULL keys (never checked by a foreign key).",
            check.checked_rows,
            if check.sampled { " (sample)" } else { "" },
            check.orphan_rows,
            check.null_rows
        ));
    }
    if !check.parent_unique {
        out.push(format!(
            "ALTER TABLE {parent} ADD CONSTRAINT {} UNIQUE ({});  -- the referenced columns must be unique",
            quote_ident(&derived_name(&p.table, &p.columns, "key")),
            column_list(&p.columns)
        ));
    }
    if !check.child_indexed {
        out.push(create_index_sql(&c.schema, &c.table, &c.columns));
    }
    let name = quote_ident(&check.constraint_name);
    out.push(format!(
        "ALTER TABLE {child} ADD CONSTRAINT {name} FOREIGN KEY ({}) REFERENCES {parent} ({}) NOT VALID;",
        column_list(&c.columns),
        column_list(&p.columns)
    ));
    let validate = format!("ALTER TABLE {child} VALIDATE CONSTRAINT {name};");
    if check.orphan_rows > 0 || check.timed_out {
        if check.orphan_rows > 0 {
            out.push(format!(
                "-- {} row(s) reference missing {} (e.g. {}). Fix or delete them, then validate:",
                check.orphan_rows,
                p.table,
                check.orphan_samples.join(", ")
            ));
        }
        out.push(format!("-- {validate}"));
    } else {
        out.push(validate);
    }
    out.join("\n") + "\n"
}

/// Endpoint as reported in `WorkloadReport` → request shape.
pub fn endpoint_input(e: &Endpoint) -> EndpointInput {
    EndpointInput { schema: e.schema.clone(), table: e.table.clone(), columns: e.columns.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(table: &str, name: &str, cols: &[Option<&str>], unique: bool, sig: &str) -> IndexInfo {
        IndexInfo {
            schema: "public".into(),
            table: table.into(),
            name: name.into(),
            columns: cols.iter().map(|c| c.map(str::to_string)).collect(),
            unique,
            primary: name.ends_with("_pkey"),
            valid: true,
            partial: false,
            backs_constraint: name.ends_with("_pkey") || name.ends_with("_key"),
            scans: if name.contains("unused") || name.contains("dup") { 0 } else { 5 },
            size_bytes: 16384,
            oid: if name.contains("dup") { 200 } else { 100 },
            signature: sig.into(),
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn identifiers_and_names() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(derived_name("events", &s(&["user_id"]), "fkey"), "events_user_id_fkey");
        assert!(derived_name(&"x".repeat(80), &s(&["c"]), "idx").len() <= 63);
    }

    #[test]
    fn leading_columns() {
        let pk = idx("memberships", "memberships_pkey", &[Some("org_id"), Some("user_id")], true, "1");
        assert!(pk.leads_with(&s(&["org_id"])));
        assert!(!pk.leads_with(&s(&["user_id"])));
        assert!(pk.leads_with(&s(&["user_id", "org_id"])));
        assert!(pk.is_unique_key_for(&s(&["org_id", "user_id"])));
        assert!(!pk.is_unique_key_for(&s(&["org_id"])));
        let expr = idx("users", "users_lower_idx", &[None], false, "2");
        assert!(!expr.leads_with(&s(&["email"])));
    }

    #[test]
    fn advice_rules() {
        let indexes = vec![
            idx("events", "events_pkey", &[Some("id")], true, "e1"),
            idx("memberships", "memberships_pkey", &[Some("org_id"), Some("user_id")], true, "m1"),
            idx("projects", "projects_name_idx", &[Some("name")], false, "p1"),
            idx("projects", "projects_name_dup", &[Some("name")], false, "p1"),
            idx("users", "users_unused_idx", &[None], false, "u1"),
        ];
        let fks = vec![
            FkColumns { schema: "public".into(), table: "events".into(), columns: s(&["user_id"]), parent: "users".into(), calls: 186, declared: false },
            FkColumns { schema: "public".into(), table: "memberships".into(), columns: s(&["org_id"]), parent: "organizations".into(), calls: 9, declared: true },
            FkColumns { schema: "public".into(), table: "memberships".into(), columns: s(&["user_id"]), parent: "users".into(), calls: 0, declared: true },
            FkColumns { schema: "public".into(), table: "project_members".into(), columns: s(&["project_id"]), parent: "projects".into(), calls: 0, declared: true },
        ];
        let mut tables = HashMap::new();
        tables.insert(("public".to_string(), "events".to_string()), TableStats { rows: 20_000.0, seq_scan: 40, idx_scan: 200 });
        tables.insert(("public".to_string(), "memberships".to_string()), TableStats { rows: 2_000.0, seq_scan: 4, idx_scan: 3 });
        tables.insert(("public".to_string(), "project_members".to_string()), TableStats { rows: 0.0, seq_scan: 1, idx_scan: 0 });
        let mut filters = BTreeMap::new();
        filters.insert(("public".to_string(), "events".to_string(), "external_ref".to_string()), 30);
        filters.insert(("public".to_string(), "events".to_string(), "kind".to_string()), 90);
        let mut column_stats = HashMap::new();
        column_stats.insert(("public".to_string(), "events".to_string(), "kind".to_string()), (3.0, 0.0));
        column_stats.insert(("public".to_string(), "events".to_string(), "external_ref".to_string()), (-1.0, 0.0));

        let advice = index_advice(&AdviceInput {
            indexes: &indexes,
            fks: &fks,
            filters: &filters,
            tables: &tables,
            column_stats: &column_stats,
            stats_reset: Some("2026-11-13 10:00:00+00"),
        });
        let summary: Vec<String> = advice.iter().map(|a| format!("{}:{}.{}", a.kind, a.table, a.columns.join("+"))).collect();
        assert_eq!(
            summary,
            vec![
                "fk_unindexed:events.user_id",
                "fk_unindexed:memberships.user_id",
                "filter_seq_scan:events.external_ref",
                "duplicate:projects.name",
                "unused:users.(expression)",
            ]
        );
        assert_eq!(advice[0].sql, "CREATE INDEX CONCURRENTLY IF NOT EXISTS \"events_user_id_idx\" ON \"public\".\"events\" (\"user_id\");");
        assert_eq!(advice[3].index_name.as_deref(), Some("projects_name_dup"));
        assert!(advice[4].reason.contains("since 2026-11-13"));
    }

    fn request() -> RelationCheckRequest {
        RelationCheckRequest {
            child: EndpointInput { schema: "public".into(), table: "events".into(), columns: s(&["user_id"]) },
            parent: EndpointInput { schema: "public".into(), table: "users".into(), columns: s(&["id"]) },
        }
    }

    fn check(orphans: i64, parent_unique: bool, child_indexed: bool) -> RelationCheck {
        RelationCheck {
            child_rows_estimate: 20_000.0,
            checked_rows: 20_000,
            sampled: false,
            timed_out: false,
            null_rows: 0,
            orphan_rows: orphans,
            orphan_samples: if orphans > 0 { s(&["2001", "2003"]) } else { vec![] },
            parent_unique,
            child_indexed,
            constraint_name: "events_user_id_fkey".into(),
            sql: String::new(),
        }
    }

    #[test]
    fn clean_relation_sql() {
        let sql = relation_sql(&request(), &check(0, true, false));
        let lines: Vec<&str> = sql.lines().collect();
        assert!(lines[1].contains("0 orphan(s)"));
        assert_eq!(lines[2], "CREATE INDEX CONCURRENTLY IF NOT EXISTS \"events_user_id_idx\" ON \"public\".\"events\" (\"user_id\");");
        assert_eq!(
            lines[3],
            "ALTER TABLE \"public\".\"events\" ADD CONSTRAINT \"events_user_id_fkey\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\") NOT VALID;"
        );
        assert_eq!(lines[4], "ALTER TABLE \"public\".\"events\" VALIDATE CONSTRAINT \"events_user_id_fkey\";");
    }

    #[test]
    fn orphans_keep_validate_commented() {
        let sql = relation_sql(&request(), &check(37, false, true));
        assert!(sql.contains("ADD CONSTRAINT \"users_id_key\" UNIQUE (\"id\")"));
        assert!(!sql.contains("CREATE INDEX"));
        assert!(sql.contains("-- 37 row(s) reference missing users (e.g. 2001, 2003)"));
        assert!(sql.contains("-- ALTER TABLE \"public\".\"events\" VALIDATE CONSTRAINT"));
        assert!(sql.lines().any(|l| l.ends_with("NOT VALID;") && !l.starts_with("--")));
    }
}
