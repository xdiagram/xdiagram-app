//! Engine dispatch for the commands every engine supports: test, list schemas, introspect, browse.

use std::time::Instant;

use super::browse::{
    finish_count, finish_export, finish_page, pg_fetch_text, pg_row_estimate, pg_table_columns, plan_count, plan_export, plan_page, plan_sql_text, BrowseColumn, BrowseRequest,
    BrowseResult, CountRequest, ExportRequest, ExportResult,
    CountResult,
};
use super::catalog::{Catalog, TableInfo, TableMeta};
use super::run::{run, Ran, Stmt};
use super::values::{finish_values, plan_values, ValuesRequest, ValuesResult};
use super::profile::{profile_columns, sample_sql, ProfileRequest, TableProfile, DEFAULT_SAMPLE, MAX_SAMPLE};
use super::query::{self, JoinRequest, Mode};
use super::sql::Dialect;
use super::browse::{cap_rows_at, MAX_LIMIT};
use super::related::{self, LookupResult, RelatedRequest, RelatedResult, Step, MAX_LOOKUPS};
use std::collections::HashMap;
use super::connect::{ConnectionInput, Engine};
use super::types::{CheckConstraint, DatabaseSchema};
use super::{connect, introspect, mssql, mysql, sqlite};
use crate::error::AppError;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
    let op = crate::ops::current();
    tokio::task::spawn_blocking(move || crate::ops::with_op(op, f)).await.map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Statement time limit for a request (seconds), within sane bounds.
fn limit(requested: Option<u32>, default: u32) -> u32 {
    requested.unwrap_or(default).clamp(1, 600)
}

/// Connects and returns a server version string.
pub async fn test_connection(input: &ConnectionInput) -> Result<String, AppError> {
    match input.engine {
        Engine::Postgres => {
            let client = connect(input).await?;
            let row = client.query_one("SELECT current_setting('server_version')", &[]).await?;
            Ok(row.get::<_, String>(0))
        }
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let v = mysql::version(&mut conn).await?;
            let _ = conn.disconnect().await;
            Ok(v)
        }
        Engine::Mssql => {
            let mut client = mssql::connect(input).await?;
            mssql::version(&mut client).await
        }
        Engine::Sqlite => {
            let input = input.clone();
            blocking(move || sqlite::version(&sqlite::open(&input)?)).await
        }
    }
}

pub async fn list_schemas(input: &ConnectionInput) -> Result<Vec<String>, AppError> {
    match input.engine {
        Engine::Postgres => introspect::list_schemas(&connect(input).await?).await,
        // A MySQL schema is the database; introspection covers the connection's database.
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let db = mysql::current_database(&mut conn).await?;
            let _ = conn.disconnect().await;
            Ok(vec![db])
        }
        Engine::Mssql => mssql::list_schemas(&mut mssql::connect(input).await?).await,
        Engine::Sqlite => Ok(vec!["main".into()]),
    }
}

/// Schema JSON for any engine. Foreign keys pointing at tables outside the selected schemas are
/// dropped (`generateDbml` rejects them), whichever engine produced them.
pub async fn introspect(input: &ConnectionInput, schemas: &[String]) -> Result<DatabaseSchema, AppError> {
    Ok(finish(introspect_raw(input, schemas).await?))
}

/// The post-processing every schema gets before it reaches `generateDbml`.
fn finish(mut schema: DatabaseSchema) -> DatabaseSchema {
    let refs = std::mem::take(&mut schema.refs);
    schema.refs = introspect::prune_dangling_refs(refs, &schema.tables);
    sanitize_expressions(&mut schema);
    schema
}

/// Schema JSON of a SQLite DDL script (`@dbml/core` has no SQLite importer).
pub async fn import_sqlite_ddl(sql: String) -> Result<sqlite::DdlImport, AppError> {
    let mut result = blocking(move || sqlite::import_ddl(&sql)).await?;
    result.schema = finish(result.schema);
    Ok(result)
}

/// DBML writes expressions between backticks and has no escape for a backtick inside one, so
/// MySQL/SQLite identifier quoting (`name`) would end the expression early. Rewrites those
/// identifiers as plain names (or "double quoted" when they are not simple identifiers).
pub fn dbml_safe_expr(expr: &str) -> String {
    if !expr.contains('`') {
        return expr.to_string();
    }
    let chars: Vec<char> = expr.chars().collect();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut name = String::new();
        let mut j = i + 1;
        while j < chars.len() {
            if chars[j] == '`' {
                if chars.get(j + 1) == Some(&'`') {
                    name.push('`');
                    j += 2;
                    continue;
                }
                break;
            }
            name.push(chars[j]);
            j += 1;
        }
        let simple = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
        if simple {
            out.push_str(&name);
        } else {
            out.push('"');
            out.push_str(&name.replace('`', "").replace('"', "\"\""));
            out.push('"');
        }
        i = j + 1;
    }
    out
}

fn sanitize_expressions(schema: &mut DatabaseSchema) {
    let fix_checks = |checks: &mut Vec<CheckConstraint>| {
        for c in checks {
            c.expression = dbml_safe_expr(&c.expression);
        }
    };
    schema.checks.values_mut().for_each(fix_checks);
    for cols in schema.table_constraints.values_mut() {
        for c in cols.values_mut() {
            fix_checks(&mut c.checks);
        }
    }
    for f in schema.fields.values_mut().flatten() {
        if let Some(d) = f.dbdefault.as_mut().filter(|d| d.kind == "expression") {
            d.value = dbml_safe_expr(&d.value);
        }
    }
    for col in schema.indexes.values_mut().flatten().flat_map(|i| i.columns.iter_mut()) {
        if col.kind == "expression" {
            col.value = dbml_safe_expr(&col.value);
        }
    }
}

async fn introspect_raw(input: &ConnectionInput, schemas: &[String]) -> Result<DatabaseSchema, AppError> {
    match input.engine {
        Engine::Postgres => introspect::fetch_schema_json(&connect(input).await?, schemas).await,
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let schema = mysql::fetch_schema_json(&mut conn).await;
            let _ = conn.disconnect().await;
            schema
        }
        Engine::Mssql => mssql::fetch_schema_json(&mut mssql::connect(input).await?, schemas).await,
        Engine::Sqlite => {
            let input = input.clone();
            blocking(move || sqlite::fetch_schema_json(&sqlite::open(&input)?)).await
        }
    }
}

/// How many rows match a browse request's filter, up to a cap and within the time limit.
pub async fn count_rows(input: &ConnectionInput, request: CountRequest) -> Result<CountResult, AppError> {
    let started = Instant::now();
    let tables = vec![(request.request.schema.clone(), request.request.table.clone())];
    let req = request.clone();
    run(input, tables, move |d, cat| Ok(vec![plan_count(d, cat, &req)?]), move |_, _, ran| finish_count(&request, ran, started)).await
}

/// The rows a browse request's filter matches, from the first, whole values: for an export.
pub async fn export_rows(input: &ConnectionInput, request: ExportRequest) -> Result<ExportResult, AppError> {
    let started = Instant::now();
    let tables = vec![(request.request.schema.clone(), request.request.table.clone())];
    let req = request.clone();
    run(input, tables, move |d, cat| Ok(vec![plan_export(d, cat, &req)?]), move |_, cat, ran| finish_export(cat, &request, ran, started)).await
}

/// The rows a browse request shows, as SQL text with the values written in (nothing is run).
pub async fn filter_sql(input: &ConnectionInput, request: BrowseRequest) -> Result<String, AppError> {
    let tables = vec![(request.schema.clone(), request.table.clone())];
    run(input, tables, |_, _| Ok(Vec::new()), move |d, cat, _| plan_sql_text(d, cat, &request)).await
}

/// A table's columns (with kinds), primary key and size estimate; no rows are read.
pub async fn describe_table(input: &ConnectionInput, schema: String, table: String) -> Result<TableInfo, AppError> {
    let key = (schema.clone(), table.clone());
    run(input, vec![(schema, table)], |_, _| Ok(Vec::new()), move |_, cat, _| cat.get(&key).map(TableInfo::from).ok_or_else(|| not_found(&key.0, &key.1))).await
}

/// A column's values with their counts among the matching rows (the value picker).
pub async fn value_counts(input: &ConnectionInput, request: ValuesRequest) -> Result<ValuesResult, AppError> {
    let started = Instant::now();
    let tables = vec![(request.schema.clone(), request.table.clone())];
    let req = request.clone();
    run(input, tables, move |d, cat| plan_values(d, cat, &req), move |_, _, ran| finish_values(&request, ran, started)).await
}

/// One page of a table's rows, filtered and sorted (see `browse.rs`), on any engine.
pub async fn browse(input: &ConnectionInput, request: BrowseRequest) -> Result<BrowseResult, AppError> {
    let started = Instant::now();
    let tables = vec![(request.schema.clone(), request.table.clone())];
    let req = request.clone();
    run(input, tables, move |d, cat| Ok(vec![plan_page(d, cat, &req)?]), move |d, cat, ran| finish_page(d, cat, &request, ran, started)).await
}

fn not_found(schema: &str, table: &str) -> AppError {
    AppError::Invalid(format!("Table {} not found", if schema.is_empty() { table.to_string() } else { format!("{schema}.{table}") }))
}

/// Select list returning every column as text.
fn text_select(d: Dialect, columns: &[BrowseColumn]) -> String {
    columns.iter().map(|c| d.select_text(&d.quote(&c.name), &c.type_name)).collect::<Vec<_>>().join(", ")
}

/// Profiles a bounded sample of one table (see `profile.rs`). Read-only on every engine.
pub async fn profile_table(input: &ConnectionInput, req: ProfileRequest) -> Result<TableProfile, AppError> {
    let started = Instant::now();
    let n = req.sample_rows.unwrap_or(DEFAULT_SAMPLE).clamp(100, MAX_SAMPLE);
    let d = Dialect::from(input.engine);
    let (columns, estimate, rows, method) = match input.engine {
        Engine::Postgres => {
            let mut client = connect(input).await?;
            let columns = pg_table_columns(&client, &req.schema, &req.table).await?;
            if columns.is_empty() {
                return Err(not_found(&req.schema, &req.table));
            }
            let estimate = pg_row_estimate(&client, &req.schema, &req.table).await?;
            let (sql, method) = sample_sql(d, &text_select(d, &columns), &d.qualified(&req.schema, &req.table), estimate, n);
            let rows = pg_fetch_text(&mut client, &sql, &[], limit(req.timeout_secs, 20)).await?;
            (columns, estimate, rows, method)
        }
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let result = async {
                let db = mysql::resolve_db(&mut conn, &req.schema).await?;
                let columns = mysql::table_columns(&mut conn, &db, &req.table).await?;
                if columns.is_empty() {
                    return Err(not_found(&db, &req.table));
                }
                let estimate = mysql::row_estimate(&mut conn, &db, &req.table).await?;
                let (sql, method) = sample_sql(d, &text_select(d, &columns), &d.qualified(&db, &req.table), estimate, n);
                let rows = mysql::fetch_text(&mut conn, &sql, &[], limit(req.timeout_secs, 20) * 1000).await?;
                Ok((columns, estimate, rows, method))
            }
            .await;
            let _ = conn.disconnect().await;
            result?
        }
        Engine::Mssql => {
            let mut client = mssql::connect(input).await?;
            let schema = mssql::resolve_schema(&req.schema);
            let columns = mssql::table_columns(&mut client, &schema, &req.table).await?;
            if columns.is_empty() {
                return Err(not_found(&schema, &req.table));
            }
            let estimate = mssql::row_estimate(&mut client, &schema, &req.table).await?;
            let (sql, method) = sample_sql(d, &text_select(d, &columns), &d.qualified(&schema, &req.table), estimate, n);
            let rows = mssql::fetch_text(&mut client, &sql, &[], limit(req.timeout_secs, 20) as u64).await?;
            (columns, estimate, rows, method)
        }
        Engine::Sqlite => {
            let input = input.clone();
            let table = req.table.clone();
            blocking(move || {
                let conn = sqlite::open(&input)?;
                let columns = sqlite::table_columns(&conn, &table)?;
                if columns.is_empty() {
                    return Err(not_found("", &table));
                }
                let estimate = sqlite::row_estimate(&conn, &table);
                let (sql, method) = sample_sql(d, &text_select(d, &columns), &d.qualified("", &table), estimate, n);
                let rows = sqlite::fetch_text(&conn, &sql, &[])?;
                Ok((columns, estimate, rows, method))
            })
            .await?
        }
    };
    let sample_size = rows.len() as u32;
    Ok(TableProfile {
        schema: req.schema,
        table: req.table,
        row_estimate: estimate.max(sample_size as f64),
        sample_size,
        sampled: sample_size >= n || estimate > sample_size as f64 * 1.05,
        method,
        columns: profile_columns(&columns, &rows),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// The tables of a join query, by alias, from the catalog the runner loaded.
fn join_tables(cat: &Catalog, req: &JoinRequest) -> Result<HashMap<String, TableMeta>, AppError> {
    req.tables
        .iter()
        .map(|t| {
            let meta = cat.get(&(t.schema.clone(), t.table.clone())).ok_or_else(|| not_found(&t.schema, &t.table))?;
            Ok((t.alias.clone(), meta.clone()))
        })
        .collect()
}

/// Each table a join query names, once.
fn join_table_names(req: &JoinRequest) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for t in &req.tables {
        let key = (t.schema.clone(), t.table.clone());
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// The join query as readable SQL, values written in: the preview and Copy. Reads the tables'
/// columns (so conditions compare as they will when run); nothing else runs.
pub async fn join_sql(input: &ConnectionInput, req: JoinRequest) -> Result<String, AppError> {
    run(input, join_table_names(&req), |_, _| Ok(Vec::new()), move |d, cat, _| Ok(query::build(d, &req, &join_tables(cat, &req)?, Mode::Readable)?.0)).await
}

/// Runs the join query read-only and returns a page of its rows (columns named `alias.column`).
pub async fn browse_join(input: &ConnectionInput, req: JoinRequest) -> Result<BrowseResult, AppError> {
    let started = Instant::now();
    let plan_req = req.clone();
    run(
        input,
        join_table_names(&req),
        move |d, cat| {
            let (sql, params) = query::build(d, &plan_req, &join_tables(cat, &plan_req)?, Mode::Execute)?;
            Ok(vec![Stmt { sql, params, timeout_s: limit(plan_req.timeout_secs, 15), optional: false }])
        },
        move |_, cat, ran| {
            let tables = join_tables(cat, &req)?;
            let rows = match ran.into_iter().next() {
                Some(Ran::Rows(rows)) => rows,
                Some(Ran::Failed(e)) => return Err(e),
                _ => return Err(AppError::Invalid("The rows could not be read".into())),
            };
            let columns: Vec<BrowseColumn> = req
                .columns
                .iter()
                .map(|c| {
                    let source = tables.get(&c.alias).and_then(|t| t.column(&c.column));
                    BrowseColumn { name: format!("{}.{}", c.alias, c.column), ..source.cloned().unwrap_or_default() }
                })
                .collect();
            let (rows, has_more, truncated_at) = cap_rows_at(rows, req.limit.clamp(1, MAX_LIMIT) as usize);
            Ok(BrowseResult {
                columns,
                rows,
                has_more,
                row_estimate: 0.0,
                ordered_by: Vec::new(),
                sort: Vec::new(),
                stable_order: false,
                truncated_cells: truncated_at.len() as u32,
                truncated_at,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        },
    )
    .await
}

/// "Related data": a batch of key lookups on one connection, read-only. A lookup that fails
/// (unknown column, timeout, …) reports its error without failing the others.
pub async fn related_rows(input: &ConnectionInput, req: RelatedRequest) -> Result<RelatedResult, AppError> {
    if req.lookups.len() > MAX_LOOKUPS {
        return Err(AppError::Invalid(format!("At most {MAX_LOOKUPS} lookups at a time")));
    }
    let started = Instant::now();
    let d = Dialect::from(input.engine);
    let timeout = limit(req.timeout_secs, 15);
    let mut results = Vec::with_capacity(req.lookups.len());
    match input.engine {
        Engine::Postgres => {
            let mut client = connect(input).await?;
            let mut cache: HashMap<(String, String), Vec<BrowseColumn>> = HashMap::new();
            for l in &req.lookups {
                let key = (l.schema.clone(), l.table.clone());
                if !cache.contains_key(&key) {
                    cache.insert(key.clone(), pg_table_columns(&client, &l.schema, &l.table).await?);
                }
                let columns = &cache[&key];
                let label = format!("{}.{}", l.schema, l.table);
                results.push(match related::step(d, &d.qualified(&l.schema, &l.table), &label, columns, l) {
                    Step::Done(r) => r,
                    Step::Run(p) => match pg_fetch_text(&mut client, &p.sql, &p.params, timeout).await {
                        Ok(rows) => related::finish(columns, rows, l.limit),
                        // Data exception (a value that is not valid for the column's type): no match.
                        Err(AppError::Db(e)) if e.code().is_some_and(|c| c.code().starts_with("22")) => related::finish(columns, Vec::new(), l.limit),
                        Err(e) => LookupResult::failed(e.to_string()),
                    },
                });
            }
        }
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let outcome = async {
                let mut dbs: HashMap<String, String> = HashMap::new();
                let mut cache: HashMap<(String, String), Vec<BrowseColumn>> = HashMap::new();
                for l in &req.lookups {
                    if !dbs.contains_key(&l.schema) {
                        let db = mysql::resolve_db(&mut conn, &l.schema).await?;
                        dbs.insert(l.schema.clone(), db);
                    }
                    let db = dbs[&l.schema].clone();
                    let key = (db.clone(), l.table.clone());
                    if !cache.contains_key(&key) {
                        cache.insert(key.clone(), mysql::table_columns(&mut conn, &db, &l.table).await?);
                    }
                    let columns = &cache[&key];
                    let label = format!("{db}.{}", l.table);
                    results.push(match related::step(d, &d.qualified(&db, &l.table), &label, columns, l) {
                        Step::Done(r) => r,
                        Step::Run(p) => match mysql::fetch_text(&mut conn, &p.sql, &p.params, timeout * 1000).await {
                            Ok(rows) => related::finish(columns, rows, l.limit),
                            Err(e) => LookupResult::failed(e.to_string()),
                        },
                    });
                }
                Ok::<_, AppError>(())
            }
            .await;
            let _ = conn.disconnect().await;
            outcome?;
        }
        Engine::Mssql => {
            let mut client = mssql::connect(input).await?;
            let mut cache: HashMap<(String, String), Vec<BrowseColumn>> = HashMap::new();
            let mut timed_out = false;
            for l in &req.lookups {
                if timed_out {
                    // The connection is mid-response after a timeout; it cannot run more queries.
                    results.push(LookupResult::failed("Skipped after a timeout"));
                    continue;
                }
                let schema = mssql::resolve_schema(&l.schema);
                let key = (schema.clone(), l.table.clone());
                if !cache.contains_key(&key) {
                    cache.insert(key.clone(), mssql::table_columns(&mut client, &schema, &l.table).await?);
                }
                let columns = &cache[&key];
                let label = format!("{schema}.{}", l.table);
                results.push(match related::step(d, &d.qualified(&schema, &l.table), &label, columns, l) {
                    Step::Done(r) => r,
                    Step::Run(p) => match mssql::fetch_text(&mut client, &p.sql, &p.params, timeout as u64).await {
                        Ok(rows) => related::finish(columns, rows, l.limit),
                        Err(e) => {
                            timed_out = e.to_string().contains("took longer than");
                            LookupResult::failed(e.to_string())
                        }
                    },
                });
            }
        }
        Engine::Sqlite => {
            let input = input.clone();
            results = blocking(move || {
                let conn = sqlite::open(&input)?;
                let mut cache: HashMap<String, Vec<BrowseColumn>> = HashMap::new();
                let mut out = Vec::with_capacity(req.lookups.len());
                for l in &req.lookups {
                    if !cache.contains_key(&l.table) {
                        cache.insert(l.table.clone(), sqlite::table_columns(&conn, &l.table)?);
                    }
                    let columns = &cache[&l.table];
                    out.push(match related::step(d, &d.qualified("", &l.table), &l.table, columns, l) {
                        Step::Done(r) => r,
                        Step::Run(p) => match sqlite::fetch_text(&conn, &p.sql, &p.params) {
                            Ok(rows) => related::finish(columns, rows, l.limit),
                            // Cancelled: the interrupt stops this statement; stop the batch too.
                            Err(e) if e.to_string().contains("interrupt") => return Err(AppError::Cancelled),
                            Err(e) => LookupResult::failed(e.to_string()),
                        },
                    });
                }
                Ok(out)
            })
            .await?;
        }
    }
    Ok(RelatedResult { results, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// X-ray reads PostgreSQL's statistics views; other engines have no equivalent wired up yet.
pub fn require_postgres(input: &ConnectionInput) -> Result<(), AppError> {
    if input.engine == Engine::Postgres {
        Ok(())
    } else {
        Err(AppError::Invalid("X-ray works with PostgreSQL connections only".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::dbml_safe_expr;

    #[test]
    fn backtick_identifiers_become_dbml_safe() {
        assert_eq!(dbml_safe_expr("(`ends_on` is null) or (`ends_on` >= `starts_on`)"), "(ends_on is null) or (ends_on >= starts_on)");
        assert_eq!(dbml_safe_expr("`login count` >= 0"), "\"login count\" >= 0");
        assert_eq!(dbml_safe_expr("`we``ird` > 0"), "\"weird\" > 0");
        assert_eq!(dbml_safe_expr("price > 0"), "price > 0");
    }
}
