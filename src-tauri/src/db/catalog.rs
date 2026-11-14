//! What the row queries need to know about a table: its columns (with kinds), primary key, a
//! row id to keep paging stable when there is no key, and the row estimate. Read from the live
//! catalog per engine; every identifier in a request is checked against it before it is quoted.

use std::collections::HashMap;

use mysql_async::Conn;
use rusqlite::Connection;
use tokio_postgres::Client;

use super::browse::{pg_columns_and_relkind, pg_primary_key, pg_row_estimate, BrowseColumn};
use super::mssql::{self, MsClient};
use super::mysql;
use super::sql::Dialect;
use super::sqlite;
use crate::error::AppError;

#[derive(Debug, Clone, Default)]
pub struct TableMeta {
    /// The schema as the engine knows it (MySQL: the database; SQL Server: `dbo` for `public`).
    pub schema: String,
    pub table: String,
    /// `schema.table`, quoted for the engine.
    pub qualified: String,
    pub columns: Vec<BrowseColumn>,
    pub primary_key: Vec<String>,
    /// A per-row identifier to sort by when there is no primary key (`ctid`, `rowid`).
    pub row_id: Option<String>,
    pub row_estimate: f64,
    pub is_view: bool,
}

impl TableMeta {
    pub fn column(&self, name: &str) -> Option<&BrowseColumn> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// Tables a request uses, keyed by the `(schema, table)` the request names them by.
pub type Catalog = HashMap<(String, String), TableMeta>;

/// What `describe_table` tells the frontend about a table (for pickers that read another table).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub columns: Vec<BrowseColumn>,
    pub primary_key: Vec<String>,
    pub row_estimate: f64,
    pub is_view: bool,
}

impl From<&TableMeta> for TableInfo {
    fn from(m: &TableMeta) -> Self {
        TableInfo { columns: m.columns.clone(), primary_key: m.primary_key.clone(), row_estimate: m.row_estimate, is_view: m.is_view }
    }
}

pub fn not_found(schema: &str, table: &str) -> AppError {
    AppError::Invalid(format!("Table {} not found", if schema.is_empty() || schema == "public" { table.to_string() } else { format!("{schema}.{table}") }))
}

pub async fn pg_meta(client: &Client, schema: &str, table: &str) -> Result<Option<TableMeta>, AppError> {
    let (columns, relkind) = pg_columns_and_relkind(client, schema, table).await?;
    if columns.is_empty() {
        return Ok(None);
    }
    Ok(Some(TableMeta {
        qualified: Dialect::Postgres.qualified(schema, table),
        schema: schema.to_string(),
        table: table.to_string(),
        columns,
        primary_key: pg_primary_key(client, schema, table).await?,
        // Partitions repeat ctids, so only plain tables and materialized views have one to use.
        row_id: matches!(relkind.as_str(), "r" | "m").then(|| "ctid".to_string()),
        row_estimate: pg_row_estimate(client, schema, table).await?,
        is_view: matches!(relkind.as_str(), "v" | "f"),
    }))
}

pub async fn mysql_meta(conn: &mut Conn, schema: &str, table: &str) -> Result<Option<TableMeta>, AppError> {
    // The DBML has no schemas for MySQL; tables live in the connection's database.
    let db = mysql::resolve_db(conn, schema).await?;
    let columns = mysql::table_columns(conn, &db, table).await?;
    if columns.is_empty() {
        return Ok(None);
    }
    Ok(Some(TableMeta {
        qualified: Dialect::Mysql.qualified(&db, table),
        primary_key: mysql::primary_key(conn, &db, table).await?,
        row_estimate: mysql::row_estimate(conn, &db, table).await?,
        is_view: mysql::is_view(conn, &db, table).await?,
        schema: db,
        table: table.to_string(),
        columns,
        row_id: None,
    }))
}

pub async fn mssql_meta(client: &mut MsClient, schema: &str, table: &str) -> Result<Option<TableMeta>, AppError> {
    let schema = mssql::resolve_schema(schema);
    let columns = mssql::table_columns(client, &schema, table).await?;
    if columns.is_empty() {
        return Ok(None);
    }
    Ok(Some(TableMeta {
        qualified: Dialect::Mssql.qualified(&schema, table),
        primary_key: mssql::primary_key(client, &schema, table).await?,
        row_estimate: mssql::row_estimate(client, &schema, table).await?,
        is_view: mssql::is_view(client, &schema, table).await?,
        schema,
        table: table.to_string(),
        columns,
        row_id: None,
    }))
}

/// SQLite keeps no row estimate: the exact count is read (files are small enough in practice).
pub fn sqlite_meta(conn: &Connection, table: &str) -> Result<Option<TableMeta>, AppError> {
    let (columns, primary_key) = sqlite::columns_and_key(conn, table)?;
    if columns.is_empty() {
        return Ok(None);
    }
    let (is_view, has_rowid) = sqlite::relation_info(conn, table);
    Ok(Some(TableMeta {
        qualified: Dialect::Sqlite.qualified("", table),
        schema: String::new(),
        table: table.to_string(),
        columns,
        primary_key,
        row_id: has_rowid.then(|| "rowid".to_string()),
        row_estimate: sqlite::row_estimate(conn, table),
        is_view,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sql::ColKind;

    #[test]
    fn sqlite_table_meta() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(80) NOT NULL, born DATE, data BLOB);
             CREATE TABLE pairs (a INT, b INT, PRIMARY KEY (b, a)) WITHOUT ROWID;
             CREATE VIEW v AS SELECT id FROM users;",
        )
        .unwrap();
        let users = sqlite_meta(&conn, "users").unwrap().unwrap();
        assert_eq!(users.primary_key, vec!["id"]);
        assert_eq!(users.row_id.as_deref(), Some("rowid"));
        let kinds: Vec<(ColKind, bool)> = users.columns.iter().map(|c| (c.kind, c.nullable)).collect();
        assert_eq!(kinds, vec![(ColKind::Int, false), (ColKind::Text, false), (ColKind::Date, true), (ColKind::Binary, true)]);
        let pairs = sqlite_meta(&conn, "pairs").unwrap().unwrap();
        assert_eq!(pairs.primary_key, vec!["b", "a"]);
        assert_eq!(pairs.row_id, None);
        let v = sqlite_meta(&conn, "v").unwrap().unwrap();
        assert!(v.is_view && v.row_id.is_none());
        assert!(sqlite_meta(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn mysql_enum_labels() {
        assert_eq!(mysql::enum_values("enum('a','it''s','')"), vec!["a", "it's", ""]);
        assert_eq!(mysql::enum_values("enum()"), Vec::<String>::new());
    }
}
