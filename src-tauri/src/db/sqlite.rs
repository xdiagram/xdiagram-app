//! SQLite: introspection from `sqlite_master` and the table PRAGMAs (`@dbml/connector` has no
//! SQLite connector), plus read-only browsing. The file is always opened read-only. The JSON
//! carries no schema names (everything is in `main`), like the MySQL connector's output.

use std::collections::BTreeMap;
use std::time::Instant;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::browse::{truncate_cell, BrowseColumn, BrowseRequest, BrowseResult, MAX_LIMIT};
use super::connect::{non_empty_field, ConnectionInput};
use super::types::*;
use crate::error::AppError;

pub fn open(input: &ConnectionInput) -> Result<Connection, AppError> {
    let path = non_empty_field(&input.path)
        .or_else(|| non_empty_field(&input.url).map(|u| u.trim_start_matches("sqlite://").trim_start_matches("sqlite:")))
        .ok_or_else(|| AppError::Invalid("Choose a SQLite database file".into()))?;
    if !std::path::Path::new(path).is_file() {
        return Err(AppError::Invalid(format!("File not found: {path}")));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    crate::ops::register(crate::ops::Interrupt::Sqlite(conn.get_interrupt_handle()));
    // Fails early on files that are not SQLite databases.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    Ok(conn)
}

pub fn version(conn: &Connection) -> Result<String, AppError> {
    Ok(conn.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))?)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// DBML default from a column's declared default (`PRAGMA table_info.dflt_value`).
pub fn default_info(raw: &str) -> DefaultInfo {
    let t = raw.trim();
    let kind = |k: &str, v: &str| DefaultInfo { kind: k.into(), value: v.into() };
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        return kind("string", &t[1..t.len() - 1].replace("''", "'"));
    }
    let unparenthesized = t.trim_start_matches('(').trim_end_matches(')');
    if unparenthesized.parse::<f64>().is_ok() {
        return kind("number", unparenthesized);
    }
    match t.to_ascii_uppercase().as_str() {
        "TRUE" | "FALSE" => kind("boolean", &t.to_ascii_lowercase()),
        _ => kind("expression", t),
    }
}

/// Splits `a, lower(b), "c"` on top-level commas (outside parentheses and quotes).
pub fn split_top_level(list: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut quote: Option<char> = None;
    let mut current = String::new();
    for ch in list.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"' | '`' | '[') => quote = Some(if ch == '[' { ']' } else { ch }),
            (None, '(') => depth += 1,
            (None, ')') => depth -= 1,
            (None, ',') if depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

/// The key list of `CREATE INDEX … ON t (key, …) [WHERE …]`.
fn index_key_list(sql: &str) -> Vec<String> {
    let Some(open) = sql.find('(') else { return vec![] };
    let mut depth = 0;
    for (i, ch) in sql[open..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return split_top_level(&sql[open + 1..open + i]);
                }
            }
            _ => {}
        }
    }
    vec![]
}

pub fn fetch_schema_json(conn: &Connection) -> Result<DatabaseSchema, AppError> {
    let mut schema = DatabaseSchema::default();
    let mut stmt = conn.prepare(
        "SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )?;
    let tables: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;

    for (table, create_sql) in &tables {
        schema.tables.push(Table { name: table.clone(), schema_name: String::new(), note: NoteInfo::from_opt(None) });
        let autoincrement = create_sql.to_ascii_uppercase().contains("AUTOINCREMENT");

        // Columns: (name, type, notnull, default, pk position)
        let mut info = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
        let columns: Vec<(String, String, bool, Option<String>, i64)> = info
            .query_map([], |r| Ok((r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get::<_, i64>(3)? != 0, r.get(4)?, r.get(5)?)))?
            .collect::<Result<_, _>>()?;
        let pk_columns: Vec<&str> = {
            let mut pks: Vec<_> = columns.iter().filter(|c| c.4 > 0).collect();
            pks.sort_by_key(|c| c.4);
            pks.into_iter().map(|c| c.0.as_str()).collect()
        };
        for (name, ty, not_null, default, pk) in &columns {
            schema.fields.entry(table.clone()).or_default().push(Field {
                name: name.clone(),
                field_type: TypeInfo { type_name: if ty.is_empty() { "any".into() } else { ty.to_lowercase() }, schema_name: None },
                dbdefault: default.as_deref().filter(|d| !d.eq_ignore_ascii_case("NULL")).map(default_info),
                not_null: *not_null,
                increment: autoincrement && *pk > 0 && pk_columns.len() == 1 && ty.eq_ignore_ascii_case("integer"),
                note: NoteInfo::from_opt(None),
            });
        }
        if pk_columns.len() == 1 {
            schema.table_constraints.entry(table.clone()).or_default().entry(pk_columns[0].to_string()).or_default().pk = Some(true);
        } else if pk_columns.len() > 1 {
            schema.indexes.entry(table.clone()).or_default().push(Index {
                name: format!("{table}_pkey"),
                index_type: None,
                columns: pk_columns.iter().map(|c| IndexColumn { kind: "column".into(), value: c.to_string() }).collect(),
                pk: Some(true),
                unique: None,
            });
        }

        // Indexes and UNIQUE constraints (origin 'pk' is covered by table_info above).
        let mut list = conn.prepare(&format!("PRAGMA index_list({})", quote(table)))?;
        let indexes: Vec<(String, bool, String)> =
            list.query_map([], |r| Ok((r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?)))?.collect::<Result<_, _>>()?;
        for (index, unique, origin) in indexes.into_iter().rev() {
            if origin == "pk" {
                continue;
            }
            let mut xinfo = conn.prepare(&format!("PRAGMA index_xinfo({})", quote(&index)))?;
            let keys: Vec<(i64, Option<String>)> = xinfo
                .query_map([], |r| Ok((r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(5)?)))?
                .filter_map(|r| r.ok())
                .filter(|(_, _, key)| *key == 1)
                .map(|(cid, name, _)| (cid, name))
                .collect();
            let index_sql: String = conn
                .query_row("SELECT COALESCE(sql, '') FROM sqlite_master WHERE type = 'index' AND name = ?1", [&index], |r| r.get(0))
                .unwrap_or_default();
            let written = index_key_list(&index_sql);
            let columns: Vec<IndexColumn> = keys
                .iter()
                .enumerate()
                .map(|(i, (cid, name))| match (cid, name) {
                    (-2, _) => IndexColumn { kind: "expression".into(), value: written.get(i).cloned().unwrap_or_else(|| "?".into()) },
                    (_, Some(n)) => IndexColumn { kind: "column".into(), value: n.clone() },
                    _ => IndexColumn { kind: "expression".into(), value: "rowid".into() },
                })
                .collect();
            if origin == "u" && columns.len() == 1 && columns[0].kind == "column" {
                let entry = schema.table_constraints.entry(table.clone()).or_default().entry(columns[0].value.clone()).or_default();
                if entry.pk != Some(true) {
                    entry.unique = Some(true);
                }
                continue;
            }
            schema.indexes.entry(table.clone()).or_default().push(Index {
                name: index,
                index_type: None,
                columns,
                pk: Some(false),
                unique: Some(unique),
            });
        }

        // Foreign keys, grouped by id (composite keys span several rows).
        let mut fks = conn.prepare(&format!("PRAGMA foreign_key_list({})", quote(table)))?;
        let rows: Vec<(i64, String, String, Option<String>, String, String)> = fks
            .query_map([], |r| Ok((r.get(0)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
            .collect::<Result<_, _>>()?;
        let mut grouped: BTreeMap<i64, Vec<(String, String, Option<String>, String, String)>> = BTreeMap::new();
        for (id, parent, from, to, on_update, on_delete) in rows {
            grouped.entry(id).or_default().push((parent, from, to, on_update, on_delete));
        }
        for parts in grouped.values() {
            let parent = parts[0].0.clone();
            let from: Vec<String> = parts.iter().map(|p| p.1.clone()).collect();
            // `REFERENCES parent` without columns means the parent's primary key.
            let to: Vec<String> = if parts.iter().all(|p| p.2.is_some()) {
                parts.iter().map(|p| p.2.clone().unwrap_or_default()).collect()
            } else {
                let mut pk = conn.prepare(&format!("PRAGMA table_info({})", quote(&parent)))?;
                let mut cols: Vec<(i64, String)> = pk
                    .query_map([], |r| Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?)))?
                    .filter_map(|r| r.ok())
                    .filter(|(p, _)| *p > 0)
                    .collect();
                cols.sort();
                cols.into_iter().map(|(_, c)| c).collect()
            };
            let action = |a: &str| (a != "NO ACTION").then(|| a.to_string());
            schema.refs.push(Ref {
                name: format!("{}_{}_fkey", table, from.join("_")),
                endpoints: vec![
                    RefEndpoint { table_name: table.clone(), schema_name: String::new(), field_names: from, relation: "0..*".into() },
                    RefEndpoint { table_name: parent, schema_name: String::new(), field_names: to, relation: "0..1".into() },
                ],
                on_update: action(&parts[0].3),
                on_delete: action(&parts[0].4),
            });
        }
    }
    Ok(schema)
}

/// Columns of a table (empty when it does not exist).
pub fn table_columns(conn: &Connection, table: &str) -> Result<Vec<BrowseColumn>, AppError> {
    let mut info = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let cols = info
        .query_map([], |r| Ok(BrowseColumn { name: r.get(1)?, type_name: r.get::<_, Option<String>>(2)?.unwrap_or_default().to_lowercase() }))?
        .collect::<Result<_, _>>()?;
    Ok(cols)
}

/// Exact row count (SQLite keeps no estimate).
pub fn row_estimate(conn: &Connection, table: &str) -> f64 {
    conn.query_row(&format!("SELECT count(*) FROM {}", quote(table)), [], |r| r.get::<_, i64>(0)).unwrap_or(0) as f64
}

fn cell_text(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!("\\x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())),
    }
}

/// Runs one SELECT (the file is open read-only) and returns its cells as text.
pub fn fetch_text(conn: &Connection, sql: &str, params: &[String]) -> Result<Vec<Vec<Option<String>>>, AppError> {
    let mut stmt = conn.prepare(sql)?;
    let width = stmt.column_count();
    let mut cursor = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = cursor.next()? {
        out.push((0..width).map(|i| row.get_ref(i).ok().and_then(cell_text)).collect());
    }
    Ok(out)
}

pub fn browse(conn: &Connection, req: &BrowseRequest) -> Result<BrowseResult, AppError> {
    let started = Instant::now();
    let mut info = conn.prepare(&format!("PRAGMA table_info({})", quote(&req.table)))?;
    let cols: Vec<(String, String, i64)> = info
        .query_map([], |r| Ok((r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    if cols.is_empty() {
        return Err(AppError::Invalid(format!("Table {} not found", req.table)));
    }
    let columns: Vec<BrowseColumn> = cols.iter().map(|c| BrowseColumn { name: c.0.clone(), type_name: c.1.to_lowercase() }).collect();
    let known = |c: &str| columns.iter().any(|x| x.name == c);
    let mut conditions = Vec::new();
    let mut params: Vec<String> = Vec::new();
    for f in &req.filters {
        if !known(&f.column) {
            return Err(AppError::Invalid(format!("Unknown column {}", f.column)));
        }
        match &f.value {
            Some(v) => {
                params.push(v.clone());
                conditions.push(format!("CAST({} AS TEXT) = ?{}", quote(&f.column), params.len()));
            }
            None => conditions.push(format!("{} IS NULL", quote(&f.column))),
        }
    }
    let order: Vec<(String, bool)> = match &req.order_by {
        Some(o) if known(&o.column) => vec![(o.column.clone(), o.desc)],
        Some(o) => return Err(AppError::Invalid(format!("Unknown column {}", o.column))),
        None => {
            let mut pk: Vec<&(String, String, i64)> = cols.iter().filter(|c| c.2 > 0).collect();
            pk.sort_by_key(|c| c.2);
            pk.into_iter().map(|c| (c.0.clone(), false)).collect()
        }
    };
    let limit = req.limit.clamp(1, MAX_LIMIT);
    let mut sql = format!("SELECT {} FROM {}", columns.iter().map(|c| quote(&c.name)).collect::<Vec<_>>().join(", "), quote(&req.table));
    if !conditions.is_empty() {
        sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }
    if !order.is_empty() {
        let keys: Vec<String> = order.iter().map(|(c, d)| format!("{}{}", quote(c), if *d { " DESC" } else { "" })).collect();
        sql.push_str(&format!(" ORDER BY {}", keys.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit + 1, req.offset));

    let mut stmt = conn.prepare(&sql)?;
    let width = columns.len();
    let mut truncated = 0;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut cursor = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    while let Some(row) = cursor.next()? {
        let mut out = Vec::with_capacity(width);
        for i in 0..width {
            let v = match row.get_ref(i)? {
                ValueRef::Null => None,
                ValueRef::Integer(n) => Some(n.to_string()),
                ValueRef::Real(f) => Some(f.to_string()),
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Some(format!("\\x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())),
            };
            out.push(v.map(|s| {
                let (s, cut) = truncate_cell(s);
                truncated += cut as u32;
                s
            }));
        }
        rows.push(out);
    }
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let estimate: i64 = conn.query_row(&format!("SELECT count(*) FROM {}", quote(&req.table)), [], |r| r.get(0)).unwrap_or(0);
    Ok(BrowseResult {
        columns,
        rows,
        has_more,
        row_estimate: estimate as f64,
        ordered_by: order.into_iter().map(|(c, _)| c).collect(),
        truncated_cells: truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Statements of a SQL script with the 1-based line each starts on, split on `;` outside
/// strings, quoted identifiers and comments. The `;` itself is dropped; blank pieces are skipped.
pub fn split_statements(sql: &str) -> Vec<(usize, String)> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut line = 1;
    let mut start_line = 1;
    let mut i = 0;
    let push = |current: &mut String, start_line: usize, out: &mut Vec<(usize, String)>| {
        if !strip_leading_comments(current).is_empty() {
            out.push((start_line, std::mem::take(current)));
        } else {
            current.clear();
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if current.trim().is_empty() && !c.is_whitespace() {
            start_line = line;
        }
        let close = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            // Quoted run; a doubled closing character is an escape.
            current.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                current.push(ch);
                if ch == '\n' {
                    line += 1;
                }
                i += 1;
                if ch == close {
                    if close != ']' && chars.get(i) == Some(&close) {
                        current.push(close);
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                current.push(chars[i]);
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            current.push_str("/*");
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                if chars[i] == '\n' {
                    line += 1;
                }
                current.push(chars[i]);
                i += 1;
            }
            current.push_str("*/");
            i += 2;
            continue;
        }
        if c == ';' {
            push(&mut current, start_line, &mut out);
            i += 1;
            continue;
        }
        if c == '\n' {
            line += 1;
        }
        current.push(c);
        i += 1;
    }
    push(&mut current, start_line, &mut out);
    out
}

/// The statement without leading whitespace and comments.
fn strip_leading_comments(stmt: &str) -> &str {
    let mut s = stmt.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map(|(_, r)| r).unwrap_or("").trim_start();
        } else {
            return s;
        }
    }
}

/// `CREATE TABLE`, `CREATE UNIQUE INDEX`, `INSERT`, `PRAGMA`… — the statement's leading keywords.
fn statement_kind(stmt: &str) -> String {
    let words: Vec<String> = strip_leading_comments(stmt)
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .take(3)
        .map(|w| w.to_ascii_uppercase())
        .collect();
    match words.as_slice() {
        [first, second, third, ..] if first == "CREATE" && matches!(second.as_str(), "UNIQUE" | "TEMP" | "TEMPORARY" | "VIRTUAL") => {
            format!("{first} {second} {third}")
        }
        [first, second, ..] if first == "CREATE" || first == "ALTER" || first == "DROP" => format!("{first} {second}"),
        [first, ..] => first.clone(),
        [] => "?".into(),
    }
}

/// Result of [`import_ddl`]: the schema, plus a summary of statements that were not run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlImport {
    pub schema: DatabaseSchema,
    /// e.g. `["INSERT ×3", "PRAGMA ×1"]`.
    pub skipped: Vec<String>,
}

/// Schema JSON of a SQLite DDL script. Only its `CREATE TABLE` and `CREATE [UNIQUE] INDEX`
/// statements are run, in a private in-memory database (no file is opened or written); the
/// result is then read back with the same introspection as a real database file.
pub fn import_ddl(sql: &str) -> Result<DdlImport, AppError> {
    let conn = Connection::open_in_memory()?;
    let mut skipped: BTreeMap<String, u32> = BTreeMap::new();
    let mut created = 0;
    for (line, stmt) in split_statements(sql) {
        let kind = statement_kind(&stmt);
        if kind == "CREATE TABLE" || kind == "CREATE INDEX" || kind == "CREATE UNIQUE INDEX" {
            conn.execute_batch(&stmt).map_err(|e| AppError::Invalid(format!("Line {line}: {e}")))?;
            if kind == "CREATE TABLE" {
                created += 1;
            }
        } else {
            *skipped.entry(kind).or_default() += 1;
        }
    }
    if created == 0 {
        return Err(AppError::Invalid("No CREATE TABLE statements found".into()));
    }
    Ok(DdlImport {
        schema: fetch_schema_json(&conn)?,
        skipped: skipped.into_iter().map(|(k, n)| format!("{k} ×{n}")).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::browse::BrowseFilter;

    #[test]
    fn splits_statements_outside_quotes_and_comments() {
        let sql = "CREATE TABLE a (x TEXT DEFAULT ';'); -- c;\n/* d; */ CREATE TABLE \"b;\" (y);\n\nINSERT INTO a VALUES ('it''s;');";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], (1, "CREATE TABLE a (x TEXT DEFAULT ';')".to_string()));
        assert!(parts[1].1.ends_with("CREATE TABLE \"b;\" (y)"));
        assert_eq!(parts[1].0, 1);
        assert_eq!(parts[2].0, 4);
        assert_eq!(statement_kind(&parts[1].1), "CREATE TABLE");
        assert_eq!(statement_kind("create unique index i on t(x)"), "CREATE UNIQUE INDEX");
        assert_eq!(statement_kind("  PRAGMA foreign_keys = ON"), "PRAGMA");
    }

    #[test]
    fn imports_the_sample_ddl() {
        let r = import_ddl(include_str!("../../../scripts/sample-schema.sqlite.sql")).unwrap();
        assert_eq!(r.schema.tables.len(), 4);
        assert_eq!(r.schema.refs.len(), 3);
        assert_eq!(r.skipped, vec!["INSERT ×3", "PRAGMA ×1"]);
        let err = import_ddl("CREATE TABLE a (x);\nCREATE INDEX i ON missing (x);").unwrap_err();
        assert!(err.to_string().contains("Line 2"), "{err}");
        assert!(import_ddl("SELECT 1;").is_err());
    }

    fn sample() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT DEFAULT 'anon', score REAL DEFAULT 0);
             CREATE TABLE orgs (id INTEGER PRIMARY KEY, slug TEXT);
             CREATE TABLE members (org_id INTEGER REFERENCES orgs ON DELETE CASCADE, user_id INTEGER NOT NULL,
               joined TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (org_id, user_id), FOREIGN KEY (user_id) REFERENCES users(id));
             CREATE INDEX members_joined_idx ON members (joined);
             CREATE INDEX orgs_lower_slug ON orgs (lower(slug));
             CREATE UNIQUE INDEX users_name_score ON users (name, score);
             INSERT INTO users (email, name) VALUES ('a@x', 'Ann'), ('b@x', NULL), ('c@x', 'Cid');
             INSERT INTO orgs (id, slug) VALUES (1, 'one');
             INSERT INTO members (org_id, user_id) VALUES (1, 1), (1, 2);",
        )
        .unwrap();
        c
    }

    #[test]
    fn introspection() {
        let s = fetch_schema_json(&sample()).unwrap();
        assert_eq!(s.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["users", "orgs", "members"]);
        let users = &s.fields["users"];
        assert!(users[0].increment && users[0].field_type.type_name == "integer");
        assert!(users[1].not_null);
        assert_eq!(users[2].dbdefault.as_ref().map(|d| (d.kind.as_str(), d.value.as_str())), Some(("string", "anon")));
        assert_eq!(users[3].dbdefault.as_ref().map(|d| d.kind.as_str()), Some("number"));
        assert_eq!(s.table_constraints["users"]["id"].pk, Some(true));
        assert_eq!(s.table_constraints["users"]["email"].unique, Some(true));
        assert_eq!(s.fields["members"][2].dbdefault.as_ref().map(|d| d.kind.as_str()), Some("expression"));

        let member_idx = &s.indexes["members"];
        assert!(member_idx.iter().any(|i| i.pk == Some(true) && i.columns.len() == 2));
        assert!(member_idx.iter().any(|i| i.name == "members_joined_idx"));
        let org_idx = &s.indexes["orgs"];
        assert_eq!(org_idx[0].columns[0].kind, "expression");
        assert_eq!(org_idx[0].columns[0].value, "lower(slug)");
        assert!(s.indexes["users"].iter().any(|i| i.name == "users_name_score" && i.unique == Some(true)));

        assert_eq!(s.refs.len(), 2);
        let to_orgs = s.refs.iter().find(|r| r.endpoints[1].table_name == "orgs").unwrap();
        assert_eq!(to_orgs.endpoints[1].field_names, vec!["id"]);
        assert_eq!(to_orgs.on_delete.as_deref(), Some("CASCADE"));
        assert!(serde_json::to_string(&s.tables[0]).unwrap().find("schemaName").is_none());
    }

    #[test]
    fn browsing() {
        let c = sample();
        let req = |filters: Vec<BrowseFilter>| BrowseRequest { schema: "public".into(), table: "users".into(), filters, order_by: None, limit: 2, offset: 0, timeout_secs: None };
        let r = browse(&c, &req(vec![])).unwrap();
        assert_eq!(r.columns.len(), 4);
        assert_eq!(r.rows.len(), 2);
        assert!(r.has_more);
        assert_eq!(r.ordered_by, vec!["id"]);
        let r = browse(&c, &req(vec![BrowseFilter { column: "name".into(), value: None }])).unwrap();
        assert_eq!(r.rows[0][1].as_deref(), Some("b@x"));
        let r = browse(&c, &req(vec![BrowseFilter { column: "id".into(), value: Some("3".into()) }])).unwrap();
        assert_eq!(r.rows[0][2].as_deref(), Some("Cid"));
        assert!(browse(&c, &req(vec![BrowseFilter { column: "nope".into(), value: None }])).is_err());
    }

    #[test]
    fn helpers() {
        assert_eq!(default_info("'it''s'").value, "it's");
        assert_eq!(default_info("(42)").kind, "number");
        assert_eq!(default_info("TRUE").kind, "boolean");
        assert_eq!(split_top_level("a, lower(b, c), \"x,y\""), vec!["a", "lower(b, c)", "\"x,y\""]);
        assert_eq!(index_key_list("CREATE INDEX i ON t (a, lower(b)) WHERE a > 0"), vec!["a", "lower(b)"]);
    }
}
