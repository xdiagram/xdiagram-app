//! End to end against a real PostgreSQL with X-ray (the test container of the README, loaded with
//! scripts/sample-schema.sql and some runs of scripts/sample-workload.sql). Skipped unless
//! XDIAGRAM_TEST_PG is set:
//!
//!   XDIAGRAM_TEST_PG=postgres://postgres:xdiagram@127.0.0.1:55432/postgres cargo test -p xdiagram-mcp --test postgres -- --ignored
//!
//! The password goes to the OS keychain under a throwaway profile id, as the app saves it, and is
//! deleted again when the test ends (also when it fails). Nothing else of the app is touched.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};
use xdiagram_core::db::connect::password_binding;
use xdiagram_core::profiles::{ConnectionProfile, to_connection_input};
use xdiagram_core::secrets;

struct Keychain(String);

impl Drop for Keychain {
    fn drop(&mut self) {
        let _ = secrets::delete_password(&self.0);
        assert!(!secrets::has_secret(&self.0).unwrap_or(true), "the test password was removed from the keychain");
    }
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next: u64,
}

impl Client {
    fn call(&mut self, tool: &str, args: Value) -> (String, bool) {
        self.next += 1;
        let id = self.next;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        writeln!(self.stdin, "{msg}").unwrap();
        loop {
            let reply: Value = serde_json::from_str(&self.lines.recv_timeout(Duration::from_secs(120)).unwrap()).unwrap();
            if reply["id"] == json!(id) {
                let r = &reply["result"];
                return (r["content"][0]["text"].as_str().unwrap_or_default().to_string(), r["isError"].as_bool().unwrap_or(false));
            }
        }
    }

    fn ok(&mut self, tool: &str, args: Value) -> Value {
        let (text, err) = self.call(tool, args);
        assert!(!err, "{tool}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `postgres://user:password@host:port/database`
fn parse(url: &str) -> (String, String, String, u16, String) {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let (auth, rest) = rest.rsplit_once('@').expect("user:password@ in XDIAGRAM_TEST_PG");
    let (user, password) = auth.split_once(':').unwrap_or((auth, ""));
    let (hostport, db) = rest.split_once('/').unwrap_or((rest, "postgres"));
    let db = db.split('?').next().unwrap_or("postgres");
    let (host, port) = hostport.rsplit_once(':').map_or((hostport, 5432), |(h, p)| (h, p.parse().unwrap()));
    (user.into(), password.into(), host.into(), port, db.into())
}

#[test]
#[ignore = "needs XDIAGRAM_TEST_PG (a PostgreSQL test database)"]
fn postgres_end_to_end() {
    let Ok(url) = std::env::var("XDIAGRAM_TEST_PG") else {
        eprintln!("XDIAGRAM_TEST_PG is not set: skipped");
        return;
    };
    let (user, password, host, port, db) = parse(&url);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let id = format!("xdiagram-mcp-test-{}-{nanos}", std::process::id());
    let profiles = json!([
        { "id": id, "name": "Docker PG", "engine": "postgres", "host": host, "port": port, "database": db, "user": user,
          "sslMode": "disable", "schemas": [], "mcp": { "enabled": true, "data": "masked" } },
        { "id": format!("{id}-public"), "name": "Public only", "engine": "postgres", "host": host, "port": port, "database": db,
          "user": user, "sslMode": "disable", "schemas": ["public"], "mcp": { "enabled": true, "data": "schema" } }
    ]);
    let dir = std::env::temp_dir().join(format!("xd-mcp-pg-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("connections.json"), json!({ "profiles": profiles }).to_string()).unwrap();

    // Saved as the app saves it: bound to the server the connection describes.
    let profile = ConnectionProfile::from_json(&profiles[0]).unwrap();
    let _keychain = Keychain(id.clone());
    secrets::save_bound(&id, &password, &password_binding(&to_connection_input(&profile))).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_xdiagram-mcp"))
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = channel();
    std::thread::spawn(move || BufReader::new(stdout).lines().map_while(Result::ok).for_each(|l| drop(tx.send(l))));
    writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "pg-test", "version": "1" } } })).unwrap();
    lines.recv_timeout(Duration::from_secs(30)).unwrap();
    writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).unwrap();
    let mut c = Client { child, stdin, lines, next: 0 };

    let list = c.ok("list_connections", json!({}));
    assert_eq!(list["connections"][0]["passwordSaved"], true);

    let tables = c.ok("list_tables", json!({ "connection": "Docker PG" }));
    let names: Vec<&str> = tables["tables"].as_array().unwrap().iter().filter_map(|t| t["table"].as_str()).collect();
    assert!(names.contains(&"public.users") && names.contains(&"billing.invoices"), "{names:?}");
    let dbml = c.ok("get_schema_dbml", json!({ "connection": "Docker PG", "tables": ["billing.invoice_lines"], "include_related": true }));
    assert!(dbml.as_str().unwrap().contains("Table \"billing\".\"invoices\""), "{dbml}");

    let users = c.ok("browse_rows", json!({ "connection": "Docker PG", "table": "users", "limit": 3 }));
    let email = users["columns"].as_array().unwrap().iter().position(|n| n == "email").unwrap();
    assert!(users["rows"].as_array().unwrap().iter().all(|r| r[email] == "[masked: email]"), "{users}");

    // The scope of the second connection: public only, and no rows.
    let (scoped, _) = c.call("list_tables", json!({ "connection": "Public only" }));
    assert!(!scoped.contains("billing."), "{scoped}");
    let (refused, is_err) = c.call("browse_rows", json!({ "connection": "Public only", "table": "users" }));
    assert!(is_err && refused.contains("schema only"));

    let xray = c.ok("xray_report", json!({ "connection": "Docker PG" }));
    let joins: Vec<String> = xray["undeclaredJoins"].as_array().unwrap().iter().map(|j| format!("{} -> {}", j["from"], j["to"])).collect();
    assert!(joins.iter().any(|j| j.contains("public.events(user_id)") && j.contains("public.users(id)")), "run scripts/sample-workload.sql first: {joins:?}");
    assert!(xray["unusedTables"].as_array().unwrap().iter().any(|t| t == "public.legacy_notes"));

    let plain = c.ok("find_join_paths", json!({ "connection": "Docker PG", "from": "events", "to": "users" }));
    let with_xray = c.ok("find_join_paths", json!({ "connection": "Docker PG", "from": "events", "to": "users", "use_xray": true }));
    assert!(with_xray["paths"][0]["steps"][0]["kind"] == "discovered", "{with_xray}");
    assert!(plain.is_string() || plain["paths"][0]["hops"].as_u64() > with_xray["paths"][0]["hops"].as_u64(), "{plain}");

    let check = c.ok("check_relation", json!({ "connection": "Docker PG", "child_table": "events", "child_columns": ["user_id"], "parent_table": "users", "parent_columns": ["id"] }));
    assert!(check["sql"].as_str().unwrap().contains("FOREIGN KEY"), "{check}");
    assert!(check["checkedRows"].as_i64().unwrap() > 0);
    let _ = std::fs::remove_dir_all(&dir);
}
