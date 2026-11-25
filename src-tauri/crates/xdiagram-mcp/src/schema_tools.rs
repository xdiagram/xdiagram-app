//! Schema tools: the tables, the schema as DBML (the format xdiagram's editor shows), one table in
//! detail, and the DBML the user keeps for the database in the app. Introspection is cached for a
//! few minutes per connection, as agents tend to ask several questions in a row.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xdiagram_core::db::catalog::TableInfo;
use xdiagram_core::db::connect::password_binding;
use xdiagram_core::db::{DatabaseSchema, dispatch};
use xdiagram_core::dbml::{subset, table_key, to_dbml};
use xdiagram_core::drafts::Drafts;
use xdiagram_core::profiles::database_key;

use crate::access::{Conn, run_op};
use crate::server::{CATALOG_BUDGET, MAX_REPLY_LEN, ToolResult, XdiagramServer, json_text, text};

/// How long a schema read is reused (`refresh: true` reads it again).
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct SchemaCache {
    entries: Mutex<HashMap<String, (Instant, Arc<DatabaseSchema>)>>,
}

impl SchemaCache {
    /// The connection's schema, read at most `CACHE_TTL` ago. Keyed by the server identity (as
    /// passwords are), so editing the connection in the app reads the new database.
    pub async fn get(&self, conn: &Conn, refresh: bool, ct: &CancellationToken) -> Result<Arc<DatabaseSchema>, String> {
        let key = format!("{}|{}|{}", conn.profile.id, password_binding(&conn.input), conn.schemas().join(","));
        if !refresh {
            let entries = self.entries.lock().map_err(|_| "schema cache unavailable")?;
            if let Some((at, schema)) = entries.get(&key)
                && at.elapsed() < CACHE_TTL
            {
                return Ok(schema.clone());
            }
        }
        let input = conn.input.clone();
        let schemas = conn.schemas().to_vec();
        let schema = run_op(ct, CATALOG_BUDGET, async move { dispatch::introspect(&input, &schemas).await }).await.map_err(|e| conn.explain(e))?;
        let schema = Arc::new(schema);
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
            entries.insert(key, (Instant::now(), schema.clone()));
        }
        Ok(schema)
    }
}

/// A table of the schema, as the other tools name it: `schema.table`, or `table` where the
/// engine has no schemas (MySQL, SQLite).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TableRef {
    pub schema: String,
    pub table: String,
}

impl TableRef {
    pub fn key(&self) -> String {
        table_key(&self.schema, &self.table)
    }

    /// The schema argument the database layer expects (`public` stands for "the default").
    pub fn db_schema(&self) -> String {
        if self.schema.is_empty() { "public".into() } else { self.schema.clone() }
    }
}

/// Every table of the schema.
pub fn tables_of(schema: &DatabaseSchema) -> Vec<TableRef> {
    schema.tables.iter().map(|t| TableRef { schema: t.schema_name.clone(), table: t.name.clone() }).collect()
}

/// The table `name` means: `schema.table`, or a table name alone when only one schema has it.
/// Exact matches first, then case-insensitive ones.
pub fn resolve_table(schema: &DatabaseSchema, name: &str) -> Result<TableRef, String> {
    let wanted = name.trim().trim_matches('"');
    let all = tables_of(schema);
    let pick = |matches: Vec<&TableRef>| -> Option<Result<TableRef, String>> {
        match matches.as_slice() {
            [] => None,
            [one] => Some(Ok((*one).clone())),
            many => Some(Err(format!(
                "\"{wanted}\" is in several schemas; name one of {}.",
                many.iter().map(|t| format!("\"{}\"", t.key())).collect::<Vec<_>>().join(", ")
            ))),
        }
    };
    let exact = |t: &&TableRef| t.key() == wanted || t.table == wanted;
    let loose = |t: &&TableRef| t.key().eq_ignore_ascii_case(wanted) || t.table.eq_ignore_ascii_case(wanted);
    if let Some(r) = pick(all.iter().filter(|t| t.key() == wanted).collect()) {
        return r;
    }
    if let Some(r) = pick(all.iter().filter(exact).collect()).or_else(|| pick(all.iter().filter(loose).collect())) {
        return r;
    }
    let lower = wanted.to_lowercase();
    let near: Vec<String> = all.iter().filter(|t| t.key().to_lowercase().contains(&lower)).take(10).map(|t| format!("\"{}\"", t.key())).collect();
    Err(if near.is_empty() {
        format!("No table \"{wanted}\" (call list_tables to see them).")
    } else {
        format!("No table \"{wanted}\". Did you mean {}?", near.join(", "))
    })
}

/// Table names for a message, or how many tables each schema has when the names would take too
/// much of the reply.
fn table_names(tables: &[TableRef]) -> String {
    let names = tables.iter().map(TableRef::key).collect::<Vec<_>>().join(", ");
    if names.len() <= MAX_REPLY_LEN / 2 {
        return names;
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for t in tables {
        *counts.entry(&t.schema).or_default() += 1;
    }
    let counts: Vec<String> = counts.iter().map(|(s, n)| if s.is_empty() { n.to_string() } else { format!("{s}: {n}") }).collect();
    format!("{} in all ({}), too many to name here; list_tables with `match` finds them", tables.len(), counts.join(", "))
}

/// `text` in parts of at most `max` bytes, cut after a line where there is one.
fn split_parts(text: &str, max: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = text;
    while rest.len() > max {
        let mut cut = max;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        if let Some(newline) = rest[..cut].rfind('\n') {
            cut = newline + 1;
        }
        parts.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    parts.push(rest);
    parts
}

/// The tables `table` references and the tables referencing it.
fn neighbours(schema: &DatabaseSchema, table: &TableRef) -> (BTreeSet<String>, BTreeSet<String>) {
    let (mut out, mut inbound) = (BTreeSet::new(), BTreeSet::new());
    let key = table.key();
    for r in &schema.refs {
        let [a, b] = r.endpoints.as_slice() else { continue };
        // The many side (`0..*`) holds the foreign key; the other side is the referenced table.
        let (fk, target) = if b.relation.contains('*') && !a.relation.contains('*') { (b, a) } else { (a, b) };
        let (from, to) = (table_key(&fk.schema_name, &fk.table_name), table_key(&target.schema_name, &target.table_name));
        if from == key {
            out.insert(to.clone());
        }
        if to == key {
            inbound.insert(from);
        }
    }
    (out, inbound)
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListTablesArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// Only tables whose name contains this text (case-insensitive).
    #[serde(default, rename = "match")]
    pub filter: Option<String>,
    /// Read the schema again instead of using the copy read in the last 5 minutes.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SchemaDbmlArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The tables to include (`schema.table`, or the table name when it is unique). Omit for the
    /// whole schema; a large schema then returns its table list and asks for a selection.
    #[serde(default)]
    pub tables: Vec<String>,
    /// Also include the tables directly related to the chosen ones (one relationship away).
    #[serde(default)]
    pub include_related: bool,
    /// Read the schema again instead of using the copy read in the last 5 minutes.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SavedDbmlArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// Which part of a long DBML, from 1 (the reply says how many there are).
    #[serde(default)]
    pub part: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TableArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableSummary {
    table: String,
    columns: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    note: String,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    references: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    referenced_by: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableDescription {
    table: String,
    #[serde(flatten)]
    info: TableInfo,
    /// The table in DBML: types, keys, defaults, notes, indexes, checks.
    dbml: String,
    /// Foreign keys from this table, and into it, as DBML `Ref`s.
    relationships: Vec<String>,
}

#[tool_router(router = schema_router, vis = "pub(crate)")]
impl XdiagramServer {
    #[tool(
        name = "list_tables",
        description = "The tables (and views) of a connection with their column count, note, and the tables each one references and is referenced by.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_tables(&self, Parameters(args): Parameters<ListTablesArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let schema = self.cache.get(&conn, args.refresh, &ct).await?;
        let filter = args.filter.as_deref().map(str::to_lowercase).filter(|f| !f.is_empty());
        let chosen: Vec<TableRef> = tables_of(&schema).into_iter().filter(|t| filter.as_ref().is_none_or(|f| t.key().to_lowercase().contains(f))).collect();
        let mut tables: Vec<TableSummary> = chosen
            .iter()
            .map(|t| {
                let (references, referenced_by) = neighbours(&schema, t);
                let key = t.key();
                TableSummary {
                    columns: schema.fields.get(&key).map_or(0, Vec::len),
                    note: schema.tables.iter().find(|x| x.name == t.table && x.schema_name == t.schema).map(|x| x.note.value.clone()).unwrap_or_default(),
                    references,
                    referenced_by,
                    table: key,
                }
            })
            .collect();
        let reply = serde_json::json!({ "count": tables.len(), "tables": tables }).to_string();
        if reply.len() <= MAX_REPLY_LEN {
            return text(reply);
        }
        // Many tables: the neighbours go first (describe_table and get_schema_dbml give them).
        for t in &mut tables {
            t.references.clear();
            t.referenced_by.clear();
        }
        let note = "references and referencedBy are left out to fit the reply; pass `match` for fewer tables with them, or see describe_table.";
        let reply = serde_json::json!({ "count": tables.len(), "tables": tables, "note": note }).to_string();
        if reply.len() <= MAX_REPLY_LEN {
            return text(reply);
        }
        Err(format!("{} tables are too many to describe in one reply; pass `match` to list some. Tables: {}", tables.len(), table_names(&chosen)))
    }

    #[tool(
        name = "get_schema_dbml",
        description = "The schema as DBML, exactly as xdiagram shows it: tables, columns with types, primary and unique keys, defaults, notes, indexes, checks, enums and relationships (Ref). Pass `tables` for part of a large schema, with `include_related` to add their direct neighbours.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_schema_dbml(&self, Parameters(args): Parameters<SchemaDbmlArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let schema = self.cache.get(&conn, args.refresh, &ct).await?;
        if args.tables.is_empty() {
            let dbml = to_dbml(&schema);
            if dbml.len() <= MAX_REPLY_LEN {
                return text(dbml);
            }
            let all = tables_of(&schema);
            return text(format!(
                "The whole schema is {} tables ({} characters of DBML), too much at once. Call get_schema_dbml again with `tables` (and `include_related` for their neighbours). Tables: {}",
                all.len(),
                dbml.len(),
                table_names(&all)
            ));
        }
        let mut keys: HashSet<String> = HashSet::new();
        for name in &args.tables {
            keys.insert(resolve_table(&schema, name)?.key());
        }
        if args.include_related {
            let chosen: Vec<TableRef> = tables_of(&schema).into_iter().filter(|t| keys.contains(&t.key())).collect();
            for t in chosen {
                let (out, inbound) = neighbours(&schema, &t);
                keys.extend(out);
                keys.extend(inbound);
            }
        }
        let dbml = to_dbml(&subset(&schema, &keys));
        if dbml.len() <= MAX_REPLY_LEN {
            return text(dbml);
        }
        let chosen: Vec<TableRef> = tables_of(&schema).into_iter().filter(|t| keys.contains(&t.key())).collect();
        text(format!(
            "These {} tables are {} characters of DBML, too much at once{}. Ask for fewer of them: {}",
            chosen.len(),
            dbml.len(),
            if args.include_related { " (include_related added their neighbours)" } else { "" },
            table_names(&chosen)
        ))
    }

    #[tool(
        name = "describe_table",
        description = "One table in detail: its columns with type, kind (int, text, timestamp…, which decides the filter operators that apply), nullability and enum values, the primary key, an estimate of the row count, the table as DBML, and its relationships. Reads no rows.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn describe_table(&self, Parameters(args): Parameters<TableArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let schema = self.cache.get(&conn, false, &ct).await?;
        let table = resolve_table(&schema, &args.table)?;
        conn.check_schema(&table.schema)?;
        let input = conn.input.clone();
        let (s, t) = (table.db_schema(), table.table.clone());
        let info = run_op(&ct, CATALOG_BUDGET, async move { dispatch::describe_table(&input, s, t).await }).await.map_err(|e| conn.explain(e))?;
        let one: HashSet<String> = [table.key()].into();
        let dbml = to_dbml(&subset(&schema, &one));
        let relationships: Vec<String> = schema
            .refs
            .iter()
            .filter(|r| r.endpoints.iter().any(|e| table_key(&e.schema_name, &e.table_name) == table.key()))
            .filter_map(|r| {
                let pair: HashSet<String> = r.endpoints.iter().map(|e| table_key(&e.schema_name, &e.table_name)).collect();
                let part = DatabaseSchema { refs: vec![r.clone()], ..subset(&schema, &pair) };
                to_dbml(&part).lines().find(|l| l.starts_with("Ref")).map(str::to_string)
            })
            .collect();
        json_text(&TableDescription { table: table.key(), info, dbml, relationships })
    }

    #[tool(
        name = "get_saved_dbml",
        description = "The DBML the user keeps for this database in xdiagram: the schema as last read, plus their own edits (notes, table groups, saved views, relationships they added). Useful for what the tables mean; it can be older than the database. A long one comes in parts (`part`).",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_saved_dbml(&self, Parameters(args): Parameters<SavedDbmlArgs>) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let drafts = Drafts::new(Some(self.access().data_dir().join("drafts")));
        let Some(raw) = drafts.load(&database_key(&conn.profile)).map_err(|e| e.to_string())? else {
            return Err(format!(
                "xdiagram has no saved DBML for \"{}\" yet: it is kept once the database has been opened in the app. Use get_schema_dbml for the schema itself.",
                conn.name()
            ));
        };
        let stored: Value = serde_json::from_str(&raw).map_err(|e| format!("The saved DBML could not be read: {e}"))?;
        let baseline = stored.get("baseline").and_then(Value::as_str).unwrap_or_default();
        let dbml = stored.get("dbml").and_then(Value::as_str);
        let saved_at = stored.get("savedAt").and_then(Value::as_str).unwrap_or("an unknown time");
        let edited = dbml.is_some_and(|d| d != baseline);
        let header = format!(
            "// Kept by xdiagram for \"{}\", saved {saved_at}{}.",
            conn.name(),
            if edited { ", with the user's edits" } else { " (no edits by the user)" }
        );
        // Room for the header and the part line.
        let parts = split_parts(dbml.unwrap_or(baseline), MAX_REPLY_LEN.saturating_sub(header.len() + 200).max(1_000));
        let n = args.part.unwrap_or(1);
        let Some(body) = n.checked_sub(1).and_then(|i| parts.get(i)) else {
            return Err(format!("The saved DBML has {} part(s); `part` goes from 1 to {}.", parts.len(), parts.len()));
        };
        let part_line = match (parts.len(), n < parts.len()) {
            (1, _) => String::new(),
            (total, true) => format!("// Part {n} of {total}: call get_saved_dbml with part {} for the next.\n", n + 1),
            (total, false) => format!("// Part {n} of {total}, the last.\n"),
        };
        text(format!("{header}\n{part_line}{body}"))
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
    fn resolves_table_names() {
        let s = schema();
        let r = |name: &str| resolve_table(&s, name);
        assert_eq!(r("users").unwrap(), TableRef { schema: "public".into(), table: "users".into() });
        assert_eq!(r("sales.invoices").unwrap().key(), "sales.invoices");
        assert_eq!(r("SALES.Invoices").unwrap().key(), "sales.invoices", "case-insensitive as a fallback");
        assert_eq!(r("\"regions\"").unwrap().key(), "sales.regions");
        let missing = r("order").unwrap_err();
        assert!(missing.contains("\"public.orders\"") && missing.contains("\"public.order_lines\""), "{missing}");
        assert!(r("zzz").unwrap_err().contains("list_tables"));
    }

    #[test]
    fn finds_ambiguous_names() {
        let mut s = schema();
        let mut dup = s.tables[0].clone();
        dup.schema_name = "sales".into();
        s.tables.push(dup);
        assert!(resolve_table(&s, "users").unwrap_err().contains("several schemas"));
        assert_eq!(resolve_table(&s, "sales.users").unwrap().schema, "sales");
    }

    #[test]
    fn splits_long_text_after_lines() {
        let text = "Table a {\n  id int\n}\n\nTable b {\n  id int\n}\n";
        let parts = split_parts(text, 25);
        assert_eq!(parts.concat(), text, "nothing lost");
        assert!(parts.iter().all(|p| p.len() <= 25 && p.ends_with('\n')), "{parts:?}");
        assert_eq!(split_parts("short", 25), ["short"]);
        // A line longer than a part is cut, on a character boundary.
        let long = "é".repeat(20);
        let parts = split_parts(&long, 7);
        assert_eq!(parts.concat(), long);
        assert!(parts.iter().all(|p| p.len() <= 7));
    }

    #[test]
    fn names_tables_or_counts_them() {
        let t = |schema: &str, table: String| TableRef { schema: schema.into(), table };
        assert_eq!(table_names(&[t("public", "a".into()), t("sales", "b".into())]), "public.a, sales.b");
        let many: Vec<TableRef> = (0..3000).map(|i| t(if i < 1000 { "public" } else { "sales" }, format!("table_number_{i}"))).collect();
        let text = table_names(&many);
        assert!(text.starts_with("3000 in all (public: 1000, sales: 2000)"), "{text}");
    }

    #[test]
    fn knows_the_neighbours() {
        let s = schema();
        let (out, inbound) = neighbours(&s, &resolve_table(&s, "orders").unwrap());
        assert_eq!(out.into_iter().collect::<Vec<_>>(), ["public.users", "sales.regions"]);
        assert_eq!(inbound.into_iter().collect::<Vec<_>>(), ["public.order_lines", "sales.invoices"]);
    }
}
