use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

const BROWSER_LABEL_PREFIX: &str = "psyche-browser-";

fn safe_browser_label(label: Option<String>) -> String {
    let raw = label.unwrap_or_else(|| "default".to_string());
    let safe: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    format!(
        "{}{}",
        BROWSER_LABEL_PREFIX,
        if safe.is_empty() { "default" } else { &safe }
    )
}

// ----------------------------------------------------------------------------
// Multi-PTY backend
// ----------------------------------------------------------------------------

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, PtySession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STARTING_SESSIONS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static AUGMENTED_PATH: Lazy<String> = Lazy::new(compute_augmented_path);

struct PendingPtyStart {
    thread_id: String,
}

impl PendingPtyStart {
    fn reserve(thread_id: &str) -> Result<Self, String> {
        let sessions = SESSIONS.lock();
        let mut starting = STARTING_SESSIONS.lock();
        if sessions.contains_key(thread_id) || starting.contains(thread_id) {
            return Err(format!("thread '{}' already running", thread_id));
        }
        starting.insert(thread_id.to_string());
        Ok(Self {
            thread_id: thread_id.to_string(),
        })
    }
}

impl Drop for PendingPtyStart {
    fn drop(&mut self) {
        let mut starting = STARTING_SESSIONS.lock();
        starting.remove(&self.thread_id);
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartOptions {
    pub thread_id: String,
    pub project_root: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Extra environment variables on top of the inherited environment.
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyDataEvent {
    pub thread_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub thread_id: String,
    pub code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BrowserPageLoadEvent {
    pub label: String,
    pub url: String,
    pub phase: String,
}

#[tauri::command]
fn pty_start(app: AppHandle, options: StartOptions) -> Result<(), String> {
    let thread_id = options.thread_id.clone();
    let pending_start = PendingPtyStart::reserve(&thread_id)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let command = options.command.unwrap_or_else(|| "/bin/zsh".to_string());
    let args = options.args.unwrap_or_else(|| vec!["-l".to_string()]);
    let mut cmd = CommandBuilder::new(command);
    cmd.args(args);
    if let Some(root) = &options.project_root {
        cmd.cwd(root);
    }
    // Build a sane child environment. When the .app is launched from
    // Finder/Dock, launchd hands us a stripped PATH that lacks
    // /opt/homebrew/bin, so psyche can't find tmux/git/gh/etc. Augment PATH
    // with the conventional locations, and provide reasonable defaults for
    // TERM / COLORTERM / LANG so xterm.js renders unicode + truecolor.
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PSYCHE_TAURI", "1");
    cmd.env("PSYCHE_NATIVE_CONTAINER", "1");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if std::env::var("LC_ALL").is_err() {
        cmd.env("LC_ALL", "en_US.UTF-8");
    }
    if let Some(extra_env) = options.env {
        for (k, v) in extra_env {
            // Empty-string values are treated as "unset this variable" so the
            // JS layer can scrub TMUX (which tmux uses to detect nesting).
            if v.is_empty() {
                cmd.env_remove(&k);
            } else {
                cmd.env(k, v);
            }
        }
    }
    // Always make sure TMUX is unset unless something downstream explicitly
    // wants it. Inheriting it from the Tauri parent process makes nested-tmux
    // checks misfire.
    cmd.env_remove("TMUX");
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");
    cmd.env_remove("PREFIX");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = SESSIONS.lock();
        guard.insert(
            thread_id.clone(),
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
            },
        );
    }
    drop(pending_start);

    let data_thread_id = thread_id.clone();
    let app_for_data = app.clone();
    let data_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = PtyDataEvent {
                        thread_id: data_thread_id.clone(),
                        bytes: buf[..n].to_vec(),
                    };
                    let _ = app_for_data.emit("pty:data", payload);
                }
                Err(_) => break,
            }
        }
    });

    let exit_thread_id = thread_id.clone();
    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        {
            let mut guard = SESSIONS.lock();
            guard.remove(&exit_thread_id);
        }
        let code = status.ok().map(|s| s.exit_code() as i32);
        let _ = data_thread.join();
        let _ = app_for_exit.emit(
            "pty:exit",
            PtyExitEvent {
                thread_id: exit_thread_id,
                code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
fn pty_write(thread_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let writer = {
        let guard = SESSIONS.lock();
        let session = guard
            .get(&thread_id)
            .ok_or_else(|| format!("thread '{}' not found", thread_id))?;
        Arc::clone(&session.writer)
    };
    let mut writer = writer.lock();
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_resize(thread_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = SESSIONS.lock();
    if let Some(session) = guard.get(&thread_id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_stop(thread_id: String) {
    let mut guard = SESSIONS.lock();
    guard.remove(&thread_id);
}

#[tauri::command]
fn pty_list() -> Vec<String> {
    let guard = SESSIONS.lock();
    guard.keys().cloned().collect()
}

// ----------------------------------------------------------------------------
// Embedded browser pane (Tauri child Webview)
// ----------------------------------------------------------------------------

fn ensure_browser(
    app: &AppHandle,
    label: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    url: &str,
) -> Result<bool, String> {
    if app.webviews().keys().any(|existing| existing == label) {
        return Ok(false);
    }

    let main = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    let parsed_url = Url::parse(url).map_err(|e| e.to_string())?;
    let browser_label = label.to_string();
    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url)).on_page_load(
        move |webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = app_for_load.emit(
                "browser:page-load",
                BrowserPageLoadEvent {
                    label: browser_label.clone(),
                    url: payload.url().to_string(),
                    phase: phase.to_string(),
                },
            );
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let label_json = serde_json::to_string(&browser_label).unwrap_or_else(|_| "null".to_string());
                let script = format!(
                    r#"(function(browserLabel) {{
                      try {{
                        var emit = function(name, payload) {{
                          if (window.__TAURI__ && window.__TAURI__.event) {{
                            window.__TAURI__.event.emit(name, payload);
                          }}
                        }};
                        var title = document.title || location.hostname || location.href;
                        emit("browser:title", {{ label: browserLabel, title: title, url: location.href }});
                        if (!window.__PSYCHE_BROWSER_SHORTCUTS_INSTALLED__) {{
                          window.__PSYCHE_BROWSER_SHORTCUTS_INSTALLED__ = true;
                          window.addEventListener("keydown", function(event) {{
                            try {{
                              if ((event.metaKey || event.ctrlKey) && event.key && event.key.toLowerCase() === "t") {{
                                event.preventDefault();
                                event.stopPropagation();
                                emit("browser:shortcut-new-tab", {{ label: browserLabel, url: location.href }});
                              }}
                            }} catch (_) {{}}
                          }}, true);
                          window.addEventListener("pointerdown", function() {{
                            emit("browser:focus", {{ label: browserLabel, url: location.href }});
                          }}, true);
                          window.addEventListener("focusin", function() {{
                            emit("browser:focus", {{ label: browserLabel, url: location.href }});
                          }}, true);
                        }}
                      }} catch (_) {{}}
                    }})({});"#,
                    label_json
                );
                let _ = webview.eval(&script);
            }
        },
    );

    main.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(w.max(1.0), h.max(1.0)),
    )
    .map_err(|e| e.to_string())?;

    Ok(true)
}

fn hide_webview(webview: &tauri::Webview) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(-10000.0, -10000.0))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(1.0, 1.0))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn browser_navigate(
    app: AppHandle,
    label: Option<String>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let label = safe_browser_label(label);
    let created = ensure_browser(&app, &label, x, y, w, h, &url)?;
    if !created {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| "browser webview missing".to_string())?;
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
        let parsed_url = Url::parse(&url).map_err(|e| e.to_string())?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_set_bounds(
    app: AppHandle,
    label: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_hide(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        hide_webview(&webview)?;
    }
    Ok(())
}

#[tauri::command]
fn browser_hide_all_except(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let keep = label.map(|raw| safe_browser_label(Some(raw)));
    for (existing_label, webview) in app.webviews() {
        if existing_label.starts_with(BROWSER_LABEL_PREFIX) && Some(existing_label.clone()) != keep
        {
            hide_webview(&webview)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn browser_reload(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_eval(app: AppHandle, label: Option<String>, script: String) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----------------------------------------------------------------------------
// Environment introspection so the JS layer can locate `node` + the bundled
// psyche entrypoint when the app is invoked from a worktree (dev mode).
// ----------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct AppEnvironment {
    pub home: Option<String>,
    pub repo_root: Option<String>,
    pub psyche_entry: Option<String>,
    pub node_path: Option<String>,
    pub default_shell: String,
}

#[tauri::command]
fn app_environment() -> AppEnvironment {
    let home = std::env::var("HOME").ok();
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Try to find a `node` on PATH. portable-pty inherits the parent env, so
    // launching `node` from there should work even if PATH munging in spawn
    // misses common Homebrew paths.
    let node_path = which_on_path("node");

    // Heuristic: if the binary is being run from a built .app inside a
    // worktree, the worktree root is a couple of levels up from the .app.
    let repo_root = locate_psyche_repo();
    let psyche_entry = repo_root.as_ref().and_then(|root| {
        let candidate = format!("{}/dist/index.js", root);
        if std::path::Path::new(&candidate).exists() {
            Some(candidate)
        } else {
            None
        }
    });

    AppEnvironment {
        home,
        repo_root,
        psyche_entry,
        node_path,
        default_shell,
    }
}

// ----------------------------------------------------------------------------
// Agent harness skills/plugins discovery.
//
// Surfaces the slash commands that an agent harness running in a thread will
// recognise, so the Tauri command bar can autocomplete + invoke them. v1
// covers Claude Code: user/project skills, user/project commands, and
// plugin-supplied skills/commands. Other harnesses can be added by extending
// the match in `agent_skills`.
// ----------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct AgentSkillEntry {
    pub harness: String,
    /// Slash command name including leading slash, e.g. "/security-review"
    /// or "/myplugin:foo".
    pub name: String,
    pub description: String,
    /// "user" | "project" | "plugin"
    pub source: String,
    /// "user" / "project" for non-plugin entries; plugin name for plugins.
    pub origin: String,
    /// "skill" | "command"
    pub kind: String,
    pub path: String,
}

fn agent_skill_source_rank(source: &str) -> u8 {
    match source {
        "project" => 0,
        "user" => 1,
        "plugin" => 2,
        _ => 3,
    }
}

#[tauri::command]
fn agent_skills(harness: Option<String>, project_root: Option<String>) -> Vec<AgentSkillEntry> {
    let harness = harness.unwrap_or_else(|| "claude".to_string());
    let mut out: Vec<AgentSkillEntry> = vec![];
    if harness != "claude" {
        return out;
    }

    if let Ok(home) = std::env::var("HOME") {
        let user_root = Path::new(&home).join(".claude");
        if user_root.is_dir() {
            scan_claude_dir(&user_root, "user", "user", None, &mut out);
        }
        let plugins_root = user_root.join("plugins");
        if plugins_root.is_dir() {
            scan_claude_plugins(&plugins_root, &mut out);
        }
    }
    if let Some(pr) = project_root.as_deref() {
        let proj_claude = Path::new(pr).join(".claude");
        if proj_claude.is_dir() {
            scan_claude_dir(&proj_claude, "project", "project", None, &mut out);
        }
    }

    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.kind.cmp(&b.kind))
            .then(agent_skill_source_rank(&a.source).cmp(&agent_skill_source_rank(&b.source)))
            .then(a.source.cmp(&b.source))
    });
    out.dedup_by(|a, b| a.name == b.name && a.kind == b.kind);
    out
}

/// Scan a `.claude` (or plugin root) directory for `commands/*.md` and
/// `skills/<name>/SKILL.md`. `prefix` is prepended to the slash name for
/// plugin-supplied entries (`Some("myplugin")` → `/myplugin:foo`).
fn scan_claude_dir(
    root: &Path,
    source: &str,
    origin: &str,
    prefix: Option<&str>,
    out: &mut Vec<AgentSkillEntry>,
) {
    let commands_dir = root.join("commands");
    if commands_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&commands_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("md") {
                    continue;
                }
                let stem = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                let name = match prefix {
                    Some(p) => format!("/{}:{}", p, stem),
                    None => format!("/{}", stem),
                };
                out.push(AgentSkillEntry {
                    harness: "claude".into(),
                    name,
                    description: read_md_description(&path).unwrap_or_default(),
                    source: source.into(),
                    origin: origin.into(),
                    kind: "command".into(),
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    let skills_dir = root.join("skills");
    if skills_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&skills_dir) {
            for entry in rd.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let skill_md = dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                let skill_name = match dir.file_name().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                let name = match prefix {
                    Some(p) => format!("/{}:{}", p, skill_name),
                    None => format!("/{}", skill_name),
                };
                out.push(AgentSkillEntry {
                    harness: "claude".into(),
                    name,
                    description: read_md_description(&skill_md).unwrap_or_default(),
                    source: source.into(),
                    origin: origin.into(),
                    kind: "skill".into(),
                    path: skill_md.to_string_lossy().to_string(),
                });
            }
        }
    }
}

/// Find every plugin under `~/.claude/plugins` that ships its own
/// `commands/` or `skills/` subtree, regardless of where Claude's plugin
/// installer actually placed it (layouts vary across versions:
/// `plugins/<name>/`, `plugins/repos/<marketplace>/<name>/`, etc.). We bound
/// the walk so we never recurse into node_modules or git history.
fn scan_claude_plugins(root: &Path, out: &mut Vec<AgentSkillEntry>) {
    fn plugin_name_from_manifest(dir: &Path) -> Option<String> {
        for rel in [
            ".plugin/plugin.json",
            ".claude-plugin/plugin.json",
            "package.json",
        ] {
            let path = dir.join(rel);
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };
            let Some(name) = json.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if !name.trim().is_empty() {
                return Some(name.trim().to_string());
            }
        }
        None
    }

    fn walk(dir: &Path, depth: u32, plugin_hint: Option<&str>, out: &mut Vec<AgentSkillEntry>) {
        if depth > 4 {
            return;
        }
        let has_commands = dir.join("commands").is_dir();
        let has_skills = dir.join("skills").is_dir();
        let plugin_name = plugin_hint
            .map(|s| s.to_string())
            .or_else(|| plugin_name_from_manifest(dir))
            .or_else(|| {
                dir.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "plugin".to_string());
        if has_commands || has_skills {
            scan_claude_dir(dir, "plugin", &plugin_name, Some(&plugin_name), out);
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let path: PathBuf = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if name.is_empty() || name.starts_with('.') || name == "node_modules" {
                continue;
            }
            walk(&path, depth + 1, None, out);
        }
    }
    walk(root, 0, None, out);
}

/// Pull a one-line description out of a markdown file. Prefers the
/// `description:` key in YAML frontmatter, then the first non-empty,
/// non-heading line.
fn read_md_description(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut iter = content.lines();
    let first = iter.next()?;
    if first.trim() == "---" {
        let mut in_fm = true;
        for line in iter.by_ref() {
            if line.trim() == "---" {
                in_fm = false;
                break;
            }
            if let Some(rest) = line.strip_prefix("description:") {
                let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                if !value.is_empty() {
                    return Some(truncate_oneline(&value));
                }
            }
        }
        if in_fm {
            return None;
        }
        for line in iter {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with('#') {
                return Some(truncate_oneline(t));
            }
        }
        None
    } else {
        let t = first.trim();
        if !t.is_empty() && !t.starts_with('#') {
            return Some(truncate_oneline(t));
        }
        for line in iter {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with('#') {
                return Some(truncate_oneline(t));
            }
        }
        None
    }
}

fn truncate_oneline(s: &str) -> String {
    let s = s.replace('\r', "");
    let one = s.lines().next().unwrap_or("").trim().to_string();
    if one.chars().count() > 160 {
        one.chars().take(157).collect::<String>() + "…"
    } else {
        one
    }
}

fn augmented_path() -> &'static str {
    AUGMENTED_PATH.as_str()
}

fn compute_augmented_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let extras = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    let mut parts: Vec<PathBuf> = Vec::new();
    for p in std::env::split_paths(&existing) {
        if !p.as_os_str().is_empty() && !parts.iter().any(|existing| existing == &p) {
            parts.push(p);
        }
    }
    for extra in extras {
        let extra = PathBuf::from(extra);
        if !parts.iter().any(|existing| existing == &extra) {
            parts.push(extra);
        }
    }
    // Plus common user-installed runtime managers on macOS.
    if let Ok(home) = std::env::var("HOME") {
        let home_path = Path::new(&home);
        for suffix in [
            ".cargo/bin",
            ".local/bin",
            ".volta/bin",
            ".bun/bin",
            ".rbenv/shims",
            ".pyenv/shims",
        ] {
            push_path_if_dir(&mut parts, home_path.join(suffix));
        }
        if let Some(nvm_bin) = newest_nvm_node_bin(home_path) {
            push_path_if_dir(&mut parts, nvm_bin);
        }
    }
    std::env::join_paths(&parts)
        .map(|joined| joined.to_string_lossy().to_string())
        .unwrap_or_else(|_| existing.clone())
}

fn push_path_if_dir(parts: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidate.is_dir() {
        return;
    }
    if !parts.iter().any(|p| p == &candidate) {
        parts.push(candidate);
    }
}

fn newest_nvm_node_bin(home: &Path) -> Option<PathBuf> {
    let versions_dir = home.join(".nvm").join("versions").join("node");
    let mut newest: Option<((u32, u32, u32), PathBuf)> = None;
    for entry in std::fs::read_dir(versions_dir).ok()? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(version) = parse_nvm_node_version(&name.to_string_lossy()) else {
            continue;
        };
        if newest
            .as_ref()
            .map_or(true, |(current, _)| version > *current)
        {
            newest = Some((version, path));
        }
    }
    newest.map(|(_, path)| path.join("bin"))
}

fn parse_nvm_node_version(name: &str) -> Option<(u32, u32, u32)> {
    let trimmed = name.strip_prefix('v').unwrap_or(name);
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn which_on_path(binary: &str) -> Option<String> {
    for dir in std::env::split_paths(augmented_path()) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn locate_psyche_repo() -> Option<String> {
    // Walk up from the current executable looking for a directory that
    // contains both `dist/index.js` and `package.json`.
    let exe = std::env::current_exe().ok()?;
    let mut current = exe.parent()?.to_path_buf();
    for _ in 0..12 {
        let dist = current.join("dist").join("index.js");
        let pkg = current.join("package.json");
        if dist.is_file() && pkg.is_file() {
            return Some(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    // Fall back to CWD walk.
    let cwd = std::env::current_dir().ok()?;
    let mut current = cwd;
    for _ in 0..12 {
        let dist = current.join("dist").join("index.js");
        let pkg = current.join("package.json");
        if dist.is_file() && pkg.is_file() {
            return Some(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    None
}

// ----------------------------------------------------------------------------
// Workspace side panels: file tree, diffs, and git/GitHub state.
//
// These back the right-rail panels. File saves are the only working-tree
// mutation and use containment plus optimistic conflict checks.
// ----------------------------------------------------------------------------

/// Cap on file preview size. Big files are truncated rather than refused so the
/// panel still shows a useful head.
const MAX_PREVIEW_BYTES: u64 = 512 * 1024;
static SAVE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn canonical_project_root(root: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("project root '{}': {}", root, e))?;
    if !canonical.is_dir() {
        return Err(format!("project root is not a directory: {}", root));
    }
    Ok(canonical)
}

fn resolve_project_path(root: &str, requested: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_project_root(root)?;
    let requested_path = Path::new(requested);
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_root.join(requested_path)
    };
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("path '{}': {}", requested, e))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!("path is outside project root: {}", requested));
    }
    Ok(canonical_candidate)
}

fn validate_git_relative_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if path.is_empty()
        || candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("git path must stay inside project root: {}", path));
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
fn fs_list_dir(root: String, path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = resolve_project_path(&root, &path)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut out: Vec<DirEntryInfo> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // .git is noise in a file tree and enormous; the git panel covers it.
        if name == ".git" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    // Directories first, then case-insensitive by name.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
pub struct FileText {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

#[tauri::command]
fn fs_read_text(root: String, path: String) -> Result<FileText, String> {
    let p = resolve_project_path(&root, &path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("is a directory: {}", path));
    }
    let size = meta.len();
    let mut file = std::fs::File::open(&p).map_err(|e| e.to_string())?;
    let take = size.min(MAX_PREVIEW_BYTES);
    let mut buf = vec![0u8; take as usize];
    let read = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(read);

    // A NUL byte in the head is the usual "this is binary" heuristic. Invalid
    // UTF-8 is also non-editable so a save can never perform a lossy rewrite.
    let binary = buf.iter().take(8000).any(|b| *b == 0) || std::str::from_utf8(&buf).is_err();
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).to_string()
    };
    Ok(FileText {
        path: p.to_string_lossy().to_string(),
        text,
        truncated: size > take,
        binary,
        size,
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct SavedFileText {
    pub path: String,
    pub text: String,
    pub size: u64,
}

fn atomic_replace_file(
    target: &Path,
    bytes: &[u8],
    permissions: std::fs::Permissions,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("file has no parent directory: {}", target.display()))?;
    let basename = target
        .file_name()
        .ok_or_else(|| format!("file has no name: {}", target.display()))?;

    let (temp_path, mut temp_file) = loop {
        let counter = SAVE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = basename.to_os_string();
        temp_name.push(format!(".psyche-save-{}-{}", std::process::id(), counter));
        let temp_path = parent.join(temp_name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => break (temp_path, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create temporary save file for '{}': {}",
                    target.display(),
                    error
                ));
            }
        }
    };

    let save_result = (|| -> Result<(), String> {
        temp_file
            .set_permissions(permissions)
            .map_err(|e| format!("copy permissions for '{}': {}", target.display(), e))?;
        temp_file
            .write_all(bytes)
            .map_err(|e| format!("write temporary save for '{}': {}", target.display(), e))?;
        temp_file
            .flush()
            .map_err(|e| format!("flush temporary save for '{}': {}", target.display(), e))?;
        temp_file
            .sync_all()
            .map_err(|e| format!("sync temporary save for '{}': {}", target.display(), e))?;
        drop(temp_file);
        std::fs::rename(&temp_path, target)
            .map_err(|e| format!("replace '{}': {}", target.display(), e))?;
        Ok(())
    })();

    if save_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    save_result
}

#[tauri::command]
fn fs_write_text(
    root: String,
    path: String,
    text: String,
    expected_text: String,
) -> Result<SavedFileText, String> {
    let target = resolve_project_path(&root, &path)?;
    if !target.is_file() {
        return Err(format!("not a regular file: {}", path));
    }

    let metadata = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    let current_bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let current_text = std::str::from_utf8(&current_bytes)
        .map_err(|_| format!("file is not valid UTF-8: {}", path))?;
    if current_text != expected_text {
        return Err(format!("file changed on disk: {}", path));
    }

    atomic_replace_file(&target, text.as_bytes(), metadata.permissions())?;
    Ok(SavedFileText {
        path: target.to_string_lossy().to_string(),
        size: text.len() as u64,
        text,
    })
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {:?} failed", args)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// git@github.com:owner/repo.git and https://github.com/owner/repo.git both
/// normalise to a browsable https URL.
fn remote_to_web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let mut parts = rest.splitn(2, ':');
        let host = parts.next()?;
        let path = parts.next()?;
        return Some(format!("https://{}/{}", host, path));
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        return Some(r.to_string());
    }
    if let Some(rest) = r.strip_prefix("ssh://git@") {
        return Some(format!("https://{}", rest));
    }
    None
}

#[derive(Debug, Serialize, Clone)]
pub struct GitFileEntry {
    pub path: String,
    /// Two-character porcelain code, e.g. " M", "A ", "??".
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileEntry>,
    pub remote_url: Option<String>,
    pub web_url: Option<String>,
}

#[tauri::command]
fn git_status(root: String) -> Result<GitStatus, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let inside = run_git(&root, &["rev-parse", "--is-inside-work-tree"]).unwrap_or_default();
    if inside.trim() != "true" {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            remote_url: None,
            web_url: None,
        });
    }

    let prefix = run_git(&root, &["rev-parse", "--show-prefix"])?
        .trim()
        .to_string();
    let raw = run_git(
        &root,
        &[
            "status",
            "--porcelain",
            "-b",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )?;
    let mut branch = None;
    let mut upstream = None;
    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut files = Vec::new();

    for line in raw.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main"
            let (refs, track) = match head.find(" [") {
                Some(i) => (&head[..i], &head[i..]),
                None => (head, ""),
            };
            let mut it = refs.splitn(2, "...");
            branch = it
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            upstream = it.next().map(|s| s.trim().to_string());
            for (key, slot) in [("ahead ", &mut ahead), ("behind ", &mut behind)] {
                if let Some(i) = track.find(key) {
                    let tail = &track[i + key.len()..];
                    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    *slot = digits.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].to_string();
        // Renames read "R  old -> new"; the new path is what the user cares about.
        let rest = &line[3..];
        let repo_path = match rest.split(" -> ").last() {
            Some(p) => p.to_string(),
            None => rest.to_string(),
        };
        let path = if prefix.is_empty() {
            repo_path
        } else {
            let Some(relative) = repo_path.strip_prefix(&prefix) else {
                continue;
            };
            relative.to_string()
        };
        let index = code.chars().next().unwrap_or(' ');
        let worktree = code.chars().nth(1).unwrap_or(' ');
        files.push(GitFileEntry {
            path,
            untracked: code == "??",
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ' && worktree != '?',
            code,
        });
    }

    let remote_url = run_git(&root, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let web_url = remote_url.as_deref().and_then(remote_to_web_url);

    Ok(GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
        remote_url,
        web_url,
    })
}

#[tauri::command]
fn git_diff(root: String, path: Option<String>, staged: Option<bool>) -> Result<String, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "--no-pager".into(),
        "diff".into(),
        "--no-color".into(),
        "--relative".into(),
    ];
    if staged.unwrap_or(false) {
        args.push("--cached".into());
    }
    if let Some(p) = path.as_ref() {
        validate_git_relative_path(p)?;
        args.push("--".into());
        args.push(p.clone());
    } else {
        args.push("--".into());
        args.push(".".into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run_git(&root, &refs)?;
    if !out.trim().is_empty() {
        return Ok(out);
    }
    // An untracked file has no diff; show it as an all-additions block instead
    // of an empty pane.
    if let Some(p) = path {
        let full = resolve_project_path(&root, &p)?;
        if full.is_file() {
            if let Ok(text) = std::fs::read_to_string(&full) {
                let mut s = format!("--- /dev/null\n+++ b/{}\n", p);
                for line in text.lines().take(2000) {
                    s.push('+');
                    s.push_str(line);
                    s.push('\n');
                }
                return Ok(s);
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub relative: String,
}

#[tauri::command]
fn git_log(root: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let n = limit.unwrap_or(30).clamp(1, 200).to_string();
    let raw = run_git(
        &root,
        &[
            "--no-pager",
            "log",
            "-n",
            &n,
            "--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar",
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            Some(GitCommit {
                hash: f.next()?.to_string(),
                short: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                relative: f.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty_start,
            pty_write,
            pty_resize,
            pty_stop,
            pty_list,
            browser_navigate,
            browser_set_bounds,
            browser_hide,
            browser_hide_all_except,
            browser_reload,
            browser_eval,
            app_environment,
            agent_skills,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            git_status,
            git_diff,
            git_log,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        Some(10.0),
                    );
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod workspace_panel_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must be after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "psyche-workspace-panels-{}-{}-{}",
                label,
                std::process::id(),
                nonce
            ));
            std::fs::create_dir_all(&root).expect("temporary tree must be created");
            Self { root }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn path_text(path: &Path) -> &str {
        path.to_str().expect("test paths must be UTF-8")
    }

    fn run_test_git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git must run in tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn save_temp_paths(target: &Path) -> Vec<PathBuf> {
        let prefix = format!(
            "{}.psyche-save-",
            target
                .file_name()
                .expect("save target must have a file name")
                .to_string_lossy()
        );
        std::fs::read_dir(target.parent().expect("save target must have a parent"))
            .expect("save target parent must be readable")
            .map(|entry| entry.expect("directory entry must be readable").path())
            .filter(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect()
    }

    #[test]
    fn resolves_existing_paths_inside_the_project() {
        let tree = TempTree::new("inside");
        let nested = tree.root.join("src").join("main.rs");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "fn main() {}\n").unwrap();

        let resolved = resolve_project_path(path_text(&tree.root), path_text(&nested)).unwrap();

        assert_eq!(resolved, nested.canonicalize().unwrap());
    }

    #[test]
    fn rejects_parent_traversal_and_sibling_prefixes() {
        let tree = TempTree::new("outside");
        let project = tree.root.join("project");
        let sibling = tree.root.join("project-copy");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling_file = sibling.join("secret.txt");
        std::fs::write(&sibling_file, "secret\n").unwrap();

        assert!(resolve_project_path(path_text(&project), "../project-copy/secret.txt").is_err());
        assert!(resolve_project_path(path_text(&project), path_text(&sibling_file)).is_err());

        let relative_error = fs_write_text(
            path_text(&project).to_string(),
            "../project-copy/secret.txt".to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        let absolute_error = fs_write_text(
            path_text(&project).to_string(),
            path_text(&sibling_file).to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        assert!(relative_error.contains("outside project root"));
        assert!(absolute_error.contains("outside project root"));
        assert_eq!(std::fs::read(&sibling_file).unwrap(), b"secret\n");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("symlink");
        let project = tree.root.join("project");
        let outside = tree.root.join("outside.txt");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(&outside, "secret\n").unwrap();
        let link = project.join("linked-secret.txt");
        symlink(&outside, &link).unwrap();

        assert!(resolve_project_path(path_text(&project), path_text(&link)).is_err());
        let error = fs_write_text(
            path_text(&project).to_string(),
            path_text(&link).to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("outside project root"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret\n");
    }

    #[test]
    fn saves_contained_text_atomically_and_preserves_permissions() {
        let tree = TempTree::new("save");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "before\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        let permissions_before = std::fs::metadata(&target).unwrap().permissions();

        let saved = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "after\n".to_string(),
            "before\n".to_string(),
        )
        .unwrap();

        assert_eq!(saved.path, target.canonicalize().unwrap().to_string_lossy());
        assert_eq!(saved.text, "after\n");
        assert_eq!(saved.size, 6);
        assert_eq!(std::fs::read(&target).unwrap(), b"after\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode(),
                permissions_before.mode()
            );
        }
        assert!(save_temp_paths(&target).is_empty());
    }

    #[test]
    fn rejects_stale_saves_without_mutation_or_temp_files() {
        let tree = TempTree::new("stale-save");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "current\n").unwrap();

        let error = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "replacement\n".to_string(),
            "stale\n".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("changed on disk"));
        assert_eq!(std::fs::read(&target).unwrap(), b"current\n");
        assert!(save_temp_paths(&target).is_empty());
    }

    #[test]
    fn invalid_utf8_is_binary_and_cannot_be_saved_as_text() {
        let tree = TempTree::new("invalid-utf8");
        let target = tree.root.join("invalid.txt");
        let original = [0xff, 0xfe, b'x'];
        std::fs::write(&target, original).unwrap();

        let preview = fs_read_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
        )
        .unwrap();
        assert!(preview.binary);
        assert!(preview.text.is_empty());

        let error = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "replacement\n".to_string(),
            String::new(),
        )
        .unwrap_err();
        assert!(error.contains("file is not valid UTF-8"));
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert!(save_temp_paths(&target).is_empty());
    }

    #[test]
    fn git_file_paths_must_be_relative_and_cannot_traverse() {
        assert!(validate_git_relative_path("src/main.rs").is_ok());
        assert!(validate_git_relative_path("../secret.txt").is_err());
        assert!(validate_git_relative_path("src/../../secret.txt").is_err());
        assert!(validate_git_relative_path("/tmp/secret.txt").is_err());
    }

    #[test]
    fn git_status_and_diff_stay_inside_a_nested_project_root() {
        let tree = TempTree::new("git-scope");
        let project = tree.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(tree.root.join("outside.txt"), "outside baseline\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["add", "."]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("outside.txt"), "outside changed\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside changed\n").unwrap();

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "inside.txt");

        let diff = git_diff(
            path_text(&project).to_string(),
            Some("inside.txt".to_string()),
            Some(false),
        )
        .unwrap();
        assert!(diff.contains("+inside changed"));
        assert!(!diff.contains("outside changed"));
    }
}
