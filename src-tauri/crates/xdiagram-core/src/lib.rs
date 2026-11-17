//! xdiagram's database layer, free of Tauri so other programs (the `xdiagram-mcp` server, the
//! dev examples) can use it: connections (TLS, SSH tunnels, keychain passwords), introspection,
//! and the read-only queries of the data browser, profiler, query builder and X-ray.

pub mod db;
pub mod drafts;
pub mod error;
pub mod fsutil;
pub mod ops;
pub mod secrets;
