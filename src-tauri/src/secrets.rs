//! Connection passwords live in the OS keychain (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux), keyed by profile id. They are never written to the profile store.
//!
//! Each saved secret records the server it was typed for (its *binding*: engine, host, port,
//! database, user and SSH hop). A connection to any other server never gets it, so a page that
//! sends a saved profile id with another host cannot pull a password out of the keychain.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const SERVICE: &str = "xdiagram";

pub const MISMATCH: &str = "The saved password belongs to a different server. Enter it again.";

/// What is stored in the keychain entry.
#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u8,
    bind: String,
    secret: String,
}

/// A keychain value as read: bound to a server, or saved by an older version (bare secret).
#[derive(Debug, PartialEq, Eq)]
enum Stored {
    Bound { bind: String, secret: String },
    Legacy(String),
}

fn decode(raw: String) -> Stored {
    match serde_json::from_str::<Envelope>(&raw) {
        Ok(e) if e.v == 1 => Stored::Bound { bind: e.bind, secret: e.secret },
        _ => Stored::Legacy(raw),
    }
}

fn encode(secret: &str, bind: &str) -> String {
    serde_json::to_string(&Envelope { v: 1, bind: bind.to_string(), secret: secret.to_string() }).expect("plain strings serialize")
}

/// The secret for a connection to `bind`. The bool asks for the entry to be saved again bound
/// (an older bare secret is accepted once and migrated).
fn pick(stored: Stored, bind: &str) -> Result<(String, bool), AppError> {
    match stored {
        Stored::Bound { bind: saved, secret } if saved == bind => Ok((secret, false)),
        Stored::Bound { .. } => Err(AppError::Invalid(MISMATCH.into())),
        Stored::Legacy(secret) => Ok((secret, true)),
    }
}

fn entry(key: &str) -> Result<keyring::Entry, AppError> {
    Ok(keyring::Entry::new(SERVICE, key)?)
}

fn read(key: &str) -> Result<Option<String>, AppError> {
    match entry(key)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Saves `secret` under `key`, usable only for connections whose binding is `bind`.
pub fn save_bound(key: &str, secret: &str, bind: &str) -> Result<(), AppError> {
    Ok(entry(key)?.set_password(&encode(secret, bind))?)
}

/// The secret saved under `key` for a connection to `bind`; an error when it was saved for
/// another server.
pub fn load_bound(key: &str, bind: &str) -> Result<Option<String>, AppError> {
    let Some(raw) = read(key)? else { return Ok(None) };
    let (secret, migrate) = pick(decode(raw), bind)?;
    if migrate {
        // Best effort: the connection still works if the keychain refuses the write.
        let _ = save_bound(key, &secret, bind);
    }
    Ok(Some(secret))
}

pub fn has_secret(key: &str) -> Result<bool, AppError> {
    Ok(read(key)?.is_some())
}

pub fn delete_password(profile_id: &str) -> Result<(), AppError> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_secrets_only_reach_their_server() {
        let raw = encode("s3cret", "postgres|db.example|5432|shop|app|");
        let stored = decode(raw);
        assert_eq!(stored, Stored::Bound { bind: "postgres|db.example|5432|shop|app|".into(), secret: "s3cret".into() });
        let (secret, migrate) = pick(decode(encode("s3cret", "a")), "a").unwrap();
        assert_eq!((secret.as_str(), migrate), ("s3cret", false));
        let err = pick(decode(encode("s3cret", "a")), "evil|attacker.example|5432||app|").unwrap_err();
        assert_eq!(err.to_string(), MISMATCH);
    }

    #[test]
    fn older_bare_secrets_are_migrated() {
        assert_eq!(decode("plain password".into()), Stored::Legacy("plain password".into()));
        // A password that happens to look like JSON is still a bare secret.
        assert_eq!(decode("{\"x\":1}".into()), Stored::Legacy("{\"x\":1}".into()));
        let (secret, migrate) = pick(Stored::Legacy("pw".into()), "anything").unwrap();
        assert_eq!((secret.as_str(), migrate), ("pw", true));
    }
}
