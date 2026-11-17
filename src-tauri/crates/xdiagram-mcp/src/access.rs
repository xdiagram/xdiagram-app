//! Which saved connections an agent may use, and how a tool call reaches one: the app's files are
//! read on every call (so a change in the app applies at once), only connections with AI agents
//! turned on are visible, and each call runs as a cancellable operation with a time limit.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xdiagram_core::db::{ConnectionInput, Engine};
use xdiagram_core::error::AppError;
use xdiagram_core::ops;
use xdiagram_core::profiles::{self, ConnectionProfile, DataAccess};

/// What to tell an agent (and through it, the user) when no connection is available.
pub const TURN_ON_HINT: &str = "In xdiagram, edit the connection (Connect, then the connection's Edit button) and turn on \"AI agents\".";

/// The app's settings that apply here (`settings.json`, written by `SettingsService`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// Statement time limit for data reads, seconds (1–600).
    pub query_timeout_secs: u32,
    /// Rows sampled by the profiler (100–100,000).
    pub profile_sample_rows: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { query_timeout_secs: 15, profile_sample_rows: 20_000 }
    }
}

/// `clamp` in settings.service.ts: a number (or numeric text), rounded and kept in range.
fn clamped(v: Option<&Value>, min: u32, max: u32, fallback: u32) -> u32 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        Some(n) if n.is_finite() => n.round().clamp(min as f64, max as f64) as u32,
        _ => fallback,
    }
}

/// Where the app keeps its files: `--data-dir`, else `XDIAGRAM_DATA_DIR`, else the app's own
/// folder (Tauri's `app_data_dir` for `com.xdiagram.app`).
pub fn default_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDIAGRAM_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    dirs::data_dir().map(|d| d.join("com.xdiagram.app"))
}

pub struct Access {
    data_dir: PathBuf,
}

impl Access {
    pub fn new(data_dir: PathBuf) -> Self {
        Access { data_dir }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn settings(&self) -> Settings {
        let d = Settings::default();
        let Ok(text) = std::fs::read_to_string(self.data_dir.join("settings.json")) else { return d };
        let Ok(json) = serde_json::from_str::<Value>(&text) else { return d };
        let s = json.get("settings");
        Settings {
            query_timeout_secs: clamped(s.and_then(|s| s.get("queryTimeoutSecs")), 1, 600, d.query_timeout_secs),
            profile_sample_rows: clamped(s.and_then(|s| s.get("profileSampleRows")), 100, 100_000, d.profile_sample_rows),
        }
    }

    /// Every saved connection (also those agents may not use).
    pub fn all_profiles(&self) -> Result<Vec<ConnectionProfile>, String> {
        profiles::load_profiles(&self.data_dir).map_err(|e| e.to_string())
    }

    /// The saved connection `name_or_id` names, if agents may use it.
    pub fn resolve(&self, name_or_id: &str) -> Result<ConnectionProfile, String> {
        let wanted = name_or_id.trim();
        let all = self.all_profiles()?;
        let matching: Vec<&ConnectionProfile> = match all.iter().find(|p| p.id == wanted) {
            Some(p) => vec![p],
            None => all.iter().filter(|p| p.label().eq_ignore_ascii_case(wanted)).collect(),
        };
        let enabled: Vec<&ConnectionProfile> = matching.iter().copied().filter(|p| p.mcp.enabled).collect();
        match (enabled.as_slice(), matching.is_empty()) {
            ([one], _) => Ok((*one).clone()),
            ([], true) => {
                let names: Vec<String> = all.iter().filter(|p| p.mcp.enabled).map(|p| format!("\"{}\"", p.label())).collect();
                Err(if names.is_empty() {
                    format!("No saved connection is called \"{wanted}\", and none allows AI agents yet. {TURN_ON_HINT}")
                } else {
                    format!("No saved connection is called \"{wanted}\". Connections you can use: {}.", names.join(", "))
                })
            }
            ([], false) => Err(format!("The connection \"{wanted}\" does not allow AI agents. {TURN_ON_HINT}")),
            (many, _) => {
                let ids: Vec<String> = many.iter().map(|p| format!("{} ({})", p.id, p.label())).collect();
                Err(format!("Several connections are called \"{wanted}\"; pass the id of one: {}.", ids.join(", ")))
            }
        }
    }
}

/// A connection an agent may use, with what it may do.
pub struct Conn {
    pub profile: ConnectionProfile,
    pub input: ConnectionInput,
}

impl Conn {
    pub fn new(profile: ConnectionProfile) -> Self {
        let input = profiles::to_connection_input(&profile);
        Conn { profile, input }
    }

    pub fn name(&self) -> String {
        self.profile.label()
    }

    /// Refuses data reads on a schema-only connection.
    pub fn require_rows(&self) -> Result<(), String> {
        if self.profile.mcp.data == DataAccess::Schema {
            return Err(format!(
                "\"{}\" is shared with AI agents for its schema only: no rows can be read. The user can change this in xdiagram (edit the connection, AI agents).",
                self.name()
            ));
        }
        Ok(())
    }

    /// The schemas this connection is limited to (what the app shows for it).
    pub fn schemas(&self) -> &[String] {
        &self.profile.schemas
    }

    /// Refuses a schema outside the connection's scope: the profile's schema list (PostgreSQL,
    /// SQL Server), or another database on the same MySQL server.
    pub fn check_schema(&self, schema: &str) -> Result<(), String> {
        match self.profile.engine {
            Engine::Mysql => {
                let own = &self.profile.database;
                if schema.is_empty() || schema == "public" || schema.eq_ignore_ascii_case(own) {
                    Ok(())
                } else {
                    Err(format!("\"{}\" gives access to the database \"{own}\" only, not \"{schema}\".", self.name()))
                }
            }
            Engine::Sqlite => Ok(()),
            Engine::Postgres | Engine::Mssql => {
                let list = &self.profile.schemas;
                if list.is_empty() || list.iter().any(|s| s == schema) || (self.profile.engine == Engine::Mssql && schema == "public" && list.iter().any(|s| s == "dbo")) {
                    Ok(())
                } else {
                    Err(format!("\"{}\" is limited to the schemas {}; \"{schema}\" is not one of them.", self.name(), quoted_list(list)))
                }
            }
        }
    }

    /// An error as the agent should read it, with what the user can do about it.
    pub fn explain(&self, err: AppError) -> String {
        let hint = match &err {
            AppError::UnknownHostKey { .. } => Some(
                "The SSH server's host key is not trusted yet. Connect once in xdiagram and accept the key; agents cannot accept it.".to_string(),
            ),
            AppError::Cancelled => None,
            _ if self.profile.engine != Engine::Sqlite && !password_saved(&self.profile) => Some(format!(
                "No password is saved for \"{}\". In xdiagram, connect with \"Remember password\" ticked.",
                self.name()
            )),
            _ => None,
        };
        match hint {
            Some(hint) => format!("{err} ({hint})"),
            None => err.to_string(),
        }
    }
}

/// Whether the keychain holds the connection's password (it is never read here).
pub fn password_saved(p: &ConnectionProfile) -> bool {
    xdiagram_core::secrets::has_secret(&p.id).unwrap_or(false)
}

pub fn quoted_list(items: &[String]) -> String {
    items.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ")
}

static NEXT_OP: AtomicU64 = AtomicU64::new(1);

/// Runs `work` as a cancellable operation: the client cancelling the request, or `budget`
/// passing, stops it (on the server too, where the engine allows; see `ops`).
pub async fn run_op<T>(ct: &CancellationToken, budget: Duration, work: impl Future<Output = Result<T, AppError>>) -> Result<T, AppError> {
    let id = format!("mcp-{}", NEXT_OP.fetch_add(1, Ordering::Relaxed));
    let work = ops::cancellable(Some(id.clone()), work);
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = ct.cancelled() => {
            ops::cancel(&id);
            Err(AppError::Cancelled)
        }
        _ = tokio::time::sleep(budget) => {
            ops::cancel(&id);
            Err(AppError::Invalid(format!("Stopped after {} seconds (time limit)", budget.as_secs())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xd-mcp-access-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_profiles(dir: &Path, profiles: Value) {
        std::fs::write(dir.join("connections.json"), serde_json::json!({ "profiles": profiles }).to_string()).unwrap();
    }

    #[test]
    fn resolves_only_connections_agents_may_use() {
        let dir = temp_dir("resolve");
        write_profiles(
            &dir,
            serde_json::json!([
                { "id": "a", "name": "Shop", "mcp": { "enabled": true } },
                { "id": "b", "name": "Prod", "mcp": { "enabled": false } },
                { "id": "c", "name": "Twin", "mcp": { "enabled": true } },
                { "id": "d", "name": "twin", "mcp": { "enabled": true } },
                { "id": "e", "name": "Legacy" }
            ]),
        );
        let access = Access::new(dir.clone());
        assert_eq!(access.resolve("shop").unwrap().id, "a", "names match case-insensitively");
        assert_eq!(access.resolve("c").unwrap().id, "c", "ids work too");
        assert!(access.resolve("Prod").unwrap_err().contains("does not allow AI agents"));
        assert!(access.resolve("b").unwrap_err().contains("does not allow AI agents"), "not by id either");
        assert!(access.resolve("Legacy").unwrap_err().contains("does not allow AI agents"), "old profiles are off");
        assert!(access.resolve("Twin").unwrap_err().contains("pass the id"));
        let missing = access.resolve("Nope").unwrap_err();
        assert!(missing.contains("\"Shop\"") && !missing.contains("Prod"), "{missing}");
        write_profiles(&dir, serde_json::json!([{ "id": "b", "name": "Prod" }]));
        assert!(access.resolve("x").unwrap_err().contains("none allows AI agents"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_to_the_connection_scope() {
        let conn = |v: Value| Conn::new(ConnectionProfile::from_json(&v).unwrap());
        let pg = conn(serde_json::json!({ "id": "p", "schemas": ["public", "sales"] }));
        assert!(pg.check_schema("sales").is_ok() && pg.check_schema("hr").is_err());
        let all = conn(serde_json::json!({ "id": "p" }));
        assert!(all.check_schema("anything").is_ok(), "no list means every schema");
        let my = conn(serde_json::json!({ "id": "m", "engine": "mysql", "database": "shop" }));
        assert!(my.check_schema("shop").is_ok() && my.check_schema("public").is_ok() && my.check_schema("mysql").is_err());
        let ms = conn(serde_json::json!({ "id": "s", "engine": "mssql", "schemas": ["dbo"] }));
        assert!(ms.check_schema("public").is_ok(), "the app's alias for dbo");
        let schema_only = conn(serde_json::json!({ "id": "x", "mcp": { "enabled": true, "data": "schema" } }));
        assert!(schema_only.require_rows().is_err() && all.require_rows().is_ok());
    }

    #[test]
    fn reads_the_app_settings() {
        let dir = temp_dir("settings");
        let access = Access::new(dir.clone());
        assert_eq!(access.settings(), Settings::default());
        std::fs::write(dir.join("settings.json"), r#"{"settings":{"queryTimeoutSecs":"30","profileSampleRows":5}}"#).unwrap();
        assert_eq!(access.settings(), Settings { query_timeout_secs: 30, profile_sample_rows: 100 });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn operations_stop_on_cancel_and_time_limit() {
        let slow = || async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<_, AppError>(())
        };
        let ct = CancellationToken::new();
        let timed = run_op(&ct, Duration::from_millis(50), slow()).await;
        assert!(matches!(timed, Err(AppError::Invalid(m)) if m.contains("time limit")));
        let child = ct.child_token();
        let cancel = child.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        assert!(matches!(run_op(&child, Duration::from_secs(60), slow()).await, Err(AppError::Cancelled)));
        assert_eq!(run_op(&ct, Duration::from_secs(1), async { Ok::<_, AppError>(7) }).await.unwrap(), 7);
    }
}
