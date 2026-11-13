//! X-ray mode: what the database actually does, read from the statistics views.
//!
//! - `analyze`: relationships discovered from `pg_stat_statements` (joins without a foreign key),
//!   usage counts of declared foreign keys, per-table facts and de facto FK cardinality.
//! - `sample_tables`: cumulative counters from `pg_stat_user_tables`, diffed by the live session.
//!
//! Everything is read-only; `pg_stat_statements_reset()` is never called.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use tokio_postgres::Client;

use super::advisor::{self, AdviceInput, FkColumns, IndexAdvice, TableStats};
use super::introspect::{generate_raw_refs, schema_filter};
use super::types::Ref;
use super::workload::{analyze_sql, de_facto_cardinality, orient, ColumnRef, JoinPredicate};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEvidence {
    pub query_id: Option<i64>,
    pub calls: i64,
    pub mean_ms: Option<f64>,
    pub text: String,
}

/// A join seen in the workload between columns that no foreign key connects.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRelation {
    /// Referencing side (when `directed`), else the alphabetically first endpoint.
    pub from: Endpoint,
    pub to: Endpoint,
    pub directed: bool,
    pub calls: i64,
    pub statements: i64,
    pub queries: Vec<QueryEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkUsage {
    pub name: String,
    pub from: Endpoint,
    pub to: Endpoint,
    pub calls: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFacts {
    pub schema: String,
    pub table: String,
    pub rows: f64,
    pub dead_ratio: f64,
    pub seq_scan: i64,
    pub idx_scan: i64,
    pub inserts: i64,
    pub updates: i64,
    pub deletes: i64,
    pub last_autovacuum: Option<String>,
    pub last_autoanalyze: Option<String>,
    /// No scan and no write since the statistics were last reset.
    pub never_used: bool,
    /// More sequential than index scans on a table with more than 10k rows.
    pub seq_scan_heavy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkCardinality {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub parent_schema: String,
    pub parent_table: String,
    pub parent_column: String,
    pub children_per_parent: f64,
    pub parent_coverage: f64,
    pub child_null_frac: f64,
    pub verdict: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementStats {
    pub total: i64,
    pub parsed: i64,
    pub unparsed: i64,
    pub redacted: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadReport {
    /// `pg_stat_statements` is installed, loaded and readable.
    pub available: bool,
    pub reason: Option<String>,
    pub extension_version: Option<String>,
    pub statements: StatementStats,
    pub relations: Vec<DiscoveredRelation>,
    pub declared_usage: Vec<FkUsage>,
    pub tables: Vec<TableFacts>,
    pub cardinality: Vec<FkCardinality>,
    /// Unindexed foreign keys, selective filters without an index, unused and duplicate indexes.
    pub index_advice: Vec<IndexAdvice>,
    /// When the statistics behind "unused" and the scan counts started accumulating.
    pub stats_reset: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Table/column universe
// ---------------------------------------------------------------------------------------------

struct Universe {
    columns: HashMap<(String, String), HashSet<String>>,
    keys: HashSet<(String, String, String)>,
    search_path: Vec<String>,
}

impl Universe {
    async fn load(client: &Client, schemas: &[String]) -> Result<Self, AppError> {
        let sql = format!(
            r#"
            SELECT n.nspname::text AS schema, c.relname::text AS table, a.attname::text AS column,
                   EXISTS (
                     SELECT 1 FROM pg_index i
                     WHERE i.indrelid = c.oid AND (i.indisprimary OR i.indisunique)
                       AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
                   ) AS is_key
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND {filter}
            "#,
            filter = schema_filter("n.nspname"),
        );
        let rows = client.query(sql.as_str(), &[&schemas]).await?;
        let mut columns: HashMap<(String, String), HashSet<String>> = HashMap::new();
        let mut keys = HashSet::new();
        for r in &rows {
            let (schema, table, column, is_key): (String, String, String, bool) =
                (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
            if is_key {
                keys.insert((schema.clone(), table.clone(), column.clone()));
            }
            columns.entry((schema, table)).or_default().insert(column);
        }
        let search_path: Vec<String> =
            client.query_one("SELECT current_schemas(false)::text[]", &[]).await?.try_get(0)?;
        Ok(Universe { columns, keys, search_path })
    }

    /// Canonical (schema, table) for a name as written in a query.
    fn resolve(&self, schema: Option<&str>, table: &str) -> Option<(String, String)> {
        if let Some(s) = schema {
            let key = (s.to_string(), table.to_string());
            return self.columns.contains_key(&key).then_some(key);
        }
        if let Some(s) = self.search_path.iter().find(|s| self.columns.contains_key(&((*s).clone(), table.to_string()))) {
            return Some((s.clone(), table.to_string()));
        }
        // Not on the search path: accept the name if exactly one selected schema has it.
        let mut hits = self.columns.keys().filter(|(_, t)| t == table);
        match (hits.next(), hits.next()) {
            (Some(k), None) => Some(k.clone()),
            _ => None,
        }
    }

    fn has_column(&self, schema: Option<&str>, table: &str, column: &str) -> bool {
        self.resolve(schema, table).is_some_and(|k| self.columns[&k].contains(column))
    }

    fn canonical(&self, c: &ColumnRef) -> Option<ColumnRef> {
        let (schema, table) = self.resolve(c.schema.as_deref(), &c.table)?;
        self.columns[&(schema.clone(), table.clone())].contains(&c.column).then(|| ColumnRef {
            schema: Some(schema),
            table,
            column: c.column.clone(),
        })
    }

    fn is_key(&self, c: &ColumnRef) -> bool {
        c.schema.as_ref().is_some_and(|s| self.keys.contains(&(s.clone(), c.table.clone(), c.column.clone())))
    }
}

// ---------------------------------------------------------------------------------------------
// pg_stat_statements
// ---------------------------------------------------------------------------------------------

struct StatementRow {
    query_id: Option<i64>,
    calls: i64,
    mean_ms: Option<f64>,
    text: String,
}

enum Statements {
    Rows(Vec<StatementRow>),
    Unavailable(String),
}

fn parse_version(v: &str) -> (u32, u32) {
    let mut it = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

async fn load_statements(client: &Client) -> Result<(Option<String>, Statements), AppError> {
    let ext = client
        .query_opt(
            "SELECT e.extversion::text, n.nspname::text FROM pg_extension e \
             JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'",
            &[],
        )
        .await?;
    let Some(ext) = ext else {
        return Ok((
            None,
            Statements::Unavailable(
                "pg_stat_statements is not installed in this database. Run `CREATE EXTENSION pg_stat_statements;` \
                 (the server must also list it in shared_preload_libraries)."
                    .into(),
            ),
        ));
    };
    let version: String = ext.try_get(0)?;
    let nsp: String = ext.try_get(1)?;
    let (major, minor) = parse_version(&version);
    let mean_col = if (major, minor) >= (1, 8) { "mean_exec_time" } else { "mean_time" };
    let toplevel = if (major, minor) >= (1, 9) { "AND toplevel" } else { "" };
    let sql = format!(
        r#"SELECT queryid::int8, calls::int8, {mean_col}::float8, query::text
           FROM "{nsp}".pg_stat_statements
           WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) {toplevel}
           ORDER BY calls DESC"#,
        nsp = nsp.replace('"', "\"\""),
    );
    match client.query(sql.as_str(), &[]).await {
        Ok(rows) => {
            let rows = rows
                .iter()
                .map(|r| {
                    Ok(StatementRow {
                        query_id: r.try_get(0)?,
                        calls: r.try_get::<_, Option<i64>>(1)?.unwrap_or(0),
                        mean_ms: r.try_get(2)?,
                        text: r.try_get::<_, Option<String>>(3)?.unwrap_or_default(),
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            Ok((Some(version), Statements::Rows(rows)))
        }
        Err(e) => {
            let reason = match e.as_db_error().map(|d| d.code().code()) {
                Some("55000") => "pg_stat_statements is installed but not loaded: add it to shared_preload_libraries \
                                  in postgresql.conf and restart PostgreSQL."
                    .to_string(),
                _ => AppError::Db(e).to_string(),
            };
            Ok((Some(version), Statements::Unavailable(reason)))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

struct DeclaredFk {
    name: String,
    child: (String, String),
    parent: (String, String),
    /// (child column, parent column) pairs.
    pairs: Vec<(String, String)>,
}

impl DeclaredFk {
    fn from_ref(r: &Ref) -> Option<Self> {
        let [child, parent] = &r.endpoints[..] else { return None };
        Some(DeclaredFk {
            name: r.name.clone(),
            child: (child.schema_name.clone(), child.table_name.clone()),
            parent: (parent.schema_name.clone(), parent.table_name.clone()),
            pairs: child.field_names.iter().cloned().zip(parent.field_names.iter().cloned()).collect(),
        })
    }

    fn endpoints(&self) -> (Endpoint, Endpoint) {
        (
            Endpoint {
                schema: self.child.0.clone(),
                table: self.child.1.clone(),
                columns: self.pairs.iter().map(|p| p.0.clone()).collect(),
            },
            Endpoint {
                schema: self.parent.0.clone(),
                table: self.parent.1.clone(),
                columns: self.pairs.iter().map(|p| p.1.clone()).collect(),
            },
        )
    }

    /// The joined column pairs are a subset of this FK's pairs (either orientation when undirected).
    fn covers(&self, child: &(String, String), parent: &(String, String), pairs: &[(String, String)], directed: bool) -> bool {
        let same = |c: &(String, String), p: &(String, String), ps: &[(String, String)]| {
            &self.child == c && &self.parent == p && ps.iter().all(|x| self.pairs.contains(x))
        };
        if same(child, parent, pairs) {
            return true;
        }
        if !directed {
            let swapped: Vec<(String, String)> = pairs.iter().map(|(a, b)| (b.clone(), a.clone())).collect();
            return same(parent, child, &swapped);
        }
        false
    }
}

#[derive(Default)]
struct Aggregate {
    calls: i64,
    statements: i64,
    queries: Vec<QueryEvidence>,
}

fn compact(text: &str, max_chars: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        let mut s: String = collapsed.chars().take(max_chars).collect();
        s.push('…');
        s
    }
}

pub async fn analyze(client: &Client, schemas: &[String]) -> Result<WorkloadReport, AppError> {
    let schemas: Vec<String> = schemas.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let (universe, refs, (extension_version, statements), facts_rows, stats_rows, indexes, stats_reset) = tokio::try_join!(
        Universe::load(client, &schemas),
        generate_raw_refs(client, &schemas),
        load_statements(client),
        load_table_facts(client, &schemas),
        load_column_stats(client, &schemas),
        advisor::load_indexes(client, &schemas),
        advisor::stats_reset(client),
    )?;
    let mut filter_calls: BTreeMap<(String, String, String), i64> = BTreeMap::new();

    let declared: Vec<DeclaredFk> = refs.iter().filter_map(DeclaredFk::from_ref).collect();
    let mut fk_calls: Vec<i64> = vec![0; declared.len()];
    let mut discovered: BTreeMap<(Endpoint, Endpoint, bool), Aggregate> = BTreeMap::new();
    let mut stats = StatementStats::default();
    let (available, reason, rows) = match statements {
        Statements::Rows(rows) => (true, None, rows),
        Statements::Unavailable(reason) => (false, Some(reason), Vec::new()),
    };

    for row in rows {
        stats.total += 1;
        if row.text.contains("<insufficient privilege>") {
            stats.redacted += 1;
            continue;
        }
        let has_column = |s: Option<&str>, t: &str, c: &str| universe.has_column(s, t, c);
        let usage = match analyze_sql(&row.text, &has_column) {
            Ok(u) => u,
            Err(_) => {
                stats.unparsed += 1;
                continue;
            }
        };
        stats.parsed += 1;
        let mut filtered: HashSet<(String, String, String)> = HashSet::new();
        for f in &usage.filters {
            if let Some(c) = universe.canonical(&f.column) {
                filtered.insert((c.schema.unwrap_or_default(), c.table, c.column));
            }
        }
        for key in filtered {
            *filter_calls.entry(key).or_default() += row.calls;
        }
        let predicates = usage.joins;

        // Group the statement's predicates by (child table, parent table) so composite joins
        // become one relation.
        let mut per_pair: BTreeMap<((String, String), (String, String), bool), Vec<(String, String)>> = BTreeMap::new();
        for p in predicates {
            let (Some(l), Some(r)) = (universe.canonical(&p.left), universe.canonical(&p.right)) else { continue };
            let o = orient(&JoinPredicate { left: l, right: r }, &|c| universe.is_key(c));
            let child = (o.child.schema.clone().unwrap_or_default(), o.child.table.clone());
            let parent = (o.parent.schema.clone().unwrap_or_default(), o.parent.table.clone());
            per_pair.entry((child, parent, o.directed)).or_default().push((o.child.column, o.parent.column));
        }

        let mut matched_fks: HashSet<usize> = HashSet::new();
        for ((child, parent, directed), mut pairs) in per_pair {
            pairs.sort();
            pairs.dedup();
            if let Some(i) = declared.iter().position(|fk| fk.covers(&child, &parent, &pairs, directed)) {
                if matched_fks.insert(i) {
                    fk_calls[i] += row.calls;
                }
                continue;
            }
            let from = Endpoint { schema: child.0, table: child.1, columns: pairs.iter().map(|p| p.0.clone()).collect() };
            let to = Endpoint { schema: parent.0, table: parent.1, columns: pairs.iter().map(|p| p.1.clone()).collect() };
            let agg = discovered.entry((from, to, directed)).or_default();
            agg.calls += row.calls;
            agg.statements += 1;
            agg.queries.push(QueryEvidence {
                query_id: row.query_id,
                calls: row.calls,
                mean_ms: row.mean_ms,
                text: compact(&row.text, 400),
            });
        }
    }

    let mut relations: Vec<DiscoveredRelation> = discovered
        .into_iter()
        .map(|((from, to, directed), mut agg)| {
            agg.queries.sort_by(|a, b| b.calls.cmp(&a.calls));
            agg.queries.truncate(5);
            DiscoveredRelation { from, to, directed, calls: agg.calls, statements: agg.statements, queries: agg.queries }
        })
        .collect();
    relations.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.from.cmp(&b.from)));

    let declared_usage = declared
        .iter()
        .zip(&fk_calls)
        .map(|(fk, calls)| {
            let (from, to) = fk.endpoints();
            FkUsage { name: fk.name.clone(), from, to, calls: *calls }
        })
        .collect();

    let rows_by_table: HashMap<(String, String), f64> =
        facts_rows.iter().map(|t| ((t.schema.clone(), t.table.clone()), t.rows)).collect();
    let cardinality = declared
        .iter()
        .filter(|fk| fk.pairs.len() == 1)
        .filter_map(|fk| {
            let (child_col, parent_col) = &fk.pairs[0];
            let (n_distinct, null_frac) = stats_rows.get(&(fk.child.0.clone(), fk.child.1.clone(), child_col.clone()))?;
            let child_rows = *rows_by_table.get(&fk.child)?;
            let parent_rows = *rows_by_table.get(&fk.parent)?;
            let c = de_facto_cardinality(child_rows, parent_rows, *n_distinct, *null_frac)?;
            Some(FkCardinality {
                schema: fk.child.0.clone(),
                table: fk.child.1.clone(),
                column: child_col.clone(),
                parent_schema: fk.parent.0.clone(),
                parent_table: fk.parent.1.clone(),
                parent_column: parent_col.clone(),
                children_per_parent: c.children_per_parent,
                parent_coverage: c.parent_coverage,
                child_null_frac: c.child_null_frac,
                verdict: c.verdict.to_string(),
            })
        })
        .collect();

    let mut fks: Vec<FkColumns> = declared
        .iter()
        .zip(&fk_calls)
        .map(|(fk, calls)| FkColumns {
            schema: fk.child.0.clone(),
            table: fk.child.1.clone(),
            columns: fk.pairs.iter().map(|p| p.0.clone()).collect(),
            parent: format!("{}.{}", fk.parent.0, fk.parent.1),
            calls: *calls,
            declared: true,
        })
        .collect();
    fks.extend(relations.iter().filter(|r| r.directed).map(|r| FkColumns {
        schema: r.from.schema.clone(),
        table: r.from.table.clone(),
        columns: r.from.columns.clone(),
        parent: format!("{}.{}", r.to.schema, r.to.table),
        calls: r.calls,
        declared: false,
    }));
    let table_stats: HashMap<(String, String), TableStats> = facts_rows
        .iter()
        .map(|t| ((t.schema.clone(), t.table.clone()), TableStats { rows: t.rows, seq_scan: t.seq_scan, idx_scan: t.idx_scan }))
        .collect();
    let index_advice = advisor::index_advice(&AdviceInput {
        indexes: &indexes,
        fks: &fks,
        filters: &filter_calls,
        tables: &table_stats,
        column_stats: &stats_rows,
        stats_reset: stats_reset.as_deref(),
    });

    Ok(WorkloadReport {
        available,
        reason,
        extension_version,
        statements: stats,
        relations,
        declared_usage,
        tables: facts_rows,
        cardinality,
        index_advice,
        stats_reset,
    })
}

async fn load_table_facts(client: &Client, schemas: &[String]) -> Result<Vec<TableFacts>, AppError> {
    let sql = format!(
        r#"
        SELECT s.schemaname::text, s.relname::text, c.reltuples::float8, s.n_live_tup::int8, s.n_dead_tup::int8,
               s.seq_scan::int8, COALESCE(s.idx_scan, 0)::int8, s.n_tup_ins::int8, s.n_tup_upd::int8, s.n_tup_del::int8,
               s.last_autovacuum::text, s.last_autoanalyze::text
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
        WHERE {filter}
        ORDER BY s.schemaname, s.relname
        "#,
        filter = schema_filter("s.schemaname"),
    );
    let rows = client.query(sql.as_str(), &[&schemas]).await?;
    rows.iter()
        .map(|r| {
            let reltuples: f64 = r.try_get(2)?;
            let live: i64 = r.try_get(3)?;
            let dead: i64 = r.try_get(4)?;
            let seq_scan: i64 = r.try_get(5)?;
            let idx_scan: i64 = r.try_get(6)?;
            let inserts: i64 = r.try_get(7)?;
            let updates: i64 = r.try_get(8)?;
            let deletes: i64 = r.try_get(9)?;
            let rows = if reltuples >= 0.0 { reltuples } else { live as f64 };
            Ok(TableFacts {
                schema: r.try_get(0)?,
                table: r.try_get(1)?,
                rows,
                dead_ratio: if live + dead > 0 { dead as f64 / (live + dead) as f64 } else { 0.0 },
                seq_scan,
                idx_scan,
                inserts,
                updates,
                deletes,
                last_autovacuum: r.try_get(10)?,
                last_autoanalyze: r.try_get(11)?,
                // One sequential scan is tolerated: building an index counts as a scan of the table.
                never_used: inserts + updates + deletes == 0 && idx_scan == 0 && seq_scan <= 1,
                seq_scan_heavy: seq_scan > idx_scan && rows > 10_000.0,
            })
        })
        .collect()
}

type ColumnStats = HashMap<(String, String, String), (f64, f64)>;

async fn load_column_stats(client: &Client, schemas: &[String]) -> Result<ColumnStats, AppError> {
    let sql = format!(
        "SELECT schemaname::text, tablename::text, attname::text, n_distinct::float8, null_frac::float8 \
         FROM pg_stats WHERE {filter}",
        filter = schema_filter("schemaname"),
    );
    let rows = client.query(sql.as_str(), &[&schemas]).await?;
    rows.iter()
        .map(|r| Ok(((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?), (r.try_get(3)?, r.try_get(4)?))))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Live counters
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TableCounters {
    pub id: String,
    pub rows: f64,
    pub n_live_tup: i64,
    pub n_dead_tup: i64,
    pub seq_scan: i64,
    pub idx_scan: i64,
    pub tuples_read: i64,
    pub tuples_written: i64,
}

pub async fn sample_tables(client: &Client, schemas: &[String]) -> Result<Vec<TableCounters>, AppError> {
    let sql = format!(
        r#"
        SELECT s.schemaname::text, s.relname::text, c.reltuples::float8, s.n_live_tup::int8, s.n_dead_tup::int8,
               s.seq_scan::int8, COALESCE(s.idx_scan, 0)::int8,
               (s.seq_tup_read + COALESCE(s.idx_tup_fetch, 0))::int8,
               (s.n_tup_ins + s.n_tup_upd + s.n_tup_del)::int8
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
        WHERE {filter}
        "#,
        filter = schema_filter("s.schemaname"),
    );
    let rows = client.query(sql.as_str(), &[&schemas]).await?;
    rows.iter()
        .map(|r| {
            let schema: String = r.try_get(0)?;
            let table: String = r.try_get(1)?;
            let reltuples: f64 = r.try_get(2)?;
            let n_live_tup: i64 = r.try_get(3)?;
            Ok(TableCounters {
                id: format!("{schema}.{table}"),
                rows: if reltuples >= 0.0 { reltuples } else { n_live_tup as f64 },
                n_live_tup,
                n_dead_tup: r.try_get(4)?,
                seq_scan: r.try_get(5)?,
                idx_scan: r.try_get(6)?,
                tuples_read: r.try_get(7)?,
                tuples_written: r.try_get(8)?,
            })
        })
        .collect()
}
