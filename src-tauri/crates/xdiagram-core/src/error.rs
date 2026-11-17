use std::error::Error as StdError;

/// Errors returned to the frontend. Serialized as a plain message string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{}", describe_pg_error(.0))]
    Db(#[from] tokio_postgres::Error),
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("Keychain error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("File error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    /// The user cancelled the operation (see `ops.rs`).
    #[error("Cancelled")]
    Cancelled,
    /// MySQL / SQL Server / SQLite driver errors.
    #[error("{0}")]
    Driver(String),
    /// SSH tunnel problems: connecting, authenticating, forwarding.
    #[error("SSH: {0}")]
    Ssh(String),
    /// First connection to an SSH server. The UI recognises this message, shows the fingerprint
    /// and, if the user trusts it, retries with `ssh.trust` set (see `db/ssh.rs`).
    #[error("Unknown SSH host key for {host}: {fingerprint}")]
    UnknownHostKey { host: String, fingerprint: String },
    #[error(
        "SSH: the host key of {host} has changed (it is now {fingerprint}). Someone may be intercepting the connection; if the server was reinstalled, remove its line from {file}."
    )]
    HostKeyChanged { host: String, fingerprint: String, file: String },
    /// Filter conditions that cannot run, each tied to its node id (see `db/filter.rs`). Sent to
    /// the frontend as `{ kind: "filter", message, issues }` so it can mark the conditions.
    #[error("{}", filter_summary(.0))]
    Filter(Vec<crate::db::filter::Issue>),
}

fn filter_summary(issues: &[crate::db::filter::Issue]) -> String {
    match issues {
        [] => "Invalid filter".into(),
        [one] => one.message.clone(),
        [first, rest @ ..] => format!("{} (and {} more)", first.message, rest.len()),
    }
}

impl From<mysql_async::Error> for AppError {
    fn from(e: mysql_async::Error) -> Self {
        AppError::Driver(format!("MySQL: {e}"))
    }
}

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        AppError::Driver(format!("SQL Server: {e}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Driver(format!("SQLite: {e}"))
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        match self {
            AppError::Filter(issues) => {
                let mut s = serializer.serialize_struct("FilterError", 3)?;
                s.serialize_field("kind", "filter")?;
                s.serialize_field("message", &self.to_string())?;
                s.serialize_field("issues", issues)?;
                s.end()
            }
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

/// `tokio_postgres::Error`'s Display is terse ("db error", "error connecting to server").
/// Surface the server message or the underlying cause so the user can act on it.
fn describe_pg_error(err: &tokio_postgres::Error) -> String {
    if let Some(db) = err.as_db_error() {
        let mut msg = format!("PostgreSQL {}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            msg.push_str(&format!(" ({detail})"));
        }
        return msg;
    }
    let mut msg = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        msg.push_str(": ");
        msg.push_str(&cause.to_string());
        source = cause.source();
    }
    msg
}
