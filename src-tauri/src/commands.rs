use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::db::advisor::{self, RelationCheck, RelationCheckRequest};
use crate::db::browse::{BrowseRequest, BrowseResult};
use crate::db::dispatch;
use crate::db::workload_db::{self, WorkloadReport};
use crate::db::{self, ConnectionInput, DatabaseSchema};
use crate::error::AppError;
use crate::files::FileState;
use crate::live::{self, LiveState};
use crate::ops;
use crate::secrets;

/// Connects and returns the server version string.
#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> Result<String, AppError> {
    dispatch::test_connection(&input).await
}

#[tauri::command]
pub async fn list_schemas(input: ConnectionInput) -> Result<Vec<String>, AppError> {
    dispatch::list_schemas(&input).await
}

/// Reads the schema in the `@dbml/connector` JSON shape. An empty `schemas` list means all schemas.
#[tauri::command]
pub async fn introspect(input: ConnectionInput, schemas: Vec<String>, op_id: Option<String>) -> Result<DatabaseSchema, AppError> {
    ops::cancellable(op_id, dispatch::introspect(&input, &schemas)).await
}

/// Cancels a running operation started with an `op_id`; false when it already finished.
#[tauri::command]
pub fn cancel_op(op_id: String) -> bool {
    ops::cancel(&op_id)
}

/// The join query as readable SQL with the values written in, for the preview and Copy (reads
/// the tables' columns; nothing else runs).
#[tauri::command]
pub async fn join_sql(input: ConnectionInput, request: db::query::JoinRequest, op_id: Option<String>) -> Result<String, AppError> {
    ops::cancellable(op_id, dispatch::join_sql(&input, request)).await
}

/// Runs the join query (read-only) and returns a page of rows.
#[tauri::command]
pub async fn browse_join(input: ConnectionInput, request: db::query::JoinRequest, op_id: Option<String>) -> Result<BrowseResult, AppError> {
    ops::cancellable(op_id, dispatch::browse_join(&input, request)).await
}

/// Column statistics for a sample of one table (read-only).
#[tauri::command]
pub async fn profile_table(
    input: ConnectionInput,
    request: db::profile::ProfileRequest,
    op_id: Option<String>,
) -> Result<db::profile::TableProfile, AppError> {
    ops::cancellable(op_id, dispatch::profile_table(&input, request)).await
}

/// Schema JSON of a SQLite DDL script, built in a private in-memory database.
#[tauri::command]
pub async fn import_sqlite_ddl(sql: String) -> Result<db::sqlite::DdlImport, AppError> {
    dispatch::import_sqlite_ddl(sql).await
}

/// X-ray: relationships discovered from the query workload, FK usage, table facts, cardinality.
#[tauri::command]
pub async fn analyze_workload(input: ConnectionInput, schemas: Vec<String>, op_id: Option<String>) -> Result<WorkloadReport, AppError> {
    dispatch::require_postgres(&input)?;
    ops::cancellable(op_id, async {
        let client = db::connect(&input).await?;
        workload_db::analyze(&client, &schemas).await
    })
    .await
}

/// One page of rows from a table (read-only), for the data browser.
#[tauri::command]
pub async fn browse_table(input: ConnectionInput, request: BrowseRequest, op_id: Option<String>) -> Result<BrowseResult, AppError> {
    ops::cancellable(op_id, dispatch::browse(&input, request)).await
}

/// How many rows match a browse request's filter, counted up to a cap (read-only, time-limited).
#[tauri::command]
pub async fn count_rows(input: ConnectionInput, request: db::browse::CountRequest, op_id: Option<String>) -> Result<db::browse::CountResult, AppError> {
    ops::cancellable(op_id, dispatch::count_rows(&input, request)).await
}

/// The rows a browse request's filter matches, whole values, up to 50,000 (read-only): exports.
#[tauri::command]
pub async fn export_rows(input: ConnectionInput, request: db::browse::ExportRequest, op_id: Option<String>) -> Result<db::browse::ExportResult, AppError> {
    ops::cancellable(op_id, dispatch::export_rows(&input, request)).await
}

/// The rows a browse request shows, as SQL with the values written in ("Copy as SQL"). Reads
/// only the table's columns; nothing else runs.
#[tauri::command]
pub async fn filter_sql(input: ConnectionInput, request: BrowseRequest, op_id: Option<String>) -> Result<String, AppError> {
    ops::cancellable(op_id, dispatch::filter_sql(&input, request)).await
}

/// A table's columns, kinds and primary key (no rows are read).
#[tauri::command]
pub async fn describe_table(input: ConnectionInput, schema: String, table: String, op_id: Option<String>) -> Result<db::catalog::TableInfo, AppError> {
    ops::cancellable(op_id, dispatch::describe_table(&input, schema, table)).await
}

/// A column's values with how often each occurs among the rows matching a filter (read-only,
/// sampled, time-limited): the value picker.
#[tauri::command]
pub async fn value_counts(input: ConnectionInput, request: db::values::ValuesRequest, op_id: Option<String>) -> Result<db::values::ValuesResult, AppError> {
    ops::cancellable(op_id, dispatch::value_counts(&input, request)).await
}

/// "Related data": the rows a row references and the rows referencing it, as a batch of key
/// lookups on one connection (read-only).
#[tauri::command]
pub async fn related_rows(input: ConnectionInput, request: db::related::RelatedRequest, op_id: Option<String>) -> Result<db::related::RelatedResult, AppError> {
    ops::cancellable(op_id, dispatch::related_rows(&input, request)).await
}

/// X-ray: counts rows that would violate a discovered relationship and generates the migration SQL.
/// Read-only; nothing is executed against the schema.
#[tauri::command]
pub async fn check_relation(input: ConnectionInput, request: RelationCheckRequest) -> Result<RelationCheck, AppError> {
    dispatch::require_postgres(&input)?;
    let mut client = db::connect(&input).await?;
    advisor::check_relation(&mut client, &request).await
}

/// X-ray: starts (or restarts) the live activity session that emits `xdiagram://live` events.
#[tauri::command]
pub async fn start_live(
    app: AppHandle,
    state: tauri::State<'_, LiveState>,
    input: ConnectionInput,
    schemas: Vec<String>,
    interval_ms: u64,
) -> Result<(), AppError> {
    dispatch::require_postgres(&input)?;
    live::start(app, &state, input, schemas, interval_ms).await
}

#[tauri::command]
pub fn stop_live(state: tauri::State<'_, LiveState>) {
    state.stop();
}

/// Saves a password (or, for `ssh:<profile id>`, an SSH secret) bound to the server in `input`:
/// it is only ever used again for a connection to that same server.
#[tauri::command]
pub fn save_password(profile_id: String, password: String, input: ConnectionInput) -> Result<(), AppError> {
    let bind = if profile_id.starts_with("ssh:") {
        input.ssh.as_ref().map(db::ssh::SshConfig::binding).ok_or_else(|| AppError::Invalid("This connection has no SSH settings".into()))?
    } else {
        db::connect::password_binding(&input)
    };
    secrets::save_bound(&profile_id, &password, &bind)
}

#[tauri::command]
pub fn delete_password(profile_id: String) -> Result<(), AppError> {
    secrets::delete_password(&profile_id)
}

#[tauri::command]
pub fn has_password(profile_id: String) -> Result<bool, AppError> {
    secrets::has_secret(&profile_id)
}

/// Asks for a destination with the native save dialog, then writes `contents`
/// (base64-decoded when `base64` is true). Returns the saved path, or `None` if cancelled.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    files: tauri::State<'_, FileState>,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents: String,
    base64: bool,
) -> Result<Option<String>, AppError> {
    let text = (!base64).then(|| contents.clone());
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(contents.as_bytes())
            .map_err(|e| AppError::Invalid(format!("Invalid export data: {e}")))?
    } else {
        contents.into_bytes()
    };
    let picked = tokio::task::spawn_blocking(move || {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog().file().set_file_name(default_name).add_filter(filter_name, &exts).blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?;

    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    if let Some(text) = &text {
        files.record_write(&path, text);
    }
    let target = path.clone();
    tokio::task::spawn_blocking(move || crate::fsutil::atomic_write(&target, &bytes))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))??;
    files.allow(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Picks a file with the native open dialog and returns its path (e.g. a SQLite database).
#[tauri::command]
pub async fn pick_file(app: AppHandle, filter_name: String, extensions: Vec<String>) -> Result<Option<String>, AppError> {
    let picked = tokio::task::spawn_blocking(move || {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog().file().add_filter(filter_name, &exts).add_filter("All files", &["*"]).blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct OpenedFile {
    path: String,
    contents: String,
}

/// Picks a text file with the native open dialog and returns its contents.
#[tauri::command]
pub async fn open_text_file(
    app: AppHandle,
    files: tauri::State<'_, FileState>,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenedFile>, AppError> {
    let picked = tokio::task::spawn_blocking(move || {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog().file().add_filter(filter_name, &exts).blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?;

    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    let contents = tokio::fs::read_to_string(&path).await?;
    files.allow(&path);
    Ok(Some(OpenedFile { path: path.to_string_lossy().into_owned(), contents }))
}

/// Reads a schema file by path (reopening the last session's tabs); limited to schema extensions.
#[tauri::command]
pub fn read_text_file(files: tauri::State<'_, FileState>, path: String) -> Result<String, AppError> {
    files.read(std::path::Path::new(&path))
}

/// Saves a .dbml file in place; only files opened or saved through a dialog qualify.
#[tauri::command]
pub fn write_text_file(files: tauri::State<'_, FileState>, path: String, contents: String) -> Result<(), AppError> {
    files.write(std::path::Path::new(&path), &contents)
}

/// Whether `write_text_file` would accept the path; when it would not, the frontend saves
/// through a dialog instead.
#[tauri::command]
pub fn can_write(files: tauri::State<'_, FileState>, path: String) -> bool {
    files.can_write(std::path::Path::new(&path))
}

/// The edited DBML kept for a database (see `drafts.rs`), or `None`.
#[tauri::command]
pub async fn load_draft(drafts: tauri::State<'_, crate::drafts::Drafts>, key: String) -> Result<Option<String>, AppError> {
    drafts.load(&key)
}

#[tauri::command]
pub async fn save_draft(drafts: tauri::State<'_, crate::drafts::Drafts>, key: String, contents: String) -> Result<(), AppError> {
    drafts.save(&key, &contents)
}

#[tauri::command]
pub async fn delete_draft(drafts: tauri::State<'_, crate::drafts::Drafts>, key: String) -> Result<(), AppError> {
    drafts.delete(&key)
}

/// The Browse-data filters remembered for a database (JSON written by `FilterMemoryService`).
#[tauri::command]
pub async fn load_filters(memory: tauri::State<'_, crate::drafts::FilterMemory>, key: String) -> Result<Option<String>, AppError> {
    memory.0.load(&key)
}

#[tauri::command]
pub async fn save_filters(memory: tauri::State<'_, crate::drafts::FilterMemory>, key: String, contents: String) -> Result<(), AppError> {
    memory.0.save(&key, &contents)
}

/// Messages about app files that were damaged and restored at start-up (each is reported once).
#[tauri::command]
pub fn startup_notices(notices: tauri::State<'_, crate::StartupNotices>) -> Vec<String> {
    std::mem::take(&mut *notices.0.lock().unwrap())
}

/// Reports changes other programs make to an open file (`xdiagram://file-changed`).
#[tauri::command]
pub fn watch_file(files: tauri::State<'_, FileState>, path: String) -> Result<(), AppError> {
    files.watch(std::path::Path::new(&path))
}

#[tauri::command]
pub fn unwatch_file(files: tauri::State<'_, FileState>, path: String) {
    files.unwatch(std::path::Path::new(&path));
}

/// The update manifest URL (`plugins.updater.endpoints[0]` in tauri.conf.json): the frontend skips
/// update checks while it is the placeholder, and links to the releases page derived from it.
#[tauri::command]
pub fn update_endpoint(app: AppHandle) -> Option<String> {
    let updater = app.config().plugins.0.get("updater")?;
    updater.get("endpoints")?.get(0)?.as_str().map(str::to_string)
}
