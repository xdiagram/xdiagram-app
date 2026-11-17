//! Dev tool: reads `DatabaseSchema` JSON (as `dump_schema` prints it) on stdin and prints the DBML
//! the Rust writer makes of it. `scripts/parity.mjs` compares that with `@dbml/core`.
//!
//!   cargo run -q -p xdiagram-core --example schema_to_dbml < schema.json

use std::io::Read;

fn main() {
    let mut json = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut json) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
    match serde_json::from_str::<xdiagram_core::db::DatabaseSchema>(&json) {
        Ok(schema) => print!("{}", xdiagram_core::dbml::to_dbml(&schema)),
        Err(e) => {
            eprintln!("error: not a schema: {e}");
            std::process::exit(1);
        }
    }
}
