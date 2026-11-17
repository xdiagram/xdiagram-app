//! The Rust DBML writer against `@dbml/core`: each `tests/dbml/<name>.json` schema must give
//! exactly `<name>.dbml`, which `node scripts/dbml-fixtures.mjs` writes with
//! `importer.generateDbml` (regenerate after changing a fixture or upgrading @dbml/core).

use std::collections::HashSet;
use std::path::Path;

use xdiagram_core::db::DatabaseSchema;
use xdiagram_core::dbml::{subset, table_key, to_dbml};

fn fixture(name: &str) -> (DatabaseSchema, String) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("dbml");
    let json = std::fs::read_to_string(dir.join(format!("{name}.json"))).expect("fixture json");
    let dbml = std::fs::read_to_string(dir.join(format!("{name}.dbml"))).expect("fixture dbml; run node scripts/dbml-fixtures.mjs");
    (serde_json::from_str(&json).expect("schema json"), dbml.replace("\r\n", "\n"))
}

#[test]
fn matches_generate_dbml_for_every_fixture() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("dbml");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .collect();
    names.sort();
    assert!(names.len() >= 2, "fixtures missing");
    for name in names {
        let (schema, expected) = fixture(&name);
        let got = to_dbml(&schema);
        if got != expected {
            let line = got.lines().zip(expected.lines()).position(|(a, b)| a != b).unwrap_or(0);
            panic!(
                "{name}: differs from @dbml/core at line {}\n  rust:     {:?}\n  dbml/core: {:?}",
                line + 1,
                got.lines().nth(line),
                expected.lines().nth(line)
            );
        }
    }
}

#[test]
fn subset_keeps_tables_their_refs_and_enums() {
    let (schema, _) = fixture("pg");
    let keys: HashSet<String> = ["public.users", "public.orders"].iter().map(|s| s.to_string()).collect();
    let part = subset(&schema, &keys);
    assert_eq!(part.tables.iter().map(|t| table_key(&t.schema_name, &t.name)).collect::<Vec<_>>(), ["public.users", "public.orders"]);
    // orders → users stays; orders → sales.regions and the order_lines refs go.
    assert_eq!(part.refs.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["orders_user_id_fkey"]);
    // users.status and orders.kind use the two enums.
    assert_eq!(part.enums.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["user_status", "order_kind"]);
    let text = to_dbml(&part);
    assert!(text.contains("Table \"users\"") && text.contains("Table \"orders\"") && !text.contains("order_lines"));
    assert!(text.contains("Ref \"orders_user_id_fkey\":\"users\".\"id\" <? \"orders\".\"user_id\""));
}

#[test]
fn skips_what_generate_dbml_would_reject() {
    let (mut schema, expected) = fixture("mysql");
    // A second constraint over the same columns, the other way round, and one naming a column
    // that does not exist: `generateDbml` throws on both; the writer leaves them out.
    let mut dup = schema.refs[0].clone();
    dup.name = "books_dup".into();
    dup.endpoints.reverse();
    let mut broken = schema.refs[0].clone();
    broken.name = "books_broken".into();
    broken.endpoints[0].field_names = vec!["nope".into()];
    schema.refs.push(dup);
    schema.refs.push(broken);
    assert_eq!(to_dbml(&schema), expected);
}
