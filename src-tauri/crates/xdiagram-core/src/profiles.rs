//! The app's saved connections (`connections.json` in the app data folder), read for programs
//! other than the app, such as xdiagram-mcp. The frontend owns the file (`ProfilesService` in
//! `src/app/persistence/profiles.service.ts`); this reads it leniently, like `normalizeProfile`,
//! and never writes it.
//!
//! [`to_connection_input`] must build exactly what `toConnectionInput()` sends from the app: a
//! saved password is bound to the server it was typed for (`connect::password_binding`), so any
//! difference would make the keychain refuse it. `src/app/persistence/profile-cases.json` holds
//! cases both sides are tested against.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::ssh::{SshAuth, SshConfig};
use crate::db::{ConnectionInput, Engine, SslMode};
use crate::error::AppError;

/// The app's store of saved connections, in its data folder.
pub const CONNECTIONS_FILE: &str = "connections.json";

/// How much an AI agent may read through xdiagram-mcp (`ConnectionProfile.mcp.data`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataAccess {
    /// The schema only: no query reads rows.
    Schema,
    /// Rows, with values that look like personal data masked.
    #[default]
    Masked,
    /// Rows as they are.
    Full,
}

/// Whether AI agents may use a connection through xdiagram-mcp; off unless the user turns it on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct McpAccess {
    pub enabled: bool,
    pub data: DataAccess,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshSettings {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub key_path: String,
}

/// A saved connection (`ConnectionProfile` in `profiles.service.ts`). No password: that is in the
/// OS keychain, under the profile id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    /// Schemas to include; empty means all user schemas.
    pub schemas: Vec<String>,
    /// SQLite database file.
    pub path: String,
    pub ssh: Option<SshSettings>,
    pub mcp: McpAccess,
}

/// `ENGINES` in `profiles.service.ts`: default port, user and database of a new profile.
fn engine_defaults(engine: Engine) -> (u16, &'static str, &'static str) {
    match engine {
        Engine::Postgres => (5432, "postgres", "postgres"),
        Engine::Mysql => (3306, "root", ""),
        Engine::Mssql => (1433, "sa", "master"),
        Engine::Sqlite => (0, "", ""),
    }
}

fn parse_enum<T: serde::de::DeserializeOwned>(v: Option<&Value>) -> Option<T> {
    v.and_then(|v| serde_json::from_value(v.clone()).ok())
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn port(v: Option<&Value>) -> Option<u16> {
    match v? {
        Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

impl ConnectionProfile {
    /// One saved profile, with the defaults `normalizeProfile` fills in for fields added after it
    /// was saved (older profiles are PostgreSQL, without SSH or MCP settings). `None` without an id.
    pub fn from_json(v: &Value) -> Option<Self> {
        let id = text(v.get("id")).filter(|id| !id.is_empty())?;
        let engine: Engine = parse_enum(v.get("engine")).unwrap_or_default();
        let (default_port, default_user, default_db) = engine_defaults(engine);
        let ssh = v.get("ssh").filter(|s| s.is_object()).map(|s| SshSettings {
            host: text(s.get("host")).unwrap_or_default(),
            port: port(s.get("port")).unwrap_or(22),
            user: text(s.get("user")).unwrap_or_default(),
            auth: parse_enum(s.get("auth")).unwrap_or_default(),
            key_path: text(s.get("keyPath")).unwrap_or_default(),
        });
        let mcp = v.get("mcp").map_or_else(McpAccess::default, |m| McpAccess {
            enabled: m.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            data: parse_enum(m.get("data")).unwrap_or_default(),
        });
        Some(ConnectionProfile {
            name: text(v.get("name")).unwrap_or_default(),
            engine,
            host: text(v.get("host")).unwrap_or_else(|| "localhost".into()),
            port: port(v.get("port")).unwrap_or(default_port),
            database: text(v.get("database")).unwrap_or_else(|| default_db.into()),
            user: text(v.get("user")).unwrap_or_else(|| default_user.into()),
            ssl_mode: parse_enum(v.get("sslMode")).unwrap_or_default(),
            schemas: v
                .get("schemas")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            path: text(v.get("path")).unwrap_or_default(),
            ssh,
            mcp,
            id,
        })
    }

    /// `profileLabel`: the name, else the file name (SQLite) or `database@host`.
    pub fn label(&self) -> String {
        let name = self.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
        if self.engine == Engine::Sqlite {
            let base = self.path.rsplit(['/', '\\']).next().unwrap_or("");
            return if base.is_empty() { "SQLite file".into() } else { base.to_string() };
        }
        let db = if self.database.is_empty() { "(default)" } else { &self.database };
        format!("{db}@{}", self.host)
    }
}

/// `toConnectionInput(profile)` without a typed password: the keychain supplies it.
pub fn to_connection_input(p: &ConnectionProfile) -> ConnectionInput {
    if p.engine == Engine::Sqlite {
        return ConnectionInput { engine: Engine::Sqlite, path: Some(p.path.clone()), profile_id: Some(p.id.clone()), ..Default::default() };
    }
    ConnectionInput {
        engine: p.engine,
        host: Some(p.host.clone()),
        port: Some(p.port),
        database: Some(p.database.clone()),
        user: Some(p.user.clone()),
        ssl_mode: Some(p.ssl_mode),
        profile_id: Some(p.id.clone()),
        ssh: p.ssh.as_ref().map(|s| SshConfig {
            host: s.host.trim().to_string(),
            port: Some(if s.port == 0 { 22 } else { s.port }),
            user: s.user.trim().to_string(),
            auth: s.auth,
            key_path: (s.auth == SshAuth::Key).then(|| s.key_path.trim().to_string()),
            secret: None,
            trust: None,
        }),
        ..Default::default()
    }
}

/// `databaseKeyOf(profile)`: the key the app keeps a database's layout, edited DBML (drafts) and
/// remembered filters under.
pub fn database_key(p: &ConnectionProfile) -> String {
    if p.engine == Engine::Sqlite {
        return format!("db:sqlite:{}", p.path);
    }
    let via = match &p.ssh {
        Some(s) if !s.host.is_empty() => format!("@ssh:{}:{}", s.host, if s.port == 0 { 22 } else { s.port }),
        _ => String::new(),
    };
    match p.engine {
        Engine::Postgres => format!("db:{}:{}/{}{via}", p.host, p.port, p.database),
        engine => format!("db:{}:{}:{}/{}{via}", engine_name(engine), p.host, p.port, p.database),
    }
}

/// The engine as the app writes it (`postgres`, `mysql`, `mssql`, `sqlite`).
pub fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "postgres",
        Engine::Mysql => "mysql",
        Engine::Mssql => "mssql",
        Engine::Sqlite => "sqlite",
    }
}

/// The saved connections in `data_dir`, read-only. No file means none saved.
pub fn load_profiles(data_dir: &Path) -> Result<Vec<ConnectionProfile>, AppError> {
    let path = data_dir.join(CONNECTIONS_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Invalid(format!("The saved connections ({}) could not be read: {e}", path.display())))?;
    Ok(json.get("profiles").and_then(Value::as_array).map(|list| list.iter().filter_map(ConnectionProfile::from_json).collect()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect::password_binding;

    /// The cases `profiles.spec.ts` checks too: each profile, the JSON `toConnectionInput` makes
    /// of it (no password), and its database key.
    fn cases() -> Vec<Value> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/app/persistence/profile-cases.json");
        let text = std::fs::read_to_string(&path).expect("profile-cases.json");
        serde_json::from_str::<Value>(&text).unwrap()["cases"].as_array().unwrap().clone()
    }

    #[test]
    fn builds_the_same_connection_as_the_app() {
        let cases = cases();
        assert!(cases.len() >= 5);
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let profile = ConnectionProfile::from_json(&case["profile"]).unwrap_or_else(|| panic!("{label}: profile"));
            let ours = to_connection_input(&profile);
            // What the app sends, as Rust reads it: the keychain binding must be identical, or a
            // password saved in the app would be refused here.
            let app: ConnectionInput = serde_json::from_value(case["connectionInput"].clone()).unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(password_binding(&ours), password_binding(&app), "{label}: password binding");
            assert_eq!(ours.engine, app.engine, "{label}");
            assert_eq!(ours.path, app.path, "{label}");
            assert_eq!(ours.host, app.host, "{label}");
            assert_eq!(ours.port, app.port, "{label}");
            assert_eq!(ours.database, app.database, "{label}");
            assert_eq!(ours.user, app.user, "{label}");
            assert_eq!(ours.ssl_mode, app.ssl_mode, "{label}");
            assert_eq!(ours.profile_id, app.profile_id, "{label}");
            assert_eq!(ours.ssh.as_ref().map(SshConfig::binding), app.ssh.as_ref().map(SshConfig::binding), "{label}: ssh");
            assert_eq!(ours.ssh.as_ref().map(|s| s.key_path.clone()), app.ssh.as_ref().map(|s| s.key_path.clone()), "{label}: key path");
            assert!(ours.password.is_none() && ours.ssh.as_ref().is_none_or(|s| s.secret.is_none() && s.trust.is_none()));
            assert_eq!(database_key(&profile), case["databaseKey"].as_str().unwrap(), "{label}: database key");
            assert_eq!(profile.label(), case["label"].as_str().unwrap(), "{label}: label");
        }
    }

    #[test]
    fn reads_old_and_new_profiles() {
        let old = serde_json::json!({ "id": "x", "name": "", "host": "h", "port": 5432, "database": "d", "user": "u", "sslMode": "prefer", "schemas": [] });
        let p = ConnectionProfile::from_json(&old).unwrap();
        assert_eq!((p.engine, p.path.as_str(), p.ssh.is_none()), (Engine::Postgres, "", true));
        assert_eq!(p.mcp, McpAccess { enabled: false, data: DataAccess::Masked }, "agents are off until turned on");
        let mysql = ConnectionProfile::from_json(&serde_json::json!({ "id": "m", "engine": "mysql" })).unwrap();
        assert_eq!((mysql.port, mysql.user.as_str(), mysql.host.as_str()), (3306, "root", "localhost"));
        let on = ConnectionProfile::from_json(&serde_json::json!({ "id": "o", "mcp": { "enabled": true, "data": "schema" } })).unwrap();
        assert_eq!(on.mcp, McpAccess { enabled: true, data: DataAccess::Schema });
        let odd = ConnectionProfile::from_json(&serde_json::json!({ "id": "q", "mcp": { "enabled": "yes", "data": "everything" } })).unwrap();
        assert_eq!(odd.mcp, McpAccess::default(), "anything unexpected keeps agents out");
        assert!(ConnectionProfile::from_json(&serde_json::json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn loads_the_store_file() {
        let dir = std::env::temp_dir().join(format!("xd-profiles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_profiles(&dir).unwrap().is_empty(), "no file, no profiles");
        std::fs::write(dir.join(CONNECTIONS_FILE), r#"{"profiles":[{"id":"a","name":"A"},{"name":"skipped"}]}"#).unwrap();
        let list = load_profiles(&dir).unwrap();
        assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["a"]);
        std::fs::write(dir.join(CONNECTIONS_FILE), "{ damaged").unwrap();
        assert!(load_profiles(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
