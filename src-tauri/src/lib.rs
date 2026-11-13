mod commands;
pub mod db;
pub mod error;
mod files;
mod live;
mod ops;
mod secrets;

use tauri::Manager;

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
            let handle = app.handle().clone();
            let notify: files::Notify = std::sync::Arc::new(move |change| {
                use tauri::Emitter;
                let _ = handle.emit(files::FILE_CHANGED_EVENT, change);
            });
            app.manage(files::FileState::new(Some(notify)));
            use tauri::Manager;
            if let Ok(dir) = app.path().app_data_dir() {
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
            commands::watch_file,
            commands::unwatch_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
