//! Writing files so a crash or power cut never leaves them half-written, and recovering the
//! app's own JSON files when one was damaged anyway.

use std::io::Write;
use std::path::{Path, PathBuf};

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".xdtmp");
    path.with_file_name(name)
}

/// Writes `bytes` to a temporary file next to `path`, flushes it to disk, then renames it over
/// `path`, so the file is either the old or the new version. When the rename is refused (another
/// program holds the file open without sharing), it falls back to writing in place.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temp_path(path);
    let renamed = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, bytes)?;
    }
    Ok(())
}

/// The app's JSON stores (`tauri-plugin-store` files in the app data folder) and what to call
/// them in a message.
pub const STORE_FILES: &[(&str, &str)] = &[
    ("connections.json", "saved connections"),
    ("settings.json", "settings"),
    ("layouts.json", "table positions"),
    ("session.json", "open tabs"),
];

fn is_json(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
}

/// Run at start-up, before anything reads the stores (the store plugin ignores a file it cannot
/// parse, and its next save would overwrite it). A file that parses is copied to `<name>.bak`;
/// one that does not is moved to `<name>.corrupt` and replaced by its `.bak`. Returns one message
/// per damaged file.
pub fn recover_json_files(dir: &Path, files: &[(&str, &str)]) -> Vec<String> {
    let mut notices = Vec::new();
    for (name, label) in files {
        let path = dir.join(name);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let backup = dir.join(format!("{name}.bak"));
        if is_json(&bytes) {
            let _ = atomic_write(&backup, &bytes);
            continue;
        }
        let corrupt = dir.join(format!("{name}.corrupt"));
        if std::fs::rename(&path, &corrupt).is_err() {
            let _ = std::fs::copy(&path, &corrupt);
        }
        match std::fs::read(&backup) {
            Ok(saved) if is_json(&saved) && atomic_write(&path, &saved).is_ok() => notices.push(format!(
                "The file with your {label} ({name}) was damaged; the copy made when xdiagram last started was restored. The damaged file was kept as {name}.corrupt."
            )),
            _ => {
                let _ = std::fs::remove_file(&path);
                notices.push(format!(
                    "The file with your {label} ({name}) was damaged and there was no backup to restore. The damaged file was kept as {name}.corrupt."
                ));
            }
        }
    }
    notices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xd-fsutil-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let d = dir("atomic");
        let path = d.join("a.dbml");
        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        assert!(!temp_path(&path).exists());
    }

    #[test]
    fn damaged_stores_come_back_from_the_backup() {
        let d = dir("recover");
        let files = &[("connections.json", "saved connections"), ("settings.json", "settings")];
        std::fs::write(d.join("connections.json"), r#"{"profiles":[{"id":"a"}]}"#).unwrap();
        assert!(recover_json_files(&d, files).is_empty(), "missing settings.json is fine");
        assert!(d.join("connections.json.bak").exists());

        // Half-written on the next run.
        std::fs::write(d.join("connections.json"), r#"{"profiles":[{"id"#).unwrap();
        let notices = recover_json_files(&d, files);
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("restored"), "{}", notices[0]);
        assert_eq!(std::fs::read_to_string(d.join("connections.json")).unwrap(), r#"{"profiles":[{"id":"a"}]}"#);
        assert!(d.join("connections.json.corrupt").exists());

        // Damaged with no backup: moved aside, so the app starts empty instead of overwriting it.
        std::fs::write(d.join("settings.json"), "not json").unwrap();
        let notices = recover_json_files(&d, files);
        assert!(notices[0].contains("no backup"), "{}", notices[0]);
        assert!(notices[0].contains("your settings"), "{}", notices[0]);
        assert!(!d.join("settings.json").exists());
        assert!(d.join("settings.json.corrupt").exists());
    }
}
