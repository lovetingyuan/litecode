use crate::sync::MutexExt;
mod commands;
mod configuration;
mod error;
mod external_drop;
mod file_clipboard;
mod file_creation;
mod file_delete;
mod file_moves;
mod files;
mod formatter_trust;
mod git;
#[cfg(windows)]
mod instance;
mod lsp;
mod media;
mod quick_files;
mod replacement;
mod recovery;
mod search;
mod state;
mod sync;
mod terminal;
mod tools;
mod transactions;
mod updates;
mod workspace;

use tauri::Manager;

fn data_directory(
    app: &tauri::AppHandle,
) -> std::result::Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let portable = std::env::current_exe()?.parent().unwrap().join("data");
    Ok(if portable.is_dir() {
        portable
    } else {
        app.path().app_data_dir()?
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = media::register(tauri::Builder::default());
    #[cfg(windows)]
    let builder = builder.plugin(instance::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(updates::Updates::new(app.handle()));
            #[cfg(windows)]
            let data_dir = app.state::<instance::Instance>().data_dir.clone();
            #[cfg(not(windows))]
            let data_dir = data_directory(app.handle())?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(state::AppState {
                data_dir,
                ..Default::default()
            });
            if let Some(window) = app.get_webview_window("main") {
                external_drop::install(&window)?;
            }
            let state = app.state::<state::AppState>();
            let mut labels = state.recovery_windows().unwrap_or_else(|error| {
                state.startup_warnings.lock_recover().push(format!(
                    "Could not inspect recovery sessions: {}",
                    error.message
                ));
                vec![]
            });
            match transactions::pending_windows(&state) {
                Ok(pending) => {
                    for (label, root) in pending {
                        if let Some(root) = root
                            .and_then(|p| state::canonical(&p).ok())
                            .filter(|p| p.is_dir())
                        {
                            state
                                .windows
                                .lock_recover()
                                .entry(label.clone())
                                .or_default()
                                .root = Some(root);
                        }
                        if label != "main" {
                            labels.push(label);
                        }
                    }
                }
                Err(error) => state.startup_warnings.lock_recover().push(format!(
                    "Could not inspect replacement recovery: {}. Backups were preserved.",
                    error.message
                )),
            }
            labels.sort();
            labels.dedup();
            for label in labels {
                if let Err(error) = commands::create_editor_window(app.handle(), &state, &label) {
                    state
                        .startup_warnings
                        .lock_recover()
                        .push(format!("Could not restore {label}: {}", error.message));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<updates::Updates>()
                    .window_destroyed(window.label());
                let state = window.state::<state::AppState>();
                state.cancel_git(window.label());
                state.terminals.close_window(window.label());
                state.replacement_plans.close_window(window.label());
                for (key, task) in state.searches.lock_recover().iter() {
                    if key.starts_with(&format!("{}/", window.label())) {
                        task.cancelled
                            .store(true, std::sync::atomic::Ordering::Release);
                    }
                }
                // Final synchronous flush must finish before the last window exits.
                // Do not wait for the disk gate on the UI thread: a task holding
                // it may be waiting for this thread to create a window.
                let _ = state.checkpoint(window.label());
                state.servers.lock_recover().retain(|key, server| {
                    if key.starts_with(&format!("{}/", window.label())) {
                        lsp::kill_tree(server.pid);
                        false
                    } else {
                        true
                    }
                });
                state.windows.lock_recover().remove(window.label());
                state.terminals.close_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates::get_update_state,
            updates::check_update,
            updates::install_update,
            updates::ack_update_checkpoint,
            commands::bootstrap,
            commands::configuration,
            commands::set_workspace_trust,
            commands::pick_path,
            commands::new_window,
            commands::open_workspace,
            commands::workspace_git_status,
            git::git_repository_info,
            git::git_read_diff,
            git::blame::git_blame_file,
            git::git_open_source,
            git::git_operate,
            git::git_cancel,
            commands::read_workspace_directory,
            quick_files::quick_file_paths,
            commands::read_document,
            commands::inspect_file,
            commands::save_document,
            commands::sync_documents,
            commands::file_operation,
            file_creation::validate_workspace_creation,
            file_creation::create_workspace_entry,
            file_creation::validate_workspace_rename,
            file_creation::rename_workspace_entry,
            file_moves::plan_file_moves,
            file_moves::move_files,
            file_clipboard::read_file_clipboard,
            file_clipboard::paste_file_clipboard,
            external_drop::authorize_external_drop,
            external_drop::plan_external_copy,
            external_drop::copy_external_item,
            external_drop::release_external_drop,
            commands::reveal_path,
            commands::open_directory,
            commands::settings_path,
            commands::explicit_open,
            search::search_start,
            search::search_ack,
            search::search_cancel,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_ack,
            lsp::lsp_stop,
            terminal::terminal_profiles,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_ack,
            terminal::terminal_close,
            terminal::terminal_update_cwd,
            tools::tool_status,
            tools::format_document,
            formatter_trust::trust_formatter,
            tools::install_tools,
            commands::language_document,
            replacement::replacement_plan,
            replacement::replacement_plan_begin,
            replacement::replacement_plan_cancel,
            replacement::replacement_plan_release,
            transactions::replace_disk,
            transactions::replay_replacement,
            transactions::finish_replacement,
            transactions::resume_replacement,
            transactions::replacement_recovery,
            transactions::recover_replacement,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
