use std::str::FromStr;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde::Deserialize;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::{Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::AppError;
use crate::secrets;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    /// Try TLS, fall back to plain. Certificate is not verified (libpq semantics).
    #[default]
    Prefer,
    /// Require TLS. Certificate is not verified (libpq semantics).
    Require,
    /// Require TLS and verify the server certificate + host name against public roots.
    VerifyFull,
}

/// Database engine behind a connection. Introspection and browsing dispatch on it.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Postgres,
    Mysql,
    Mssql,
    Sqlite,
}

/// What the frontend sends to identify a database. Either `url`, or the discrete fields.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionInput {
    pub engine: Engine,
    /// SQLite database file.
    pub path: Option<String>,
    pub url: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    /// Saved profile; when set and `password` is empty, the password is read from the OS keychain.
    pub profile_id: Option<String>,
    pub ssl_mode: Option<SslMode>,
    /// Connect through this SSH server (not for SQLite).
    pub ssh: Option<super::ssh::SshConfig>,
}

/// Like `SshConfig`'s: the password and the URL (which may carry one) are never printed.
impl std::fmt::Debug for ConnectionInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hidden = |v: &Option<String>| v.as_ref().map(|_| "…");
        f.debug_struct("ConnectionInput")
            .field("engine", &self.engine)
            .field("path", &self.path)
            .field("url", &hidden(&self.url))
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("password", &hidden(&self.password))
            .field("profile_id", &self.profile_id)
            .field("ssl_mode", &self.ssl_mode)
            .field("ssh", &self.ssh)
            .finish()
    }
}

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The server a saved database password belongs to (see `secrets`). Defaults are filled in, so
/// a profile saved with an empty port matches one with the engine's default port.
pub fn password_binding(input: &ConnectionInput) -> String {
    let (engine, port) = match input.engine {
        Engine::Postgres => ("postgres", 5432),
        Engine::Mysql => ("mysql", 3306),
        Engine::Mssql => ("mssql", 1433),
        Engine::Sqlite => ("sqlite", 0),
    };
    let ssh = input.ssh.as_ref().map(super::ssh::SshConfig::binding).unwrap_or_default();
    if let Some(url) = non_empty(&input.url) {
        return format!("{engine}|url:{url}|{ssh}");
    }
    format!(
        "{engine}|{}|{}|{}|{}|{ssh}",
        non_empty(&input.host).unwrap_or("localhost").to_ascii_lowercase(),
        input.port.unwrap_or(port),
        non_empty(&input.database).unwrap_or(""),
        non_empty(&input.user).unwrap_or(""),
    )
}

/// Every PostgreSQL session starts read-only (on top of the read-only transactions data reads
/// already use), keeping any `options` the URL carried.
const READ_ONLY_OPTION: &str = "-c default_transaction_read_only=on";

fn with_read_only(options: Option<&str>) -> String {
    match options.map(str::trim).filter(|o| !o.is_empty()) {
        Some(o) => format!("{o} {READ_ONLY_OPTION}"),
        None => READ_ONLY_OPTION.to_string(),
    }
}

/// Connection poolers such as PgBouncer refuse startup options they do not know.
fn rejects_startup_options(err: &tokio_postgres::Error) -> bool {
    err.as_db_error().is_some_and(|db| db.message().contains("unsupported startup parameter"))
}

/// Split `sslmode=verify-ca|verify-full` out of a URL, since tokio-postgres only understands
/// disable/prefer/require. Returns the rewritten URL and the mode that was requested, if any.
fn extract_url_ssl_mode(url: &str) -> (String, Option<SslMode>) {
    let Some((base, query)) = url.split_once('?') else {
        return (url.to_string(), None);
    };
    let mut mode = None;
    let mut kept = Vec::new();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k.eq_ignore_ascii_case("sslmode") {
            mode = match v.to_ascii_lowercase().as_str() {
                "disable" | "allow" => Some(SslMode::Disable),
                "prefer" => Some(SslMode::Prefer),
                "require" => Some(SslMode::Require),
                "verify-ca" | "verify-full" => Some(SslMode::VerifyFull),
                _ => None,
            };
        } else if !k.eq_ignore_ascii_case("schemas") {
            // `schemas=` is a @dbml/connector convention, not a libpq parameter.
            kept.push(pair);
        }
    }
    let url = if kept.is_empty() { base.to_string() } else { format!("{base}?{}", kept.join("&")) };
    (url, mode)
}

/// Explicit password, else the one saved for the profile in the OS keychain.
pub fn resolve_password(input: &ConnectionInput) -> Result<Option<String>, AppError> {
    if let Some(pw) = input.password.as_deref().filter(|p| !p.is_empty()) {
        return Ok(Some(pw.to_string()));
    }
    match non_empty(&input.profile_id) {
        Some(id) => secrets::load_bound(id, &password_binding(input)),
        None => Ok(None),
    }
}

pub fn non_empty_field(v: &Option<String>) -> Option<&str> {
    non_empty(v)
}

pub fn build_config(input: &ConnectionInput, read_only: bool) -> Result<(Config, SslMode), AppError> {
    let (mut config, url_mode) = if let Some(url) = non_empty(&input.url) {
        let (url, mode) = extract_url_ssl_mode(url);
        let config = Config::from_str(&url).map_err(|e| AppError::Invalid(format!("Invalid connection URL: {e}")))?;
        (config, mode)
    } else {
        let mut config = Config::new();
        config.host(non_empty(&input.host).unwrap_or("localhost"));
        config.port(input.port.unwrap_or(5432));
        if let Some(db) = non_empty(&input.database) {
            config.dbname(db);
        }
        match non_empty(&input.user) {
            Some(user) => config.user(user),
            None => return Err(AppError::Invalid("A user name is required".into())),
        };
        (config, None)
    };

    // Password precedence: explicit > keychain (saved profile) > whatever the URL carried.
    if let Some(pw) = resolve_password(input)? {
        config.password(pw);
    }
    if read_only {
        let options = with_read_only(config.get_options());
        config.options(&options);
    }

    let mode = input.ssl_mode.or(url_mode).unwrap_or_default();
    config.ssl_mode(match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require | SslMode::VerifyFull => PgSslMode::Require,
    });
    config.application_name("xdiagram");
    config.connect_timeout(std::time::Duration::from_secs(15));
    Ok((config, mode))
}

pub async fn connect(input: &ConnectionInput) -> Result<Client, AppError> {
    match open(input, true).await {
        Err(Open::Pg(e)) if rejects_startup_options(&e) => {
            // Behind a pooler: connect without the session option. Browsing, profiling, related
            // rows and data checks still run in `SET TRANSACTION READ ONLY` transactions.
            open(input, false).await.map_err(AppError::from)
        }
        other => other.map_err(AppError::from),
    }
}

/// `connect`'s failure, keeping the PostgreSQL error so a refused startup option can be retried.
enum Open {
    Pg(tokio_postgres::Error),
    App(AppError),
}

impl From<AppError> for Open {
    fn from(e: AppError) -> Self {
        Open::App(e)
    }
}

impl From<Open> for AppError {
    fn from(e: Open) -> Self {
        match e {
            Open::Pg(e) => e.into(),
            Open::App(e) => e,
        }
    }
}

async fn open(input: &ConnectionInput, read_only: bool) -> Result<Client, Open> {
    let (mut config, mode) = build_config(input, read_only)?;
    if input.ssh.is_some() {
        let host = match config.get_hosts() {
            [host] => match host {
                tokio_postgres::config::Host::Tcp(host) => host.clone(),
                // Unix sockets exist only on Unix builds.
                #[allow(unreachable_patterns)]
                _ => return Err(AppError::Invalid("An SSH tunnel needs a TCP host, not a socket".into()).into()),
            },
            _ => return Err(AppError::Invalid("An SSH tunnel needs a single database host".into()).into()),
        };
        let port = config.get_ports().first().copied().unwrap_or(5432);
        if let Some(local) = super::ssh::route(input, &host, port).await? {
            config = through_tunnel(&config, &host, local);
        }
    }
    let tls = MakeRustlsConnect::new(tls_config(mode)?);
    let (client, connection) = config.connect(tls.clone()).await.map_err(Open::Pg)?;
    // A cancelled operation also cancels the statement running on the server.
    crate::ops::register(crate::ops::Interrupt::Postgres(client.cancel_token(), tls));
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection closed with error: {e}");
        }
    });
    client.simple_query("SELECT 1").await.map_err(Open::Pg)?;
    Ok(client)
}

/// The same connection, made to the tunnel's local port. The real host name stays the TLS
/// server name (`hostaddr` is what gets dialled), so `verify-full` still checks it.
fn through_tunnel(src: &Config, host: &str, local_port: u16) -> Config {
    let mut config = Config::new();
    config.host(host);
    config.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    config.port(local_port);
    if let Some(user) = src.get_user() {
        config.user(user);
    }
    if let Some(password) = src.get_password() {
        config.password(password);
    }
    if let Some(db) = src.get_dbname() {
        config.dbname(db);
    }
    if let Some(options) = src.get_options() {
        config.options(options);
    }
    if let Some(name) = src.get_application_name() {
        config.application_name(name);
    }
    if let Some(timeout) = src.get_connect_timeout() {
        config.connect_timeout(*timeout);
    }
    config.ssl_mode(src.get_ssl_mode());
    config
}

fn tls_config(mode: SslMode) -> Result<ClientConfig, AppError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Tls(e.to_string()))?;
    let config = if mode == SslMode::VerifyFull {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
            .with_no_client_auth()
    };
    Ok(config)
}

/// Encrypts without authenticating the server, matching libpq's `sslmode=require`.
#[derive(Debug)]
struct AcceptAnyCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_unsupported_url_params() {
        let (url, mode) = extract_url_ssl_mode("postgres://u@h/db?sslmode=verify-full&schemas=public&connect_timeout=5");
        assert_eq!(url, "postgres://u@h/db?connect_timeout=5");
        assert_eq!(mode, Some(SslMode::VerifyFull));

        let (url, mode) = extract_url_ssl_mode("postgres://u@h/db");
        assert_eq!(url, "postgres://u@h/db");
        assert_eq!(mode, None);
    }

    fn pg_input() -> ConnectionInput {
        ConnectionInput {
            host: Some("DB.Example".into()),
            database: Some("shop".into()),
            user: Some("app".into()),
            password: Some("pw".into()),
            ..Default::default()
        }
    }

    #[test]
    fn sessions_are_read_only() {
        assert_eq!(with_read_only(None), "-c default_transaction_read_only=on");
        assert_eq!(with_read_only(Some("  ")), "-c default_transaction_read_only=on");
        assert_eq!(with_read_only(Some("-c search_path=app")), "-c search_path=app -c default_transaction_read_only=on");
        let (config, _) = build_config(&pg_input(), true).unwrap();
        assert_eq!(config.get_options(), Some("-c default_transaction_read_only=on"));
        let (config, _) = build_config(&pg_input(), false).unwrap();
        assert_eq!(config.get_options(), None);
        let url = ConnectionInput { url: Some("postgres://u:p@h/db?options=-c%20search_path%3Dapp".into()), ..Default::default() };
        let (config, _) = build_config(&url, true).unwrap();
        assert_eq!(config.get_options(), Some("-c search_path=app -c default_transaction_read_only=on"));
    }

    #[test]
    fn password_binding_names_the_server() {
        let a = password_binding(&pg_input());
        assert_eq!(a, "postgres|db.example|5432|shop|app|");
        assert_eq!(password_binding(&ConnectionInput { port: Some(5432), ..pg_input() }), a, "default port");
        assert_ne!(password_binding(&ConnectionInput { host: Some("attacker.example".into()), ..pg_input() }), a);
        assert_ne!(password_binding(&ConnectionInput { engine: Engine::Mysql, ..pg_input() }), a);
    }

    #[test]
    fn debug_hides_secrets() {
        let printed = format!("{:?}", ConnectionInput { url: Some("postgres://u:hunter2@h/db".into()), ..pg_input() });
        assert!(!printed.contains("hunter2"), "{printed}");
        assert!(!printed.contains("\"pw\""), "{printed}");
    }
}
