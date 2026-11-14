mod commands;
pub mod db;
mod drafts;
pub mod error;
mod files;
mod fsutil;
mod live;
mod ops;
mod secrets;

use tauri::Manager;

/// What the start-up checks of the app's files found (see `fsutil::recover_json_files`).
#[derive(Default)]
pub struct StartupNotices(pub std::sync::Mutex<Vec<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(live::LiveState::default())
        .setup(|app| {
            // First, before any command runs (so before the store plugin reads its files).
            let data_dir = app.path().app_data_dir().ok();
            let notices = data_dir.as_deref().map(|dir| fsutil::recover_json_files(dir, fsutil::STORE_FILES)).unwrap_or_default();
            app.manage(StartupNotices(std::sync::Mutex::new(notices)));
            app.manage(drafts::Drafts::new(data_dir.as_ref().map(|dir| dir.join("drafts"))));
            app.manage(drafts::FilterMemory(drafts::Drafts::new(data_dir.as_ref().map(|dir| dir.join("filters")))));

            let handle = app.handle().clone();
            let notify: files::Notify = std::sync::Arc::new(move |change| {
                use tauri::Emitter;
                let _ = handle.emit(files::FILE_CHANGED_EVENT, change);
            });
            app.manage(files::FileState::new(Some(notify), data_dir.as_ref().map(|dir| dir.join("allowed-files.json"))));
            if let Some(dir) = &data_dir {
                db::ssh::init_known_hosts(dir.join("known_hosts"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.app_handle().state::<live::LiveState>().stop();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_connection,
            commands::list_schemas,
            commands::introspect,
            commands::cancel_op,
            commands::update_endpoint,
            commands::import_sqlite_ddl,
            commands::browse_table,
            commands::count_rows,
            commands::value_counts,
            commands::describe_table,
            commands::filter_sql,
            commands::export_rows,
            commands::profile_table,
            commands::join_sql,
            commands::browse_join,
            commands::related_rows,
            commands::analyze_workload,
            commands::check_relation,
            commands::start_live,
            commands::stop_live,
            commands::save_password,
            commands::delete_password,
            commands::has_password,
            commands::save_file,
            commands::open_text_file,
            commands::pick_file,
            commands::read_text_file,
            commands::write_text_file,
            commands::can_write,
            commands::startup_notices,
            commands::load_draft,
            commands::save_draft,
            commands::delete_draft,
            commands::load_filters,
            commands::save_filters,
            commands::watch_file,
            commands::unwatch_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
