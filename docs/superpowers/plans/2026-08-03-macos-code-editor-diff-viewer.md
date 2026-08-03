# macOS Code Editor and Diff Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native macOS workspace's plain-text file and diff renderers with an editable, conflict-safe CodeMirror editor and a bounded, virtualized unified diff viewer.

**Architecture:** A locally bundled CodeMirror bridge owns editor-specific behavior while the existing static workspace controller continues to own projects, tabs, Tauri calls, and prompts. Rust adds one contained atomic write command and changes `git_diff` to return capped structured data. Pure browser-independent model helpers carry language mapping, dirty state, request generation, and LRU caching so behavior is directly testable in Vitest.

**Tech Stack:** Tauri 2, Rust 2021, plain browser JavaScript, CodeMirror 6, esbuild, Vitest, pnpm.

---

## File Map

- Create `native/macos/psyche-build-tauri/web/editor/workspace-model.mjs`: pure language, dirty-state, request-generation, and LRU-cache logic.
- Create `native/macos/psyche-build-tauri/web/editor/editor-entry.js`: CodeMirror file-editor and read-only diff-viewer bridge exposed as `window.PsycheCodeEditor` by esbuild.
- Create `__tests__/tauriWorkspaceEditorModel.test.ts`: direct behavior tests for the pure model.
- Create `__tests__/tauriWorkspaceEditorIntegration.test.ts`: source/build contract tests for editor, save, prompt, and diff wiring.
- Modify `native/macos/psyche-build-tauri/package.json`: local CodeMirror dependencies and editor bundle scripts.
- Modify `native/macos/psyche-build-tauri/web/index.html`: editor hosts, toolbar/status controls, dirty prompt, and local bundle load order.
- Modify `native/macos/psyche-build-tauri/web/main.js`: file models, save lifecycle, guarded navigation, and diff request/cache coordination.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: CodeMirror theme integration and editor/diff states.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`: contained atomic writes, structured capped diffs, command registration, and Rust tests.
- Modify `__tests__/tauriWorkspacePanels.test.ts`: update the command allowlist and structured diff contract assertions.

### Task 1: Pure Editor Model and Local CodeMirror Toolchain

**Files:**
- Create: `__tests__/tauriWorkspaceEditorModel.test.ts`
- Create: `native/macos/psyche-build-tauri/web/editor/workspace-model.mjs`
- Create: `native/macos/psyche-build-tauri/web/editor/editor-entry.js`
- Modify: `native/macos/psyche-build-tauri/package.json`

- [ ] **Step 1: Write failing model tests**

Create a test that imports the future model module dynamically so the TypeScript test tree does not need a declaration file:

```ts
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const modelUrl = pathToFileURL(join(
  process.cwd(),
  'native/macos/psyche-build-tauri/web/editor/workspace-model.mjs'
)).href;
const model = await import(modelUrl);

describe('macOS workspace editor model', () => {
  it.each([
    ['component.tsx', 'typescript'],
    ['main.rs', 'rust'],
    ['script.py', 'python'],
    ['Dockerfile', 'shell'],
    ['config.toml', 'toml'],
    ['unknown.data', 'plain'],
  ])('maps %s to %s', (path, language) => {
    expect(model.languageForPath(path)).toBe(language);
  });

  it('tracks edits against the saved baseline', () => {
    const clean = model.createFileBuffer('one');
    const dirty = model.updateFileBuffer(clean, 'two');
    expect(dirty.dirty).toBe(true);
    expect(model.markFileSaved(dirty, 'two')).toEqual({
      text: 'two', originalText: 'two', dirty: false,
    });
  });

  it('suppresses stale request generations', () => {
    const gate = model.createRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('evicts least-recently-used diff entries', () => {
    const cache = model.createLruCache(2);
    cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts`

Expected: FAIL because `workspace-model.mjs` does not exist.

- [ ] **Step 3: Implement the pure model**

Create `workspace-model.mjs` with no DOM or Tauri dependencies:

```js
const EXTENSIONS = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'], ['js', 'javascript'], ['jsx', 'javascript'],
  ['json', 'json'], ['html', 'html'], ['htm', 'html'], ['xml', 'xml'], ['css', 'css'],
  ['md', 'markdown'], ['mdx', 'markdown'], ['py', 'python'], ['rs', 'rust'],
  ['sh', 'shell'], ['bash', 'shell'], ['zsh', 'shell'], ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'],
]);

export function languageForPath(path) {
  const name = String(path || '').split('/').pop() || '';
  if (/^(Dockerfile|Makefile)$/.test(name)) return 'shell';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? 'plain' : EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) || 'plain';
}

export function createFileBuffer(text) {
  return { text, originalText: text, dirty: false };
}

export function updateFileBuffer(buffer, text) {
  return { ...buffer, text, dirty: text !== buffer.originalText };
}

export function markFileSaved(buffer, text) {
  return { ...buffer, text, originalText: text, dirty: false };
}

export function createRequestGate() {
  let generation = 0;
  return { next: () => ++generation, isCurrent: value => value === generation };
}

export function createLruCache(limit) {
  const values = new Map();
  return {
    get(key) {
      if (!values.has(key)) return undefined;
      const value = values.get(key); values.delete(key); values.set(key, value); return value;
    },
    set(key, value) {
      values.delete(key); values.set(key, value);
      while (values.size > limit) values.delete(values.keys().next().value);
    },
    deleteWhere(predicate) {
      for (const key of values.keys()) if (predicate(key)) values.delete(key);
    },
    clear() { values.clear(); },
  };
}
```

- [ ] **Step 4: Add pinned editor dependencies and bundle scripts**

Update the nested package with these runtime dependencies: `codemirror@6.0.2`, `@codemirror/view@6.43.7`, `@codemirror/state@6.7.1`, `@codemirror/language@6.12.4`, `@codemirror/lang-javascript@6.2.5`, `@codemirror/lang-json@6.0.2`, `@codemirror/lang-html@6.4.11`, `@codemirror/lang-xml@6.1.0`, `@codemirror/lang-css@6.3.1`, `@codemirror/lang-markdown@6.5.1`, `@codemirror/lang-python@6.2.1`, `@codemirror/lang-rust@6.0.2`, `@codemirror/lang-yaml@6.1.3`, and `@codemirror/legacy-modes@6.5.3`. Add `esbuild@0.28.1` as a dev dependency.

Use scripts:

```json
{
  "scripts": {
    "build:web": "esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js",
    "build": "pnpm build:web && tauri build",
    "dev": "pnpm build:web && tauri dev"
  }
}
```

Create `editor-entry.js` initially as a buildable API shell:

```js
export { languageForPath, createFileBuffer, updateFileBuffer, markFileSaved,
  createRequestGate, createLruCache } from './workspace-model.mjs';
```

- [ ] **Step 5: Verify GREEN and bundle output**

Run:

```bash
pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts
pnpm --dir native/macos/psyche-build-tauri install
pnpm --dir native/macos/psyche-build-tauri run build:web
```

Expected: model tests PASS and `web/editor.bundle.js` is generated without network imports.

- [ ] **Step 6: Commit the model and toolchain**

```bash
git add -f native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/editor/workspace-model.mjs \
  native/macos/psyche-build-tauri/web/editor/editor-entry.js
git add __tests__/tauriWorkspaceEditorModel.test.ts
git commit -m "build: add local CodeMirror workspace bundle"
```

Do not add generated `web/editor.bundle.js` or the nested generated lockfile.

### Task 2: Contained, Conflict-Safe Atomic File Writes

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:903-1035`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:1290-1310`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:1360-1430`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Write failing Rust save tests**

Add tests beside the existing workspace-panel tests:

```rust
#[test]
fn writes_text_atomically_inside_project_and_preserves_permissions() {
    let temp = temp_dir("write");
    let project = temp.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let file = project.join("main.rs");
    std::fs::write(&file, "fn old() {}\n").unwrap();
    let before = std::fs::metadata(&file).unwrap().permissions();

    let saved = fs_write_text(
        path_text(&project).into(), path_text(&file).into(),
        "fn new() {}\n".into(), "fn old() {}\n".into(),
    ).unwrap();

    assert_eq!(saved.text, "fn new() {}\n");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), saved.text);
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().readonly(), before.readonly());
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn rejects_stale_writes_and_symlink_escapes() {
    let temp = temp_dir("stale");
    let project = temp.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let file = project.join("main.txt");
    std::fs::write(&file, "disk changed").unwrap();
    let error = fs_write_text(
        path_text(&project).into(), path_text(&file).into(),
        "editor text".into(), "old baseline".into(),
    ).unwrap_err();
    assert!(error.contains("changed on disk"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "disk changed");
    let _ = std::fs::remove_dir_all(temp);
}
```

Extend the existing symlink test to call `fs_write_text` through a symlink whose target is outside the project and assert rejection.

Add an invalid UTF-8 fixture and assert both `fs_read_text` and `fs_write_text` classify/reject it instead of exposing lossy editable text.

- [ ] **Step 2: Verify the Rust tests fail**

Run: `cargo test workspace_panel_tests --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml`

Expected: compilation FAIL because `fs_write_text` does not exist.

- [ ] **Step 3: Implement the write command**

Add `SavedFileText` and `fs_write_text`. Reuse `resolve_project_path`; require valid UTF-8 and an exact baseline match. Create a unique same-directory temporary file with `OpenOptions::create_new`, copy permissions, write/flush/sync, then rename it over the target. On every error after temp creation, remove only that exact temp file. Replace `String::from_utf8_lossy` in `fs_read_text` with `String::from_utf8`; invalid UTF-8 returns `binary: true`, empty text, and never becomes editable.

The public shape is:

```rust
#[derive(Debug, Serialize, Clone)]
pub struct SavedFileText {
    pub path: String,
    pub text: String,
    pub size: u64,
}

fn atomic_replace_text(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);

    let parent = target.parent().ok_or_else(|| "file has no parent".to_string())?;
    let name = target.file_name().and_then(|value| value.to_str())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?;
    let temp = parent.join(format!(
        ".{}.psyche-save-{}-{}", name, std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let result = (|| {
        let permissions = std::fs::metadata(target).map_err(|e| e.to_string())?.permissions();
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temp)
            .map_err(|e| e.to_string())?;
        file.set_permissions(permissions).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}

#[tauri::command]
fn fs_write_text(
    root: String,
    path: String,
    text: String,
    expected_text: String,
) -> Result<SavedFileText, String> {
    let target = resolve_project_path(&root, &path)?;
    if !target.is_file() { return Err(format!("not a regular file: {}", path)); }
    let current = std::fs::read(&target).map_err(|e| e.to_string())?;
    let current_text = std::str::from_utf8(&current)
        .map_err(|_| format!("file is not valid UTF-8: {}", path))?;
    if current_text != expected_text { return Err("file changed on disk".into()); }
    atomic_replace_text(&target, text.as_bytes())?;
    Ok(SavedFileText { path: target.to_string_lossy().into(), size: text.len() as u64, text })
}
```

Register `fs_write_text` in `tauri::generate_handler!`.

- [ ] **Step 4: Update the workspace command contract test**

Change the allowlist assertion to require `fs_write_text`, and continue rejecting unrelated Git mutation commands:

```ts
for (const command of [
  'fs_list_dir', 'fs_read_text', 'fs_write_text', 'git_status', 'git_diff', 'git_log'
]) {
  expect(tauriLib).toMatch(new RegExp(`\\n\\s*${command},`));
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cargo fmt --check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test workspace_panel_tests --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm exec vitest --run __tests__/tauriWorkspacePanels.test.ts
```

Expected: all workspace Rust tests and panel contract tests PASS.

- [ ] **Step 6: Commit the save boundary**

```bash
git add -f native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git add __tests__/tauriWorkspacePanels.test.ts
git commit -m "feat: add conflict-safe workspace file saves"
```

### Task 3: CodeMirror File Editor Surface

**Files:**
- Create: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/editor/editor-entry.js`
- Modify: `native/macos/psyche-build-tauri/web/index.html:72-82`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:950-1020`

- [ ] **Step 1: Write failing editor surface contracts**

Assert the HTML exposes `file-editor-host`, `file-save`, `file-language`, `file-status`, and loads `editor.bundle.js` before `main.js`. Assert the bridge exports `createFileEditor` and maps all specified languages.

```ts
expect(indexHtml).toContain('id="file-editor-host"');
expect(indexHtml).toContain('id="file-save"');
expect(indexHtml.indexOf('./editor.bundle.js')).toBeLessThan(indexHtml.indexOf('./main.js'));
expect(editorEntry).toMatch(/export function createFileEditor/);
expect(editorEntry).toMatch(/javascript\(\{ typescript: true, jsx: true \}\)/);
expect(editorEntry).toMatch(/StreamLanguage\.define\(shell\)/);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts`

Expected: FAIL because the host and bridge API do not exist.

- [ ] **Step 3: Implement the CodeMirror file bridge**

Use `EditorView`, `EditorState`, `basicSetup`, `Compartment`, and locally imported language packages. Define `extensionForLanguage` exhaustively so every language promised in the spec is local and unknown values return `[]`:

```js
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';

function extensionForLanguage(id) {
  return ({
    typescript: () => javascript({ typescript: true, jsx: true }),
    javascript: () => javascript({ jsx: true }), json, html, xml, css, markdown,
    python, rust, yaml,
    shell: () => StreamLanguage.define(shell),
    toml: () => StreamLanguage.define(toml),
  }[id] || (() => []))();
}
```

`createFileEditor` must return this shell-facing API:

```js
export function createFileEditor({ parent, onChange, onSelectionChange }) {
  const language = new Compartment();
  const editable = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        workspaceTheme,
        language.of([]),
        editable.of(EditorView.editable.of(true)),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            onSelectionChange({ line: line.number, column: head - line.from + 1 });
          }
        }),
      ],
    }),
  });
  return {
    setDocument({ text, languageId, readOnly }) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: [
          language.reconfigure(extensionForLanguage(languageId)),
          editable.reconfigure(EditorView.editable.of(!readOnly)),
        ],
      });
    },
    getText: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
```

Guard programmatic `setDocument` updates so they do not call the shell's edit handler.

- [ ] **Step 4: Replace the `<pre>` with the approved toolbar/editor/status structure**

Add the Save button, breadcrumb, editor host, read-only message, and status bar. Load:

```html
<script src="./editor.bundle.js" defer></script>
<script src="./main.js" defer></script>
```

Style `.cm-editor`, `.cm-scroller`, gutters, active line, selections, syntax tokens, focus ring, toolbar, breadcrumb, and status bar using existing CSS variables. The editor must fill the current file-view grid without introducing a second outer scroll area.

- [ ] **Step 5: Verify GREEN and build the local bundle**

Run:

```bash
pnpm exec vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts
pnpm --dir native/macos/psyche-build-tauri run build:web
```

Expected: integration contracts PASS and esbuild exits 0.

- [ ] **Step 6: Commit the editor surface**

```bash
git add __tests__/tauriWorkspaceEditorIntegration.test.ts
git add -f native/macos/psyche-build-tauri/web/editor/editor-entry.js \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat: add native CodeMirror file editor surface"
```

### Task 4: Dirty State and Explicit Save Lifecycle

**Files:**
- Modify: `__tests__/tauriWorkspaceEditorModel.test.ts`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1130-1240`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1240-1320`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1935-1985`

- [ ] **Step 1: Add failing save lifecycle contracts**

Require file models to hold `originalText`, `dirty`, `saving`, `languageId`, and cursor state. Require a `saveFile` function to invoke:

```js
invoke("fs_write_text", {
  root: project.root,
  path: file.path,
  text: file.text,
  expectedText: file.originalText,
})
```

Require the global key handler to route `metaKey && key === "s"` to the active file save and prevent the browser default.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts`

Expected: FAIL because save wiring and dirty metadata are absent.

- [ ] **Step 3: Wire file documents into the bridge**

Create the editor once after DOM refs. On open, store the read response as both `text` and `originalText`; set `readOnly` when binary, invalid, truncated, or errored. In the editor `onChange`, update only the active file through `updateFileBuffer`, refresh its tab, and update Save/status controls.

`renderFileView` must stop constructing line-number HTML and instead call `fileEditor.setDocument` only when the active file changes or is explicitly reloaded.

- [ ] **Step 4: Implement explicit save**

Use this control flow:

```js
async function saveFile(file) {
  if (!file || !file.dirty || file.saving || !isEditableFile(file)) return false;
  const project = findProject(file.projectId);
  file.saving = true; renderFileChrome(file);
  try {
    const saved = await invoke('fs_write_text', {
      root: project.root, path: file.path, text: file.text,
      expectedText: file.originalText,
    });
    Object.assign(file, markFileSaved(file, saved.text), { size: saved.size, saving: false, error: null });
    invalidateProjectDiffs(project.id);
    renderFileChrome(file); refreshTabs();
    if (currentPanel() === 'diffs') renderDiffsPanel();
    if (currentPanel() === 'git') renderGitPanel();
    return true;
  } catch (error) {
    file.saving = false;
    file.saveError = String(error);
    renderFileChrome(file);
    if (file.saveError.includes('changed on disk')) showConflictPrompt(file);
    return false;
  }
}
```

Wire Save click and `Command-S`. Dirty tabs render a separate `.dirty-dot`; Save/status reflect clean, modified, saving, saved, and error states.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts
pnpm --dir native/macos/psyche-build-tauri run build:web
```

Expected: all focused editor tests PASS and the bundle builds.

- [ ] **Step 6: Commit the save lifecycle**

```bash
git add __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts
git add -f native/macos/psyche-build-tauri/web/main.js
git commit -m "feat: wire explicit native editor saves"
```

### Task 5: Guarded Navigation, Close, Quit, and Conflicts

**Files:**
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/main.js:780-900`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1130-1320`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`

- [ ] **Step 1: Write failing prompt-flow contracts**

Require a single native-styled `<dialog id="dirty-file-dialog">` with Save, Discard, and Cancel controls plus conflict-mode Reload and Keep Editing controls. Assert `activateFileTab`, `closeFileTab`, `removeProject`, `showTerminalView`, and the window close-request handler pass through `guardDirtyFile` before changing state.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts`

Expected: FAIL because the dialog and guards do not exist.

- [ ] **Step 3: Implement one promise-based dialog primitive**

`showFileDecision({ mode, file })` opens the dialog and resolves exactly once with:

```js
// dirty mode
'save' | 'discard' | 'cancel'
// conflict mode
'reload' | 'keep-editing'
```

Escape and backdrop dismissal resolve to the non-destructive choice (`cancel` or `keep-editing`). Buttons must restore focus to the editor when navigation does not continue.

- [ ] **Step 4: Implement the dirty guard and conflict reload**

```js
async function guardDirtyFile(file) {
  if (!file || !file.dirty) return true;
  const choice = await showFileDecision({ mode: 'dirty', file });
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  return saveFile(file);
}
```

For conflicts, `reloadFile(file)` calls `fs_read_text`, replaces `text` and `originalText`, clears dirty/error state, and updates the active editor. Keep Editing changes no buffer state.

Convert state-changing callers to async and await the guard before mutating active IDs or arrays. Intercept Tauri window close with `window.__TAURI__.window.getCurrentWindow().onCloseRequested`; call `event.preventDefault()` while dirty decisions run, then call `window.destroy()` only after every dirty file is saved or discarded.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm exec vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts
pnpm --dir native/macos/psyche-build-tauri run build:web
```

Expected: prompt/guard contracts PASS and the bundle builds.

- [ ] **Step 6: Commit safe navigation**

```bash
git add __tests__/tauriWorkspaceEditorIntegration.test.ts
git add -f native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat: protect unsaved native editor changes"
```

### Task 6: Structured and Bounded Diff Backend

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:1190-1255`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:1360-1460`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Write failing Rust diff-cap tests**

Create a temporary Git repo with a tracked file, commit a small baseline, write more than 2 MiB of changed valid UTF-8 content, and assert:

```rust
let diff = git_diff(path_text(&project).into(), Some("large.txt".into()), Some(false)).unwrap();
assert!(diff.truncated);
assert!(diff.text.len() <= MAX_DIFF_BYTES);
assert!(diff.bytes > diff.text.len() as u64);
assert!(diff.lines > diff.text.lines().count() as u64);
assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
```

- [ ] **Step 2: Verify RED**

Run: `cargo test workspace_panel_tests::caps_large_git_diffs --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml`

Expected: compilation FAIL because `git_diff` still returns `String`.

- [ ] **Step 3: Implement `GitDiffResult` and UTF-8-safe truncation**

```rust
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct GitDiffResult {
    pub text: String,
    pub bytes: u64,
    pub lines: u64,
    pub truncated: bool,
}

fn bounded_diff(text: String) -> GitDiffResult {
    let bytes = text.len();
    let lines = text.lines().count() as u64;
    if bytes <= MAX_DIFF_BYTES {
        return GitDiffResult { text, bytes: bytes as u64, lines, truncated: false };
    }
    let mut end = MAX_DIFF_BYTES;
    while !text.is_char_boundary(end) { end -= 1; }
    GitDiffResult { text: text[..end].into(), bytes: bytes as u64, lines, truncated: true }
}
```

Return `bounded_diff(out)` for tracked and untracked paths. Remove the untracked 2,000-line special limit so both paths use the same byte cap.

- [ ] **Step 4: Update frontend contract expectations**

Assert `GitDiffResult`, `MAX_DIFF_BYTES`, `truncated`, and the structured `git_diff` return type are present. Update any string-return regexes.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cargo fmt --check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test workspace_panel_tests --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm exec vitest --run __tests__/tauriWorkspacePanels.test.ts
```

Expected: Rust workspace tests and panel contract tests PASS.

- [ ] **Step 6: Commit the bounded diff contract**

```bash
git add -f native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git add __tests__/tauriWorkspacePanels.test.ts
git commit -m "perf: bound native workspace diff payloads"
```

### Task 7: Virtualized Unified Diff Viewer

**Files:**
- Modify: `__tests__/tauriWorkspaceEditorModel.test.ts`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/editor/editor-entry.js`
- Modify: `native/macos/psyche-build-tauri/web/index.html:145-155`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2050-2250`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1010-1050`

- [ ] **Step 1: Write failing virtualized diff contracts**

Require `createDiffViewer`, a `diff-editor-host`, read-only CodeMirror configuration, line-decoration classes, a six-entry LRU cache, a request gate, and structured result handling:

```ts
expect(editorEntry).toMatch(/export function createDiffViewer/);
expect(editorEntry).toMatch(/EditorView\.editable\.of\(false\)/);
expect(mainJs).toMatch(/createLruCache\(6\)/);
expect(mainJs).toMatch(/createRequestGate\(\)/);
expect(mainJs).toMatch(/result\.truncated/);
expect(mainJs).not.toMatch(/diffBodyEl\.innerHTML\s*=\s*text/);
```

Extend model tests to prove `deleteWhere` removes only affected project keys.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts`

Expected: FAIL because the diff bridge and coordination are absent.

- [ ] **Step 3: Implement the read-only CodeMirror diff bridge**

`createDiffViewer({ parent })` creates one `EditorView` with `EditorView.editable.of(false)`, no active-line or editing keymaps, and a decoration plugin that classifies visible lines by prefix:

```js
function diffClass(text) {
  if (text.startsWith('@@')) return 'cm-diff-hunk';
  if (/^(diff |index |---|\+\+\+)/.test(text)) return 'cm-diff-meta';
  if (text.startsWith('+')) return 'cm-diff-add';
  if (text.startsWith('-')) return 'cm-diff-delete';
  return '';
}
```

The returned API is `setDiff({ text })`, `clear()`, and `destroy()`. Decorations are computed through CodeMirror viewport ranges rather than prebuilding DOM nodes for the whole document.

- [ ] **Step 4: Replace the `<pre>` diff path and coordinate requests**

Create the diff viewer once. In `showDiff`:

1. Generate a cache key from project ID, relative path, and staged state.
2. Display cached results immediately when present.
3. Call `const generation = diffRequestGate.next()` before invoking Rust.
4. Render the response only when `diffRequestGate.isCurrent(generation)` and the current selection still matches the key.
5. Show `lines`, `bytes`, and a truncation notice outside CodeMirror.

`invalidateProjectDiffs(projectId)` uses `deleteWhere(key => key.startsWith(projectId + '\0'))`. Manual refresh calls it before fetching. Successful saves call the same function from Task 4.

- [ ] **Step 5: Verify GREEN and bundle size**

Run:

```bash
pnpm exec vitest --run __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts
pnpm --dir native/macos/psyche-build-tauri run build:web
ls -lh native/macos/psyche-build-tauri/web/editor.bundle.js
```

Expected: focused tests PASS, esbuild exits 0, and the local bundle exists. Record its size in the execution notes; do not add a brittle exact-size test.

- [ ] **Step 6: Commit the virtualized viewer**

```bash
git add __tests__/tauriWorkspaceEditorModel.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts
git add -f native/macos/psyche-build-tauri/web/editor/editor-entry.js \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "perf: virtualize native unified diffs"
```

### Task 8: Full Verification and Delivery Audit

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [ ] **Step 1: Run focused workspace tests**

```bash
pnpm exec vitest --run \
  __tests__/tauriWorkspaceEditorModel.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriDesktopTabs.test.ts
cargo test workspace_panel_tests --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 2: Run repository verification**

```bash
pnpm run typecheck
pnpm run test
pnpm run build
cargo fmt --check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
git diff --check
```

Expected: typecheck/build exit 0; Vitest reports zero failures; Rust fmt/test/check exit 0; diff check emits no output.

- [ ] **Step 3: Build native application bundles**

```bash
pnpm --dir native/macos/psyche-build-tauri install
pnpm --dir native/macos/psyche-build-tauri run build
```

Expected: Tauri produces both `psyche.app` and `psyche_0.0.7_aarch64.dmg`. If the known macOS DMG helper leaves its generated `rw.*.dmg` mounted, identify the exact image with `hdiutil info`, detach only its exact `/dev/diskN`, and rerun with `pnpm exec tauri build --bundles dmg --verbose`.

- [ ] **Step 4: Audit the final diff and repository state**

```bash
git status --short --branch
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline --decorate main..HEAD
```

Expected: only planned source, test, package, spec, and plan files differ; generated bundle, nested lockfile, and `.superpowers/` are not committed.

- [ ] **Step 5: Commit any verification-only correction**

Only if Step 2 or 3 required a source correction, rerun the exact failed command plus the focused tests, then commit the correction with a message naming the behavior fixed. Do not create an empty verification commit.
