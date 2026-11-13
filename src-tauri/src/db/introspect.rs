//! Port of `@dbml/connector`'s PostgreSQL connector (connectors/postgres/index.ts).
//!
//! The SQL and the row mapping follow the original closely so that `importer.generateDbml`
//! produces the same DBML. Deliberate differences:
//! - the schema filter is a bind parameter (`$1::text[]`) instead of interpolated SQL;
//! - information_schema domain columns are cast to plain types so tokio-postgres can decode them;
//! - check constraints are ordered, so output is deterministic.

use std::collections::{BTreeMap, HashMap};

use tokio_postgres::{Client, Row};

use super::types::*;
use crate::error::AppError;

/// `(<no filter> OR <col> IN schemas)`, with schemas bound as `$1`.
pub(crate) fn schema_filter(column: &str) -> String {
    format!("(cardinality($1::text[]) = 0 OR {column}::text = ANY($1::text[]))")
}

pub async fn fetch_schema_json(client: &Client, schemas: &[String]) -> Result<DatabaseSchema, AppError> {
    let schemas: Vec<String> = schemas.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let checks_sql = check_list_sql();
    let (tables_and_fields, (indexes, mut table_constraints), checks_rows, refs, enums) = tokio::try_join!(
        generate_tables_and_fields(client, &schemas),
        generate_indexes_and_constraints(client, &schemas),
        async { Ok::<_, AppError>(client.query(checks_sql.as_str(), &[&schemas]).await?) },
        generate_raw_refs(client, &schemas),
        generate_raw_enums(client, &schemas),
    )?;
    let (tables, fields) = tables_and_fields;
    let checks = apply_checks(&checks_rows, &mut table_constraints);
    let refs = prune_dangling_refs(refs, &tables);

    Ok(DatabaseSchema { tables, fields, enums, table_constraints, refs, indexes, checks })
}

/// With a schema filter, a foreign key can point at a table outside the selected schemas.
/// `generateDbml` rejects such refs ("Can't find table"), so drop them. (Fixes a bug that
/// `@dbml/connector` itself has: it filters refs by the referencing schema only.)
pub(crate) fn prune_dangling_refs(refs: Vec<Ref>, tables: &[Table]) -> Vec<Ref> {
    let known: std::collections::HashSet<(&str, &str)> =
        tables.iter().map(|t| (t.schema_name.as_str(), t.name.as_str())).collect();
    refs.into_iter()
        .filter(|r| r.endpoints.iter().all(|e| known.contains(&(e.schema_name.as_str(), e.table_name.as_str()))))
        .collect()
}

/// Lists user schemas, for the schema picker.
pub async fn list_schemas(client: &Client) -> Result<Vec<String>, AppError> {
    let rows = client
        .query(
            "SELECT nspname::text FROM pg_namespace
             WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
               AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
             ORDER BY nspname",
            &[],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

// ---------------------------------------------------------------------------------------------
// JS semantics helpers
// ---------------------------------------------------------------------------------------------

/// `str.slice(start, end)` where `end` is negative (counted from the end), by chars.
fn js_slice(s: &str, start: usize, end_from_back: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    let end = chars.len().saturating_sub(end_from_back);
    if start >= end {
        return String::new();
    }
    chars[start..end].iter().collect()
}

/// `str.split('::')[0]`
fn before_cast(s: &str) -> &str {
    s.split("::").next().unwrap_or("")
}

/// JS truthiness of a nullable string.
fn truthy(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------------------------
// Tables and fields
// ---------------------------------------------------------------------------------------------

pub fn get_field_type(
    data_type: &str,
    udt_name: &str,
    character_maximum_length: Option<i32>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> String {
    if data_type == "ARRAY" {
        return format!("{}[]", udt_name.chars().skip(1).collect::<String>());
    }
    // Zero is falsy in the original, e.g. int4 has precision 32 / scale 0 -> plain "int4".
    if let Some(len) = character_maximum_length.filter(|v| *v != 0) {
        return format!("{udt_name}({len})");
    }
    if let (Some(p), Some(s)) = (numeric_precision.filter(|v| *v != 0), numeric_scale.filter(|v| *v != 0)) {
        return format!("{udt_name}({p},{s})");
    }
    udt_name.to_string()
}

pub fn get_dbdefault(data_type: &str, column_default: &str, default_type: &str) -> DefaultInfo {
    // Only a non-empty ARRAY[...] constructor is rewritten; other array defaults fall through.
    if data_type == "ARRAY" && column_default.starts_with("ARRAY[") && !column_default.starts_with("ARRAY[]") {
        let inner = js_slice(column_default, 6, 1);
        let values: Vec<&str> = inner.split(',').map(before_cast).collect();
        return DefaultInfo { kind: default_type.to_string(), value: format!("ARRAY[{}]", values.join(", ")) };
    }
    if default_type == "string" {
        let is_json = data_type == "json" || data_type == "jsonb";
        return DefaultInfo {
            kind: if is_json { "expression" } else { "string" }.to_string(),
            value: js_slice(before_cast(column_default), 1, 1),
        };
    }
    DefaultInfo { kind: default_type.to_string(), value: column_default.to_string() }
}

fn tables_and_fields_sql() -> String {
    format!(
        r#"
    WITH
      comments AS (
        SELECT DISTINCT ON (pc.relname, pn.nspname, pa.attname)
          pc.relname AS table_name,
          pn.nspname AS table_schema,
          pa.attname AS column_name,
          pd.description
        FROM pg_description pd
        JOIN pg_class pc ON pd.objoid = pc.oid
        JOIN pg_namespace pn ON pc.relnamespace = pn.oid
        LEFT JOIN pg_attribute pa ON pd.objoid = pa.attrelid AND pd.objsubid = pa.attnum
        WHERE pc.relkind = 'r'
          AND pn.nspname NOT IN ('pg_catalog', 'information_schema')
      ),
      table_positions AS (
        SELECT
          pc.oid AS table_ordinal_position,
          pc.relname AS table_name,
          pn.nspname AS table_schema
        FROM pg_class pc
        JOIN pg_namespace pn ON pc.relnamespace = pn.oid
        WHERE pc.relkind = 'r'
          AND pn.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND {pn_filter}
      )
    SELECT
      t.table_schema::text AS table_schema,
      t.table_name::text AS table_name,
      c.column_name::text AS column_name,
      c.data_type::text AS data_type,
      c.character_maximum_length::int4 AS character_maximum_length,
      c.numeric_precision::int4 AS numeric_precision,
      c.numeric_scale::int4 AS numeric_scale,
      c.udt_schema::text AS udt_schema,
      c.udt_name::text AS udt_name,
      c.identity_increment::text AS identity_increment,
      c.is_nullable::text AS is_nullable,
      c.column_default::text AS column_default,
      CASE
        WHEN c.column_default IS NULL THEN NULL
        WHEN c.column_default LIKE 'nextval(%' THEN 'increment'
        WHEN c.column_default LIKE '''%' THEN 'string'
        WHEN c.column_default = 'true' OR c.column_default = 'false' THEN 'boolean'
        WHEN c.column_default ~ '^-?[0-9]+(.[0-9]+)?$' THEN 'number'
        ELSE 'expression'
      END AS default_type,
      (SELECT description FROM comments WHERE table_name = t.table_name AND table_schema = t.table_schema AND column_name IS NULL LIMIT 1) AS table_comment,
      (SELECT description FROM comments WHERE table_name = t.table_name AND table_schema = t.table_schema AND column_name = c.column_name LIMIT 1) AS column_comment
    FROM information_schema.columns c
    JOIN information_schema.tables t ON c.table_name = t.table_name AND c.table_schema = t.table_schema
    JOIN table_positions tp ON tp.table_name = t.table_name AND tp.table_schema = t.table_schema
    WHERE t.table_type = 'BASE TABLE'
      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND {t_filter}
    ORDER BY t.table_schema, tp.table_ordinal_position, c.ordinal_position
    "#,
        pn_filter = schema_filter("pn.nspname"),
        t_filter = schema_filter("t.table_schema"),
    )
}

fn generate_field(row: &Row) -> Result<Field, AppError> {
    let data_type: String = row.try_get("data_type")?;
    let udt_name: String = row.try_get("udt_name")?;
    let udt_schema: Option<String> = row.try_get("udt_schema")?;
    let identity_increment: Option<String> = row.try_get("identity_increment")?;
    let is_nullable: Option<String> = row.try_get("is_nullable")?;
    let column_default: Option<String> = row.try_get("column_default")?;
    let default_type: Option<String> = row.try_get("default_type")?;
    let default_type_str = default_type.as_deref().unwrap_or("expression");

    let dbdefault = match &column_default {
        Some(d) if !d.is_empty() && default_type_str != "increment" => {
            Some(get_dbdefault(&data_type, d, default_type_str))
        }
        _ => None,
    };

    let field_type = if data_type == "USER-DEFINED" {
        TypeInfo { type_name: udt_name, schema_name: udt_schema }
    } else {
        TypeInfo {
            type_name: get_field_type(
                &data_type,
                &udt_name,
                row.try_get("character_maximum_length")?,
                row.try_get("numeric_precision")?,
                row.try_get("numeric_scale")?,
            ),
            schema_name: None,
        }
    };

    Ok(Field {
        name: row.try_get("column_name")?,
        field_type,
        dbdefault,
        not_null: is_nullable.as_deref() != Some("YES"),
        increment: truthy(&identity_increment) || default_type_str == "increment",
        note: NoteInfo::from_opt(row.try_get("column_comment")?),
    })
}

async fn generate_tables_and_fields(
    client: &Client,
    schemas: &[String],
) -> Result<(Vec<Table>, BTreeMap<String, Vec<Field>>), AppError> {
    let rows = client.query(tables_and_fields_sql().as_str(), &[&schemas]).await?;
    let mut tables: Vec<Table> = Vec::new();
    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut fields: BTreeMap<String, Vec<Field>> = BTreeMap::new();

    for row in &rows {
        let schema: String = row.try_get("table_schema")?;
        let name: String = row.try_get("table_name")?;
        let key = format!("{schema}.{name}");
        if seen.insert(key.clone(), ()).is_none() {
            tables.push(Table {
                name,
                schema_name: schema,
                note: NoteInfo::from_opt(row.try_get("table_comment")?),
            });
        }
        fields.entry(key).or_default().push(generate_field(row)?);
    }
    Ok((tables, fields))
}

// ---------------------------------------------------------------------------------------------
// Refs (foreign keys)
// ---------------------------------------------------------------------------------------------

fn refs_sql() -> String {
    format!(
        r#"
    SELECT
      source_ns.nspname::text AS table_schema,
      source_table.relname::text AS table_name,
      constraint_row.conname::text AS fk_constraint_name,
      STRING_AGG(source_column.attname::text, ',' ORDER BY key_column.ordinality) AS column_names,
      target_ns.nspname::text AS foreign_table_schema,
      target_table.relname::text AS foreign_table_name,
      STRING_AGG(target_column.attname::text, ',' ORDER BY key_column.ordinality) AS foreign_column_names,
      CASE constraint_row.confdeltype
        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
      END AS on_delete,
      CASE constraint_row.confupdtype
        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
      END AS on_update
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS source_table ON constraint_row.conrelid = source_table.oid
    JOIN pg_namespace AS source_ns ON source_table.relnamespace = source_ns.oid
    JOIN pg_class AS target_table ON constraint_row.confrelid = target_table.oid
    JOIN pg_namespace AS target_ns ON target_table.relnamespace = target_ns.oid
    JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS key_column(source_attnum, target_attnum, ordinality) ON TRUE
    JOIN pg_attribute AS source_column
      ON source_column.attrelid = source_table.oid AND source_column.attnum = key_column.source_attnum
    JOIN pg_attribute AS target_column
      ON target_column.attrelid = target_table.oid AND target_column.attnum = key_column.target_attnum
    WHERE constraint_row.contype = 'f'
      AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND {filter}
    GROUP BY
      source_ns.nspname, source_table.relname, constraint_row.conname,
      target_ns.nspname, target_table.relname, constraint_row.confdeltype, constraint_row.confupdtype
    ORDER BY source_ns.nspname, source_table.relname
    "#,
        filter = schema_filter("source_ns.nspname"),
    )
}

fn non_default_action(action: Option<String>) -> Option<String> {
    action.filter(|a| a != "NO ACTION")
}

pub(crate) async fn generate_raw_refs(client: &Client, schemas: &[String]) -> Result<Vec<Ref>, AppError> {
    let rows = client.query(refs_sql().as_str(), &[&schemas]).await?;
    let split = |s: String| s.split(',').map(str::to_string).collect::<Vec<_>>();
    rows.iter()
        .map(|row| {
            Ok(Ref {
                name: row.try_get("fk_constraint_name")?,
                endpoints: vec![
                    RefEndpoint {
                        table_name: row.try_get("table_name")?,
                        schema_name: row.try_get("table_schema")?,
                        field_names: split(row.try_get("column_names")?),
                        relation: "0..*".into(),
                    },
                    RefEndpoint {
                        table_name: row.try_get("foreign_table_name")?,
                        schema_name: row.try_get("foreign_table_schema")?,
                        field_names: split(row.try_get("foreign_column_names")?),
                        relation: "0..1".into(),
                    },
                ],
                on_delete: non_default_action(row.try_get("on_delete")?),
                on_update: non_default_action(row.try_get("on_update")?),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Indexes, inline PK/unique constraints, checks
// ---------------------------------------------------------------------------------------------

/// One row per index, with its *key* columns listed position by position.
///
/// Deliberately different from the connector, which aggregated column names into one string and
/// split `pg_get_expr(indexprs)` on every comma. That breaks expressions containing commas, e.g.
/// `COALESCE(a, '*'::text)`, into fragments; two such expressions yield duplicate fragments and
/// `generateDbml` fails with "Index column ... existed". Reading each key position separately
/// (`pg_get_indexdef(index, k)` for expressions, `attname` for columns) keeps expressions whole,
/// keeps column/expression order, keeps expression-only indexes (the connector dropped them) and
/// excludes `INCLUDE` columns. Requires PostgreSQL 11+ (`indnkeyatts`).
fn index_list_sql() -> String {
    format!(
        r#"
    SELECT
      n.nspname::text AS table_schema,
      t.relname::text AS table_name,
      i.relname::text AS index_name,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      am.amname::text AS index_type,
      ARRAY(
        SELECT CASE WHEN ix.indkey[k.pos] = 0 THEN 'expression' ELSE 'column' END
        FROM generate_series(0, ix.indnkeyatts - 1) AS k(pos)
        ORDER BY k.pos
      ) AS key_kinds,
      ARRAY(
        SELECT CASE
          WHEN ix.indkey[k.pos] = 0 THEN pg_get_indexdef(ix.indexrelid, k.pos + 1, true)
          ELSE (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ix.indkey[k.pos])
        END
        FROM generate_series(0, ix.indnkeyatts - 1) AS k(pos)
        ORDER BY k.pos
      ) AS key_values,
      CASE
        WHEN ix.indisprimary THEN 'PRIMARY KEY'
        WHEN ix.indisunique THEN 'UNIQUE'
        ELSE NULL
      END AS constraint_type
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE t.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND t.relname NOT LIKE 'pg_%'
      AND t.relname NOT LIKE 'sql_%'
      AND {filter}
    ORDER BY t.relname, constraint_type, i.relname
    "#,
        filter = schema_filter("n.nspname"),
    )
}

fn check_list_sql() -> String {
    format!(
        r#"
    SELECT
      n.nspname::text AS table_schema,
      c.relname::text AS table_name,
      MAX(a.attname)::text AS column_name,
      con.conname::text AS check_name,
      pg_get_constraintdef(con.oid) AS check_definition,
      CASE WHEN COUNT(*) = 1 THEN TRUE ELSE FALSE END AS is_column_constraint
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON con.conrelid = c.oid
    LEFT JOIN pg_catalog.pg_namespace AS n ON c.relnamespace = n.oid
    LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'c'
      AND {filter}
    GROUP BY con.conname, n.nspname, c.relname, con.oid
    ORDER BY n.nspname, c.relname, con.conname
    "#,
        filter = schema_filter("n.nspname"),
    )
}

type TableConstraints = BTreeMap<String, BTreeMap<String, ColumnConstraint>>;

/// The inline/out-of-line split: a PK or UNIQUE index on a single plain column becomes a column
/// setting (`[pk]` / `[unique]`); everything else becomes an entry in the table's `indexes` block.
pub fn split_indexes(rows: Vec<IndexRow>) -> (BTreeMap<String, Vec<Index>>, TableConstraints) {
    let mut indexes: BTreeMap<String, Vec<Index>> = BTreeMap::new();
    let mut constraints: TableConstraints = BTreeMap::new();

    for row in rows {
        // `@dbml/core` rejects an index that lists the same column/expression twice
        // ("Index column ... existed"), which PostgreSQL allows; keep the first occurrence.
        let mut columns: Vec<IndexColumn> = Vec::with_capacity(row.columns.len());
        for col in row.columns {
            if !col.value.trim().is_empty() && !columns.iter().any(|c| c.kind == col.kind && c.value == col.value) {
                columns.push(col);
            }
        }
        if columns.is_empty() {
            continue;
        }
        let key = format!("{}.{}", row.table_schema, row.table_name);
        let ctype = row.constraint_type.as_deref();
        let is_inline = columns.len() == 1
            && columns[0].kind == "column"
            && matches!(ctype, Some("PRIMARY KEY") | Some("UNIQUE"));

        if is_inline {
            let entry = constraints.entry(key).or_default().entry(columns[0].value.clone()).or_default();
            if ctype == Some("PRIMARY KEY") {
                entry.pk = Some(true);
            }
            if ctype == Some("UNIQUE") && entry.pk != Some(true) {
                entry.unique = Some(true);
            }
            continue;
        }

        indexes.entry(key).or_default().push(Index {
            name: row.index_name,
            index_type: Some(row.index_type),
            columns,
            pk: Some(row.is_primary),
            unique: Some(!row.is_primary && row.is_unique),
        });
    }
    (indexes, constraints)
}

pub struct IndexRow {
    pub table_schema: String,
    pub table_name: String,
    pub index_name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub index_type: String,
    /// Key columns in index order; `kind` is "column" or "expression".
    pub columns: Vec<IndexColumn>,
    pub constraint_type: Option<String>,
}

async fn generate_indexes_and_constraints(
    client: &Client,
    schemas: &[String],
) -> Result<(BTreeMap<String, Vec<Index>>, TableConstraints), AppError> {
    let rows = client.query(index_list_sql().as_str(), &[&schemas]).await?;
    let rows = rows
        .iter()
        .map(|r| {
            let kinds: Vec<Option<String>> = r.try_get("key_kinds")?;
            let values: Vec<Option<String>> = r.try_get("key_values")?;
            let columns = kinds
                .into_iter()
                .zip(values)
                .filter_map(|(kind, value)| Some(IndexColumn { kind: kind?, value: value? }))
                .collect();
            Ok(IndexRow {
                table_schema: r.try_get("table_schema")?,
                table_name: r.try_get("table_name")?,
                index_name: r.try_get("index_name")?,
                is_unique: r.try_get::<_, Option<bool>>("is_unique")?.unwrap_or(false),
                is_primary: r.try_get::<_, Option<bool>>("is_primary")?.unwrap_or(false),
                index_type: r.try_get("index_type")?,
                columns,
                constraint_type: r.try_get("constraint_type")?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(split_indexes(rows))
}

/// JS: `def.match(/CHECK \(\(.*\)\)/)` — `.` does not cross line breaks.
fn looks_like_check(def: &str) -> bool {
    def.match_indices("CHECK ((").any(|(i, _)| {
        let rest = &def[i + "CHECK ((".len()..];
        let line = rest.split(['\n', '\r', '\u{2028}', '\u{2029}']).next().unwrap_or("");
        line.contains("))")
    })
}

/// `CHECK ((expr))` -> `expr`  (original: `slice(8, -2)`)
pub fn check_expression(def: &str) -> Option<String> {
    looks_like_check(def).then(|| js_slice(def, 8, 2))
}

fn apply_checks(rows: &[Row], constraints: &mut TableConstraints) -> BTreeMap<String, Vec<CheckConstraint>> {
    let mut checks: BTreeMap<String, Vec<CheckConstraint>> = BTreeMap::new();
    for row in rows {
        let schema: Option<String> = row.get("table_schema");
        let table: Option<String> = row.get("table_name");
        let def: Option<String> = row.get("check_definition");
        let (Some(schema), Some(table), Some(def)) = (schema, table, def) else { continue };
        let Some(expression) = check_expression(&def) else { continue };
        let column: Option<String> = row.get("column_name");
        let is_column_constraint: bool = row.get::<_, Option<bool>>("is_column_constraint").unwrap_or(false);
        let name: Option<String> = row.get::<_, Option<String>>("check_name").filter(|n| !n.is_empty());
        let key = format!("{schema}.{table}");
        let check = CheckConstraint { name, expression };

        if is_column_constraint {
            let Some(column) = column else { continue };
            constraints.entry(key).or_default().entry(column).or_default().checks.push(check);
        } else {
            checks.entry(key).or_default().push(check);
        }
    }
    checks
}

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

async fn generate_raw_enums(client: &Client, schemas: &[String]) -> Result<Vec<Enum>, AppError> {
    let sql = format!(
        r#"
    SELECT DISTINCT
      n.nspname AS schema_name,
      t.typname AS enum_type,
      e.enumlabel AS enum_value,
      e.enumsortorder AS sort_order
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE {filter}
    ORDER BY schema_name, enum_type, sort_order
    "#,
        filter = schema_filter("n.nspname"),
    );
    let rows = client.query(sql.as_str(), &[&schemas]).await?;
    let mut enums: Vec<Enum> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in &rows {
        // `name` columns decode natively; keeping them uncast preserves the C-collation ordering.
        let schema: String = row.try_get("schema_name")?;
        let name: String = row.try_get("enum_type")?;
        let value: String = row.try_get("enum_value")?;
        let key = format!("{schema}.{name}");
        let i = *index.entry(key).or_insert_with(|| {
            enums.push(Enum { name, schema_name: schema, values: Vec::new() });
            enums.len() - 1
        });
        enums[i].values.push(EnumValue { name: value });
    }
    Ok(enums)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_types() {
        assert_eq!(get_field_type("ARRAY", "_int4", None, None, None), "int4[]");
        assert_eq!(get_field_type("character varying", "varchar", Some(255), None, None), "varchar(255)");
        assert_eq!(get_field_type("integer", "int4", None, Some(32), Some(0)), "int4");
        assert_eq!(get_field_type("numeric", "numeric", None, Some(10), Some(2)), "numeric(10,2)");
        assert_eq!(get_field_type("numeric", "numeric", None, None, None), "numeric");
        assert_eq!(get_field_type("text", "text", None, None, None), "text");
    }

    #[test]
    fn defaults() {
        let d = get_dbdefault("character varying", "'active'::character varying", "string");
        assert_eq!((d.kind.as_str(), d.value.as_str()), ("string", "active"));

        let d = get_dbdefault("jsonb", "'{}'::jsonb", "string");
        assert_eq!((d.kind.as_str(), d.value.as_str()), ("expression", "{}"));

        let d = get_dbdefault("ARRAY", "ARRAY['a'::text, 'b'::text]", "expression");
        assert_eq!(d.value, "ARRAY['a',  'b']");

        let d = get_dbdefault("ARRAY", "ARRAY[]::text[]", "expression");
        assert_eq!(d.value, "ARRAY[]::text[]");

        let d = get_dbdefault("timestamp without time zone", "now()", "expression");
        assert_eq!((d.kind.as_str(), d.value.as_str()), ("expression", "now()"));
    }

    #[test]
    fn checks() {
        assert_eq!(check_expression("CHECK ((price > (0)::numeric))").as_deref(), Some("price > (0)::numeric"));
        assert_eq!(check_expression("CHECK (price > 0)"), None);
        assert_eq!(check_expression("CHECK ((a > 0\n))"), None);
    }

    /// `cols`: plain names are columns, `=expr` entries are expressions.
    fn idx(name: &str, cols: &[&str], ctype: Option<&str>, unique: bool, primary: bool) -> IndexRow {
        IndexRow {
            table_schema: "public".into(),
            table_name: "t".into(),
            index_name: name.into(),
            is_unique: unique,
            is_primary: primary,
            index_type: "btree".into(),
            columns: cols
                .iter()
                .map(|c| match c.strip_prefix('=') {
                    Some(e) => IndexColumn { kind: "expression".into(), value: e.into() },
                    None => IndexColumn { kind: "column".into(), value: (*c).into() },
                })
                .collect(),
            constraint_type: ctype.map(str::to_string),
        }
    }

    fn values(index: &Index) -> Vec<(&str, &str)> {
        index.columns.iter().map(|c| (c.kind.as_str(), c.value.as_str())).collect()
    }

    #[test]
    fn index_split() {
        let (indexes, constraints) = split_indexes(vec![
            idx("t_pkey", &["id"], Some("PRIMARY KEY"), true, true),
            idx("t_email_key", &["email"], Some("UNIQUE"), true, false),
            idx("t_a_b_key", &["a", "b"], Some("UNIQUE"), true, false),
            idx("t_name_idx", &["name"], None, false, false),
            idx("t_empty_idx", &[], None, false, false),
        ]);
        let cols = &constraints["public.t"];
        assert_eq!(cols["id"].pk, Some(true));
        assert_eq!(cols["email"].unique, Some(true));
        let idxs = &indexes["public.t"];
        assert_eq!(idxs.len(), 2);
        assert_eq!(idxs[0].name, "t_a_b_key");
        assert!(idxs[0].unique == Some(true) && idxs[0].pk == Some(false));
        assert_eq!(values(&idxs[0]), [("column", "a"), ("column", "b")]);
        assert_eq!(idxs[1].name, "t_name_idx");
    }

    #[test]
    fn expression_indexes() {
        let (indexes, constraints) = split_indexes(vec![
            // Expressions containing commas stay whole, in key order, mixed with columns.
            idx(
                "t_coalesce_idx",
                &["=COALESCE(a, '*'::text)", "role", "=COALESCE(b, '*'::text)"],
                None,
                false,
                false,
            ),
            // A unique index on a single expression is not a column setting.
            idx("t_lower_slug_key", &["=lower(slug)"], Some("UNIQUE"), true, false),
            // PostgreSQL allows repeating a column; @dbml/core does not.
            idx("t_dup_idx", &["a", "a", "b"], None, false, false),
        ]);
        assert!(!constraints.contains_key("public.t"));
        let idxs = &indexes["public.t"];
        assert_eq!(
            values(&idxs[0]),
            [("expression", "COALESCE(a, '*'::text)"), ("column", "role"), ("expression", "COALESCE(b, '*'::text)")]
        );
        assert_eq!(values(&idxs[1]), [("expression", "lower(slug)")]);
        assert_eq!(idxs[1].unique, Some(true));
        assert_eq!(values(&idxs[2]), [("column", "a"), ("column", "b")]);
    }
}
