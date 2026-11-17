//! xdiagram-mcp: a Model Context Protocol server, over stdio, that lets AI agents (Claude Code,
//! Claude Desktop, …) read the databases saved in xdiagram. Read-only, and only for connections
//! the user turned "AI agents" on for. Stdout carries the protocol; messages go to stderr.
//!
//!   xdiagram-mcp [--data-dir <folder>]
//!
//! The data folder is the app's (`%APPDATA%\com.xdiagram.app` on Windows); `--data-dir` or
//! `XDIAGRAM_DATA_DIR` point elsewhere (tests).

mod access;
mod data_tools;
mod mask;
mod schema_tools;
mod server;

use std::path::PathBuf;
use std::process::ExitCode;

use rmcp::ServiceExt;

const USAGE: &str = "usage: xdiagram-mcp [--data-dir <folder>]

An MCP server (stdio) that lets AI agents read the databases saved in xdiagram, read-only.
Add it to your MCP client, for example:
  claude mcp add xdiagram -- \"<path to>\\xdiagram-mcp.exe\"";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut data_dir: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => match args.next() {
                Some(dir) => data_dir = Some(PathBuf::from(dir)),
                None => return usage_error("--data-dir needs a folder"),
            },
            "--help" | "-h" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "--version" | "-V" => {
                println!("xdiagram-mcp {}", env!("XDIAGRAM_VERSION"));
                return ExitCode::SUCCESS;
            }
            other => return usage_error(&format!("unknown argument {other}")),
        }
    }
    let Some(data_dir) = data_dir.or_else(access::default_data_dir) else {
        eprintln!("xdiagram-mcp: cannot find the app data folder; pass --data-dir");
        return ExitCode::FAILURE;
    };
    // Host keys the user accepted in the app; the server never accepts new ones itself.
    xdiagram_core::db::ssh::init_known_hosts(data_dir.join("known_hosts"));

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("xdiagram-mcp: {e}");
            return ExitCode::FAILURE;
        }
    };
    let server = server::XdiagramServer::new(access::Access::new(data_dir));
    let result = runtime.block_on(async move {
        let running = server.serve(rmcp::transport::stdio()).await.map_err(|e| e.to_string())?;
        running.waiting().await.map_err(|e| e.to_string())
    });
    match result {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xdiagram-mcp: {e}");
            ExitCode::FAILURE
        }
    }
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("xdiagram-mcp: {message}\n\n{USAGE}");
    ExitCode::from(2)
}
