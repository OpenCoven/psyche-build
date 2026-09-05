//! Desktop application composition root.
//!
//! Extracted from `lib.rs` under #197 slice 1. This module constructs and
//! registers capabilities; it deliberately implements none of them. Command
//! bodies, state types, and domain logic stay where they were, so this is a
//! relocation rather than a redesign.
//!
//! Two orderings here are load-bearing and must survive future edits:
//!
//! - the macOS FPS plugin registers before Tauri creates any webview, and
//! - `setup` tolerates `configure_window` failure rather than aborting launch.
//!
//! Neither is observable in CI. A regression in the first shows up only as a
//! ProMotion display silently falling back to 60 Hz at runtime.

use super::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let runtime_diagnostics_state = RuntimeDiagnosticsState::from_startup();
    let native_project_authority = NativeProjectAuthority::from_startup();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        // Registers before Tauri creates any webview, including child browser
        // webviews, so WKWebView does not silently constrain visual updates to
        // 60 Hz on macOS 13–15 and before setup/run lifecycle hooks execute.
        .plugin(tauri_plugin_macos_fps::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(runtime_diagnostics_state)
        .manage(native_project_authority)
        .manage(MetricsState::default())
        .manage(ControlProviderState::default())
        .manage(BrowserShortcutAuthorizations::default())
        .manage(BrowserAutomationAuthorizations::default())
        .invoke_handler(tauri::generate_handler![
            pty_start,
            pty_attach,
            pane_session_metrics,
            canonical_project_path,
            native_project_open,
            native_project_reconcile,
            native_project_close,
            pty_write,
            pty_resize,
            pty_ack,
            pty_set_visibility,
            pty_stop,
            pty_current_generation,
            pty_list,
            pty_transport_metrics,
            browser_app_shortcut,
            browser_report_title,
            browser_automation_result,
            browser_navigate,
            browser_set_bounds,
            browser_hide,
            browser_hide_all_except,
            browser_destroy,
            browser_destroy_many,
            browser_current_url,
            browser_reload,
            browser_eval,
            browser_script,
            browser_snapshot,
            app_environment,
            coven_sessions,
            coven_launch_session,
            coven_launch_capabilities,
            coven_session_kill,
            workspace_load,
            workspace_save,
            native_session_create,
            native_session_list,
            native_session_stop,
            native_session_capture,
            agent_skills,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            git_status,
            git_worktrees,
            git_diff,
            git_log,
            workspace_metrics,
            control_provider_start,
            control_provider_stop,
            control_provider_upsert,
            control_provider_remove,
            control_provider_complete,
            control_provider_shutdown,
            control_operator_submit,
            control_state,
            runtime_diagnostics,
            runtime_process_metrics,
            #[cfg(debug_assertions)]
            diagnostics_spawn_fixture,
            #[cfg(debug_assertions)]
            diagnostics_cycle_window,
        ])
        .setup(|app| {
            if let Err(error) = platform::configure_window(app) {
                log::warn!("optional window configuration unavailable: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
