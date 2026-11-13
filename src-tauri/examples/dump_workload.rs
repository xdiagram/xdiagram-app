//! Dev tool: prints the X-ray `WorkloadReport` JSON for a connection URL.
//!
//!   cargo run --example dump_workload -- "postgres://user:pw@localhost:5432/db" [schema1,schema2]

use xdiagram_lib::db::{self, workload_db, ConnectionInput};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(url) = args.next() else {
        eprintln!("usage: dump_workload <postgres-url> [schema1,schema2]");
        std::process::exit(2);
    };
    let schemas: Vec<String> = args.next().map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default();
    let input = ConnectionInput { url: Some(url), ..Default::default() };

    let result = async {
        let client = db::connect(&input).await?;
        workload_db::analyze(&client, &schemas).await
    }
    .await;

    match result {
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report).expect("serialize")),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
