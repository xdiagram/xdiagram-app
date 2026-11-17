//! DBML text for an introspected [`DatabaseSchema`], the same text the app's editor shows.
//!
//! The app turns the schema JSON into DBML with `@dbml/core`'s `importer.generateDbml`; this is a
//! port of that path (`generateDatabase` + `DbmlExporter`) for programs without a JavaScript
//! engine, such as xdiagram-mcp. It reproduces its output byte for byte, quirks included, and
//! `npm run parity -- --dbml` checks that against real databases. Where `generateDbml` throws
//! (a duplicate relationship, an endpoint that names a missing column) this skips the item.

use std::collections::{BTreeMap, HashSet};

use crate::db::types::{CheckConstraint, ColumnConstraint, DatabaseSchema, Field, Index, Ref, RefEndpoint, Table};

/// `@dbml/core`'s default schema: elements in it are written without a schema name.
const DEFAULT_SCHEMA: &str = "public";

/// The key the schema JSON's dictionaries use for a table: `schema.table`, or just `table` for
/// engines without schemas in the connector output (MySQL, SQLite).
pub fn table_key(schema_name: &str, table_name: &str) -> String {
    if schema_name.is_empty() { table_name.to_string() } else { format!("{schema_name}.{table_name}") }
}

fn schema_of(name: &str) -> &str {
    if name.is_empty() { DEFAULT_SCHEMA } else { name }
}

/// `"schema".` before an element name, except for the default schema.
fn schema_prefix(schema: &str) -> String {
    if schema == DEFAULT_SCHEMA { String::new() } else { format!("\"{schema}\".") }
}

fn has_whitespace(s: &str) -> bool {
    s.chars().any(char::is_whitespace)
}

/// `DbmlExporter.escapeNote`: single quotes, or triple quotes for text with line breaks or quotes.
fn escape_note(note: &str) -> String {
    let t = note.replace('\\', "\\\\");
    if t.contains(['\n', '\r', '\'']) {
        format!("'''{}'''", t.replace('\'', "\\'").replace("\r\n", "\n"))
    } else {
        format!("'{t}'")
    }
}

// ---------------------------------------------------------------------------------- cardinality

#[derive(Clone, Copy, PartialEq, Eq)]
enum Max {
    One,
    Many,
    Other,
}

/// `parseCardinality`: `"1"`, `"*"` (one or more), `"0..1"`, `"0..*"`, `"1..*"`.
fn parse_cardinality(rel: &str) -> (u32, Max) {
    let max_of = |m: &str| match m {
        "*" => Max::Many,
        "1" => Max::One,
        _ => Max::Other,
    };
    match rel.split_once("..") {
        Some((min, max)) => (min.parse().unwrap_or(0), max_of(max)),
        None if rel == "*" => (1, Max::Many),
        None => (rel.parse().unwrap_or(1), max_of(rel)),
    }
}

/// `makeCardinalityRequired`: `0..1` becomes `1`, `0..*` becomes `*`.
fn make_required(rel: &str) -> String {
    match rel.strip_prefix("0..") {
        Some("1") => "1".into(),
        Some("*") => "*".into(),
        Some(max) => format!("1..{max}"),
        None => rel.to_string(),
    }
}

/// `getRelationshipOp`: `<`, `>`, `-` or `<>`, with `?` on an optional side.
fn relationship_op(left: &str, right: &str) -> String {
    let (lmin, lmax) = parse_cardinality(left);
    let (rmin, rmax) = parse_cardinality(right);
    let base = match (lmax == Max::Many, rmax == Max::Many) {
        (false, true) => "<",
        (true, false) => ">",
        (false, false) => "-",
        (true, true) => "<>",
    };
    format!("{}{base}{}", if lmin == 0 { "?" } else { "" }, if rmin == 0 { "?" } else { "" })
}

// ---------------------------------------------------------------------------------- the model

struct TableView<'a> {
    table: &'a Table,
    fields: &'a [Field],
    constraints: Option<&'a BTreeMap<String, ColumnConstraint>>,
    indexes: &'a [Index],
    checks: &'a [CheckConstraint],
}

impl TableView<'_> {
    fn constraint(&self, field: &str) -> Option<&ColumnConstraint> {
        self.constraints.and_then(|c| c.get(field))
    }

    fn is_pk(&self, field: &str) -> bool {
        self.constraint(field).and_then(|c| c.pk).unwrap_or(false)
    }

    fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }
}

/// One schema's elements, in the order `@dbml/core` creates and exports them.
#[derive(Default)]
struct SchemaElements<'a> {
    enums: Vec<&'a crate::db::types::Enum>,
    tables: Vec<TableView<'a>>,
    refs: Vec<&'a Ref>,
}

struct Model<'a> {
    /// Schemas in order of first use: by enums, then tables, then relationships (which always
    /// land in the default schema, as `generateDbml` gives them no schema).
    schemas: Vec<(&'a str, SchemaElements<'a>)>,
}

impl<'a> Model<'a> {
    fn schema_mut(&mut self, name: &'a str) -> &mut SchemaElements<'a> {
        let i = match self.schemas.iter().position(|(n, _)| *n == name) {
            Some(i) => i,
            None => {
                self.schemas.push((name, SchemaElements::default()));
                self.schemas.len() - 1
            }
        };
        &mut self.schemas[i].1
    }

    fn table(&self, schema: &str, name: &str) -> Option<&TableView<'a>> {
        let (_, elements) = self.schemas.iter().find(|(n, _)| *n == schema)?;
        elements.tables.iter().find(|t| t.table.name == name)
    }

    fn has_enum(&self, schema: &str, name: &str) -> bool {
        self.schemas.iter().any(|(n, e)| *n == schema && e.enums.iter().any(|en| en.name == name))
    }

    fn build(db: &'a DatabaseSchema) -> Self {
        let mut model = Model { schemas: Vec::new() };
        for e in &db.enums {
            model.schema_mut(schema_of(&e.schema_name)).enums.push(e);
        }
        let empty_fields: &[Field] = &[];
        for t in &db.tables {
            let key = table_key(&t.schema_name, &t.name);
            let view = TableView {
                table: t,
                fields: db.fields.get(&key).map(Vec::as_slice).unwrap_or(empty_fields),
                constraints: db.table_constraints.get(&key),
                indexes: db.indexes.get(&key).map(Vec::as_slice).unwrap_or(&[]),
                checks: db.checks.get(&key).map(Vec::as_slice).unwrap_or(&[]),
            };
            model.schema_mut(schema_of(&t.schema_name)).tables.push(view);
        }
        let mut seen: Vec<[(String, String, Vec<String>); 2]> = Vec::new();
        for r in &db.refs {
            if r.endpoints.len() != 2 || !r.endpoints.iter().all(|e| model.resolves(e)) {
                continue;
            }
            // `checkRef`: the same pair of endpoints, either way round, is a duplicate.
            let ends = [endpoint_id(&r.endpoints[0]), endpoint_id(&r.endpoints[1])];
            if ends[0] == ends[1] || seen.iter().any(|s| *s == ends || (s[0] == ends[1] && s[1] == ends[0])) {
                continue;
            }
            seen.push(ends);
            model.schema_mut(DEFAULT_SCHEMA).refs.push(r);
        }
        model
    }

    /// Whether an endpoint's table and columns exist (`generateDbml` throws otherwise).
    fn resolves(&self, e: &RefEndpoint) -> bool {
        match self.table(schema_of(&e.schema_name), &e.table_name) {
            Some(t) => !e.field_names.is_empty() && e.field_names.iter().all(|f| t.field(f).is_some()),
            None => false,
        }
    }
}

/// An endpoint's identity for duplicate detection: table and sorted columns.
fn endpoint_id(e: &RefEndpoint) -> (String, String, Vec<String>) {
    let mut cols = e.field_names.clone();
    cols.sort();
    (schema_of(&e.schema_name).to_string(), e.table_name.clone(), cols)
}

// ---------------------------------------------------------------------------------- writing

fn export_enum(schema: &str, e: &crate::db::types::Enum) -> String {
    let values: Vec<String> = e.values.iter().map(|v| format!("  \"{}\"", v.name)).collect();
    format!("Enum {}\"{}\" {{\n{}\n}}\n", schema_prefix(schema), e.name, values.join("\n"))
}

fn field_line(model: &Model, t: &TableView, f: &Field) -> String {
    // `Field.bindType`: a type with a schema that is not one of the schema's enums is renamed
    // `schema.type` (and still gets the schema prefix below, as in `@dbml/core`).
    let mut type_name = f.field_type.type_name.clone();
    let type_schema = f.field_type.schema_name.as_deref().filter(|s| !s.is_empty());
    if let Some(s) = type_schema
        && !model.has_enum(s, &type_name)
    {
        type_name = format!("{s}.{type_name}");
    }
    let prefix = match type_schema {
        Some(s) if s != DEFAULT_SCHEMA => {
            if has_whitespace(s) { format!("\"{s}\".") } else { format!("{s}.") }
        }
        _ => String::new(),
    };
    let quoted_type = if has_whitespace(&type_name) || type_name.contains(['[', ']']) { format!("\"{type_name}\"") } else { type_name };
    let mut line = format!("\"{}\" {prefix}{quoted_type}", f.name);

    let constraint = t.constraint(&f.name);
    let mut settings: Vec<String> = Vec::new();
    if constraint.and_then(|c| c.unique).unwrap_or(false) {
        settings.push("unique".into());
    }
    if constraint.and_then(|c| c.pk).unwrap_or(false) {
        settings.push("pk".into());
    }
    if f.not_null {
        settings.push("not null".into());
    }
    if f.increment {
        settings.push("increment".into());
    }
    if let Some(c) = constraint {
        settings.extend(c.checks.iter().map(|ch| format!("check: `{}`", ch.expression)));
    }
    if let Some(d) = &f.dbdefault {
        let skip = d.kind == "boolean" && d.value.eq_ignore_ascii_case("null");
        if !skip {
            let value = match d.kind.as_str() {
                "boolean" | "number" => d.value.clone(),
                "string" => {
                    let q = if d.value.contains('\n') { "'''" } else { "'" };
                    format!("{q}{}{q}", d.value)
                }
                _ => format!("`{}`", d.value),
            };
            settings.push(format!("default: {value}"));
        }
    }
    if !f.note.value.is_empty() {
        settings.push(format!("note: {}", escape_note(&f.note.value)));
    }
    if !settings.is_empty() {
        line.push_str(&format!(" [{}]", settings.join(", ")));
    }
    line
}

fn index_line(index: &Index) -> String {
    let cols: Vec<String> =
        index.columns.iter().map(|c| if c.kind == "expression" { format!("`{}`", c.value) } else { c.value.clone() }).collect();
    let mut line = match cols.len() {
        0 => String::new(),
        1 => cols[0].clone(),
        _ => format!("({})", cols.join(", ")),
    };
    let mut settings: Vec<String> = Vec::new();
    if index.pk.unwrap_or(false) {
        settings.push("pk".into());
    }
    if let Some(kind) = index.index_type.as_deref().filter(|k| !k.is_empty()) {
        settings.push(format!("type: {}", kind.to_lowercase()));
    }
    if index.unique.unwrap_or(false) {
        settings.push("unique".into());
    }
    if !index.name.is_empty() {
        settings.push(format!("name: \"{}\"", index.name));
    }
    if !settings.is_empty() {
        line.push_str(&format!(" [{}]", settings.join(", ")));
    }
    line
}

fn check_line(check: &CheckConstraint) -> String {
    match check.name.as_deref().filter(|n| !n.is_empty()) {
        Some(name) => format!("`{}` [name: '{name}']", check.expression),
        None => format!("`{}`", check.expression),
    }
}

fn export_table(model: &Model, schema: &str, t: &TableView) -> String {
    let fields: String = t.fields.iter().map(|f| format!("  {}\n", field_line(model, t, f))).collect();
    let checks = if t.checks.is_empty() {
        String::new()
    } else {
        format!("\n  Checks {{\n{}  }}\n", t.checks.iter().map(|c| format!("    {}\n", check_line(c))).collect::<String>())
    };
    let indexes = if t.indexes.is_empty() {
        String::new()
    } else {
        format!("\n  Indexes {{\n{}  }}\n", t.indexes.iter().map(|i| format!("    {}\n", index_line(i))).collect::<String>())
    };
    let note = if t.table.note.value.is_empty() { String::new() } else { format!("  Note: {}\n", escape_note(&t.table.note.value)) };
    format!("Table {}\"{}\" {{\n{fields}{checks}{indexes}{note}}}\n", schema_prefix(schema), t.table.name)
}

fn field_names(names: &[String]) -> String {
    let quoted: Vec<String> = names.iter().map(|n| format!("\"{n}\"")).collect();
    if quoted.len() == 1 { quoted[0].clone() } else { format!("({})", quoted.join(", ")) }
}

fn export_ref(model: &Model, r: &Ref) -> String {
    // `adjustCardinalitiesFromColumns`: the one side becomes required ("1") when every column of
    // the many side is NOT NULL, a primary key or auto-increment.
    let mut relations: Vec<String> = r.endpoints.iter().map(|e| e.relation.clone()).collect();
    let many = relations.iter().position(|rel| parse_cardinality(rel).1 == Max::Many);
    let one = relations.iter().position(|rel| parse_cardinality(rel).1 == Max::One);
    if let Some(one) = one {
        let (from, to) = match many {
            Some(many) => (many, one),
            None => (1, 0),
        };
        let e = &r.endpoints[from];
        let required = model.table(schema_of(&e.schema_name), &e.table_name).is_some_and(|t| {
            e.field_names.iter().all(|name| t.field(name).is_some_and(|f| f.not_null || f.increment || t.is_pk(name)))
        });
        if required {
            relations[to] = make_required(&relations[to]);
        }
    }

    // The one side is written first.
    let first = relations.iter().position(|rel| parse_cardinality(rel).1 == Max::One).unwrap_or(0);
    let second = 1 - first;
    let (a, b) = (&r.endpoints[first], &r.endpoints[second]);
    let mut line = String::from("Ref");
    if !r.name.is_empty() {
        line.push_str(&format!(" \"{}\"", r.name));
    }
    line.push(':');
    line.push_str(&format!("{}\"{}\".{} ", schema_prefix(schema_of(&a.schema_name)), a.table_name, field_names(&a.field_names)));
    line.push_str(&relationship_op(&relations[first], &relations[second]));
    line.push(' ');
    line.push_str(&format!("{}\"{}\".{}", schema_prefix(schema_of(&b.schema_name)), b.table_name, field_names(&b.field_names)));
    let mut settings: Vec<String> = Vec::new();
    if let Some(u) = r.on_update.as_deref().filter(|s| !s.is_empty()) {
        settings.push(format!("update: {}", u.to_lowercase()));
    }
    if let Some(d) = r.on_delete.as_deref().filter(|s| !s.is_empty()) {
        settings.push(format!("delete: {}", d.to_lowercase()));
    }
    if !settings.is_empty() {
        line.push_str(&format!(" [{}]", settings.join(", ")));
    }
    line.push('\n');
    line
}

/// The schema as DBML, exactly as `importer.generateDbml(schema)` writes it.
pub fn to_dbml(db: &DatabaseSchema) -> String {
    let model = Model::build(db);
    let mut parts: Vec<String> = Vec::new();
    for (name, elements) in &model.schemas {
        if !elements.enums.is_empty() {
            parts.push(elements.enums.iter().map(|e| export_enum(name, e)).collect::<Vec<_>>().join("\n"));
        }
        if !elements.tables.is_empty() {
            parts.push(elements.tables.iter().map(|t| export_table(&model, name, t)).collect::<Vec<_>>().join("\n"));
        }
        if !elements.refs.is_empty() {
            parts.push(elements.refs.iter().map(|r| export_ref(&model, r)).collect::<Vec<_>>().join("\n"));
        }
    }
    parts.join("\n")
}

/// The part of a schema about some tables (by [`table_key`]): those tables, the relationships
/// between them, and the enums their columns use.
pub fn subset(db: &DatabaseSchema, keys: &HashSet<String>) -> DatabaseSchema {
    fn pick<V: Clone>(map: &BTreeMap<String, V>, keys: &HashSet<String>) -> BTreeMap<String, V> {
        map.iter().filter(|(k, _)| keys.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    let keep = |schema: &str, table: &str| keys.contains(&table_key(schema, table));
    let fields = pick(&db.fields, keys);
    let used_types: HashSet<(String, String)> = fields
        .values()
        .flatten()
        .map(|f| (schema_of(f.field_type.schema_name.as_deref().unwrap_or("")).to_string(), f.field_type.type_name.clone()))
        .collect();
    DatabaseSchema {
        tables: db.tables.iter().filter(|t| keep(&t.schema_name, &t.name)).cloned().collect(),
        enums: db.enums.iter().filter(|e| used_types.contains(&(schema_of(&e.schema_name).to_string(), e.name.clone()))).cloned().collect(),
        table_constraints: pick(&db.table_constraints, keys),
        refs: db.refs.iter().filter(|r| r.endpoints.iter().all(|e| keep(&e.schema_name, &e.table_name))).cloned().collect(),
        indexes: pick(&db.indexes, keys),
        checks: pick(&db.checks, keys),
        fields,
    }
}
