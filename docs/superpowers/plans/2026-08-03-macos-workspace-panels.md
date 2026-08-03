# macOS Workspace Panels Implementation Plan

> **For agentic workers:** Implement this plan task-by-task and keep progress tracked with checkbox (`- [ ]`) syntax.

**Goal:** Make the existing macOS Files, Diffs, and Git panels project-scoped, tested, formatted, and release-verifiable.

**Architecture:** Keep the current no-bundler HTML/CSS/JavaScript UI. Add small Rust path-validation helpers used by every filesystem read and by the untracked-file diff fallback; pass the selected project root from JavaScript on each filesystem invocation.

**Tech Stack:** Tauri 2, Rust 2021, vanilla JavaScript, Vitest, pnpm.

---

### Task 1: Pin the workspace-panel contract

**Files:**
- Create: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`

- [x] **Step 1: Add a Vitest contract that requires `root` on `fs_list_dir` and `fs_read_text`, read-only command registration, and the four right-rail panel buttons.**

```ts
expect(mainJs).toMatch(/invoke\("fs_list_dir",\s*\{\s*root:\s*root,\s*path:\s*dirPath\s*\}\)/);
expect(mainJs).toMatch(/invoke\("fs_read_text",\s*\{\s*root:\s*project\.root,\s*path:\s*path\s*\}\)/);
expect(tauriLib).toMatch(/fn fs_list_dir\(root: String, path: String\)/);
expect(tauriLib).toMatch(/fn fs_read_text\(root: String, path: String\)/);
for (const panel of ['browser', 'files', 'diffs', 'git']) {
  expect(indexHtml).toContain(`data-panel-btn="${panel}"`);
}
```

- [x] **Step 2: Add Rust unit tests requiring nested-path acceptance plus parent, sibling-prefix, symlink-escape, and nested-Git-root rejection.**

```rust
assert_eq!(resolve_project_path(root, nested)?, nested.canonicalize()?);
assert!(resolve_project_path(root, "../outside.txt").is_err());
assert!(resolve_project_path(root, sibling_file).is_err());
#[cfg(unix)]
assert!(resolve_project_path(root, symlink_to_outside).is_err());
```
- [x] **Step 3: Run `pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts` and `cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml` and confirm the new containment assertions fail for the missing helper/API.**

### Task 2: Enforce project containment

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [x] **Step 1: Add `canonical_project_root`, `resolve_project_path`, and `validate_git_relative_path` helpers.**

```rust
fn canonical_project_root(root: &str) -> Result<PathBuf, String>;
fn resolve_project_path(root: &str, requested: &str) -> Result<PathBuf, String>;
fn validate_git_relative_path(path: &str) -> Result<(), String>;
```
- [x] **Step 2: Change `fs_list_dir` and `fs_read_text` to accept `root`, resolve the requested path through `resolve_project_path`, and return the canonical path.**

```rust
#[tauri::command]
fn fs_list_dir(root: String, path: String) -> Result<Vec<DirEntryInfo>, String>;

#[tauri::command]
fn fs_read_text(root: String, path: String) -> Result<FileText, String>;
```
- [x] **Step 3: Validate an optional `git_diff` path before invoking Git, scope nested repositories with pathspecs, and use `resolve_project_path` before reading an untracked file.**
- [x] **Step 4: Pass `project.root` in the frontend `fs_list_dir` and `fs_read_text` invocations.**

```js
invoke("fs_list_dir", { root: root, path: dirPath });
invoke("fs_read_text", { root: project.root, path: path });
```
- [x] **Step 5: Re-run the focused Rust and Vitest tests and confirm they pass.**

### Task 3: Repair the existing desktop assertion and formatting

**Files:**
- Modify: `__tests__/tauriDesktopTabs.test.ts`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`

- [x] **Step 1: Scope the `join_paths` fallback assertion to the `compute_augmented_path` function body so later Rust functions cannot cause a false positive.**

```ts
const augmentedPathFunction = tauriLib.match(
  /fn compute_augmented_path\(\) -> String \{[\s\S]*?\n\}\n\nfn push_path_if_dir/
)?.[0] ?? '';
expect(augmentedPathFunction).not.toMatch(
  /std::env::join_paths\(&parts\)[\s\S]*?\.unwrap_or_default\(\)/
);
```
- [x] **Step 2: Run `pnpm vitest --run __tests__/tauriDesktopTabs.test.ts` and confirm all desktop-tab tests pass.**
- [x] **Step 3: Run `cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml` and review that only intended Rust formatting changed.**

### Task 4: Pin the native build tool

**Files:**
- Modify: `native/macos/psyche-build-tauri/package.json`
- Test: `__tests__/tauriWorkspacePanels.test.ts`

- [x] **Step 1: Reproduce the packaged build failure with the globally resolved `tauri-cli 1.6.6`.**
- [x] **Step 2: Pin `@tauri-apps/cli` 2.x locally and route `dev`/`build` through the package binary.**
- [x] **Step 3: Add a source contract that prevents the package from falling back to `cargo tauri`.**

### Task 5: Verify the complete patch

**Files:**
- Verify only; do not modify unrelated checkout files.

- [x] **Step 1: Run `git diff --check`.**
- [x] **Step 2: Run `pnpm run typecheck`, `pnpm run test`, and `pnpm run build`.**
- [x] **Step 3: Run `cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check`, `cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml`, and `cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml`.**
- [x] **Step 4: Run `pnpm --dir native/macos/psyche-build-tauri build` to prove the packaged desktop application builds.**
- [x] **Step 5: Review `git status --short`, `git diff --stat`, and the complete diff. Leave the branch uncommitted unless Val explicitly requests commit/push/PR.**
