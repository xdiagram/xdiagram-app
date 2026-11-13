//! Connection passwords live in the OS keychain (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux), keyed by profile id. They are never written to the profile store.

use crate::error::AppError;

const SERVICE: &str = "xdiagram";

fn entry(profile_id: &str) -> Result<keyring::Entry, AppError> {
    Ok(keyring::Entry::new(SERVICE, profile_id)?)
}

pub fn set_password(profile_id: &str, password: &str) -> Result<(), AppError> {
    Ok(entry(profile_id)?.set_password(password)?)
}

pub fn get_password(profile_id: &str) -> Result<Option<String>, AppError> {
    match entry(profile_id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_password(profile_id: &str) -> Result<(), AppError> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
