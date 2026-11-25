//! The MCP tools. Each one names a saved connection, reaches it the way the app does (keychain
//! password, SSH tunnel, TLS), and only ever reads: the statements are the app's own generated
//! SELECTs and catalog queries, in read-only sessions or transactions where the engine has them.

use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xdiagram_core::db::{Engine, dispatch};
use xdiagram_core::profiles::{DataAccess, engine_name};

use crate::access::{Access, Conn, TURN_ON_HINT, password_saved, run_op, ssh_password_saved};
use crate::path_tools::XrayCache;
use crate::schema_tools::SchemaCache;

/// What a tool returns: text for the agent (JSON or DBML), or an error message it can act on.
pub type ToolResult = Result<CallToolResult, String>;

pub fn text(body: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::success(vec![ContentBlock::text(body.into())]))
}

pub fn json_text(value: &impl Serialize) -> ToolResult {
    text(serde_json::to_string(value).map_err(|e| e.to_string())?)
}

/// Time allowed for reading a schema or other catalog work, which has no statement time limit.
pub const CATALOG_BUDGET: Duration = Duration::from_secs(120);

/// The most text one reply carries (bytes of UTF-8, about 15,000–20,000 tokens): clients cap tool
/// output (Claude Code at 25,000 tokens by default), so larger results are cut or split instead.
pub const MAX_REPLY_LEN: usize = 60_000;

const INSTRUCTIONS: &str = "\
xdiagram-mcp reads the databases the user saved in xdiagram (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite). \
Everything is read-only: the server only runs SELECTs and catalog queries it builds itself, never SQL you write.

Start with list_connections: only connections the user has opened to AI agents are listed, each with its data \
access (schema: no rows at all; masked: rows with values that look like personal data replaced by \
\"[masked: kind]\"; full: rows as they are). Pass a connection's name (or id) to the other tools.

Typical flow: list_tables to see what exists, get_schema_dbml with the tables you care about (DBML: tables, \
columns, keys, relationships), describe_table for one table's columns and keys, then browse_rows / count_rows \
with a filter. find_join_paths tells how two tables connect, and run_join_query reads across them.";

#[derive(Clone)]
pub struct XdiagramServer {
    access: Arc<Access>,
    pub(crate) cache: Arc<SchemaCache>,
    pub(crate) xray: Arc<XrayCache>,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectionArg {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    name: String,
    id: String,
    engine: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    /// Schemas the connection is limited to (empty: all).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    schemas: Vec<String>,
    data: DataAccess,
    #[serde(skip_serializing_if = "Option::is_none")]
    password_saved: Option<bool>,
    /// Through SSH with a password: whether that one is saved too.
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_password_saved: Option<bool>,
}

#[derive(Serialize)]
struct ConnectionList {
    connections: Vec<ConnectionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl XdiagramServer {
    pub fn new(access: Access) -> Self {
        XdiagramServer {
            access: Arc::new(access),
            cache: Arc::new(SchemaCache::default()),
            xray: Arc::new(XrayCache::default()),
            tool_router: Self::tool_router() + Self::schema_router() + Self::data_router() + Self::path_router(),
        }
    }

    pub fn access(&self) -> &Access {
        &self.access
    }

    /// The connection a tool call names, if agents may use it.
    pub fn conn(&self, name_or_id: &str) -> Result<Conn, String> {
        self.access.resolve(name_or_id).map(Conn::new)
    }
}

#[tool_router(router = tool_router)]
impl XdiagramServer {
    #[tool(
        name = "list_connections",
        description = "The saved database connections you may use, with their engine, database, schema scope and data access (schema, masked or full). Call this first.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_connections(&self) -> ToolResult {
        let all = self.access.all_profiles()?;
        let hidden = all.iter().filter(|p| !p.mcp.enabled).count();
        let connections: Vec<ConnectionInfo> = all
            .iter()
            .filter(|p| p.mcp.enabled)
            .map(|p| {
                let lite = p.engine == Engine::Sqlite;
                ConnectionInfo {
                    name: p.label(),
                    id: p.id.clone(),
                    engine: engine_name(p.engine),
                    host: (!lite).then(|| p.host.clone()),
                    database: (!lite).then(|| p.database.clone()),
                    file: lite.then(|| p.path.clone()),
                    schemas: p.schemas.clone(),
                    data: p.mcp.data,
                    password_saved: (!lite).then(|| password_saved(p)),
                    ssh_password_saved: if lite { None } else { ssh_password_saved(p) },
                }
            })
            .collect();
        let note = if connections.is_empty() {
            Some(format!(
                "No saved connection allows AI agents yet{}. {TURN_ON_HINT}",
                if hidden > 0 { format!(" ({hidden} saved, all off)") } else { String::new() }
            ))
        } else if hidden > 0 {
            Some(format!("{hidden} more saved connection(s) do not allow AI agents."))
        } else {
            None
        };
        json_text(&ConnectionList { connections, note })
    }

    #[tool(
        name = "list_schemas",
        description = "The schemas of a connection (PostgreSQL, SQL Server), within the connection's scope. MySQL has one: its database; SQLite has `main`.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_schemas(&self, Parameters(args): Parameters<ConnectionArg>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let input = conn.input.clone();
        let all = run_op(&ct, CATALOG_BUDGET, async move { dispatch::list_schemas(&input).await }).await.map_err(|e| conn.explain(e))?;
        let scope = conn.schemas();
        let schemas: Vec<String> = all.into_iter().filter(|s| scope.is_empty() || scope.contains(s)).collect();
        json_text(&json!({ "schemas": schemas }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for XdiagramServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("xdiagram", env!("XDIAGRAM_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}
