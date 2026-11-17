//! The server as an MCP client sees it: the real binary over stdio, against a data folder of its
//! own (never the app's) with SQLite copies of the sample schema, so no database server is needed.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    /// A data folder with `sample.db` (scripts/sample-schema.sqlite.sql) and these profiles.
    fn new(name: &str, profiles: impl FnOnce(&str) -> Value) -> Self {
        let dir = std::env::temp_dir().join(format!("xd-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("sample.db");
        let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/sample-schema.sqlite.sql")).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(&sql).unwrap();
        drop(conn);
        let profiles = profiles(&db.to_string_lossy());
        std::fs::write(dir.join("connections.json"), json!({ "profiles": profiles }).to_string()).unwrap();
        Fixture { dir }
    }

    fn client(&self) -> Client {
        Client::start(&self.dir)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn sqlite(id: &str, name: &str, path: &str, mcp: Value) -> Value {
    json!({ "id": id, "name": name, "engine": "sqlite", "path": path, "mcp": mcp })
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Client {
    fn start(data_dir: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_xdiagram-mcp"))
            .arg("--data-dir")
            .arg(data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start xdiagram-mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut client = Client { child, stdin, lines, next_id: 1 };
        let init = client.request(
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "stdio-test", "version": "1" } }),
        );
        assert_eq!(init["serverInfo"]["name"], "xdiagram");
        client.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        client
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let line = self.lines.recv_timeout(Duration::from_secs(60)).expect("a reply within 60 s");
            let message: Value = serde_json::from_str(&line).expect("stdout carries JSON-RPC only");
            if message["id"] == json!(id) {
                assert!(message.get("error").is_none(), "{method}: {message}");
                return message["result"].clone();
            }
        }
    }

    /// A tool's text and whether it is an error result.
    fn call(&mut self, tool: &str, arguments: Value) -> (String, bool) {
        let result = self.request("tools/call", json!({ "name": tool, "arguments": arguments }));
        let text = result["content"][0]["text"].as_str().unwrap_or_default().to_string();
        (text, result["isError"].as_bool().unwrap_or(false))
    }

    fn ok(&mut self, tool: &str, arguments: Value) -> String {
        let (text, is_error) = self.call(tool, arguments);
        assert!(!is_error, "{tool} failed: {text}");
        text
    }

    fn ok_json(&mut self, tool: &str, arguments: Value) -> Value {
        let text = self.ok(tool, arguments);
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{tool}: not JSON ({e}): {text}"))
    }

    fn err(&mut self, tool: &str, arguments: Value) -> String {
        let (text, is_error) = self.call(tool, arguments);
        assert!(is_error, "{tool} should fail, got: {text}");
        text
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn lists_only_connections_open_to_agents() {
    let fx = Fixture::new("list", |db| {
        json!([
            sqlite("lite", "Sample", db, json!({ "enabled": true, "data": "masked" })),
            sqlite("off", "Hidden", db, json!({ "enabled": false })),
            { "id": "old", "name": "Legacy", "host": "localhost" }
        ])
    });
    let mut c = fx.client();
    let tools = c.request("tools/list", json!({}));
    let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"list_connections") && names.contains(&"list_schemas"), "{names:?}");
    for tool in tools["tools"].as_array().unwrap() {
        assert_eq!(tool["annotations"]["readOnlyHint"], true, "{} is read-only", tool["name"]);
    }

    let list = c.ok_json("list_connections", json!({}));
    let conns = list["connections"].as_array().unwrap();
    assert_eq!(conns.len(), 1);
    assert_eq!((conns[0]["name"].as_str(), conns[0]["data"].as_str()), (Some("Sample"), Some("masked")));
    assert!(list["note"].as_str().unwrap().contains("2 more"));

    assert_eq!(c.ok_json("list_schemas", json!({ "connection": "sample" }))["schemas"], json!(["main"]));
    assert!(c.err("list_schemas", json!({ "connection": "Hidden" })).contains("does not allow AI agents"));
    assert!(c.err("list_schemas", json!({ "connection": "off" })).contains("does not allow AI agents"));
    assert!(c.err("list_schemas", json!({ "connection": "Nope" })).contains("\"Sample\""));
}

#[test]
fn says_how_to_turn_agents_on_when_nothing_is_shared() {
    let fx = Fixture::new("none", |db| json!([sqlite("off", "Hidden", db, json!({ "enabled": false }))]));
    let mut c = fx.client();
    let list = c.ok_json("list_connections", json!({}));
    assert_eq!(list["connections"], json!([]));
    assert!(list["note"].as_str().unwrap().contains("turn on \"AI agents\""));
}

#[test]
fn reads_the_schema_as_dbml() {
    let fx = Fixture::new("schema", |db| json!([sqlite("lite", "Sample", db, json!({ "enabled": true, "data": "schema" }))]));
    let mut c = fx.client();

    let list = c.ok_json("list_tables", json!({ "connection": "Sample" }));
    assert_eq!(list["count"], 4);
    let memberships = list["tables"].as_array().unwrap().iter().find(|t| t["table"] == "memberships").unwrap();
    assert_eq!(memberships["references"], json!(["organizations", "users"]));
    assert_eq!(memberships["referencedBy"], json!(["project_members"]));
    assert_eq!(c.ok_json("list_tables", json!({ "connection": "Sample", "match": "MEMBER" }))["count"], 2);

    let all = c.ok("get_schema_dbml", json!({ "connection": "Sample" }));
    assert!(all.contains("Table \"users\" {") && all.contains("Ref "), "{all}");
    let part = c.ok("get_schema_dbml", json!({ "connection": "Sample", "tables": ["users"] }));
    assert!(part.contains("Table \"users\"") && !part.contains("Table \"memberships\"") && !part.contains("Ref "), "{part}");
    let near = c.ok("get_schema_dbml", json!({ "connection": "Sample", "tables": ["users"], "include_related": true }));
    assert!(near.contains("Table \"memberships\"") && near.contains("Ref ") && !near.contains("Table \"project_members\""), "{near}");
    assert!(c.err("get_schema_dbml", json!({ "connection": "Sample", "tables": ["user"] })).contains("Did you mean \"users\""));

    // Reads no rows, so a schema-only connection may describe tables.
    let users = c.ok_json("describe_table", json!({ "connection": "Sample", "table": "USERS" }));
    assert_eq!(users["table"], "users");
    assert_eq!(users["primaryKey"], json!(["id"]));
    let email = users["columns"].as_array().unwrap().iter().find(|col| col["name"] == "email").unwrap();
    assert_eq!((email["kind"].as_str(), email["nullable"].as_bool()), (Some("text"), Some(false)));
    assert!(users["dbml"].as_str().unwrap().starts_with("Table \"users\""));
    assert_eq!(users["relationships"].as_array().unwrap().len(), 1, "memberships.user_id → users.id");
}

#[test]
fn reads_the_dbml_the_user_keeps_in_the_app() {
    let fx = Fixture::new("draft", |db| json!([sqlite("lite", "Sample", db, json!({ "enabled": true }))]));
    let mut c = fx.client();
    assert!(c.err("get_saved_dbml", json!({ "connection": "Sample" })).contains("no saved DBML"));

    // As the app stores it (DraftService): under the database's key, `dbml` null when unedited.
    let profile = xdiagram_core::profiles::load_profiles(&fx.dir).unwrap().remove(0);
    let drafts = xdiagram_core::drafts::Drafts::new(Some(fx.dir.join("drafts")));
    let key = xdiagram_core::profiles::database_key(&profile);
    let stored = json!({ "v": 1, "baseline": "Table a { id int }", "dbml": "Table a { id int [note: 'mine'] }\nTableGroup g { a }", "savedAt": "2026-11-17T10:00:00.000Z" });
    drafts.save(&key, &stored.to_string()).unwrap();
    let text = c.ok("get_saved_dbml", json!({ "connection": "Sample" }));
    assert!(text.contains("with the user's edits") && text.contains("TableGroup g") && text.contains("2026-11-17"), "{text}");
    drafts.save(&key, &json!({ "v": 1, "baseline": "Table a { id int }", "dbml": null, "savedAt": "x" }).to_string()).unwrap();
    assert!(c.ok("get_saved_dbml", json!({ "connection": "Sample" })).contains("no edits by the user"));
}

fn three_levels(db: &str) -> Value {
    json!([
        sqlite("m", "Masked", db, json!({ "enabled": true, "data": "masked" })),
        sqlite("f", "Full", db, json!({ "enabled": true, "data": "full" })),
        sqlite("s", "SchemaOnly", db, json!({ "enabled": true, "data": "schema" }))
    ])
}

#[test]
fn reads_rows_with_personal_data_masked() {
    let fx = Fixture::new("rows", three_levels);
    let mut c = fx.client();

    let page = c.ok_json("browse_rows", json!({ "connection": "Masked", "table": "users", "sort": [{ "column": "id" }] }));
    let email = page["columns"].as_array().unwrap().iter().position(|n| n == "email").unwrap();
    assert_eq!(page["rows"][0][email], "[masked: email]");
    assert_eq!(page["maskedColumns"]["email"], "email");
    let name = page["columns"].as_array().unwrap().iter().position(|n| n == "full_name").unwrap();
    assert_eq!(page["rows"][0][name], "[masked: name]", "full_name is a personal-data name");
    assert_eq!(page["hasMore"], false);

    let full = c.ok_json("browse_rows", json!({ "connection": "Full", "table": "users", "sort": [{ "column": "id" }] }));
    assert_eq!(full["rows"][0][email], "ann@x.io");
    assert!(full.get("maskedColumns").is_none());

    let refused = c.err("browse_rows", json!({ "connection": "SchemaOnly", "table": "users" }));
    assert!(refused.contains("schema only"), "{refused}");
    assert!(c.err("count_rows", json!({ "connection": "SchemaOnly", "table": "users" })).contains("schema only"));

    // Filtering still works on masked columns (the agent supplies the value).
    let one = c.ok_json(
        "browse_rows",
        json!({ "connection": "Masked", "table": "users", "columns": ["id", "role"], "include_sql": true,
                "filter": { "t": "group", "op": "and", "items": [{ "t": "cond", "column": "email", "op": "eq", "args": ["bob@x.io"] }] } }),
    );
    assert_eq!(one["columns"], json!(["id", "role"]));
    assert_eq!(one["rows"], json!([["2", "member"]]));
    assert!(one["sql"].as_str().unwrap().contains("bob@x.io"), "{}", one["sql"]);

    let count = c.ok_json("count_rows", json!({ "connection": "Masked", "table": "memberships",
        "filter": { "t": "rel", "schema": "public", "table": "organizations", "on": [["org_id", "id"]], "quant": "some",
                    "filter": { "t": "cond", "column": "slug", "op": "eq", "args": ["acme"] } } }));
    assert_eq!(count["count"], 1);

    let bad = c.err("browse_rows", json!({ "connection": "Masked", "table": "users",
        "filter": { "t": "cond", "column": "nope", "op": "eq", "args": ["1"] } }));
    assert!(bad.contains("nope"), "{bad}");
}

#[test]
fn counts_values_and_profiles_columns() {
    let fx = Fixture::new("stats", three_levels);
    let mut c = fx.client();
    let roles = c.ok_json("value_counts", json!({ "connection": "Masked", "table": "users", "column": "role" }));
    let values: Vec<&str> = roles["values"].as_array().unwrap().iter().filter_map(|v| v["value"].as_str()).collect();
    assert_eq!(values.len(), 2, "{roles}");
    assert!(c.err("value_counts", json!({ "connection": "Masked", "table": "users", "column": "email" })).contains("personal data"));
    let emails = c.ok_json("value_counts", json!({ "connection": "Full", "table": "users", "column": "email" }));
    assert_eq!(emails["values"].as_array().unwrap().len(), 2);

    let profile = c.ok_json("profile_table", json!({ "connection": "Masked", "table": "users" }));
    let email = profile["columns"].as_array().unwrap().iter().find(|col| col["name"] == "email").unwrap();
    assert_eq!(email["pii"], "email");
    assert_eq!(email["min"], "[masked: email]");
    assert!(email["top"].as_array().unwrap().iter().all(|t| t["value"] == "[masked: email]"));
    assert!(profile["masked"]["maskedColumns"]["email"].is_string());
}

#[test]
fn joins_tables() {
    let fx = Fixture::new("join", three_levels);
    let mut c = fx.client();
    let rows = c.ok_json(
        "run_join_query",
        json!({
            "connection": "Masked",
            "tables": [{ "table": "memberships", "alias": "m" }, { "table": "users", "alias": "u" }, { "table": "organizations", "alias": "o" }],
            "joins": [{ "alias": "u", "parent": "m", "on": [["user_id", "id"]] }, { "alias": "o", "parent": "m", "on": [["org_id", "id"]] }],
            "columns": [{ "alias": "o", "column": "name" }, { "alias": "u", "column": "email" }, { "alias": "m", "column": "joined_at" }],
            "order_by": { "alias": "m", "column": "joined_at" },
            "include_sql": true
        }),
    );
    assert_eq!(rows["rows"].as_array().unwrap().len(), 2, "{rows}");
    assert_eq!(rows["rows"][0][0], "Acme");
    assert_eq!(rows["rows"][0][1], "[masked: email]");
    assert!(rows["sql"].as_str().unwrap().to_uppercase().contains("JOIN"));
    assert!(c.err("run_join_query", json!({ "connection": "SchemaOnly", "tables": [{ "table": "users", "alias": "u" }], "joins": [] })).contains("schema only"));
}
