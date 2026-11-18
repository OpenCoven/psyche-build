// Prevent additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(status) = psyche_build_tauri_lib::support_bundle_helper_entry() {
        std::process::exit(status);
    }
    psyche_build_tauri_lib::run()
}
