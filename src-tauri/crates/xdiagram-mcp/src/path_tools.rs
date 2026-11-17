//! How tables connect: join paths over the declared relationships (and, on PostgreSQL, the joins
//! X-ray finds in the query statistics), the X-ray report itself, and the check of a relationship
//! the database does not declare.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use join_paths::{ColumnPair, Dialect, Edge, EdgeKind, Multiplicity, PathOpts, PathOutcome, SchemaGraph, TableNode, aliases, find_join_paths, path_sql};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xdiagram_core::db::advisor::{self, EndpointInput, RelationCheckRequest};
use xdiagram_core::db::workload_db::{self, WorkloadReport};
use xdiagram_core::db::{self, DatabaseSchema, Engine, dispatch};
use xdiagram_core::dbml::table_key;

use crate::access::{Conn, run_op};
use crate::mask;
use crate::schema_tools::{TableRef, resolve_table, tables_of};
use crate::server::{CATALOG_BUDGET, ToolResult, XdiagramServer, json_text, text};

const XRAY_TTL: Duration = Duration::from_secs(300);
/// Example queries kept per discovered relationship, and their length.
const EXAMPLE_QUERIES: usize = 2;
const EXAMPLE_CHARS: usize = 300;

/// X-ray reports, reused for a few minutes like schemas (reading pg_stat_statements is slow).
#[derive(Default)]
pub struct XrayCache {
    entries: Mutex<HashMap<String, (Instant, Arc<WorkloadReport>)>>,
}

impl XrayCache {
    async fn get(&self, conn: &Conn, refresh: bool, ct: &CancellationToken) -> Result<Arc<WorkloadReport>, String> {
        if conn.profile.engine != Engine::Postgres {
            return Err(format!("X-ray reads PostgreSQL's query statistics; \"{}\" is not a PostgreSQL connection.", conn.name()));
        }
        let key = format!("{}|{}", conn.profile.id, conn.schemas().join(","));
        if !refresh
            && let Ok(entries) = self.entries.lock()
            && let Some((at, report)) = entries.get(&key)
            && at.elapsed() < XRAY_TTL
        {
            return Ok(report.clone());
        }
        let input = conn.input.clone();
        let schemas = conn.schemas().to_vec();
        let report = run_op(ct, CATALOG_BUDGET, async move {
            dispatch::require_postgres(&input)?;
            let client = db::connect(&input).await?;
            workload_db::analyze(&client, &schemas).await
        })
        .await
        .map_err(|e| conn.explain(e))?;
        let report = Arc::new(report);
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key, (Instant::now(), report.clone()));
        }
        Ok(report)
    }
}

fn dialect(engine: Engine) -> Dialect {
    match engine {
        Engine::Postgres => Dialect::Postgres,
        Engine::Mysql => Dialect::Mysql,
        Engine::Mssql => Dialect::Mssql,
        Engine::Sqlite => Dialect::Sqlite,
    }
}

fn endpoint_key(schema: &str, table: &str, columns: &[String]) -> String {
    format!("{}({})", table_key(schema, table), columns.join(","))
}

/// The join-path graph of a schema (`buildJoinGraph` in the app): its tables, a declared edge per
/// foreign key, and with an X-ray report, the joins seen in queries that no foreign key backs.
pub fn join_graph(schema: &DatabaseSchema, report: Option<&WorkloadReport>) -> SchemaGraph {
    let tables: Vec<TableNode> = tables_of(schema)
        .into_iter()
        .map(|t| TableNode { id: t.key(), schema: if t.schema.is_empty() { "public".into() } else { t.schema.clone() }, name: t.table })
        .collect();
    let columns: HashMap<String, HashSet<String>> =
        schema.fields.iter().map(|(k, fields)| (k.clone(), fields.iter().map(|f| f.name.clone()).collect())).collect();
    let mut calls: HashMap<String, u64> = HashMap::new();
    for u in report.map(|r| r.declared_usage.as_slice()).unwrap_or_default() {
        let key = format!("{}->{}", endpoint_key(&u.from.schema, &u.from.table, &u.from.columns), endpoint_key(&u.to.schema, &u.to.table, &u.to.columns));
        *calls.entry(key).or_default() += u.calls.max(0) as u64;
    }

    let mut edges: Vec<Edge> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in &schema.refs {
        let [a, b] = r.endpoints.as_slice() else { continue };
        let (fk, target) = if b.relation.contains('*') && !a.relation.contains('*') { (b, a) } else { (a, b) };
        if fk.field_names.is_empty() || fk.field_names.len() != target.field_names.len() {
            continue;
        }
        let id = format!("{}->{}", endpoint_key(&fk.schema_name, &fk.table_name, &fk.field_names), endpoint_key(&target.schema_name, &target.table_name, &target.field_names));
        if !seen.insert(id.clone()) {
            continue;
        }
        let mult = |rel: &str| if rel.contains('*') { Multiplicity::Many } else { Multiplicity::One };
        edges.push(Edge {
            from: table_key(&fk.schema_name, &fk.table_name),
            to: table_key(&target.schema_name, &target.table_name),
            pairs: fk.field_names.iter().zip(&target.field_names).map(|(f, t)| ColumnPair { from: f.clone(), to: t.clone() }).collect(),
            kind: EdgeKind::Declared,
            from_mult: mult(&fk.relation),
            to_mult: mult(&target.relation),
            calls: calls.get(&id).copied().unwrap_or(0),
            id,
        });
    }
    for rel in report.map(|r| r.relations.as_slice()).unwrap_or_default() {
        let (from, to) = (table_key(&rel.from.schema, &rel.from.table), table_key(&rel.to.schema, &rel.to.table));
        let has = |key: &str, cols: &[String]| columns.get(key).is_some_and(|set| cols.iter().all(|c| set.contains(c)));
        if rel.from.columns.is_empty() || rel.from.columns.len() != rel.to.columns.len() || !has(&from, &rel.from.columns) || !has(&to, &rel.to.columns) {
            continue;
        }
        let declared = format!("{}->{}", endpoint_key(&rel.from.schema, &rel.from.table, &rel.from.columns), endpoint_key(&rel.to.schema, &rel.to.table, &rel.to.columns));
        if seen.contains(&declared) {
            continue;
        }
        edges.push(Edge {
            id: format!("discovered:{declared}"),
            pairs: rel.from.columns.iter().zip(&rel.to.columns).map(|(f, t)| ColumnPair { from: f.clone(), to: t.clone() }).collect(),
            kind: EdgeKind::Discovered,
            from_mult: if rel.directed { Multiplicity::Many } else { Multiplicity::Unknown },
            to_mult: if rel.directed { Multiplicity::One } else { Multiplicity::Unknown },
            calls: rel.calls.max(0) as u64,
            from,
            to,
        });
    }
    SchemaGraph { tables, edges }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PathArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The start table (`schema.table`, or the table name when it is unique).
    pub from: String,
    /// The end table.
    pub to: String,
    /// How many routes to return (default 3, at most 10).
    #[serde(default)]
    pub max_paths: Option<usize>,
    /// Most joins in a route (default 6, at most 10).
    #[serde(default)]
    pub max_hops: Option<usize>,
    /// Tables no route may go through.
    #[serde(default)]
    pub avoid: Vec<String>,
    /// PostgreSQL: also use the joins X-ray finds in the query statistics (slower the first time).
    #[serde(default)]
    pub use_xray: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct XrayArgs {
    /// The saved connection (PostgreSQL): its name as list_connections shows it, or its id.
    pub connection: String,
    /// Read the statistics again instead of using the report made in the last 5 minutes.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckArgs {
    /// The saved connection (PostgreSQL): its name as list_connections shows it, or its id.
    pub connection: String,
    /// The referencing table (`schema.table`, or the table name when it is unique).
    pub child_table: String,
    pub child_columns: Vec<String>,
    /// The referenced table.
    pub parent_table: String,
    pub parent_columns: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathOut {
    tables: Vec<String>,
    hops: usize,
    steps: Vec<StepOut>,
    /// Ready for run_join_query (`tables` and `joins`).
    query: serde_json::Value,
    sql: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepOut {
    left: String,
    right: String,
    /// `[left column, right column]` pairs.
    on: Vec<(String, String)>,
    kind: EdgeKind,
    /// One or many rows on each side.
    cardinality: String,
    #[serde(skip_serializing_if = "is_zero")]
    calls: u64,
    /// Other relationships between the same two tables.
    #[serde(skip_serializing_if = "is_zero")]
    alternatives: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

fn mult_text(m: Multiplicity) -> &'static str {
    match m {
        Multiplicity::One => "1",
        Multiplicity::Many => "N",
        Multiplicity::Unknown => "?",
    }
}

fn clip(text: &str, n: usize) -> String {
    if text.chars().count() <= n { text.to_string() } else { format!("{}…", text.chars().take(n).collect::<String>()) }
}

#[tool_router(router = path_router, vis = "pub(crate)")]
impl XdiagramServer {
    #[tool(
        name = "find_join_paths",
        description = "The best ways to join two tables: chains of relationships, cheapest first (fewer joins, many-to-one before one-to-many, joins used in queries before unused ones). Each route comes with its join columns, the SELECT skeleton in the connection's SQL dialect, and `query`, ready for run_join_query.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn find_join_paths(&self, Parameters(args): Parameters<PathArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let schema = self.cache.get(&conn, false, &ct).await?;
        let report = if args.use_xray { Some(self.xray.get(&conn, false, &ct).await?) } else { None };
        let graph = join_graph(&schema, report.as_deref().filter(|r| r.available));
        let from = resolve_table(&schema, &args.from)?.key();
        let to = resolve_table(&schema, &args.to)?.key();
        let avoid = args.avoid.iter().map(|t| resolve_table(&schema, t).map(|r| r.key())).collect::<Result<Vec<_>, _>>()?;
        let defaults = PathOpts::default();
        let opts = PathOpts { max_paths: args.max_paths.unwrap_or(defaults.max_paths), max_hops: args.max_hops.unwrap_or(defaults.max_hops), avoid };
        match find_join_paths(&graph, &from, &to, &opts) {
            PathOutcome::Found { paths } => {
                let dialect = dialect(conn.profile.engine);
                let routes: Vec<PathOut> = paths
                    .iter()
                    .map(|p| {
                        let ids: Vec<&str> = p.tables.iter().map(String::as_str).collect();
                        let alias = aliases(&ids);
                        let steps: Vec<StepOut> = p
                            .steps
                            .iter()
                            .filter_map(|s| {
                                let v = s.variants.first()?;
                                Some(StepOut {
                                    left: s.left.clone(),
                                    right: s.right.clone(),
                                    on: v.on.iter().map(|c| (c.from.clone(), c.to.clone())).collect(),
                                    kind: v.kind,
                                    cardinality: format!("{}:{}", mult_text(v.left_mult), mult_text(v.right_mult)),
                                    calls: v.calls,
                                    alternatives: s.variants.len().saturating_sub(1) as u64,
                                })
                            })
                            .collect();
                        let query = json!({
                            "tables": p.tables.iter().zip(&alias).map(|(t, a)| json!({ "table": t, "alias": a })).collect::<Vec<_>>(),
                            "joins": steps.iter().enumerate().map(|(i, s)| json!({ "alias": alias[i + 1], "parent": alias[i], "on": s.on })).collect::<Vec<_>>(),
                        });
                        PathOut { tables: p.tables.clone(), hops: p.hops, sql: path_sql(p, &graph.tables, dialect, &[]), steps, query }
                    })
                    .collect();
                json_text(&json!({ "from": from, "to": to, "paths": routes }))
            }
            PathOutcome::NoPath { reason } => {
                let why = match reason {
                    join_paths::NoPathReason::NotConnected => "no chain of relationships links them".to_string(),
                    join_paths::NoPathReason::OnlyThroughAvoided => "they are linked only through the avoided tables".to_string(),
                    join_paths::NoPathReason::TooLong { hops } => format!("the shortest route needs {hops} joins (raise max_hops)"),
                    join_paths::NoPathReason::NoSelfReference => "the table does not reference itself".to_string(),
                };
                let hint = if args.use_xray || conn.profile.engine != Engine::Postgres { "" } else { " With use_xray, joins seen in queries count too." };
                text(format!("No join path from {from} to {to}: {why}.{hint}"))
            }
            PathOutcome::Invalid { error } => Err(match error {
                join_paths::InputError::UnknownTable(t) => format!("No table {t} in the join graph."),
                join_paths::InputError::EndpointAvoided(t) => format!("{t} is a start or end table, so it cannot be avoided."),
            }),
        }
    }

    #[tool(
        name = "xray_report",
        description = "PostgreSQL X-ray: what the database actually does, from pg_stat_statements and the table statistics. Joins seen in queries that no foreign key declares (with example queries), how often each foreign key is joined, index advice (unindexed foreign keys, filters without an index, unused and duplicate indexes, each with its SQL, never run), unused tables and one-to-one foreign keys.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn xray_report(&self, Parameters(args): Parameters<XrayArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let r = self.xray.get(&conn, args.refresh, &ct).await?;
        if !r.available {
            return text(format!("X-ray is not available on \"{}\": {}", conn.name(), r.reason.as_deref().unwrap_or("pg_stat_statements cannot be read")));
        }
        let ep = |e: &workload_db::Endpoint| endpoint_key(&e.schema, &e.table, &e.columns);
        let mut usage: Vec<_> = r.declared_usage.iter().collect();
        usage.sort_by_key(|u| std::cmp::Reverse(u.calls));
        let out = json!({
            "statsReset": r.stats_reset,
            "statements": r.statements,
            "undeclaredJoins": r.relations.iter().map(|rel| json!({
                "from": ep(&rel.from),
                "to": ep(&rel.to),
                "directed": rel.directed,
                "calls": rel.calls,
                "statements": rel.statements,
                "exampleQueries": rel.queries.iter().take(EXAMPLE_QUERIES).map(|q| clip(&q.text, EXAMPLE_CHARS)).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "foreignKeyJoins": usage.iter().map(|u| json!({ "name": u.name, "from": ep(&u.from), "to": ep(&u.to), "calls": u.calls })).collect::<Vec<_>>(),
            "indexAdvice": r.index_advice.iter().map(|a| json!({
                "kind": a.kind,
                "table": table_key(&a.schema, &a.table),
                "columns": a.columns,
                "index": a.index_name,
                "reason": a.reason,
                "impact": a.impact,
                "sql": a.sql,
            })).collect::<Vec<_>>(),
            "unusedTables": r.tables.iter().filter(|t| t.never_used).map(|t| table_key(&t.schema, &t.table)).collect::<Vec<_>>(),
            "seqScanHeavyTables": r.tables.iter().filter(|t| t.seq_scan_heavy).map(|t| json!({ "table": table_key(&t.schema, &t.table), "rows": t.rows, "seqScans": t.seq_scan, "indexScans": t.idx_scan })).collect::<Vec<_>>(),
            "oneToOneForeignKeys": r.cardinality.iter().filter(|c| c.verdict == "1:1").map(|c| format!("{}.{} -> {}.{}", table_key(&c.schema, &c.table), c.column, table_key(&c.parent_schema, &c.parent_table), c.parent_column)).collect::<Vec<_>>(),
        });
        json_text(&out)
    }

    #[tool(
        name = "check_relation",
        description = "PostgreSQL: whether a relationship the database does not declare (for example one xray_report found) holds in the data: rows whose key has no parent (orphans, with a few examples), NULL keys, whether the parent key is unique and the child columns indexed, and the ALTER TABLE that would declare it (never run). Reads rows, so not on schema-only connections.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn check_relation(&self, Parameters(args): Parameters<CheckArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        conn.require_rows()?;
        if conn.profile.engine != Engine::Postgres {
            return Err(format!("check_relation works on PostgreSQL connections; \"{}\" is not one.", conn.name()));
        }
        let schema = self.cache.get(&conn, false, &ct).await?;
        let (child, parent): (TableRef, TableRef) = (resolve_table(&schema, &args.child_table)?, resolve_table(&schema, &args.parent_table)?);
        conn.check_schema(&child.schema)?;
        conn.check_schema(&parent.schema)?;
        let request = RelationCheckRequest {
            child: EndpointInput { schema: child.db_schema(), table: child.table.clone(), columns: args.child_columns.clone() },
            parent: EndpointInput { schema: parent.db_schema(), table: parent.table.clone(), columns: args.parent_columns },
        };
        let input = conn.input.clone();
        let mut result = run_op(&ct, CATALOG_BUDGET, async move {
            let mut client = db::connect(&input).await?;
            advisor::check_relation(&mut client, &request).await
        })
        .await
        .map_err(|e| conn.explain(e))?;
        let access = conn.profile.mcp.data;
        let named = args.child_columns.iter().find_map(|c| mask::column_kind(c, &[]));
        for sample in result.orphan_samples.iter_mut() {
            match named {
                Some(kind) if access != xdiagram_core::profiles::DataAccess::Full => *sample = mask::masked(kind),
                _ => {
                    let mut v = Some(std::mem::take(sample));
                    mask::mask_value(access, &mut v);
                    *sample = v.unwrap_or_default();
                }
            }
        }
        json_text(&result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> DatabaseSchema {
        let json = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../xdiagram-core/tests/dbml/pg.json")).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn builds_the_graph_from_the_foreign_keys() {
        let g = join_graph(&schema(), None);
        assert_eq!(g.tables.len(), 5);
        assert_eq!(g.edges.len(), 5);
        let composite = g.edges.iter().find(|e| e.from == "sales.invoices" && e.to == "public.order_lines").unwrap();
        assert_eq!(composite.pairs.len(), 2);
        assert_eq!((composite.from_mult, composite.to_mult), (Multiplicity::Many, Multiplicity::One));
        let PathOutcome::Found { paths } = find_join_paths(&g, "public.users", "sales.invoices", &PathOpts::default()) else { panic!() };
        assert_eq!(paths[0].tables, ["public.users", "public.orders", "sales.invoices"]);
        let sql = path_sql(&paths[0], &g.tables, Dialect::Postgres, &[]);
        assert!(sql.contains("\"sales\".\"invoices\"") && sql.contains("JOIN"), "{sql}");
    }
}
