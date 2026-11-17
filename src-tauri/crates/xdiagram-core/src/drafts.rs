//! The DBML a user edited on a database tab, kept per database so edits (header colours, saved
//! views, groups, notes, added refs) survive Refresh and restarts. One small JSON file per
//! database in `<app data>/drafts/`, written atomically. The frontend owns the format; the key
//! (the database identity) is only ever hashed into a file name, so it cannot point elsewhere.

use std::path::PathBuf;

use crate::error::AppError;

/// Drafts are DBML text: a few MB at most, even for very large schemas.
const MAX_DRAFT_BYTES: usize = 32 * 1024 * 1024;

pub struct Drafts {
    dir: Option<PathBuf>,
}

/// The Browse-data filters remembered per database (same storage, `<app data>/filters/`).
pub struct FilterMemory(pub Drafts);

/// FNV-1a: stable across Rust versions (unlike `DefaultHasher`), so a draft keeps its file name.
fn fnv1a64(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

impl Drafts {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Drafts { dir }
    }

    fn path(&self, key: &str) -> Result<PathBuf, AppError> {
        let dir = self.dir.as_ref().ok_or_else(|| AppError::Invalid("No app data folder for drafts".into()))?;
        Ok(dir.join(format!("{:016x}.json", fnv1a64(key))))
    }

    pub fn load(&self, key: &str) -> Result<Option<String>, AppError> {
        match std::fs::read_to_string(self.path(key)?) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, key: &str, contents: &str) -> Result<(), AppError> {
        if contents.len() > MAX_DRAFT_BYTES {
            return Err(AppError::Invalid("This DBML is too large to keep as a draft".into()));
        }
        let path = self.path(key)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::fsutil::atomic_write(&path, contents.as_bytes())?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<(), AppError> {
        match std::fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_round_trip_per_key() {
        let dir = std::env::temp_dir().join(format!("xd-drafts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let drafts = Drafts::new(Some(dir.clone()));
        assert_eq!(drafts.load("db:localhost:5432/shop").unwrap(), None);
        drafts.save("db:localhost:5432/shop", r#"{"dbml":"Table a {}"}"#).unwrap();
        drafts.save("db:localhost:5432/other", r#"{"dbml":"Table b {}"}"#).unwrap();
        assert_eq!(drafts.load("db:localhost:5432/shop").unwrap().as_deref(), Some(r#"{"dbml":"Table a {}"}"#));
        // Keys never become paths.
        drafts.save("../../evil", "x").unwrap();
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| e.unwrap().path().parent() == Some(dir.as_path())));
        drafts.delete("db:localhost:5432/shop").unwrap();
        drafts.delete("db:localhost:5432/shop").unwrap();
        assert_eq!(drafts.load("db:localhost:5432/shop").unwrap(), None);
        assert!(drafts.load("db:localhost:5432/other").unwrap().is_some());
        assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
    }
}
