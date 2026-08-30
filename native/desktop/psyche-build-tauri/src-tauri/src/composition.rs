//! Desktop application composition surface.
//!
//! Issue #197 slice 1: application lifecycle and command registration. The
//! composition root in `crate::run` stays the single place that assembles
//! plugins, managed service state, and the `tauri::generate_handler!` command
//! registration. This module owns the two seams that root already exposes:
//!
//! - [`REGISTERED_COMMANDS`] is the ordered inventory of the public Tauri
//!   command surface. It must stay identical to the `tauri::generate_handler!`
//!   list in `src/lib.rs` and to the `tauri_build::AppManifest` command list
//!   in `build.rs`; the focused composition tests below fail when any copy
//!   drifts, so renames cannot silently change the public command surface.
//! - [`on_app_setup`] is the startup window/webview lifecycle hook. It
//!   delegates platform-specific window configuration to the `platform`
//!   adapter and keeps optional configuration failures non-fatal.
//!
//! Later slices move command implementations out of `lib.rs` module by module
//! behind this same registration inventory, so each capability owns its
//! state, errors, interfaces, and focused tests.

/// Ordered inventory of every Tauri command the desktop application registers
/// with the webview bridge.
///
/// Keep identical to the `tauri::generate_handler!` list in `src/lib.rs` and
/// the `AppManifest::new().commands(&[...])` list in `build.rs`. The order is
/// part of the reviewed public surface; the composition tests in this module
/// enforce both copies plus the command-name invariants.
pub const REGISTERED_COMMANDS: &[&str] = &[
    "pty_start",
    "pty_attach",
    "pane_session_metrics",
    "canonical_project_path",
    "pty_write",
    "pty_resize",
    "pty_ack",
    "pty_set_visibility",
    "pty_stop",
    "pty_list",
    "pty_transport_metrics",
    "browser_app_shortcut",
    "browser_report_title",
    "browser_automation_result",
    "browser_navigate",
    "browser_set_bounds",
    "browser_hide",
    "browser_hide_all_except",
    "browser_destroy",
    "browser_destroy_many",
    "browser_current_url",
    "browser_reload",
    "browser_eval",
    "browser_script",
    "browser_snapshot",
    "app_environment",
    "coven_sessions",
    "coven_session_kill",
    "workspace_load",
    "workspace_save",
    "native_session_create",
    "native_session_list",
    "native_session_stop",
    "native_session_capture",
    "agent_skills",
    "fs_list_dir",
    "fs_read_text",
    "fs_write_text",
    "git_status",
    "git_worktrees",
    "git_diff",
    "git_log",
    "workspace_metrics",
    "control_provider_start",
    "control_provider_stop",
    "control_provider_upsert",
    "control_provider_remove",
    "control_provider_complete",
    "control_provider_shutdown",
    "control_operator_submit",
    "control_state",
    "runtime_diagnostics",
    "runtime_process_metrics",
];

/// Startup window/webview lifecycle hook installed by the composition root's
/// `.setup(...)` in `crate::run`.
///
/// Window configuration is a progressive platform-adapter enhancement: a
/// failure must keep the application bootable and only log, preserving the
/// current user-visible behavior on every supported platform.
pub(crate) fn on_app_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(error) = crate::platform::configure_window(app) {
        log::warn!("optional window configuration unavailable: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod composition_tests {
    use super::REGISTERED_COMMANDS;

    const LIB_RS: &str = include_str!("lib.rs");
    const BUILD_RS: &str = include_str!("../build.rs");

    fn expected_inventory() -> Vec<String> {
        REGISTERED_COMMANDS
            .iter()
            .map(|command| command.to_string())
            .collect()
    }

    /// Extracts the ordered registration list from the single
    /// `tauri::generate_handler![...]` invocation in `src/lib.rs`.
    fn lib_rs_registered_commands() -> Vec<String> {
        let marker = "tauri::generate_handler![";
        let Some(start_offset) = LIB_RS.find(marker) else {
            panic!("lib.rs must keep its tauri::generate_handler! command registration");
        };
        let list = &LIB_RS[start_offset + marker.len()..];
        let Some(end_offset) = list.find(']') else {
            panic!("lib.rs tauri::generate_handler! list must be closed with ]");
        };
        split_command_names(&list[..end_offset])
    }

    /// Extracts the ordered command list from the
    /// `AppManifest::new().commands(&[...])` manifest in `build.rs`.
    fn build_rs_manifest_commands() -> Vec<String> {
        let marker = "AppManifest::new().commands(&[";
        let Some(start_offset) = BUILD_RS.find(marker) else {
            panic!("build.rs must keep its AppManifest command list");
        };
        let list = &BUILD_RS[start_offset + marker.len()..];
        let Some(end_offset) = list.find(']') else {
            panic!("build.rs AppManifest command list must be closed with ]");
        };
        split_command_names(&list[..end_offset])
    }

    /// Splits a comma-separated registration list into trimmed command names,
    /// tolerating line comments and trailing commas.
    fn split_command_names(list: &str) -> Vec<String> {
        list.split(',')
            .map(|entry| {
                let entry = entry.trim();
                match entry.find("//") {
                    Some(comment_start) => entry[..comment_start].trim(),
                    None => entry,
                }
            })
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.trim_matches('"').to_string())
            .collect()
    }

    #[test]
    fn inventory_matches_the_lib_rs_command_registration() {
        assert_eq!(lib_rs_registered_commands(), expected_inventory());
    }

    #[test]
    fn inventory_matches_the_build_rs_app_manifest() {
        assert_eq!(build_rs_manifest_commands(), expected_inventory());
    }

    #[test]
    fn registered_commands_are_unique_snake_case_names() {
        assert!(!REGISTERED_COMMANDS.is_empty());
        let mut sorted = REGISTERED_COMMANDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), REGISTERED_COMMANDS.len());
        for &command in REGISTERED_COMMANDS {
            assert!(
                is_snake_case_command(command),
                "registered command must be snake_case: {command}"
            );
        }
    }

    #[test]
    fn registered_commands_cover_every_desktop_capability_family() {
        let families = [
            ("pty transport", "pty_start"),
            ("pane metrics", "pane_session_metrics"),
            ("browser control", "browser_navigate"),
            ("app environment", "app_environment"),
            ("coven sessions", "coven_sessions"),
            ("workspace persistence", "workspace_load"),
            ("native sessions", "native_session_create"),
            ("agent skills", "agent_skills"),
            ("workspace files", "fs_list_dir"),
            ("git provider", "git_status"),
            ("workspace metrics", "workspace_metrics"),
            ("control provider", "control_provider_start"),
            ("runtime diagnostics", "runtime_diagnostics"),
        ];
        for (family, command) in families {
            assert!(
                REGISTERED_COMMANDS.contains(&command),
                "the {family} capability must keep its registered {command} command"
            );
        }
    }

    fn is_snake_case_command(command: &str) -> bool {
        let snake_case = command.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        });
        !command.is_empty() && !command.starts_with('_') && !command.ends_with('_') && snake_case
    }
}
