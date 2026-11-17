//! SSH tunnels: database connections through an SSH server ("jump host"). A tunnel listens on a
//! local port; each connection to it becomes a `direct-tcpip` channel that the SSH server opens
//! to the database. Tunnels are shared per SSH server and database target, and close after five
//! idle minutes.
//!
//! Host keys are checked against the app's own `known_hosts` (in its data folder) and the user's
//! `~/.ssh/known_hosts`. An unknown server is refused with its fingerprint; the UI shows it and,
//! once the user accepts, retries with `trust` set, which records the key. A changed key is
//! always refused.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::connect::ConnectionInput;
use crate::error::AppError;
use crate::secrets;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_CLOSE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    #[default]
    Password,
    Key,
}

/// SSH settings of a connection (`ConnectionInput.ssh`).
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Private key file (OpenSSH, PEM or PuTTY format) for key authentication.
    pub key_path: Option<String>,
    /// The password, or the key's passphrase. When empty it is read from the keychain
    /// (`ssh:<profileId>`).
    pub secret: Option<String>,
    /// A host key fingerprint (`SHA256:…`) the user has just accepted: trusted and remembered.
    pub trust: Option<String>,
}

impl std::fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("auth", &self.auth)
            .field("key_path", &self.key_path)
            .field("secret", &self.secret.as_ref().map(|_| "…"))
            .field("trust", &self.trust)
            .finish()
    }
}

impl SshConfig {
    fn port(&self) -> u16 {
        self.port.unwrap_or(22)
    }

    /// The SSH server a saved secret belongs to (see `secrets`).
    pub fn binding(&self) -> String {
        format!("ssh:{}@{}:{}", self.user.trim(), self.host.trim().to_ascii_lowercase(), self.port())
    }

    fn label(&self) -> String {
        if self.port() == 22 {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port())
        }
    }
}

// ------------------------------------------------------------------ known hosts

static KNOWN_HOSTS: OnceLock<PathBuf> = OnceLock::new();

/// Where accepted host keys are kept (set once at startup, in the app's data folder).
pub fn init_known_hosts(path: PathBuf) {
    let _ = KNOWN_HOSTS.set(path);
}

fn app_known_hosts() -> PathBuf {
    KNOWN_HOSTS.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("xdiagram-known_hosts"))
}

fn user_known_hosts() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

#[derive(Debug, PartialEq)]
enum HostKey {
    Known,
    Unknown { fingerprint: String },
    Changed { fingerprint: String, file: PathBuf },
}

/// Is this server key trusted? Checks the app's file, then the user's (read only); a key the
/// user has just accepted (`trust`) is recorded in the app's file.
fn verify_host_key(host: &str, port: u16, key: &PublicKey, app_file: &Path, user_file: Option<&Path>, trust: Option<&str>) -> Result<HostKey, String> {
    // Compare the key material only (`PublicKey` equality includes the comment).
    let key = &PublicKey::from(key.key_data().clone());
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    match check_known_hosts_path(host, port, key, app_file) {
        Ok(true) => return Ok(HostKey::Known),
        Ok(false) => {}
        Err(russh::keys::Error::KeyChanged { .. }) => return Ok(HostKey::Changed { fingerprint, file: app_file.to_path_buf() }),
        Err(e) => return Err(format!("could not read {}: {e}", app_file.display())),
    }
    if let Some(user_file) = user_file {
        match check_known_hosts_path(host, port, key, user_file) {
            Ok(true) => return Ok(HostKey::Known),
            Err(russh::keys::Error::KeyChanged { .. }) => return Ok(HostKey::Changed { fingerprint, file: user_file.to_path_buf() }),
            // Unreadable entries in the user's own file are not ours to judge.
            Ok(false) | Err(_) => {}
        }
    }
    if trust == Some(fingerprint.as_str()) {
        learn_known_hosts_path(host, port, key, app_file).map_err(|e| format!("could not save the host key: {e}"))?;
        return Ok(HostKey::Known);
    }
    Ok(HostKey::Unknown { fingerprint })
}

/// russh callbacks: only the host key check is ours.
struct HostCheck {
    host: String,
    port: u16,
    trust: Option<String>,
    verdict: Arc<Mutex<Option<Result<HostKey, String>>>>,
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let user_file = user_known_hosts();
        let verdict = verify_host_key(&self.host, self.port, &key, &app_known_hosts(), user_file.as_deref(), self.trust.as_deref());
        let accepted = matches!(verdict, Ok(HostKey::Known));
        *self.verdict.lock().unwrap() = Some(verdict);
        Ok(accepted)
    }
}

// ------------------------------------------------------------------ tunnels

#[derive(Clone, PartialEq, Eq, Hash)]
struct TunnelKey {
    ssh_host: String,
    ssh_port: u16,
    user: String,
    auth: SshAuth,
    key_path: Option<String>,
    /// Hash of the password / passphrase (in memory only): a different one must sign in again
    /// rather than ride on a tunnel opened with the right one.
    secret: u64,
    target_host: String,
    target_port: u16,
}

fn secret_hash(secret: Option<&str>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    secret.hash(&mut h);
    h.finish()
}

/// The password / passphrase typed for this connection, else the one saved in the keychain.
fn resolve_secret(ssh: &SshConfig, profile_id: Option<&str>) -> Result<Option<String>, AppError> {
    if let Some(s) = ssh.secret.as_deref().filter(|s| !s.is_empty()) {
        return Ok(Some(s.to_string()));
    }
    match profile_id.filter(|id| !id.is_empty()) {
        Some(id) => secrets::load_bound(&format!("ssh:{id}"), &ssh.binding()),
        None => Ok(None),
    }
}

struct Tunnel {
    port: u16,
    handle: Arc<Handle<HostCheck>>,
    /// Connections currently going through the tunnel.
    active: Arc<AtomicUsize>,
    last_used: Arc<Mutex<Instant>>,
    stop: CancellationToken,
}

impl Tunnel {
    fn idle(&self) -> bool {
        self.active.load(Ordering::SeqCst) == 0 && self.last_used.lock().unwrap().elapsed() > IDLE_CLOSE
    }

    fn close(&self) {
        self.stop.cancel();
        let handle = self.handle.clone();
        tokio::spawn(async move {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        });
    }
}

static TUNNELS: LazyLock<tokio::sync::Mutex<HashMap<TunnelKey, Arc<Tunnel>>>> = LazyLock::new(Default::default);

/// The local port to connect to instead of `target_host:target_port`, when the connection goes
/// through SSH (None otherwise). Opens the tunnel, or reuses an open one.
pub async fn route(input: &ConnectionInput, target_host: &str, target_port: u16) -> Result<Option<u16>, AppError> {
    let Some(ssh) = input.ssh.as_ref() else { return Ok(None) };
    if ssh.host.trim().is_empty() || ssh.user.trim().is_empty() {
        return Err(AppError::Ssh("enter the SSH server and user name".into()));
    }
    let secret = resolve_secret(ssh, input.profile_id.as_deref())?;
    let key = TunnelKey {
        ssh_host: ssh.host.trim().to_string(),
        ssh_port: ssh.port(),
        user: ssh.user.trim().to_string(),
        auth: ssh.auth,
        key_path: ssh.key_path.clone().filter(|p| !p.trim().is_empty()),
        secret: secret_hash(secret.as_deref()),
        target_host: target_host.to_string(),
        target_port,
    };
    let mut tunnels = TUNNELS.lock().await;
    if let Some(t) = tunnels.get(&key) {
        if !t.handle.is_closed() {
            *t.last_used.lock().unwrap() = Instant::now();
            return Ok(Some(t.port));
        }
        t.close();
        tunnels.remove(&key);
    }
    let tunnel = Arc::new(open(&key, ssh, secret).await?);
    tunnels.insert(key, tunnel.clone());
    start_reaper();
    Ok(Some(tunnel.port))
}

/// Closes tunnels nobody used for a while (and ones whose SSH session ended).
fn start_reaper() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                TUNNELS.lock().await.retain(|_, t| {
                    let keep = !t.idle() && !t.handle.is_closed();
                    if !keep {
                        t.close();
                    }
                    keep
                });
            }
        });
    });
}

fn ssh_err(context: &str) -> impl Fn(russh::Error) -> AppError + '_ {
    move |e| AppError::Ssh(format!("{context}: {e}"))
}

async fn open(key: &TunnelKey, ssh: &SshConfig, secret: Option<String>) -> Result<Tunnel, AppError> {
    let label = ssh.label();
    let verdict = Arc::new(Mutex::new(None));
    let handler = HostCheck { host: key.ssh_host.clone(), port: key.ssh_port, trust: ssh.trust.clone(), verdict: verdict.clone() };
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });

    let connected = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (key.ssh_host.as_str(), key.ssh_port), handler))
        .await
        .map_err(|_| AppError::Ssh(format!("could not reach {}:{} (timed out)", key.ssh_host, key.ssh_port)))?;
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(e) => {
            // A refused host key explains the failure better than the transport error.
            return Err(match verdict.lock().unwrap().take() {
                Some(Ok(HostKey::Unknown { fingerprint })) => AppError::UnknownHostKey { host: host_label(key), fingerprint },
                Some(Ok(HostKey::Changed { fingerprint, file })) => {
                    AppError::HostKeyChanged { host: host_label(key), fingerprint, file: file.display().to_string() }
                }
                Some(Err(msg)) => AppError::Ssh(msg),
                _ => AppError::Ssh(format!("could not connect to {}:{}: {e}", key.ssh_host, key.ssh_port)),
            });
        }
    };

    authenticate(&mut handle, ssh, secret, &label).await?;

    // Check that the SSH server can reach the database before handing out the tunnel.
    let probe = handle
        .channel_open_direct_tcpip(key.target_host.as_str(), u32::from(key.target_port), "127.0.0.1", 0)
        .await
        .map_err(|e| AppError::Ssh(format!("connected to {label}, but it could not reach the database at {}:{} ({e})", key.target_host, key.target_port)))?;
    let _ = probe.close().await;

    let listener = TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let port = listener.local_addr()?.port();
    let tunnel = Tunnel {
        port,
        handle: Arc::new(handle),
        active: Arc::new(AtomicUsize::new(0)),
        last_used: Arc::new(Mutex::new(Instant::now())),
        stop: CancellationToken::new(),
    };
    tokio::spawn(serve(
        listener,
        tunnel.handle.clone(),
        key.target_host.clone(),
        key.target_port,
        tunnel.active.clone(),
        tunnel.last_used.clone(),
        tunnel.stop.clone(),
    ));
    Ok(tunnel)
}

fn host_label(key: &TunnelKey) -> String {
    if key.ssh_port == 22 {
        key.ssh_host.clone()
    } else {
        format!("{}:{}", key.ssh_host, key.ssh_port)
    }
}

async fn authenticate(handle: &mut Handle<HostCheck>, ssh: &SshConfig, secret: Option<String>, label: &str) -> Result<(), AppError> {
    let result = match ssh.auth {
        SshAuth::Password => {
            let password = secret.ok_or_else(|| AppError::Ssh(format!("enter the SSH password for {label}")))?;
            handle.authenticate_password(ssh.user.trim(), password).await.map_err(ssh_err("authentication failed"))?
        }
        SshAuth::Key => {
            let path = ssh.key_path.as_deref().map(str::trim).filter(|p| !p.is_empty()).ok_or_else(|| AppError::Ssh("choose a private key file".into()))?;
            let private = russh::keys::load_secret_key(path, secret.as_deref()).map_err(|e| match e {
                russh::keys::Error::KeyIsEncrypted => AppError::Ssh("the key file is protected by a passphrase: enter it".into()),
                russh::keys::Error::IO(io) if io.kind() == std::io::ErrorKind::NotFound => AppError::Ssh(format!("no key file at {path}")),
                // Decrypting with the wrong passphrase fails the integrity check.
                russh::keys::Error::SshKey(russh::keys::ssh_key::Error::Crypto) if secret.is_some() => {
                    AppError::Ssh("the passphrase does not unlock the key file".into())
                }
                other => AppError::Ssh(format!("could not read the key file {path}: {other}")),
            })?;
            let hash = if private.algorithm().is_rsa() {
                handle.best_supported_rsa_hash().await.map_err(ssh_err("authentication failed"))?.flatten()
            } else {
                None
            };
            handle
                .authenticate_publickey(ssh.user.trim(), PrivateKeyWithHashAlg::new(Arc::new(private), hash))
                .await
                .map_err(ssh_err("authentication failed"))?
        }
    };
    if !result.success() {
        let what = if ssh.auth == SshAuth::Password { "password" } else { "key" };
        return Err(AppError::Ssh(format!("{label} did not accept the {what}")));
    }
    Ok(())
}

/// Accepts local connections and pipes each through its own channel to the database.
async fn serve(
    listener: TcpListener,
    handle: Arc<Handle<HostCheck>>,
    target_host: String,
    target_port: u16,
    active: Arc<AtomicUsize>,
    last_used: Arc<Mutex<Instant>>,
    stop: CancellationToken,
) {
    loop {
        let (mut socket, peer) = tokio::select! {
            _ = stop.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(_) => continue,
            },
        };
        let (handle, target_host, active, last_used, stop) = (handle.clone(), target_host.clone(), active.clone(), last_used.clone(), stop.clone());
        active.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            match handle.channel_open_direct_tcpip(target_host.as_str(), u32::from(target_port), "127.0.0.1", u32::from(peer.port())).await {
                Ok(channel) => {
                    let mut stream = channel.into_stream();
                    tokio::select! {
                        _ = stop.cancelled() => {}
                        _ = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {}
                    }
                }
                Err(e) => eprintln!("SSH tunnel: could not open a channel to {target_host}:{target_port}: {e}"),
            }
            active.fetch_sub(1, Ordering::SeqCst);
            *last_used.lock().unwrap() = Instant::now();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two throwaway ed25519 public keys (generated with ssh-keygen for these tests).
    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEGki+3myacj/+Cl7vuzaqQ7sqr9aHepLtbx0atXnKg6 test-a";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID6InG2T1u42Eiuh04YYMCCJylY2/Hy6pZsZlWFUQMDu test-b";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xdiagram-ssh-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_hosts_are_refused_until_trusted_then_remembered() {
        let dir = temp_dir("trust");
        let app = dir.join("known_hosts");
        let key = PublicKey::from_openssh(KEY_A).unwrap();
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        assert!(fp.starts_with("SHA256:"));

        assert_eq!(verify_host_key("db.example", 22, &key, &app, None, None), Ok(HostKey::Unknown { fingerprint: fp.clone() }));
        // a fingerprint for some other key does not count
        assert_eq!(verify_host_key("db.example", 22, &key, &app, None, Some("SHA256:nope")), Ok(HostKey::Unknown { fingerprint: fp.clone() }));
        assert_eq!(verify_host_key("db.example", 22, &key, &app, None, Some(&fp)), Ok(HostKey::Known));
        // remembered, also on a non-standard port entry only for that port
        assert_eq!(verify_host_key("db.example", 22, &key, &app, None, None), Ok(HostKey::Known));
        assert!(matches!(verify_host_key("db.example", 2222, &key, &app, None, None), Ok(HostKey::Unknown { .. })));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_changed_key_is_refused_even_when_trusted() {
        let dir = temp_dir("changed");
        let app = dir.join("known_hosts");
        let a = PublicKey::from_openssh(KEY_A).unwrap();
        let b = PublicKey::from_openssh(KEY_B).unwrap();
        let fp_a = a.fingerprint(HashAlg::Sha256).to_string();
        let fp_b = b.fingerprint(HashAlg::Sha256).to_string();
        verify_host_key("jump", 2222, &a, &app, None, Some(&fp_a)).unwrap();
        assert!(matches!(verify_host_key("jump", 2222, &b, &app, None, Some(&fp_b)), Ok(HostKey::Changed { .. })));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_users_known_hosts_counts_but_is_not_written() {
        let dir = temp_dir("user");
        let app = dir.join("known_hosts");
        let user = dir.join("user_known_hosts");
        std::fs::write(&user, format!("# comment\nother.host {KEY_B}\n[jump.example]:2222 {KEY_A}\n")).unwrap();
        let a = PublicKey::from_openssh(KEY_A).unwrap();
        assert_eq!(verify_host_key("jump.example", 2222, &a, &app, Some(&user), None), Ok(HostKey::Known));
        assert!(!app.exists());
        let b = PublicKey::from_openssh(KEY_B).unwrap();
        assert!(matches!(verify_host_key("jump.example", 2222, &b, &app, Some(&user), None), Ok(HostKey::Changed { .. })));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn secrets_stay_out_of_debug_output() {
        let cfg = SshConfig { host: "h".into(), user: "u".into(), secret: Some("hunter2".into()), ..Default::default() };
        assert!(!format!("{cfg:?}").contains("hunter2"));
    }
}
