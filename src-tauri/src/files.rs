//! Text files the user works on: an allow-list of paths, saving back to them, and watching them
//! for changes made by other programs. Only paths the user picked in a dialog (or that a previous
//! session reopened) can be written or watched; reads are limited to schema-like extensions.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use crate::error::AppError;

/// Files that may be read back by path (session restore).
const READABLE: &[&str] = &["dbml", "sql", "ddl", "rb", "txt"];
/// Files that may be written in place.
const WRITABLE: &[&str] = &["dbml", "txt"];
pub const FILE_CHANGED_EVENT: &str = "xdiagram://file-changed";

#[derive(Clone, Serialize)]
pub struct FileChanged {
    pub path: String,
    pub contents: String,
}

#[derive(Default)]
struct Inner {
    allowed: HashSet<PathBuf>,
    /// Hash of what this app last wrote to a path (its own writes are not "external changes").
    written: HashMap<PathBuf, u64>,
    /// Watched file → number of tabs watching it.
    watched: HashMap<PathBuf, usize>,
    /// Watched directory → number of watched files in it.
    dirs: HashMap<PathBuf, usize>,
}

/// Delivers external changes to the frontend (an event in the app; nothing in tests).
pub type Notify = Arc<dyn Fn(FileChanged) + Send + Sync>;

pub struct FileState {
    inner: Arc<Mutex<Inner>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    notify: Option<Notify>,
    generation: Arc<Mutex<HashMap<PathBuf, u64>>>,
    counter: Arc<AtomicU64>,
}

fn key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn has_ext(path: &Path, allowed: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| allowed.iter().any(|a| a.eq_ignore_ascii_case(e)))
}

pub fn hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

impl FileState {
    pub fn new(notify: Option<Notify>) -> Self {
        FileState {
            inner: Arc::default(),
            watcher: Mutex::new(None),
            notify,
            generation: Arc::default(),
            counter: Arc::default(),
        }
    }

    /// Marks a path the user picked in a dialog as usable.
    pub fn allow(&self, path: &Path) {
        self.inner.lock().unwrap().allowed.insert(key(path));
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        self.inner.lock().unwrap().allowed.contains(&key(path))
    }

    /// Records content this app wrote, so the watcher does not report it back.
    pub fn record_write(&self, path: &Path, contents: &str) {
        self.inner.lock().unwrap().written.insert(key(path), hash(contents));
    }

    /// Reads a schema file by path (session restore); the path becomes usable afterwards.
    pub fn read(&self, path: &Path) -> Result<String, AppError> {
        if !has_ext(path, READABLE) {
            return Err(AppError::Invalid(format!("Not a schema file: {}", path.display())));
        }
        let contents = std::fs::read_to_string(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::Invalid(format!("File not found: {}", path.display())),
            _ => e.into(),
        })?;
        self.allow(path);
        Ok(contents)
    }

    pub fn write(&self, path: &Path, contents: &str) -> Result<(), AppError> {
        if !has_ext(path, WRITABLE) {
            return Err(AppError::Invalid(format!("Only .dbml files are saved in place: {}", path.display())));
        }
        if !self.is_allowed(path) {
            return Err(AppError::Invalid(format!("Open or save {} through a dialog first", path.display())));
        }
        self.record_write(path, contents);
        std::fs::write(path, contents)?;
        Ok(())
    }

    pub fn watch(&self, path: &Path) -> Result<(), AppError> {
        if !self.is_allowed(path) {
            return Err(AppError::Invalid(format!("Not an open file: {}", path.display())));
        }
        let file = key(path);
        let dir = file.parent().map(Path::to_path_buf).ok_or_else(|| AppError::Invalid("No parent folder".into()))?;
        let mut inner = self.inner.lock().unwrap();
        *inner.watched.entry(file).or_default() += 1;
        let count = inner.dirs.entry(dir.clone()).or_default();
        *count += 1;
        if *count == 1 {
            drop(inner);
            let mut watcher = self.watcher.lock().unwrap();
            if watcher.is_none() {
                *watcher = Some(self.make_watcher()?);
            }
            watcher
                .as_mut()
                .unwrap()
                .watch(&dir, RecursiveMode::NonRecursive)
                .map_err(|e| AppError::Invalid(format!("Cannot watch {}: {e}", dir.display())))?;
        }
        Ok(())
    }

    pub fn unwatch(&self, path: &Path) {
        let file = key(path);
        let Some(dir) = file.parent().map(Path::to_path_buf) else { return };
        let mut inner = self.inner.lock().unwrap();
        match inner.watched.get_mut(&file) {
            Some(n) if *n > 1 => *n -= 1,
            Some(_) => {
                inner.watched.remove(&file);
            }
            None => return,
        }
        let last = match inner.dirs.get_mut(&dir) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            _ => {
                inner.dirs.remove(&dir);
                true
            }
        };
        drop(inner);
        if last && let Some(w) = self.watcher.lock().unwrap().as_mut() {
            let _ = w.unwatch(&dir);
        }
    }

    /// Changes are debounced (editors write in several steps) and compared with what this app
    /// wrote; only real external changes are emitted, with the new contents.
    fn make_watcher(&self) -> Result<RecommendedWatcher, AppError> {
        let inner = self.inner.clone();
        let generation = self.generation.clone();
        let counter = self.counter.clone();
        let app = self.notify.clone();
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            for path in event.paths {
                let file = key(&path);
                if !inner.lock().unwrap().watched.contains_key(&file) {
                    continue;
                }
                let n = counter.fetch_add(1, Ordering::SeqCst);
                generation.lock().unwrap().insert(file.clone(), n);
                let (inner, generation, app) = (inner.clone(), generation.clone(), app.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(300));
                    if generation.lock().unwrap().get(&file) != Some(&n) {
                        return; // a later event for the same file will report it
                    }
                    let Ok(contents) = std::fs::read_to_string(&file) else { return };
                    let ours = inner.lock().unwrap().written.get(&file) == Some(&hash(&contents));
                    if ours {
                        return;
                    }
                    if let Some(notify) = app {
                        notify(FileChanged { path: path_for_display(&file), contents });
                    }
                });
            }
        })
        .map_err(|e| AppError::Invalid(format!("File watching unavailable: {e}")))
    }
}

/// `\\?\C:\x` (canonical form on Windows) → `C:\x`, the form the dialogs return.
fn path_for_display(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xd-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn writes_only_to_allowed_dbml_files() {
        let state = FileState::new(None);
        let path = temp("a.dbml");
        std::fs::write(&path, "Table a {}").unwrap();
        assert!(state.write(&path, "x").is_err(), "not picked in a dialog");
        state.allow(&path);
        state.write(&path, "Table b {}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Table b {}");
        let sql = temp("a.sql");
        std::fs::write(&sql, "x").unwrap();
        state.allow(&sql);
        assert!(state.write(&sql, "y").is_err(), "only .dbml/.txt are written in place");
        assert!(state.read(&temp("secret.key")).is_err());
        assert_eq!(state.read(&path).unwrap(), "Table b {}");
    }

    #[test]
    fn records_its_own_writes() {
        let state = FileState::new(None);
        let path = temp("b.dbml");
        std::fs::write(&path, "").unwrap();
        state.allow(&path);
        state.write(&path, "mine").unwrap();
        let inner = state.inner.lock().unwrap();
        assert_eq!(inner.written.get(&key(&path)), Some(&hash("mine")));
    }

    #[test]
    fn reports_external_changes_but_not_its_own() {
        let (tx, rx) = std::sync::mpsc::channel::<FileChanged>();
        let tx = Mutex::new(tx);
        let notify: Notify = Arc::new(move |c| {
            let _ = tx.lock().unwrap().send(c);
        });
        let state = FileState::new(Some(notify));
        let path = temp("watched.dbml");
        std::fs::write(&path, "Table a {}").unwrap();
        state.allow(&path);
        state.watch(&path).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        state.write(&path, "Table mine {}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err(), "own write reported");

        std::fs::write(&path, "Table theirs {}").unwrap();
        let change = rx.recv_timeout(Duration::from_secs(3)).expect("external change not reported");
        assert_eq!(change.contents, "Table theirs {}");
        assert!(change.path.ends_with("watched.dbml"), "{}", change.path);
        state.unwatch(&path);
    }

    #[test]
    fn counts_watchers() {
        let state = FileState::new(None);
        let path = temp("c.dbml");
        std::fs::write(&path, "").unwrap();
        assert!(state.watch(&path).is_err());
        state.allow(&path);
        state.watch(&path).unwrap();
        state.watch(&path).unwrap();
        state.unwatch(&path);
        assert_eq!(state.inner.lock().unwrap().watched.get(&key(&path)), Some(&1));
        state.unwatch(&path);
        assert!(state.inner.lock().unwrap().watched.is_empty());
        assert!(state.inner.lock().unwrap().dirs.is_empty());
    }
}
