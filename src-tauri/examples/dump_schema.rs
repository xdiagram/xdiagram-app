//! Dev tool: prints the introspected `DatabaseSchema` JSON. Used by `scripts/parity.mjs` to
//! compare against `@dbml/connector`.
//!
//!   cargo run --example dump_schema -- "postgres://user:pw@localhost:5432/db" [schema1,schema2]
//!   cargo run --example dump_schema -- --engine mysql "mysql://user:pw@localhost:3306/db"
//!   cargo run --example dump_schema -- --engine mssql "Server=localhost,1433;Database=db;User Id=sa;Password=…;TrustServerCertificate=true" [schemas]
//!   cargo run --example dump_schema -- --engine sqlite path/to/file.db

use xdiagram_lib::db::{dispatch, ConnectionInput, Engine};

#[tokio::main]
async fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut engine = Engine::Postgres;
    if args.first().map(String::as_str) == Some("--engine") && args.len() >= 2 {
        engine = match args[1].as_str() {
            "postgres" => Engine::Postgres,
            "mysql" | "mariadb" => Engine::Mysql,
            "mssql" | "sqlserver" => Engine::Mssql,
            "sqlite" => Engine::Sqlite,
            other => {
                eprintln!("unknown engine {other}");
                std::process::exit(2);
            }
        };
        args.drain(0..2);
    }
    let Some(target) = args.first().cloned() else {
        eprintln!("usage: dump_schema [--engine postgres|mysql|mssql|sqlite] <url|path> [schema1,schema2]");
        std::process::exit(2);
    };
    let schemas: Vec<String> = args.get(1).map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default();
    let input = match engine {
        Engine::Sqlite => ConnectionInput { engine, path: Some(target), ..Default::default() },
        _ => ConnectionInput { engine, url: Some(target), ..Default::default() },
    };
    match dispatch::introspect(&input, &schemas).await {
        Ok(schema) => println!("{}", serde_json::to_string_pretty(&schema).expect("serialize")),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
