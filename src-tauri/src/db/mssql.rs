//! SQL Server: port of `@dbml/connector`'s MSSQL connector (connectors/mssql/index.ts), plus
//! read-only browsing. One deliberate fix: referential actions are reported as `SET NULL` /
//! `SET DEFAULT` (the connector passes `SET_NULL`, which DBML rejects, breaking the document).

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row, ToSql};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::browse::BrowseColumn;
use super::connect::{non_empty_field, resolve_password, ConnectionInput, SslMode};
use super::sql::{classify, Dialect};
use super::types::*;
use crate::error::AppError;

pub type MsClient = Client<Compat<TcpStream>>;

const DATE_TYPES: [&str; 6] = ["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"];

pub async fn connect(input: &ConnectionInput) -> Result<MsClient, AppError> {
    let mut config = match non_empty_field(&input.url) {
        Some(ado) if ado.contains(';') => Config::from_ado_string(ado)?,
        _ => {
            let mut c = Config::new();
            c.host(non_empty_field(&input.host).unwrap_or("localhost"));
            c.port(input.port.unwrap_or(1433));
            if let Some(db) = non_empty_field(&input.database) {
                c.database(db);
            }
            let user = non_empty_field(&input.user).ok_or_else(|| AppError::Invalid("A user name is required".into()))?;
            c.authentication(AuthMethod::sql_server(user, resolve_password(input)?.unwrap_or_default()));
            c
        }
    };
    config.application_name("xdiagram");
    let (encryption, trust) = tls_settings(input.ssl_mode.unwrap_or_default());
    config.encryption(encryption);
    if trust {
        config.trust_cert();
    }
    // Through a tunnel only the socket changes: TLS still names (and can verify) the real host.
    let mut addr = config.get_addr();
    if input.ssh.is_some() {
        let (host, port) = addr.rsplit_once(':').ok_or_else(|| AppError::Invalid(format!("Unexpected SQL Server address {addr}")))?;
        let port = port.parse().map_err(|_| AppError::Invalid(format!("Unexpected SQL Server address {addr}")))?;
        if let Some(local) = super::ssh::route(input, host, port).await? {
            addr = format!("127.0.0.1:{local}");
        }
    }
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(addr))
        .await
        .map_err(|_| AppError::Invalid("SQL Server: connection timed out".into()))??;
    tcp.set_nodelay(true)?;
    let mut client = Client::connect(config, tcp.compat_write()).await?;
    client.simple_query("SELECT 1").await?.into_results().await?;
    Ok(client)
}

/// Encryption level, and whether to accept the certificate unchecked. Like libpq's modes:
/// `prefer` and `require` encrypt without checking (self-signed servers work), and `verify-full`
/// always checks the certificate and host name. (Older profiles carry a "trust server
/// certificate" flag; it only ever disabled the `verify-full` check, so it is ignored.)
fn tls_settings(mode: SslMode) -> (EncryptionLevel, bool) {
    match mode {
        SslMode::Disable => (EncryptionLevel::NotSupported, false),
        SslMode::Prefer => (EncryptionLevel::On, true),
        SslMode::Require => (EncryptionLevel::Required, true),
        SslMode::VerifyFull => (EncryptionLevel::Required, false),
    }
}

/// A read blocked by another session's locks gives up on the server after `timeout_s`, instead
/// of holding locks there after the app stopped waiting.
pub async fn limit_lock_wait(client: &mut MsClient, timeout_s: u64) -> Result<(), AppError> {
    client.simple_query(format!("SET LOCK_TIMEOUT {}", timeout_s.saturating_mul(1000).min(i32::MAX as u64))).await?.into_results().await?;
    Ok(())
}

async fn rows(client: &mut MsClient, sql: &str, params: &[&dyn ToSql]) -> Result<Vec<Row>, AppError> {
    Ok(client.query(sql, params).await?.into_first_result().await?)
}

fn s(row: &Row, i: usize) -> Option<String> {
    row.try_get::<&str, _>(i).ok().flatten().map(str::to_string)
}

fn n(row: &Row, i: usize) -> i32 {
    row.try_get::<i32, _>(i).ok().flatten().unwrap_or(0)
}

pub async fn version(client: &mut MsClient) -> Result<String, AppError> {
    let r = rows(client, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) + N' ' + CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128))", &[]).await?;
    Ok(r.first().and_then(|r| s(r, 0)).unwrap_or_default())
}

pub async fn list_schemas(client: &mut MsClient) -> Result<Vec<String>, AppError> {
    let r = rows(
        client,
        "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') ORDER BY name",
        &[],
    )
    .await?;
    Ok(r.iter().filter_map(|r| s(r, 0)).collect())
}

/// `AND <col> IN (@P1, …)` with the schemas bound as parameters (empty: no filter).
fn schema_filter(column: &str, schemas: &[String]) -> String {
    if schemas.is_empty() {
        return String::new();
    }
    let params: Vec<String> = (1..=schemas.len()).map(|i| format!("@P{i}")).collect();
    format!("AND {column} IN ({})", params.join(", "))
}

fn params(schemas: &[String]) -> Vec<&dyn ToSql> {
    schemas.iter().map(|s| s as &dyn ToSql).collect()
}

pub fn field_type(data_type: &str, max_length: i32, precision: i32, scale: i32) -> String {
    if DATE_TYPES.contains(&data_type) || data_type == "timestamp" || data_type == "bit" {
        return data_type.to_string();
    }
    if precision != 0 {
        return if scale != 0 { format!("{data_type}({precision},{scale})") } else { format!("{data_type}({precision})") };
    }
    if ["ntext", "text", "image"].contains(&data_type) {
        return data_type.to_string();
    }
    if max_length < 0 {
        return if data_type == "xml" { data_type.to_string() } else { format!("{data_type}(MAX)") };
    }
    if max_length > 0 {
        let chars = if data_type == "nchar" || data_type == "nvarchar" { max_length / 2 } else { max_length };
        return format!("{data_type}({chars})");
    }
    data_type.to_string()
}

/// JS: `s.replace(/\(([^()]+)\)/g, '$1')` — unwraps innermost parentheses, one pass.
fn unwrap_inner_parens(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '(' && chars[j] != ')' {
                j += 1;
            }
            if j < chars.len() && chars[j] == ')' && j > i + 1 {
                out.extend(&chars[i + 1..j]);
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn slice_1_neg1(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 2 { String::new() } else { chars[1..chars.len() - 1].iter().collect() }
}

pub fn dbdefault(column_default: &str, default_type: &str) -> DefaultInfo {
    let value = unwrap_inner_parens(&slice_1_neg1(column_default));
    DefaultInfo {
        kind: default_type.to_string(),
        value: if default_type == "string" { slice_1_neg1(&value) } else { value },
    }
}

/// `SET_NULL` → `SET NULL` (DBML's spelling); `NO_ACTION` → none.
fn referential_action(desc: Option<String>) -> Option<String> {
    desc.filter(|a| a != "NO_ACTION").map(|a| a.replace('_', " "))
}

pub async fn fetch_schema_json(client: &mut MsClient, schemas: &[String]) -> Result<DatabaseSchema, AppError> {
    let mut schema = DatabaseSchema::default();

    let sql = format!(
        r#"
        WITH tables_and_fields AS (
          SELECT t.object_id AS table_id, s.name AS table_schema, t.name AS table_name, t.create_date AS table_create_date,
                 c.name AS column_name, c.column_id, ty.name AS data_type,
                 CAST(c.max_length AS INT) AS character_maximum_length, CAST(c.precision AS INT) AS numeric_precision,
                 CAST(c.scale AS INT) AS numeric_scale, CAST(c.is_identity AS INT) AS identity_increment,
                 CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
                 CASE WHEN c.default_object_id = 0 THEN NULL ELSE OBJECT_DEFINITION(c.default_object_id) END AS column_default,
                 CAST(p.value AS NVARCHAR(4000)) AS table_comment, CAST(ep.value AS NVARCHAR(4000)) AS column_comment
          FROM sys.tables t
          JOIN sys.schemas s ON t.schema_id = s.schema_id
          JOIN sys.columns c ON t.object_id = c.object_id
          JOIN sys.types ty ON c.user_type_id = ty.user_type_id
          LEFT JOIN sys.extended_properties p ON p.major_id = t.object_id AND p.name LIKE '%description%' AND p.minor_id = 0
          LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name LIKE '%description%'
          WHERE t.type = 'U'
        )
        SELECT table_schema, table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
               identity_increment, is_nullable, column_default, table_comment, column_comment,
               CASE WHEN column_default LIKE '((%))' THEN 'number' WHEN column_default LIKE '(''%'')' THEN 'string' ELSE 'expression' END AS default_type
        FROM tables_and_fields
        WHERE 1 = 1 {filter}
        ORDER BY table_schema, table_create_date, table_id, column_id
        "#,
        filter = schema_filter("table_schema", schemas)
    );
    let mut seen = HashMap::new();
    for r in rows(client, &sql, &params(schemas)).await? {
        let (sch, table) = (s(&r, 0).unwrap_or_default(), s(&r, 1).unwrap_or_default());
        let key = format!("{sch}.{table}");
        if seen.insert(key.clone(), ()).is_none() {
            schema.tables.push(Table { name: table, schema_name: sch, note: NoteInfo::from_opt(s(&r, 10)) });
        }
        let data_type = s(&r, 3).unwrap_or_default();
        let default_type = s(&r, 12).unwrap_or_else(|| "expression".into());
        let identity = n(&r, 7) != 0;
        schema.fields.entry(key).or_default().push(Field {
            name: s(&r, 2).unwrap_or_default(),
            field_type: TypeInfo { type_name: field_type(&data_type, n(&r, 4), n(&r, 5), n(&r, 6)), schema_name: None },
            dbdefault: s(&r, 9).filter(|d| !d.is_empty() && default_type != "increment").map(|d| dbdefault(&d, &default_type)),
            not_null: s(&r, 8).as_deref() != Some("YES"),
            increment: identity,
            note: NoteInfo::from_opt(s(&r, 11)),
        });
    }

    // Foreign keys (deduplicated by endpoints, like the connector).
    let sql = format!(
        r#"
        SELECT s.name, t.name, fk.name,
          STUFF((SELECT ',' + c1.name FROM sys.foreign_key_columns AS fkc
                 JOIN sys.columns AS c1 ON fkc.parent_object_id = c1.object_id AND fkc.parent_column_id = c1.column_id
                 WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, ''),
          s2.name, t2.name,
          STUFF((SELECT ',' + c2.name FROM sys.foreign_key_columns AS fkc
                 JOIN sys.columns AS c2 ON fkc.referenced_object_id = c2.object_id AND fkc.referenced_column_id = c2.column_id
                 WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, ''),
          fk.delete_referential_action_desc, fk.update_referential_action_desc
        FROM sys.foreign_keys AS fk
        JOIN sys.tables AS t ON fk.parent_object_id = t.object_id
        JOIN sys.schemas AS s ON t.schema_id = s.schema_id
        JOIN sys.tables AS t2 ON fk.referenced_object_id = t2.object_id
        JOIN sys.schemas AS s2 ON t2.schema_id = s2.schema_id
        WHERE s.name NOT IN ('sys', 'information_schema') {filter}
        ORDER BY s.name, t.name, fk.name
        "#,
        filter = schema_filter("s.name", schemas)
    );
    let split = |v: Option<String>| v.unwrap_or_default().split(',').map(str::to_string).collect::<Vec<_>>();
    for r in rows(client, &sql, &params(schemas)).await? {
        let endpoints = vec![
            RefEndpoint { table_name: s(&r, 1).unwrap_or_default(), schema_name: s(&r, 0).unwrap_or_default(), field_names: split(s(&r, 3)), relation: "0..*".into() },
            RefEndpoint { table_name: s(&r, 5).unwrap_or_default(), schema_name: s(&r, 4).unwrap_or_default(), field_names: split(s(&r, 6)), relation: "0..1".into() },
        ];
        if schema.refs.iter().any(|x| x.endpoints == endpoints) {
            continue;
        }
        schema.refs.push(Ref {
            name: s(&r, 2).unwrap_or_default(),
            endpoints,
            on_delete: referential_action(s(&r, 7)),
            on_update: referential_action(s(&r, 8)),
        });
    }

    // Indexes: PK/UNIQUE become column settings (all their columns, as the connector does);
    // others go to the indexes block.
    let sql = format!(
        r#"
        WITH user_tables AS (
          SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE 'dt%' AND TABLE_NAME NOT LIKE 'syscs%'
            AND TABLE_NAME NOT LIKE 'sysss%' AND TABLE_NAME NOT LIKE 'sysrs%' AND TABLE_NAME NOT LIKE 'sysxlgc%'
        ),
        index_info AS (
          SELECT SCHEMA_NAME(t.schema_id) AS table_schema, OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name,
                 CAST(i.is_unique AS INT) AS is_unique, CASE WHEN i.type = 1 THEN 1 ELSE 0 END AS is_primary, i.type_desc AS index_type,
                 STUFF((SELECT ', ' + c.name FROM sys.index_columns ic
                        JOIN sys.columns c ON ic.column_id = c.column_id AND ic.object_id = c.object_id
                        WHERE ic.index_id = i.index_id AND ic.object_id = i.object_id
                          AND OBJECT_NAME(ic.object_id) IN (SELECT TABLE_NAME FROM user_tables)
                        ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS columns,
                 CASE WHEN i.type = 1 THEN 'PRIMARY KEY' WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE NULL END AS constraint_type
          FROM sys.indexes i JOIN sys.tables t ON i.object_id = t.object_id
          WHERE t.is_ms_shipped = 0 AND i.type <> 0
        )
        SELECT ut.TABLE_SCHEMA, ut.TABLE_NAME, ii.index_name, ii.is_unique, ii.is_primary, ii.index_type, ii.columns, ii.constraint_type
        FROM user_tables ut
        LEFT JOIN index_info ii ON ut.TABLE_NAME = ii.table_name AND ut.TABLE_SCHEMA = ii.table_schema
        WHERE ii.columns IS NOT NULL {filter}
        ORDER BY ut.TABLE_NAME, ii.constraint_type, ii.index_name
        "#,
        filter = schema_filter("ut.TABLE_SCHEMA", schemas)
    );
    let mut indexes: BTreeMap<String, Vec<Index>> = BTreeMap::new();
    for r in rows(client, &sql, &params(schemas)).await? {
        let columns_text = s(&r, 6).unwrap_or_default();
        if columns_text == "null" || columns_text.trim().is_empty() {
            continue;
        }
        let key = format!("{}.{}", s(&r, 0).unwrap_or_default(), s(&r, 1).unwrap_or_default());
        let columns: Vec<String> = columns_text.split(',').map(|c| c.trim().to_string()).collect();
        match s(&r, 7).as_deref() {
            Some(ctype @ ("PRIMARY KEY" | "UNIQUE")) => {
                let table = schema.table_constraints.entry(key).or_default();
                for c in columns {
                    let entry = table.entry(c).or_default();
                    if ctype == "PRIMARY KEY" {
                        entry.pk = Some(true);
                    }
                    if ctype == "UNIQUE" && entry.pk != Some(true) {
                        entry.unique = Some(true);
                    }
                }
            }
            _ => {
                let primary = n(&r, 4) != 0;
                indexes.entry(key).or_default().push(Index {
                    name: s(&r, 2).unwrap_or_default(),
                    index_type: s(&r, 5),
                    columns: columns.into_iter().map(|c| IndexColumn { kind: "column".into(), value: c }).collect(),
                    pk: Some(primary),
                    unique: Some(!primary && n(&r, 3) != 0),
                });
            }
        }
    }
    schema.indexes = indexes;

    // CHECK constraints: column-level ones become column settings.
    let sql = format!(
        r#"
        SELECT OBJECT_SCHEMA_NAME(cc.parent_object_id), OBJECT_NAME(cc.parent_object_id), c.name, cc.name, cc.definition
        FROM sys.check_constraints cc
        LEFT JOIN sys.columns c ON cc.parent_object_id = c.object_id AND cc.parent_column_id = c.column_id
        WHERE 1 = 1 {filter}
        "#,
        filter = schema_filter("OBJECT_SCHEMA_NAME(cc.parent_object_id)", schemas)
    );
    for r in rows(client, &sql, &params(schemas)).await? {
        let Some(definition) = s(&r, 4).filter(|d| !d.is_empty()) else { continue };
        let key = format!("{}.{}", s(&r, 0).unwrap_or_default(), s(&r, 1).unwrap_or_default());
        let check = CheckConstraint { name: s(&r, 3), expression: slice_1_neg1(&definition) };
        match s(&r, 2) {
            Some(column) => schema.table_constraints.entry(key).or_default().entry(column).or_default().checks.push(check),
            None => schema.checks.entry(key).or_default().push(check),
        }
    }
    Ok(schema)
}

// ---------------------------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------------------------

/// The schema a DBML schema name stands for (`public`/none = `dbo`).
pub fn resolve_schema(schema: &str) -> String {
    if schema.is_empty() || schema == "public" { "dbo".to_string() } else { schema.to_string() }
}

/// Columns of a table in column order (empty when it does not exist). A user-defined alias type
/// is reported as its base type, so it is compared and shown like one.
pub async fn table_columns(client: &mut MsClient, schema: &str, table: &str) -> Result<Vec<BrowseColumn>, AppError> {
    let cols = rows(
        client,
        "SELECT c.name, CASE WHEN ty.is_user_defined = 1 THEN TYPE_NAME(c.system_type_id) ELSE ty.name END, CAST(c.is_nullable AS INT)
         FROM sys.columns c JOIN sys.types ty ON c.user_type_id = ty.user_type_id
         WHERE c.object_id = OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2)) ORDER BY c.column_id",
        &[&schema, &table],
    )
    .await?;
    Ok(cols
        .iter()
        .map(|r| {
            let type_name = s(r, 1).unwrap_or_default();
            BrowseColumn { name: s(r, 0).unwrap_or_default(), kind: classify(Dialect::Mssql, &type_name), type_name, nullable: n(r, 2) != 0, enum_values: None }
        })
        .collect())
}

/// Primary-key columns in key order.
pub async fn primary_key(client: &mut MsClient, schema: &str, table: &str) -> Result<Vec<String>, AppError> {
    Ok(rows(
        client,
        "SELECT c.name FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2)) ORDER BY ic.key_ordinal",
        &[&schema, &table],
    )
    .await?
    .iter()
    .filter_map(|r| s(r, 0))
    .collect())
}

/// Whether the name is a view.
pub async fn is_view(client: &mut MsClient, schema: &str, table: &str) -> Result<bool, AppError> {
    Ok(rows(client, "SELECT o.type FROM sys.objects o WHERE o.object_id = OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2))", &[&schema, &table])
        .await?
        .first()
        .and_then(|r| s(r, 0))
        .is_some_and(|t| t.trim() == "V"))
}

pub async fn row_estimate(client: &mut MsClient, schema: &str, table: &str) -> Result<f64, AppError> {
    Ok(rows(
        client,
        "SELECT CAST(SUM(p.rows) AS BIGINT) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2)) AND p.index_id IN (0, 1)",
        &[&schema, &table],
    )
    .await?
    .first()
    .and_then(|r| r.try_get::<i64, _>(0).ok().flatten())
    .unwrap_or(0) as f64)
}

/// Runs one SELECT whose columns are all NVARCHAR (see `Dialect::select_text`), with a time limit.
/// Only generated SELECTs reach this; SQL Server has no read-only transaction mode to add.
pub async fn fetch_text(client: &mut MsClient, sql: &str, params: &[String], timeout_s: u64) -> Result<Vec<Vec<Option<String>>>, AppError> {
    limit_lock_wait(client, timeout_s).await?;
    tokio::time::timeout(Duration::from_secs(timeout_s), fetch_rows(client, sql, params))
        .await
        .map_err(|_| AppError::Invalid(format!("SQL Server: the query took longer than {timeout_s} s")))?
}

/// One generated SELECT whose columns are all NVARCHAR, cells as text (no time limit here).
pub async fn fetch_rows(client: &mut MsClient, sql: &str, params: &[String]) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let values: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();
    let result = rows(client, sql, &values).await?;
    Ok(result.iter().map(|r| (0..r.columns().len()).map(|i| s(r, i)).collect()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_full_always_checks_the_certificate() {
        assert!(matches!(tls_settings(SslMode::VerifyFull), (EncryptionLevel::Required, false)));
        assert!(matches!(tls_settings(SslMode::Require), (EncryptionLevel::Required, true)));
        assert!(matches!(tls_settings(SslMode::Prefer), (EncryptionLevel::On, true)));
        assert!(matches!(tls_settings(SslMode::Disable), (EncryptionLevel::NotSupported, false)));
    }

    #[test]
    fn types() {
        assert_eq!(field_type("nvarchar", 510, 0, 0), "nvarchar(255)");
        assert_eq!(field_type("varchar", -1, 0, 0), "varchar(MAX)");
        assert_eq!(field_type("xml", -1, 0, 0), "xml");
        assert_eq!(field_type("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(field_type("int", 4, 10, 0), "int(10)");
        assert_eq!(field_type("datetime2", 8, 27, 7), "datetime2");
        assert_eq!(field_type("bit", 1, 1, 0), "bit");
    }

    #[test]
    fn defaults() {
        assert_eq!(dbdefault("((0))", "number").value, "0");
        assert_eq!(dbdefault("('active')", "string").value, "active");
        assert_eq!(dbdefault("(getdate())", "expression").value, "getdate()");
        assert_eq!(dbdefault("(getdate()-(1))", "expression").value, "getdate()-1");
        assert_eq!(referential_action(Some("SET_NULL".into())).as_deref(), Some("SET NULL"));
        assert_eq!(referential_action(Some("NO_ACTION".into())), None);
    }

    #[test]
    fn filters() {
        assert_eq!(schema_filter("s.name", &[]), "");
        assert_eq!(schema_filter("s.name", &["dbo".into(), "sales".into()]), "AND s.name IN (@P1, @P2)");
    }
}
