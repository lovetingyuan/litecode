mod commands;
mod configuration;
mod error;
mod external_drop;
mod file_clipboard;
mod file_moves;
mod files;
mod lsp;
mod media;
mod quick_files;
mod replacement;
mod search;
mod state;
mod tools;
mod transactions;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    media::register(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let portable = std::env::current_exe()?.parent().unwrap().join("data");
            let data_dir = if portable.is_dir() {
                portable
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            app.manage(state::AppState {
                data_dir,
                ..Default::default()
            });
            if let Some(window) = app.get_webview_window("main") {
                external_drop::install(&window)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<state::AppState>();
                for (key, task) in state.searches.lock().unwrap().iter() {
                    if key.starts_with(&format!("{}/", window.label())) {
                        task.cancelled
                            .store(true, std::sync::atomic::Ordering::Release);
                    }
                }
                let _ = state.checkpoint(window.label());
                state.servers.lock().unwrap().retain(|key, server| {
                    if key.starts_with(&format!("{}/", window.label())) {
                        lsp::kill_tree(server.pid);
                        false
                    } else {
                        true
                    }
                });
                state.windows.lock().unwrap().remove(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::configuration,
            commands::pick_path,
            commands::open_workspace,
            commands::scan_workspace,
            quick_files::quick_file_paths,
            commands::read_document,
            commands::inspect_file,
            commands::save_document,
            commands::sync_documents,
            commands::file_operation,
            file_moves::plan_file_moves,
            file_moves::move_files,
            file_clipboard::read_file_clipboard,
            file_clipboard::paste_file_clipboard,
            external_drop::authorize_external_drop,
            external_drop::plan_external_copy,
            external_drop::copy_external_item,
            external_drop::release_external_drop,
            commands::reveal_path,
            commands::settings_path,
            commands::explicit_open,
            search::search_start,
            search::search_ack,
            search::search_cancel,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_ack,
            lsp::lsp_stop,
            tools::tool_status,
            tools::format_document,
            tools::install_tools,
            commands::language_document,
            replacement::replacement_plan,
            transactions::replace_disk,
            transactions::replay_replacement,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
