//! MySQL / MariaDB: port of `@dbml/connector`'s MySQL connector (connectors/mysql/index.ts),
//! plus read-only browsing. A MySQL "schema" is a database; like the connector, introspection
//! covers the connection's database, and the JSON carries no schema names.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts, Value};

use super::browse::{truncate_cell, BrowseColumn, BrowseRequest, BrowseResult, MAX_LIMIT};
use super::connect::{non_empty_field, resolve_password, ConnectionInput, SslMode};
use super::types::*;
use crate::error::AppError;

const NUMBER_REGEX: &str = "^-?[0-9]+(.[0-9]+)?$";

/// `via`: the real database host and the SSH tunnel's local port to dial instead.
fn opts(input: &ConnectionInput, ssl: Option<SslOpts>, via: Option<&(String, u16)>) -> Result<Opts, AppError> {
    let base = match non_empty_field(&input.url) {
        Some(url) => {
            let url = url.replacen("mariadb://", "mysql://", 1);
            OptsBuilder::from_opts(Opts::from_url(&url).map_err(|e| AppError::Invalid(format!("Invalid MySQL URL: {e}")))?)
        }
        None => OptsBuilder::default()
            .ip_or_hostname(non_empty_field(&input.host).unwrap_or("localhost"))
            .tcp_port(input.port.unwrap_or(3306))
            .user(non_empty_field(&input.user))
            .db_name(non_empty_field(&input.database)),
    };
    let base = match resolve_password(input)? {
        Some(pw) => base.pass(Some(pw)),
        None => base,
    };
    let (base, ssl) = match via {
        // Through a tunnel the certificate is still checked against the real host name.
        Some((host, port)) => (
            base.ip_or_hostname("127.0.0.1").tcp_port(*port),
            ssl.map(|s| s.with_danger_tls_hostname_override(Some(host.clone()))),
        ),
        None => (base, ssl),
    };
    Ok(base.ssl_opts(ssl).into())
}

/// TLS like libpq's sslmode: `prefer` falls back to plain when the server has no TLS,
/// `require` encrypts without verifying, `verify-full` verifies certificate and host name.
pub async fn connect(input: &ConnectionInput) -> Result<Conn, AppError> {
    let lax = || SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true);
    let mode = input.ssl_mode.unwrap_or_default();
    let via = match input.ssh {
        Some(_) => {
            let target = opts(input, None, None)?;
            let host = target.ip_or_hostname().to_string();
            super::ssh::route(input, &host, target.tcp_port()).await?.map(|port| (host, port))
        }
        None => None,
    };
    let via = via.as_ref();
    let mut conn = match mode {
        SslMode::Disable => Conn::new(opts(input, None, via)?).await?,
        SslMode::Require => Conn::new(opts(input, Some(lax()), via)?).await?,
        SslMode::VerifyFull => Conn::new(opts(input, Some(SslOpts::default()), via)?).await?,
        SslMode::Prefer => match Conn::new(opts(input, Some(lax()), via)?).await {
            Ok(c) => c,
            // Only a TLS problem means "try without": a wrong password must not be resent in plain text.
            Err(e) if is_tls_failure(&e) => Conn::new(opts(input, None, via)?).await?,
            Err(e) => return Err(e.into()),
        },
    };
    conn.query_drop("SELECT 1").await?;
    // The whole session is read-only, on top of the read-only transactions data reads use.
    // Servers older than MySQL 5.6.5 lack the statement; their data reads fail on their own.
    let _ = conn.query_drop("SET SESSION TRANSACTION READ ONLY").await;
    Ok(conn)
}

/// The server has no TLS, or the TLS handshake failed.
fn is_tls_failure(e: &mysql_async::Error) -> bool {
    matches!(
        e,
        mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer) | mysql_async::Error::Io(mysql_async::IoError::Tls(_))
    )
}

pub async fn version(conn: &mut Conn) -> Result<String, AppError> {
    let v: Option<String> = conn.query_first("SELECT VERSION()").await?;
    Ok(v.unwrap_or_default())
}

pub async fn current_database(conn: &mut Conn) -> Result<String, AppError> {
    let db: Option<Option<String>> = conn.query_first("SELECT DATABASE()").await?;
    db.flatten().ok_or_else(|| AppError::Invalid("Choose a database: MySQL connections need one".into()))
}

fn text(row: &Row, i: usize) -> Option<String> {
    match row.as_ref(i)? {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        other => Some(value_text(other.clone()).unwrap_or_default()),
    }
}

fn int(row: &Row, i: usize) -> Option<i64> {
    match row.as_ref(i)? {
        Value::Int(v) => Some(*v),
        Value::UInt(v) => Some(*v as i64),
        Value::Bytes(b) => String::from_utf8_lossy(b).trim().parse().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Introspection (faithful to the connector)
// ---------------------------------------------------------------------------------------------

fn enum_name(table: &str, column: &str) -> String {
    format!("{table}_{column}_enum")
}

fn generation_expression(extra: &str, expression: &str) -> String {
    match extra {
        "VIRTUAL GENERATED" => format!("GENERATED ALWAYS AS ({expression}) VIRTUAL"),
        "STORED GENERATED" => format!("GENERATED ALWAYS AS ({expression}) STORED"),
        e if e.contains("on update CURRENT_TIMESTAMP") => "on update CURRENT_TIMESTAMP".into(),
        _ => String::new(),
    }
}

pub fn field_type(table: &str, column: &str, column_type: &str, data_type: &str, extra: &str, generation: &str) -> String {
    if data_type == "enum" {
        return enum_name(table, column);
    }
    let generated = generation_expression(extra, generation);
    if generated.is_empty() { column_type.to_string() } else { format!("{column_type} {generated}") }
}

/// Identifiers quoted with backticks inside a CHECK clause (JS: /`(?:``|[^`])*`/g), every occurrence.
pub fn check_columns(clause: &str) -> Vec<String> {
    let chars: Vec<char> = clause.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut name = String::new();
        while j < chars.len() {
            if chars[j] == '`' {
                if j + 1 < chars.len() && chars[j + 1] == '`' {
                    name.push_str("``");
                    j += 2;
                    continue;
                }
                break;
            }
            name.push(chars[j]);
            j += 1;
        }
        if j < chars.len() {
            out.push(name);
        }
        i = j + 1;
    }
    out
}

/// `(expr)` → `expr` (JS `slice(1, -1)`).
fn strip_outer(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 2 { String::new() } else { chars[1..chars.len() - 1].iter().collect() }
}

pub async fn fetch_schema_json(conn: &mut Conn) -> Result<DatabaseSchema, AppError> {
    let db = current_database(conn).await?;
    let mut schema = DatabaseSchema::default();

    // Tables and fields.
    let rows: Vec<Row> = conn
        .exec(
            "select t.table_name, t.table_comment, c.column_name, c.column_default,
               case
                 when c.column_default is null then 'boolean'
                 when c.data_type = 'enum' then 'string'
                 when c.column_default regexp ? then 'number'
                 when c.extra like '%DEFAULT_GENERATED%' then 'expression'
                 else 'string'
               end,
               c.is_nullable, c.data_type, c.column_type, c.extra, c.column_comment, c.generation_expression
             from information_schema.tables t
             join information_schema.columns c on t.table_schema = c.table_schema and t.table_name = c.table_name
             where t.table_schema = ? and t.table_type = 'BASE TABLE'
             order by t.table_name, c.ordinal_position",
            (NUMBER_REGEX, &db),
        )
        .await?;
    let mut seen = HashMap::new();
    for r in &rows {
        let table = text(r, 0).unwrap_or_default();
        if seen.insert(table.clone(), ()).is_none() {
            schema.tables.push(Table { name: table.clone(), schema_name: String::new(), note: NoteInfo::from_opt(text(r, 1)) });
        }
        let column = text(r, 2).unwrap_or_default();
        let default = text(r, 3);
        let default_type = text(r, 4).unwrap_or_else(|| "string".into());
        let data_type = text(r, 6).unwrap_or_default();
        let extra = text(r, 8).unwrap_or_default();
        schema.fields.entry(table.clone()).or_default().push(Field {
            name: column.clone(),
            field_type: TypeInfo {
                type_name: field_type(&table, &column, &text(r, 7).unwrap_or_default(), &data_type, &extra, &text(r, 10).unwrap_or_default()),
                schema_name: None,
            },
            dbdefault: default.map(|value| DefaultInfo { kind: default_type, value }),
            not_null: text(r, 5).as_deref() != Some("YES"),
            increment: extra == "auto_increment",
            note: NoteInfo { value: text(r, 9).unwrap_or_default() },
        });
    }

    // Enums: one per enum column, named table_column_enum.
    let rows: Vec<Row> = conn
        .exec(
            "select t.table_name, c.column_name, TRIM(LEADING 'enum' FROM c.column_type)
             from information_schema.tables t
             join information_schema.columns c on t.table_schema = c.table_schema and t.table_name = c.table_name
             where t.table_schema = ? and t.table_type = 'BASE TABLE' and c.data_type = 'enum'
             order by t.table_name, c.ordinal_position",
            (&db,),
        )
        .await?;
    for r in &rows {
        let raw = text(r, 2).unwrap_or_default();
        let values = strip_outer(&raw).split(',').map(|v| EnumValue { name: strip_outer(v) }).collect();
        schema.enums.push(Enum { name: enum_name(&text(r, 0).unwrap_or_default(), &text(r, 1).unwrap_or_default()), schema_name: String::new(), values });
    }

    // Indexes that are not backing a PK / FK / UNIQUE constraint.
    let rows: Vec<Row> = conn
        .exec(
            "with pk_fk_uniques as (
               select constraint_name, table_name from information_schema.table_constraints where table_schema = ?
             )
             select st.table_name, case when st.non_unique = 0 then 1 else 0 end, st.index_name, st.column_name,
                    st.sub_part, st.index_type, replace(st.expression, '`', '')
             from information_schema.statistics st
             where st.table_schema = ?
               and st.index_name not in (select constraint_name from pk_fk_uniques pfu where pfu.table_name = st.table_name)
               and st.index_type in ('BTREE', 'HASH')
             group by st.table_name, st.non_unique, st.index_name, st.column_name, st.sub_part, st.index_type, st.expression, st.seq_in_index
             order by st.index_name, st.seq_in_index",
            (&db, &db),
        )
        .await?;
    let mut per_table: BTreeMap<String, Vec<Index>> = BTreeMap::new();
    for r in &rows {
        let table = text(r, 0).unwrap_or_default();
        let name = text(r, 2).unwrap_or_default();
        let list = per_table.entry(table).or_default();
        let idx = match list.iter().position(|i| i.name == name) {
            Some(p) => p,
            None => {
                list.push(Index { name: name.clone(), index_type: text(r, 5), columns: vec![], pk: None, unique: Some(int(r, 1) == Some(1)) });
                list.len() - 1
            }
        };
        let column = text(r, 3);
        let sub_part = int(r, 4);
        let expression = text(r, 6).filter(|e| !e.is_empty());
        let col = match (expression, sub_part, column) {
            (Some(e), _, _) => Some(IndexColumn { kind: "expression".into(), value: e }),
            (None, Some(n), Some(c)) => Some(IndexColumn { kind: "expression".into(), value: format!("{c}({n})") }),
            (None, None, Some(c)) => Some(IndexColumn { kind: "column".into(), value: c }),
            _ => None,
        };
        if let Some(col) = col {
            list[idx].columns.push(col);
        }
    }
    let mut indexes = per_table;

    // Primary keys and unique constraints: single column → column setting, composite → index.
    let rows: Vec<Row> = conn
        .exec(
            "select tc.table_name, tc.constraint_name,
                    group_concat(kcu.column_name order by kcu.ordinal_position separator ','),
                    count(kcu.column_name), tc.constraint_type
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu
               on tc.constraint_schema = kcu.constraint_schema and tc.constraint_name = kcu.constraint_name and tc.table_name = kcu.table_name
             where (tc.constraint_type = 'PRIMARY KEY' or tc.constraint_type = 'UNIQUE') and tc.table_schema = ?
             group by tc.table_name, tc.constraint_name, tc.constraint_type
             order by tc.table_name, tc.constraint_name",
            (&db,),
        )
        .await?;
    for r in &rows {
        let table = text(r, 0).unwrap_or_default();
        let columns: Vec<String> = text(r, 2).unwrap_or_default().split(',').map(str::to_string).collect();
        let ctype = text(r, 4).unwrap_or_default();
        if int(r, 3) == Some(1) {
            let entry = schema.table_constraints.entry(table).or_default().entry(columns[0].clone()).or_default();
            if ctype == "PRIMARY KEY" {
                entry.pk = Some(true);
            }
            if ctype == "UNIQUE" && entry.pk != Some(true) {
                entry.unique = Some(true);
            }
        } else {
            indexes.entry(table).or_default().push(Index {
                name: text(r, 1).unwrap_or_default(),
                index_type: None,
                columns: columns.into_iter().map(|c| IndexColumn { kind: "column".into(), value: c }).collect(),
                pk: (ctype == "PRIMARY KEY").then_some(true),
                unique: (ctype == "UNIQUE").then_some(true),
            });
        }
    }
    schema.indexes = indexes;

    // Foreign keys.
    let rows: Vec<Row> = conn
        .exec(
            "select rc.constraint_name, rc.table_name,
                    group_concat(kcu.column_name order by kcu.ordinal_position separator ','),
                    kcu.referenced_table_name,
                    group_concat(kcu.referenced_column_name order by kcu.ordinal_position separator ','),
                    rc.update_rule, rc.delete_rule
             from information_schema.referential_constraints rc
             join information_schema.key_column_usage kcu
               on rc.constraint_name = kcu.constraint_name and rc.table_name = kcu.table_name and rc.constraint_schema = kcu.table_schema
             where rc.constraint_schema = ?
             group by rc.constraint_name, rc.table_name, kcu.referenced_table_name, rc.update_rule, rc.delete_rule
             order by rc.table_name, rc.constraint_name",
            (&db,),
        )
        .await?;
    let action = |v: Option<String>| v.filter(|a| a != "NO ACTION");
    for r in &rows {
        let split = |v: Option<String>| v.unwrap_or_default().split(',').map(str::to_string).collect::<Vec<_>>();
        schema.refs.push(Ref {
            name: text(r, 0).unwrap_or_default(),
            endpoints: vec![
                RefEndpoint { table_name: text(r, 1).unwrap_or_default(), schema_name: String::new(), field_names: split(text(r, 2)), relation: "0..*".into() },
                RefEndpoint { table_name: text(r, 3).unwrap_or_default(), schema_name: String::new(), field_names: split(text(r, 4)), relation: "0..1".into() },
            ],
            on_update: action(text(r, 5)),
            on_delete: action(text(r, 6)),
        });
    }

    // CHECK constraints (MySQL 8.0.16+ / MariaDB 10.2+; older servers have none to report).
    let checks: Result<Vec<Row>, _> = conn
        .exec(
            "select cc.constraint_name, tc.table_name, cc.check_clause
             from information_schema.check_constraints cc
             join information_schema.table_constraints tc
               on cc.constraint_name = tc.constraint_name and cc.constraint_schema = tc.constraint_schema
             where cc.constraint_schema = ?",
            (&db,),
        )
        .await;
    for r in checks.unwrap_or_default() {
        let table = text(&r, 1).unwrap_or_default();
        let clause = text(&r, 2).unwrap_or_default();
        let check = CheckConstraint { name: text(&r, 0), expression: strip_outer(&clause) };
        let cols = check_columns(&clause);
        if cols.len() == 1 {
            schema.table_constraints.entry(table).or_default().entry(cols[0].clone()).or_default().checks.push(check);
        } else {
            schema.checks.entry(table).or_default().push(check);
        }
    }
    Ok(schema)
}

// ---------------------------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------------------------

fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn value_text(v: Value) -> Option<String> {
    Some(match v {
        Value::NULL => return None,
        Value::Bytes(b) => String::from_utf8_lossy(&b).into_owned(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(d) => d.to_string(),
        Value::Date(y, mo, d, h, mi, s, us) => {
            if h == 0 && mi == 0 && s == 0 && us == 0 {
                format!("{y:04}-{mo:02}-{d:02}")
            } else if us == 0 {
                format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
            } else {
                format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
            }
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let hours = days * 24 + h as u32;
            let frac = if us == 0 { String::new() } else { format!(".{us:06}") };
            format!("{}{hours:02}:{mi:02}:{s:02}{frac}", if neg { "-" } else { "" })
        }
    })
}

/// The database a DBML schema name stands for: none (`public`) means the connection's database.
pub async fn resolve_db(conn: &mut Conn, schema: &str) -> Result<String, AppError> {
    if schema.is_empty() || schema == "public" { current_database(conn).await } else { Ok(schema.to_string()) }
}

/// Columns of a table in ordinal order (empty when it does not exist).
pub async fn table_columns(conn: &mut Conn, db: &str, table: &str) -> Result<Vec<BrowseColumn>, AppError> {
    let cols: Vec<Row> = conn
        .exec(
            "select column_name, column_type from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position",
            (db, table),
        )
        .await?;
    Ok(cols
        .iter()
        .map(|r| BrowseColumn { name: text(r, 0).unwrap_or_default(), type_name: text(r, 1).unwrap_or_default() })
        .collect())
}

pub async fn row_estimate(conn: &mut Conn, db: &str, table: &str) -> Result<f64, AppError> {
    let r: Option<Row> = conn.exec_first("select table_rows from information_schema.tables where table_schema = ? and table_name = ?", (db, table)).await?;
    Ok(r.as_ref().and_then(|r| int(r, 0)).unwrap_or(0) as f64)
}

/// Runs one SELECT in a read-only transaction (time-limited where the server supports it) and
/// returns its cells as text.
pub async fn fetch_text(conn: &mut Conn, sql: &str, params: &[String], timeout_ms: u32) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let _ = conn.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {timeout_ms}")).await;
    conn.query_drop("START TRANSACTION READ ONLY").await?;
    let values: Vec<Value> = params.iter().map(|p| Value::from(p.as_str())).collect();
    let result: Result<Vec<Row>, _> = conn.exec(sql, values).await;
    let _ = conn.query_drop("ROLLBACK").await;
    Ok(result?.into_iter().map(|r| r.unwrap().into_iter().map(value_text).collect()).collect())
}

pub async fn browse(conn: &mut Conn, req: &BrowseRequest) -> Result<BrowseResult, AppError> {
    let started = Instant::now();
    // The DBML has no schemas for MySQL; tables live in the connection's database.
    let db = resolve_db(conn, &req.schema).await?;
    let columns = table_columns(conn, &db, &req.table).await?;
    if columns.is_empty() {
        return Err(AppError::Invalid(format!("Table {}.{} not found", db, req.table)));
    }
    let known = |c: &str| columns.iter().any(|x| x.name == c);
    let mut conditions = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    for f in &req.filters {
        if !known(&f.column) {
            return Err(AppError::Invalid(format!("Unknown column {}", f.column)));
        }
        match &f.value {
            Some(v) => {
                conditions.push(format!("CAST({} AS CHAR) = ?", quote(&f.column)));
                params.push(Value::from(v.as_str()));
            }
            None => conditions.push(format!("{} IS NULL", quote(&f.column))),
        }
    }
    let order: Vec<(String, bool)> = match &req.order_by {
        Some(o) if known(&o.column) => vec![(o.column.clone(), o.desc)],
        Some(o) => return Err(AppError::Invalid(format!("Unknown column {}", o.column))),
        None => {
            let pk: Vec<Row> = conn
                .exec(
                    "select column_name from information_schema.key_column_usage
                     where table_schema = ? and table_name = ? and constraint_name = 'PRIMARY' order by ordinal_position",
                    (&db, &req.table),
                )
                .await?;
            pk.iter().filter_map(|r| text(r, 0)).map(|c| (c, false)).collect()
        }
    };
    let estimate = row_estimate(conn, &db, &req.table).await?;
    let limit = req.limit.clamp(1, MAX_LIMIT);
    let mut sql = format!(
        "SELECT {} FROM {}.{}",
        columns.iter().map(|c| quote(&c.name)).collect::<Vec<_>>().join(", "),
        quote(&db),
        quote(&req.table)
    );
    if !conditions.is_empty() {
        sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }
    if !order.is_empty() {
        let keys: Vec<String> = order.iter().map(|(c, d)| format!("{}{}", quote(c), if *d { " DESC" } else { "" })).collect();
        sql.push_str(&format!(" ORDER BY {}", keys.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit + 1, req.offset));

    // Read-only transaction; SELECTs time out after 10 s (MySQL; ignored by servers without it).
    let _ = conn.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {}", req.timeout() * 1000)).await;
    conn.query_drop("START TRANSACTION READ ONLY").await?;
    let result: Result<Vec<Row>, _> = conn.exec(sql, params).await;
    let _ = conn.query_drop("ROLLBACK").await;
    let result = result?;

    let has_more = result.len() > limit as usize;
    let mut truncated = 0;
    let rows = result
        .into_iter()
        .take(limit as usize)
        .map(|r| {
            r.unwrap()
                .into_iter()
                .map(|v| {
                    value_text(v).map(|s| {
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

    #[test]
    fn falls_back_to_plain_text_only_for_tls_failures() {
        use mysql_async::{DriverError, Error, IoError};
        assert!(is_tls_failure(&Error::Driver(DriverError::NoClientSslFlagFromServer)));
        assert!(!is_tls_failure(&Error::Driver(DriverError::ConnectionClosed)));
        assert!(!is_tls_failure(&Error::Io(IoError::Io(std::io::Error::other("refused")))));
    }

    #[test]
    fn types_and_enums() {
        assert_eq!(field_type("orders", "status", "enum('a','b')", "enum", "", ""), "orders_status_enum");
        assert_eq!(field_type("t", "c", "int", "int", "VIRTUAL GENERATED", "a + 1"), "int GENERATED ALWAYS AS (a + 1) VIRTUAL");
        assert_eq!(
            field_type("t", "c", "timestamp", "timestamp", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", ""),
            "timestamp on update CURRENT_TIMESTAMP"
        );
        assert_eq!(strip_outer("('draft','sent')"), "'draft','sent'");
    }

    #[test]
    fn check_identifiers() {
        assert_eq!(check_columns("(`price` > 0)"), vec!["price"]);
        assert_eq!(check_columns("((`a` > 0) and (`b` < `a`))"), vec!["a", "b", "a"]);
        assert_eq!(check_columns("(`we``ird` is not null)"), vec!["we``ird"]);
    }

    #[test]
    fn value_formatting() {
        assert_eq!(value_text(Value::Date(2026, 11, 13, 0, 0, 0, 0)).as_deref(), Some("2026-11-13"));
        assert_eq!(value_text(Value::Date(2026, 11, 13, 9, 5, 7, 0)).as_deref(), Some("2026-11-13 09:05:07"));
        assert_eq!(value_text(Value::Time(false, 1, 2, 3, 4, 0)).as_deref(), Some("26:03:04"));
        assert_eq!(value_text(Value::NULL), None);
    }
}
