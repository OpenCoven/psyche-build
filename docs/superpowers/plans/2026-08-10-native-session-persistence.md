# Native Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep native shell, nested Psyche, Coven chat, and Coven attachment sessions alive across macOS app restarts, restore their pane layouts, and add `Ctrl+T` for shells and `Ctrl+A` for agents.

**Architecture:** A Psyche-owned isolated tmux server becomes the durable process owner. The Tauri process opens disposable `portable-pty` clients that attach to tmux sessions, while an atomically written workspace v3 document stores sanitized session descriptors and pane trees for restore/reconciliation.

**Tech Stack:** Rust 2021, Tauri 2, `portable-pty`, tmux, serde/serde_json, browser JavaScript modules, xterm.js, Vitest.

---

## File structure

- Create `native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs`
  - Own isolated tmux paths, stable names, allowlisted launch construction, scrollback capture, and create/list/stop operations.
- Create `native/macos/psyche-build-tauri/src-tauri/src/native_workspace.rs`
  - Validate, load, and atomically write workspace v3.
- Create `native/macos/psyche-build-tauri/web/workspace/workspace-model.mjs`
  - Sanitize workspace/session/tree data and reconcile persisted sessions with live tmux IDs.
- Create `native/macos/psyche-build-tauri/web/workspace/workspace-entry.js`
  - Export the workspace model as the `PsycheWorkspace` browser global.
- Create `__tests__/tauriSessionPersistence.test.ts`
  - Exercise the pure workspace model and source-level lifecycle/shortcut contracts.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
  - Register native workspace/session commands and convert direct process PTYs into tmux attach clients.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Persist workspace v3, create/restore/stop persistent sessions, save pane mutations, and wire shortcuts.
- Modify `native/macos/psyche-build-tauri/web/index.html`
  - Load the workspace bundle and display the new shortcuts.
- Modify `native/macos/psyche-build-tauri/package.json`
  - Build `workspace.bundle.js`.
- Modify `__tests__/tauriPhysicalPanes.test.ts`
  - Replace the process-local topology contract with persistence/save-trigger coverage.
- Modify `__tests__/tauriCovenLaunch.test.ts`
  - Assert allowlisted native session creation and attach/retry behavior.
- Modify `docs/SMOKE.md`
  - Add the app-restart continuity acceptance flow.

Preserve the existing uncommitted `main.js` work that merges Diffs into Git and moves Retry into the pane context menu. Persistence changes must build on those edits rather than replacing them.

### Task 1: Add the pure workspace v3 model

**Files:**
- Create: `native/macos/psyche-build-tauri/web/workspace/workspace-model.mjs`
- Create: `native/macos/psyche-build-tauri/web/workspace/workspace-entry.js`
- Create: `__tests__/tauriSessionPersistence.test.ts`
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html:394-397`

- [ ] **Step 1: Write failing model tests**

Create `__tests__/tauriSessionPersistence.test.ts` with direct module tests:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const workspaceRoot = join(
  repoRoot,
  'native/macos/psyche-build-tauri/web/workspace',
);
const model = await import(
  pathToFileURL(join(workspaceRoot, 'workspace-model.mjs')).href
);

describe('Tauri workspace v3 model', () => {
  it('imports v2 without inventing sessions or pane layouts', () => {
    expect(model.importWorkspaceV2({
      version: 2,
      activeProjectId: 'p1',
      projects: [{ id: 'p1', root: '/repo', name: 'repo' }],
    })).toEqual({
      version: 3,
      activeProjectId: 'p1',
      activeThreadId: null,
      projects: [{ id: 'p1', root: '/repo', name: 'repo' }],
      sessions: [],
      paneLayouts: [],
    });
  });

  it('sanitizes allowlisted session descriptors', () => {
    expect(model.sanitizeSessionDescriptor({
      id: 'session-1',
      projectId: 'p1',
      worktreePath: '/repo',
      name: 'Shell',
      kind: 'shell',
      launchKind: 'shell',
      hidden: true,
      command: 'rm -rf /',
      env: { BAD: '1' },
    })).toEqual({
      id: 'session-1',
      projectId: 'p1',
      worktreePath: '/repo',
      name: 'Shell',
      kind: 'shell',
      launchKind: 'shell',
      hidden: true,
      covenSessionId: null,
    });
    expect(model.sanitizeSessionDescriptor({
      id: 'bad id',
      projectId: 'p1',
      worktreePath: '/repo',
      launchKind: 'arbitrary-command',
    })).toBeNull();
  });

  it('drops malformed and duplicate pane leaves', () => {
    const tree = {
      type: 'split',
      id: 'split-1',
      orientation: 'row',
      ratio: 0.6,
      first: { type: 'leaf', id: 'leaf-1', threadId: 'session-1' },
      second: { type: 'leaf', id: 'leaf-2', threadId: 'session-1' },
    };
    expect(model.sanitizePaneTree(tree, new Set(['session-1']))).toEqual({
      type: 'leaf',
      id: 'leaf-1',
      threadId: 'session-1',
    });
  });

  it('reconciles live, missing, and unknown tmux sessions', () => {
    const descriptors = [
      {
        id: 'live',
        projectId: 'p1',
        worktreePath: '/repo',
        name: 'Live',
        kind: 'shell',
        launchKind: 'shell',
        hidden: false,
        covenSessionId: null,
      },
      {
        id: 'missing',
        projectId: 'p1',
        worktreePath: '/repo',
        name: 'Missing',
        kind: 'coven-chat',
        launchKind: 'coven-chat',
        hidden: false,
        covenSessionId: null,
      },
    ];
    expect(model.reconcileSessions(descriptors, ['live', 'orphan'])).toEqual({
      sessions: [
        { ...descriptors[0], status: 'running', persistentLive: true },
        { ...descriptors[1], status: 'exited', persistentLive: false },
      ],
      unknownLiveIds: ['orphan'],
    });
  });
});

describe('Tauri workspace bundle contract', () => {
  const packageJson = readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/package.json'),
    'utf8',
  );
  const indexHtml = readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
    'utf8',
  );

  it('builds and loads PsycheWorkspace before main.js', () => {
    expect(packageJson).toContain('--global-name=PsycheWorkspace');
    expect(indexHtml.indexOf('workspace.bundle.js')).toBeLessThan(
      indexHtml.indexOf('main.js'),
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because `web/workspace/workspace-model.mjs` does not exist.

- [ ] **Step 3: Implement the pure model**

Create `native/macos/psyche-build-tauri/web/workspace/workspace-model.mjs`:

```js
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,96}$/;
const LAUNCH_KINDS = new Set(["shell", "psyche", "coven-chat", "coven-attach"]);
const ORIENTATIONS = new Set(["row", "column"]);

function cleanString(value, maximum = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

export function importWorkspaceV2(saved) {
  return {
    version: 3,
    activeProjectId: cleanString(saved && saved.activeProjectId, 96),
    activeThreadId: null,
    projects: Array.isArray(saved && saved.projects) ? saved.projects : [],
    sessions: [],
    paneLayouts: [],
  };
}

export function sanitizeSessionDescriptor(saved) {
  if (!saved || !SESSION_ID_RE.test(saved.id || "")) return null;
  if (!LAUNCH_KINDS.has(saved.launchKind)) return null;
  const projectId = cleanString(saved.projectId, 96);
  const worktreePath = cleanString(saved.worktreePath);
  if (!projectId || !worktreePath) return null;
  const covenSessionId = saved.launchKind === "coven-attach"
    ? cleanString(saved.covenSessionId, 128)
    : null;
  if (saved.launchKind === "coven-attach" && !covenSessionId) return null;
  return {
    id: saved.id,
    projectId,
    worktreePath,
    name: cleanString(saved.name, 256) || saved.launchKind,
    kind: LAUNCH_KINDS.has(saved.kind) ? saved.kind : saved.launchKind,
    launchKind: saved.launchKind,
    hidden: saved.hidden === true,
    covenSessionId,
  };
}

export function sanitizePaneTree(root, knownThreadIds, seenLeaves = new Set()) {
  function visit(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "leaf") {
      if (!SESSION_ID_RE.test(node.id || "")) return null;
      if (!knownThreadIds.has(node.threadId) || seenLeaves.has(node.threadId)) return null;
      seenLeaves.add(node.threadId);
      return { type: "leaf", id: node.id, threadId: node.threadId };
    }
    if (node.type !== "split" || !SESSION_ID_RE.test(node.id || "")) return null;
    const first = visit(node.first);
    const second = visit(node.second);
    if (!first) return second;
    if (!second) return first;
    return {
      type: "split",
      id: node.id,
      orientation: ORIENTATIONS.has(node.orientation) ? node.orientation : "column",
      ratio: Number.isFinite(node.ratio)
        ? Math.min(1, Math.max(0, node.ratio))
        : 0.5,
      first,
      second,
    };
  }
  return visit(root);
}

export function reconcileSessions(descriptors, liveIds) {
  const live = new Set(Array.isArray(liveIds) ? liveIds : []);
  const sessions = (Array.isArray(descriptors) ? descriptors : [])
    .map(sanitizeSessionDescriptor)
    .filter(Boolean)
    .map((descriptor) => {
      const persistentLive = live.delete(descriptor.id);
      return {
        ...descriptor,
        status: persistentLive ? "running" : "exited",
        persistentLive,
      };
    });
  return { sessions, unknownLiveIds: [...live].sort() };
}

export function sanitizeWorkspaceV3(saved) {
  if (!saved || saved.version !== 3) return null;
  const seenSessionIds = new Set();
  const sessions = (Array.isArray(saved.sessions) ? saved.sessions : [])
    .map(sanitizeSessionDescriptor)
    .filter((session) => {
      if (!session || seenSessionIds.has(session.id)) return false;
      seenSessionIds.add(session.id);
      return true;
    });
  const knownIds = new Set(sessions.map((session) => session.id));
  const seenPaneThreads = new Set();
  const paneLayouts = (Array.isArray(saved.paneLayouts) ? saved.paneLayouts : [])
    .map((layout) => {
      const projectId = cleanString(layout && layout.projectId, 96);
      const worktreePath = cleanString(layout && layout.worktreePath);
      const root = sanitizePaneTree(layout && layout.root, knownIds, seenPaneThreads);
      if (!projectId || !worktreePath || !root) return null;
      const focusedLeafId = SESSION_ID_RE.test(layout.focusedLeafId || "")
        ? layout.focusedLeafId
        : null;
      return { projectId, worktreePath, root, focusedLeafId };
    })
    .filter(Boolean);
  return {
    version: 3,
    activeProjectId: cleanString(saved.activeProjectId, 96),
    activeThreadId: cleanString(saved.activeThreadId, 96),
    projects: Array.isArray(saved.projects) ? saved.projects : [],
    sessions,
    paneLayouts,
  };
}
```

Create `native/macos/psyche-build-tauri/web/workspace/workspace-entry.js`:

```js
export {
  importWorkspaceV2,
  reconcileSessions,
  sanitizePaneTree,
  sanitizeSessionDescriptor,
  sanitizeWorkspaceV3,
} from "./workspace-model.mjs";
```

- [ ] **Step 4: Add the browser bundle**

Update `native/macos/psyche-build-tauri/package.json` so `build:web` also runs:

```json
"esbuild web/workspace/workspace-entry.js --bundle --minify --format=iife --global-name=PsycheWorkspace --outfile=web/workspace.bundle.js"
```

Add this before `main.js` in `native/macos/psyche-build-tauri/web/index.html`:

```html
<script src="./workspace.bundle.js" defer></script>
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriSessionPersistence.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/workspace
git commit -m "feat(tauri): add workspace persistence model"
```

### Task 2: Add atomic native workspace storage

**Files:**
- Create: `native/macos/psyche-build-tauri/src-tauri/src/native_workspace.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:20-25`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:2144-2165`

- [ ] **Step 1: Write failing Rust tests**

Create `native_workspace.rs` with its test module first:

```rust
#[cfg(test)]
mod tests {
    use super::{load_workspace_from, save_workspace_to};
    use serde_json::json;
    use std::fs;

    #[test]
    fn writes_and_loads_workspace_v3_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace-v3.json");
        let workspace = json!({
            "version": 3,
            "activeProjectId": null,
            "activeThreadId": null,
            "projects": [],
            "sessions": [],
            "paneLayouts": []
        });

        save_workspace_to(&path, &workspace).unwrap();
        assert_eq!(load_workspace_from(&path).unwrap(), Some(workspace));
        assert!(fs::read_dir(temp.path())
            .unwrap()
            .all(|entry| !entry.unwrap().file_name().to_string_lossy().contains(".tmp")));
    }

    #[test]
    fn rejects_unsupported_or_malformed_documents() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace-v3.json");
        fs::write(&path, br#"{"version":2,"projects":[]}"#).unwrap();
        assert!(load_workspace_from(&path).is_err());
        fs::write(&path, br#"{"version":3,"projects":{}}"#).unwrap();
        assert!(load_workspace_from(&path).is_err());
    }

    #[test]
    fn preserves_the_previous_file_when_serialization_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace-v3.json");
        let valid = json!({
            "version": 3,
            "projects": [],
            "sessions": [],
            "paneLayouts": []
        });
        save_workspace_to(&path, &valid).unwrap();
        assert!(save_workspace_to(&path, &json!({"version": 3})).is_err());
        assert_eq!(load_workspace_from(&path).unwrap(), Some(valid));
    }
}
```

Add `tempfile = "3"` under `[dev-dependencies]` in
`native/macos/psyche-build-tauri/src-tauri/Cargo.toml`.

- [ ] **Step 2: Run the focused Rust test and confirm failure**

Run:

```bash
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native_workspace::tests -- --nocapture
```

Expected: FAIL because the module functions do not exist.

- [ ] **Step 3: Implement validation and atomic storage**

Add to `native_workspace.rs`:

```rust
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

fn validate_workspace(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "workspace must be an object".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(3) {
        return Err("unsupported workspace version".to_string());
    }
    for key in ["projects", "sessions", "paneLayouts"] {
        if !object.get(key).is_some_and(Value::is_array) {
            return Err(format!("workspace.{key} must be an array"));
        }
    }
    Ok(())
}

fn workspace_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    Ok(PathBuf::from(home)
        .join(".psyche")
        .join("macos-app")
        .join("workspace-v3.json"))
}

pub(crate) fn load_workspace_from(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    validate_workspace(&value)?;
    Ok(Some(value))
}

pub(crate) fn save_workspace_to(path: &Path, value: &Value) -> Result<(), String> {
    validate_workspace(value)?;
    let parent = path.parent().ok_or_else(|| "workspace path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| -> Result<(), String> {
        let mut handle = options.open(&temporary).map_err(|error| error.to_string())?;
        handle.write_all(&bytes).map_err(|error| error.to_string())?;
        handle.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(())
}

#[tauri::command]
pub(crate) fn workspace_load(_app: AppHandle) -> Result<Option<Value>, String> {
    load_workspace_from(&workspace_path()?)
}

#[tauri::command]
pub(crate) fn workspace_save(_app: AppHandle, workspace: Value) -> Result<(), String> {
    save_workspace_to(&workspace_path()?, &workspace)
}
```

- [ ] **Step 4: Register the commands**

In `lib.rs` add:

```rust
mod native_workspace;
use native_workspace::{workspace_load, workspace_save};
```

Add both commands to `tauri::generate_handler!`:

```rust
workspace_load,
workspace_save,
```

- [ ] **Step 5: Run format and focused tests**

Run:

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native_workspace::tests -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/Cargo.lock \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/native_workspace.rs
git commit -m "feat(tauri): persist workspace state atomically"
```

### Task 3: Add the isolated tmux session owner

**Files:**
- Create: `native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:20-25`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:2144-2165`

- [ ] **Step 1: Write failing command-construction tests**

Start `native_sessions.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::{
        build_capture_args, build_create_args, build_list_args, build_stop_args, session_name,
        shell_quote, NativeLaunchKind, NativeSessionCreate,
    };

    fn request(kind: NativeLaunchKind) -> NativeSessionCreate {
        NativeSessionCreate {
            id: "session-1".to_string(),
            project_root: "/repo".to_string(),
            cwd: "/repo/worktree".to_string(),
            launch_kind: kind,
            coven_session_id: None,
        }
    }

    #[test]
    fn uses_an_explicit_isolated_socket_for_every_tmux_operation() {
        let socket = std::path::Path::new("/tmp/psyche-native.sock");
        assert_eq!(&build_list_args(socket)[0..2], ["-S", "/tmp/psyche-native.sock"]);
        assert_eq!(&build_stop_args(socket, "session-1").unwrap()[0..2], ["-S", "/tmp/psyche-native.sock"]);
        assert_eq!(&build_capture_args(socket, "session-1").unwrap()[0..2], ["-S", "/tmp/psyche-native.sock"]);
        assert_eq!(&build_create_args(socket, &request(NativeLaunchKind::Shell), "/bin/zsh", &[]).unwrap()[0..2],
            ["-S", "/tmp/psyche-native.sock"]);
    }

    #[test]
    fn derives_bounded_opaque_tmux_names() {
        assert_eq!(
            session_name("session-1").unwrap(),
            "psyche-73657373696f6e2d31",
        );
        assert!(session_name("bad id").is_err());
        assert!(session_name(&"x".repeat(97)).is_err());
    }

    #[test]
    fn quotes_each_trusted_command_argument() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn coven_attach_requires_a_safe_session_id() {
        let mut attach = request(NativeLaunchKind::CovenAttach);
        attach.coven_session_id = Some("valid:session-1".to_string());
        assert!(build_create_args(
            std::path::Path::new("/tmp/socket"),
            &attach,
            "/usr/local/bin/coven",
            &["attach".to_string(), "valid:session-1".to_string()],
        ).is_ok());
        attach.coven_session_id = Some("../unsafe".to_string());
        assert!(build_create_args(
            std::path::Path::new("/tmp/socket"),
            &attach,
            "/usr/local/bin/coven",
            &[],
        ).is_err());
    }
}
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native_sessions::tests -- --nocapture
```

Expected: FAIL because `native_sessions` is not implemented.

- [ ] **Step 3: Implement stable IDs, paths, and allowlisted launch kinds**

Add:

```rust
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const SESSION_ID_MAX: usize = 96;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeLaunchKind {
    Shell,
    Psyche,
    CovenChat,
    CovenAttach,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSessionCreate {
    pub(crate) id: String,
    pub(crate) project_root: String,
    pub(crate) cwd: String,
    pub(crate) launch_kind: NativeLaunchKind,
    pub(crate) coven_session_id: Option<String>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SESSION_ID_MAX
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

pub(crate) fn session_name(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("invalid native session id".to_string());
    }
    let encoded = id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("psyche-{encoded}"))
}

fn session_id_from_name(name: &str) -> Option<String> {
    let encoded = name.strip_prefix("psyche-")?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    let id = String::from_utf8(bytes).ok()?;
    valid_id(&id).then_some(id)
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn native_socket_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    Ok(PathBuf::from(home)
        .join(".psyche")
        .join("macos-app")
        .join("native-sessions.sock"))
}

fn ensure_native_session_dir(socket: &Path) -> Result<(), String> {
    let parent = socket
        .parent()
        .ok_or_else(|| "native session socket has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(
        parent,
        std::fs::Permissions::from_mode(0o700),
    ).map_err(|error| error.to_string())?;
    Ok(())
}
```

Build tmux arguments through helpers:

```rust
pub(crate) fn build_create_args(
    socket: &Path,
    request: &NativeSessionCreate,
    command: &str,
    args: &[String],
) -> Result<Vec<String>, String> {
    let name = session_name(&request.id)?;
    if request.launch_kind == NativeLaunchKind::CovenAttach {
        let id = request
            .coven_session_id
            .as_deref()
            .ok_or_else(|| "coven attach requires a session id".to_string())?;
        if !crate::coven_sessions::is_safe_session_id(id) {
            return Err("coven attach session id is unsafe".to_string());
        }
    }
    let shell_command = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        name,
        "-c".into(),
        request.cwd.clone(),
        shell_command,
    ])
}

pub(crate) fn build_list_args(socket: &Path) -> Vec<String> {
    vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "list-sessions".into(),
        "-F".into(),
        "#{session_name}".into(),
    ]
}

pub(crate) fn build_stop_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "kill-session".into(),
        "-t".into(),
        session_name(id)?,
    ])
}

pub(crate) fn build_capture_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "capture-pane".into(),
        "-p".into(),
        "-e".into(),
        "-S".into(),
        "-".into(),
        "-t".into(),
        session_name(id)?,
    ])
}
```

- [ ] **Step 4: Add bounded Tauri commands**

Reuse `open_pty_cwd` from `lib.rs` by exposing a crate-visible validation
function that returns the canonical cwd. Reconstruct commands from current
trusted paths:

```rust
#[tauri::command]
pub(crate) fn native_session_create(request: NativeSessionCreate) -> Result<(), String> {
    let canonical_cwd =
        crate::resolve_pty_cwd(&request.project_root, &request.cwd)?;
    let (command, args) = crate::native_launch_command(&request)?;
    let mut canonical_request = request;
    canonical_request.cwd = canonical_cwd.to_string_lossy().into_owned();
    let socket = native_socket_path()?;
    ensure_native_session_dir(&socket)?;
    let output = Command::new("tmux")
        .args(build_create_args(
            &socket,
            &canonical_request,
            &command,
            &args,
        )?)
        .output()
        .map_err(|error| format!("tmux is unavailable: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub(crate) fn native_session_list() -> Result<Vec<String>, String> {
    let output = Command::new("tmux")
        .args(build_list_args(&native_socket_path()?))
        .output()
        .map_err(|error| format!("tmux is unavailable: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("failed to connect") {
            return Ok(Vec::new());
        }
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(session_id_from_name)
        .collect())
}

#[tauri::command]
pub(crate) fn native_session_stop(id: String) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(build_stop_args(&native_socket_path()?, &id)?)
        .output()
        .map_err(|error| format!("tmux is unavailable: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("can't find session") || stderr.contains("no server running") {
        return Ok(());
    }
    Err(format!("failed to stop native session {id}: {}", stderr.trim()))
}

#[tauri::command]
pub(crate) fn native_session_capture(id: String) -> Result<Vec<u8>, String> {
    let output = Command::new("tmux")
        .args(build_capture_args(&native_socket_path()?, &id)?)
        .output()
        .map_err(|error| format!("tmux is unavailable: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
```

Keep `native_launch_command` in `lib.rs` next to `app_environment` so it can
reuse `which_on_path`, `locate_psyche_repo`, the default shell, and current
Coven path:

```rust
fn native_launch_command(request: &NativeSessionCreate) -> Result<(String, Vec<String>), String> {
    let environment = app_environment();
    let (executable, command_args) = match request.launch_kind {
        NativeLaunchKind::Shell => (
            environment.default_shell,
            vec!["-l".to_string()],
        ),
        NativeLaunchKind::Psyche => (
            environment.node_path.ok_or_else(|| "node is unavailable".to_string())?,
            vec![environment
                .psyche_entry
                .ok_or_else(|| "Psyche entrypoint is unavailable".to_string())?],
        ),
        NativeLaunchKind::CovenChat => (
            environment.coven_path.ok_or_else(|| "Coven CLI is unavailable".to_string())?,
            vec!["chat".to_string()],
        ),
        NativeLaunchKind::CovenAttach => {
            let id = request
                .coven_session_id
                .clone()
                .ok_or_else(|| "Coven session id is required".to_string())?;
            if !is_safe_session_id(&id) {
                return Err("Coven session id is unsafe".to_string());
            }
            (
                environment.coven_path.ok_or_else(|| "Coven CLI is unavailable".to_string())?,
                vec!["attach".to_string(), id],
            )
        }
    };
    let mut args = vec![
        "-u".to_string(), "TMUX".to_string(),
        "-u".to_string(), "npm_config_prefix".to_string(),
        "-u".to_string(), "NPM_CONFIG_PREFIX".to_string(),
        "-u".to_string(), "PREFIX".to_string(),
        format!("PATH={}", augmented_path()),
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        "PSYCHE_TAURI=1".to_string(),
        "PSYCHE_NATIVE_CONTAINER=1".to_string(),
    ];
    if request.launch_kind == NativeLaunchKind::Psyche {
        let home = environment.home.ok_or_else(|| "HOME is unavailable".to_string())?;
        args.push(format!("TMUX_TMPDIR={home}/.psyche/macos-app/nested-tmux"));
    }
    args.push(executable);
    args.extend(command_args);
    Ok(("/usr/bin/env".to_string(), args))
}
```

Never copy serialized command or environment values into this function.

- [ ] **Step 5: Register commands and run tests**

Add:

```rust
mod native_sessions;
use native_sessions::{
    native_session_capture, native_session_create, native_session_list, native_session_stop,
    NativeLaunchKind, NativeSessionCreate,
};
```

Register the four commands in `tauri::generate_handler!`.

Run:

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native_sessions::tests -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs
git commit -m "feat(tauri): own native sessions with isolated tmux"
```

### Task 4: Convert portable PTYs into reconnectable tmux clients

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:59-79`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:400-575`
- Modify: `__tests__/tauriCovenLaunch.test.ts:20-75`

- [ ] **Step 1: Add failing Rust attach argument tests**

Add to `native_sessions.rs` tests:

```rust
#[test]
fn attach_uses_the_owned_socket_and_stable_session_name() {
    assert_eq!(
        super::build_attach_args(
            std::path::Path::new("/tmp/native.sock"),
            "session-1",
        ).unwrap(),
        vec![
            "-S",
            "/tmp/native.sock",
            "attach-session",
            "-d",
            "-t",
            "psyche-73657373696f6e2d31",
        ],
    );
}
```

Add a source contract to `__tests__/tauriCovenLaunch.test.ts`:

```ts
it('attaches disposable PTYs to durable native sessions', () => {
  expect(libRs).toMatch(/struct PtyAttachOptions/);
  expect(libRs).toMatch(/fn pty_attach\s*\(/);
  expect(libRs).toMatch(/build_attach_args/);
  expect(libRs).toMatch(/tauri::generate_handler!\s*\[[\s\S]*pty_attach\s*,/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenLaunch.test.ts
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native_sessions::tests::attach_uses_the_owned_socket_and_stable_session_name \
  -- --nocapture
```

Expected: both fail because `pty_attach` is absent.

- [ ] **Step 3: Add attach arguments**

In `native_sessions.rs`:

```rust
pub(crate) fn build_attach_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "attach-session".into(),
        "-d".into(),
        "-t".into(),
        session_name(id)?,
    ])
}
```

- [ ] **Step 4: Add `pty_attach` without changing the event protocol**

In `lib.rs` define:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttachOptions {
    pub thread_id: String,
    pub session_id: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}
```

Extract the repeated PTY reader/writer/exit registration from `pty_start` into:

```rust
fn register_pty_client(
    app: AppHandle,
    thread_id: String,
    pair: portable_pty::PtyPair,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) -> Result<(), String>
```

Then implement:

```rust
#[tauri::command]
fn pty_attach(app: AppHandle, options: PtyAttachOptions) -> Result<(), String> {
    let pending = PendingPtyStart::reserve(&options.thread_id)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new("tmux");
    command.args(native_sessions::build_attach_args(
        &native_sessions::native_socket_path()?,
        &options.session_id,
    )?);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    register_pty_client(app, options.thread_id, pair, child)?;
    drop(pending);
    Ok(())
}
```

Keep `pty_write`, `pty_resize`, `pty_stop`, and `pty_list` scoped to disposable
clients. `pty_stop` means detach client only; `native_session_stop` is the sole
process-terminating command.

Update `handlePtyExit` in a later webview task to query `native_session_list`
before deciding the durable process exited. A dropped tmux client while the
session remains listed is an attachment failure, not a terminated session.

- [ ] **Step 5: Register and verify**

Add `pty_attach` to the Tauri handler.

Run:

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm vitest --run __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs
git commit -m "feat(tauri): attach PTY clients to persistent sessions"
```

### Task 5: Persist workspace v3 from the webview

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:379-530`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1635-1740`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3235-3300`
- Modify: `__tests__/tauriSessionPersistence.test.ts`
- Modify: `__tests__/tauriPhysicalPanes.test.ts:340-365`

- [ ] **Step 1: Add failing persistence source tests**

Append:

```ts
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

it('serializes sessions and pane layouts into workspace v3', () => {
  expect(functionSource('persistableSession')).not.toMatch(/term|host|pane|fit/);
  expect(functionSource('persistablePaneLayouts')).toContain('paneLayouts.forEach');
  expect(functionSource('buildPersistedWorkspace')).toContain('version: 3');
  expect(functionSource('buildPersistedWorkspace')).toContain('sessions:');
  expect(functionSource('buildPersistedWorkspace')).toContain('paneLayouts:');
});

it('saves through the native atomic workspace command', () => {
  expect(functionSource('saveWorkspaceNow')).toContain('invoke("workspace_save"');
  expect(functionSource('readSavedWorkspace')).toContain('invoke("workspace_load"');
  expect(functionSource('handleWindowCloseRequested')).toContain('await saveWorkspaceNow()');
});
```

Replace the old assertion in `tauriPhysicalPanes.test.ts`:

```ts
expect(functionSource('persistableProject')).not.toMatch(/paneLayouts|paneLeafId/);
```

with:

```ts
expect(functionSource('persistablePaneLayouts')).toMatch(/paneLayouts\.forEach/);
expect(functionSource('buildPersistedWorkspace')).toMatch(/paneLayouts/);
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because workspace v3 serialization is absent.

- [ ] **Step 3: Implement serialization**

In `main.js`, replace the localStorage-only workspace functions with:

```js
var LEGACY_WORKSPACE_STATE_KEY = "psyche.tauri.workspace.v1";
var workspaceSaveChain = Promise.resolve();

function persistableSession(thread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    name: thread.name,
    kind: thread.kind,
    launchKind: thread.launch && thread.launch.launchKind,
    hidden: thread.hidden === true,
    covenSessionId: thread.launch && thread.launch.covenSessionId || null,
  };
}

function persistablePaneLayouts() {
  var records = [];
  paneLayouts.forEach(function (layout, key) {
    var separator = key.indexOf("\u0000");
    records.push({
      projectId: key.slice(0, separator),
      worktreePath: key.slice(separator + 1),
      root: layout.root,
      focusedLeafId: layout.focusedLeafId || null,
    });
  });
  return records;
}

function buildPersistedWorkspace() {
  return {
    version: 3,
    activeProjectId: state.activeProjectId || null,
    activeThreadId: state.activeThreadId || null,
    projects: state.projects.map(persistableProject).slice(0, HARD_MAX_PROJECTS),
    sessions: state.threads.map(persistableSession),
    paneLayouts: persistablePaneLayouts(),
  };
}

function saveWorkspaceNow() {
  if (isRestoringWorkspace) return Promise.resolve(false);
  var workspace = PsycheWorkspace.sanitizeWorkspaceV3(buildPersistedWorkspace());
  if (!workspace) return Promise.reject(new Error("workspace state is invalid"));
  workspaceSaveChain = workspaceSaveChain
    .catch(function () {})
    .then(function () {
      return invoke("workspace_save", { workspace: workspace });
    })
    .then(function () { return true; });
  return workspaceSaveChain.catch(function (error) {
    setStatus("workspace save failed: " + String(error), "error");
    throw error;
  });
}

function saveWorkspaceSoon() {
  if (isRestoringWorkspace) return;
  if (saveWorkspaceTimer) cancelAnimationFrame(saveWorkspaceTimer);
  saveWorkspaceTimer = requestAnimationFrame(function () {
    saveWorkspaceTimer = 0;
    saveWorkspaceNow().catch(function () {});
  });
}

async function readSavedWorkspace() {
  var saved = null;
  try {
    saved = await invoke("workspace_load");
  } catch (error) {
    setStatus("workspace restore failed: " + String(error), "error");
    return null;
  }
  if (saved) {
    var sanitized = PsycheWorkspace.sanitizeWorkspaceV3(saved);
    if (!sanitized) setStatus("workspace restore failed: invalid workspace v3", "error");
    return sanitized;
  }
  try {
    var legacy = JSON.parse(localStorage.getItem(LEGACY_WORKSPACE_STATE_KEY) || "null");
    return legacy && Array.isArray(legacy.projects)
      ? PsycheWorkspace.importWorkspaceV2(legacy)
      : null;
  } catch (_) {
    return null;
  }
}
```

Change `handleVisibilityChange` to fire a save with an explicit rejection
handler, and change `handleWindowCloseRequested` to:

```js
await saveWorkspaceNow();
await currentWindow.destroy();
```

- [ ] **Step 4: Save every pane mutation**

Add `saveWorkspaceSoon()` after successful durable mutations in:

```js
commitPanePlacement
updateActiveSplit
movePaneTo
focusThread
detachThreadPane
hideThread
reopenThread
renameThread
```

Do not save from render-only helpers. `isRestoringWorkspace` suppresses writes
while the initial document is being hydrated.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "feat(tauri): save native sessions and pane layouts"
```

### Task 6: Create, attach, retry, and stop persistent sessions

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:889-1160`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1725-1840`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `__tests__/tauriSessionPersistence.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Add source contracts:

```ts
it('creates the tmux session before mutating webview thread state', () => {
  const create = functionSource('createThread');
  expect(create.indexOf('invoke("native_session_create"')).toBeGreaterThan(-1);
  expect(create.indexOf('invoke("native_session_create"')).toBeLessThan(
    create.indexOf('state.threads.push(thread)'),
  );
  expect(create).toContain('attachThreadClient(thread)');
});

it('explicit close stops tmux before removing the descriptor', () => {
  const close = functionSource('closeThread');
  expect(close.indexOf('invoke("native_session_stop"')).toBeGreaterThan(-1);
  expect(close.indexOf('invoke("native_session_stop"')).toBeLessThan(
    close.indexOf('state.threads = state.threads.filter'),
  );
});

it('retry recreates only an exited persistent session', () => {
  const retry = functionSource('retryThread');
  expect(retry).toContain('invoke("native_session_create"');
  expect(retry).toContain('attachThreadClient(thread)');
});

it('distinguishes a dropped client from a stopped tmux session', () => {
  const exit = functionSource('handlePtyExit');
  expect(exit).toContain('invoke("native_session_list")');
  expect(exit).toContain('thread.status = persistentLive ? "failed" : "exited"');
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because direct `pty_start` still owns process creation.

- [ ] **Step 3: Split durable creation from client attachment**

Replace `spawnPty` with:

```js
function attachThreadClient(thread) {
  if (!isLiveThread(thread) || thread.startInFlight || thread.closeStarted) {
    return Promise.resolve(false);
  }
  thread.startInFlight = true;
  thread.status = "starting";
  syncThreadPaneMetadata(thread);
  return invoke("pty_attach", {
    options: {
      threadId: thread.id,
      sessionId: thread.id,
      cols: thread.term ? thread.term.cols : 120,
      rows: thread.term ? thread.term.rows : 40,
    },
  }).then(function () {
    thread.startInFlight = false;
    thread.ptyStarted = true;
    thread.status = "running";
    syncThreadPaneMetadata(thread);
    refreshSidebar();
    refreshTabs();
    return true;
  }).catch(function (error) {
    thread.startInFlight = false;
    thread.ptyStarted = false;
    thread.status = "failed";
    syncThreadPaneMetadata(thread);
    if (thread.term) {
      thread.term.write("\r\n\x1b[31m[attach error]\x1b[0m " + String(error) + "\r\n");
    }
    return false;
  });
}
```

Make `handlePtyExit` asynchronous and reconcile the durable owner before
changing status:

```js
async function handlePtyExit(payload) {
  payload = payload || {};
  var thread = findThread(payload.thread_id);
  if (!thread || thread.closing || thread.closeStarted) return false;
  thread.ptyStarted = false;
  thread.startInFlight = false;
  thread.spawning = false;
  var liveIds = [];
  try {
    liveIds = await invoke("native_session_list");
  } catch (error) {
    thread.status = "failed";
    syncThreadPaneMetadata(thread);
    setStatus("session status unavailable: " + String(error), "error");
    return false;
  }
  var persistentLive = liveIds.indexOf(thread.id) !== -1;
  thread.status = persistentLive ? "failed" : "exited";
  syncThreadPaneMetadata(thread);
  if (thread.term) {
    thread.term.write(
      persistentLive
        ? "\r\n\x1b[33m[terminal detached — retry to reattach]\x1b[0m\r\n"
        : "\r\n\x1b[2;90m[process exited]\x1b[0m\r\n"
    );
  }
  refreshSidebar();
  refreshTabs();
  saveWorkspaceSoon();
  return true;
}
```

The `pty:exit` listener should call `void handlePtyExit(event.payload || {})`
and attach a `.catch` that reports an error without terminating the tmux
session.

Make `createThread` async. Before committing placement or pushing the thread,
call:

```js
try {
  await invoke("native_session_create", {
    request: {
      id: thread.id,
      projectRoot: thread.launch.projectRoot,
      cwd: thread.worktreePath,
      launchKind: thread.launch.launchKind,
      covenSessionId: thread.launch.covenSessionId || null,
    },
  });
} catch (error) {
  setStatus("persistent session start failed: " + String(error), "error");
  return null;
}
```

After mounting, call `attachThreadClient(thread)` and save.

- [ ] **Step 4: Make explicit close authoritative**

Convert `closeThread` to `async function closeThread(id, options)`. Its first
backend mutation must be:

```js
try {
  await invoke("native_session_stop", { id: thread.id });
} catch (error) {
  thread.closeStarted = false;
  thread.closing = false;
  setStatus("stop failed: " + String(error), "error");
  return false;
}
```

Only after success should it detach the client, remove the pane leaf, dispose
xterm, remove the descriptor, update focus, and `await saveWorkspaceNow()`.

Update call sites that need completion ordering:

```js
await closeThread(thread.id);
await Promise.all(threadIds.map(function (id) {
  return closeThread(id, { focus: false });
}));
```

- [ ] **Step 5: Recreate only on explicit retry**

In `retryThread`, preserve the existing Coven attachment availability check,
then:

```js
await invoke("native_session_create", {
  request: {
    id: thread.id,
    projectRoot: thread.launch.projectRoot,
    cwd: thread.worktreePath,
    launchKind: thread.launch.launchKind,
    covenSessionId: thread.launch.covenSessionId || null,
  },
});
return attachThreadClient(thread);
```

Do not invoke `native_session_create` during boot reconciliation.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriSessionPersistence.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "feat(tauri): manage persistent session lifecycle"
```

### Task 7: Restore and reconcile live sessions on boot

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:490-530`
- Modify: `native/macos/psyche-build-tauri/web/main.js:900-1015`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5060-5325`
- Modify: `__tests__/tauriSessionPersistence.test.ts`
- Modify: `__tests__/tauriPhysicalPanes.test.ts`

- [ ] **Step 1: Add failing restore tests**

Add:

```ts
it('loads workspace before project discovery and reconciles tmux sessions', () => {
  const boot = functionSource('boot');
  expect(boot).toContain('await readSavedWorkspace()');
  expect(boot).toContain('invoke("native_session_list")');
  expect(boot).toContain('restorePersistedSessions');
  expect(boot.indexOf('restorePersistedSessions')).toBeLessThan(
    boot.indexOf('ensureProjectCoven'),
  );
});

it('hydrates live sessions by attaching and missing sessions as exited', () => {
  const restore = functionSource('restorePersistedSessions');
  expect(restore).toContain('PsycheWorkspace.reconcileSessions');
  expect(restore).toContain('mountTerminal(thread)');
  expect(restore).toContain('invoke("native_session_capture"');
  expect(restore).toContain('attachThreadClient(thread)');
  expect(restore).not.toContain('native_session_create');
});

it('does not silently replace a persisted exited Coven chat', () => {
  const boot = functionSource('boot');
  expect(boot).toMatch(
    /state\.threads\.some[\s\S]*thread\.kind === "coven-chat"[\s\S]*ensureProjectCoven/,
  );
  expect(boot).not.toMatch(
    /thread\.kind === "coven-chat"[\s\S]*thread\.status === "running"[\s\S]*ensureProjectCoven/,
  );
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because boot ignores saved sessions and trees.

- [ ] **Step 3: Add persisted-thread hydration**

Add:

```js
function restoredThread(descriptor, project) {
  return {
    id: descriptor.id,
    projectId: descriptor.projectId,
    worktreePath: descriptor.worktreePath,
    name: descriptor.name,
    kind: descriptor.kind,
    hidden: descriptor.hidden,
    launch: {
      projectRoot: project.root,
      cwd: descriptor.worktreePath,
      launchKind: descriptor.launchKind,
      covenSessionId: descriptor.covenSessionId,
    },
    status: descriptor.status,
    spawning: false,
    term: null,
    fit: null,
    host: null,
    pane: null,
    closing: false,
    closeStarted: false,
    startInFlight: false,
    exitDuringStart: false,
    stopRequested: false,
    ptyStarted: false,
  };
}

async function restorePersistedSessions(saved, liveIds) {
  var reconciled = PsycheWorkspace.reconcileSessions(saved.sessions, liveIds);
  state.threads = reconciled.sessions.map(function (descriptor) {
    var project = findProject(descriptor.projectId);
    return project ? restoredThread(descriptor, project) : null;
  }).filter(function (thread) {
    return !!thread;
  });
  paneLayouts.clear();
  saved.paneLayouts.forEach(function (layout) {
    paneLayouts.set(paneLayoutKey(layout.projectId, layout.worktreePath), {
      root: layout.root,
      focusedLeafId: layout.focusedLeafId,
    });
  });
  await Promise.all(state.threads.map(async function (thread) {
    mountTerminal(thread);
    if (thread.status !== "running") return;
    try {
      var captured = await invoke("native_session_capture", { id: thread.id });
      if (thread.term && Array.isArray(captured) && captured.length) {
        thread.term.write(new Uint8Array(captured));
        thread.term.write("\r\n");
      }
    } catch (error) {
      setStatus("scrollback restore failed: " + String(error), "warn");
    }
    await attachThreadClient(thread);
  }));
  return reconciled.unknownLiveIds;
}
```

If a missing descriptor is not represented in any restored pane tree, keep it
hidden so it remains recoverable from the session rail without creating an
unpositioned canvas pane.

- [ ] **Step 4: Update boot ordering**

Change boot to:

```js
async function boot(env) {
  state.env = env || {};
  var saved = await readSavedWorkspace();
  var bootRoot = state.env.repo_root || state.env.home || "/";
  var project = null;
  isRestoringWorkspace = true;
  if (saved && saved.projects.length) {
    var restored = await restoreSavedProjects(
      saved.projects,
      saved.activeProjectId,
      Math.min(settings.maxProjects, HARD_MAX_PROJECTS),
    );
    state.projects = restored.projects;
    state.activeProjectId = restored.activeProjectId;
    project = activeProject();
    await Promise.all(state.projects.map(refreshProjectWorktrees));
    var liveIds = await invoke("native_session_list");
    await restorePersistedSessions(saved, liveIds);
    state.activeThreadId = state.threads.some(function (thread) {
      return thread.id === saved.activeThreadId && !thread.hidden;
    }) ? saved.activeThreadId : null;
  }
  isRestoringWorkspace = false;
  if (!project) project = await addProject(bootRoot);
  if (project && !state.threads.some(function (thread) {
    return thread.projectId === project.id &&
      thread.worktreePath === activeWorkspaceRoot(project) &&
      thread.kind === "coven-chat";
  })) {
    await ensureProjectCoven(project);
  }
  restoreProjectLayout(project);
  renderPaneWorkspace();
  refreshSidebar();
  refreshTabs();
  renderBrowserTabs();
  syncProjectBrowser();
  loadAgentSkills();
  await saveWorkspaceNow();
  startCovenPolling();
}
```

Catch `native_session_list` failure at the boot boundary, show an actionable
status, and reconcile against an empty list without killing or relaunching
anything.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "feat(tauri): restore persistent native sessions"
```

### Task 8: Add `Ctrl+T` and `Ctrl+A` without changing Command shortcuts

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:4298-4360`
- Modify: `native/macos/psyche-build-tauri/web/main.js:4440-4510`
- Modify: `native/macos/psyche-build-tauri/web/index.html:65-82`
- Modify: `__tests__/tauriSessionPersistence.test.ts`

- [ ] **Step 1: Add failing shortcut tests**

Add:

```ts
it('reserves Control-T for shells and Control-A for Coven agents', () => {
  expect(mainJs).toMatch(
    /e\.ctrlKey && !e\.metaKey[\s\S]*e\.code === "KeyT"[\s\S]*runNewShellCommand/,
  );
  expect(mainJs).toMatch(
    /e\.ctrlKey && !e\.metaKey[\s\S]*e\.code === "KeyA"[\s\S]*runNewThreadCommand/,
  );
  expect(mainJs).toMatch(/var meta = e\.metaKey \|\| e\.ctrlKey/);
});

it('shows the Control shortcuts in the menu and help overlay', () => {
  const indexHtml = readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
    'utf8',
  );
  expect(indexHtml).toContain('Shell — login shell<span class="new-pane-key">⌃T</span>');
  expect(indexHtml).toContain('Agent — coven chat<span class="new-pane-key">⌃A</span>');
  expect(mainJs).toContain('["New shell pane", "⌃T"]');
  expect(mainJs).toContain('["New agent pane (coven chat)", "⌃A"]');
});
```

- [ ] **Step 2: Run the shortcut test and confirm failure**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because the Control shortcuts are absent.

- [ ] **Step 3: Add Control-only handling before generic shortcuts**

At the start of the capture-phase keydown handler:

```js
if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
  if (e.code === "KeyT") {
    e.preventDefault();
    await runNewShellCommand();
    return;
  }
  if (e.code === "KeyA") {
    e.preventDefault();
    await runNewThreadCommand();
    return;
  }
}
var meta = e.metaKey || e.ctrlKey;
```

This ordering intentionally overrides xterm's default `Ctrl+A` and `Ctrl+T`
input only for the two requested app-level actions. Leave `Ctrl+1` through
`Ctrl+9` and all current Command-key branches unchanged.

- [ ] **Step 4: Update visible shortcut labels**

In `index.html`:

```html
<span class="new-pane-glyph mono">❯_</span>Shell — login shell<span class="new-pane-key">⌃T</span>
<span class="new-pane-glyph">✳</span>Agent — coven chat<span class="new-pane-key">⌃A</span>
```

In `HELP_ROWS`:

```js
["New shell pane", "⌃T"],
["New agent pane (coven chat)", "⌃A"],
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriSessionPersistence.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "feat(tauri): add terminal and agent shortcuts"
```

### Task 9: Add packaged continuity acceptance and final verification

**Files:**
- Modify: `docs/SMOKE.md`
- Modify: `__tests__/tauriSessionPersistence.test.ts`
- Generated: `native/macos/psyche-build-tauri/web/workspace.bundle.js`

- [ ] **Step 1: Document the manual acceptance flow**

Add to `docs/SMOKE.md`:

```markdown
## Native session persistence

1. Launch the packaged macOS app and open a project with at least one linked
   worktree.
2. Press `Ctrl+T` and confirm a shell opens in the selected worktree.
3. Press `Ctrl+A` and confirm a Coven chat opens in the same worktree.
4. Move the panes into a mixed row/column layout, resize both split axes, hide
   one pane, and focus the other.
5. Quit Psyche without using **Stop and close**.
6. Run `tmux -S ~/.psyche/macos-app/native-sessions.sock list-sessions` and
   confirm both Psyche-owned sessions remain live.
7. Reopen Psyche and confirm visible/hidden state, layout topology, split
   ratios, focus, scrollback, and interactive process state are restored.
8. Use **Stop and close** on one pane and confirm only its tmux session is
   removed.
9. Force-quit Psyche, reopen it, and confirm the last successful workspace save
   restores without terminating the remaining session.
```

- [ ] **Step 2: Rebuild browser bundles**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: `workspace.bundle.js`, `panes.bundle.js`, `sessions.bundle.js`, and
`editor.bundle.js` are generated successfully.

- [ ] **Step 3: Run all targeted JavaScript tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run Rust verification**

Run:

```bash
cargo fmt \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  -- --check
cargo test \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo check \
  --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

Expected: all commands succeed.

- [ ] **Step 5: Run repository type checking**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- \
  __tests__/tauriSessionPersistence.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/Cargo.lock \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/native_sessions.rs \
  native/macos/psyche-build-tauri/src-tauri/src/native_workspace.rs \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/workspace/workspace-model.mjs \
  native/macos/psyche-build-tauri/web/workspace/workspace-entry.js \
  native/macos/psyche-build-tauri/web/workspace.bundle.js \
  docs/SMOKE.md
```

Expected: only the planned persistence, shortcut, test, generated-bundle, and
smoke-documentation changes appear. Existing unrelated Git-panel work remains
intact.

- [ ] **Step 7: Commit**

```bash
git add \
  docs/SMOKE.md \
  native/macos/psyche-build-tauri/web/editor.bundle.js \
  native/macos/psyche-build-tauri/web/panes.bundle.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  native/macos/psyche-build-tauri/web/workspace.bundle.js
git commit -m "test(tauri): verify native session continuity"
```
