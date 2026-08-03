# macOS Code Editor and Diff Viewer Design

**Date:** 2026-08-03

## Goal

Turn the native macOS Files surface into a real editable code editor with local syntax highlighting and explicit, conflict-safe saves. Replace the current full-DOM diff renderer with a responsive unified diff viewer that stays usable for large changes.

## Scope

This increment covers:

- A locally bundled CodeMirror 6 editor in the native Tauri shell.
- Editable UTF-8 project files with language-aware syntax highlighting.
- Explicit saves through a Save button and `Command-S`.
- Dirty-state UI and safe navigation/close behavior.
- Optimistic conflict detection and atomic writes inside the selected project root.
- A read-only, virtualized CodeMirror unified diff viewer.
- Bounded diff payloads, stale-request suppression, and a small diff cache.

It does not add file creation, file deletion, staging, committing, merge conflict resolution, language servers, autocomplete, formatting, or side-by-side diffs.

## Editor Architecture

The native package will add CodeMirror 6 and a small local bundling step. No editor code or language grammar will load from a CDN. `tauri dev` and `tauri build` will build the browser editor bridge before launching or packaging the app.

The existing static shell remains in place. A focused editor bridge will expose a narrow API to `web/main.js` for:

- creating and destroying an editor;
- loading a document and language extension;
- reading the current document;
- tracking document changes and selection position;
- setting read-only, saving, error, and clean states; and
- creating the read-only diff viewer.

The shell owns file tabs, project selection, Tauri calls, prompts, and Git panel refreshes. CodeMirror owns text editing, viewport rendering, undo/redo, selection, search, line numbers, and highlighting. This keeps editor internals out of the existing workspace controller.

One editor instance is reused for the active file. Each open-file model retains its current text, original saved text, language identifier, selection, dirty state, and loading/error metadata so a tab can be restored without losing in-memory edits.

## Language Support

Language selection is derived from the basename and extension. The first increment supports:

- TypeScript, TSX, JavaScript, and JSX;
- JSON;
- HTML and XML;
- CSS;
- Markdown;
- Python;
- Rust;
- shell scripts;
- YAML; and
- TOML.

Unknown text formats open in plain-text mode. Binary files, invalid UTF-8 files, and files larger than the existing 512 KiB preview limit remain read-only and show a clear explanation.

## Visible Editor Design

The Files panel keeps the existing project tree. The main file surface becomes:

1. A compact toolbar with language label, filename, dirty dot, Save button, and `Command-S` hint.
2. A project-relative breadcrumb.
3. The CodeMirror editing surface with line numbers and the existing native dark palette.
4. A status bar with dirty/saved state, language, encoding, line ending, and cursor position.

The Save button is enabled only when the active file is editable, dirty, and not already saving. Saving temporarily disables the control and reports `Saving...`; success resets the clean baseline and briefly reports `Saved`.

## Save Contract

The Rust backend adds one mutation command:

```text
fs_write_text(root, path, text, expected_text)
```

The command:

1. Canonicalizes the selected project root and target through the existing containment boundary.
2. Requires an existing regular file within that root.
3. Reads the current bytes and requires valid UTF-8.
4. Rejects the write when current disk text does not exactly match `expected_text`.
5. Writes a temporary file in the same directory, preserves the target permissions, flushes it, and atomically renames it over the target.
6. Returns the saved text metadata used to reset the frontend baseline.

The backend never accepts an absolute escape, parent traversal, sibling-prefix escape, or symlink escape. It does not silently overwrite externally modified content.

After a successful save, the shell marks the file clean and invalidates the selected project's diff/status cache before refreshing the Diffs and Git panels.

## Dirty and Conflict Behavior

Dirty files show a dot in their tab, an enabled Save button, and `Modified` in the status bar.

Switching away from a dirty file, closing its tab, closing its project, or quitting the window presents Save, Discard, and Cancel choices:

- **Save** performs the explicit save and continues only after success.
- **Discard** drops the in-memory edit and continues.
- **Cancel** leaves the editor and navigation unchanged.

If disk content changed after the file was opened or last saved, saving is rejected. The conflict UI offers:

- **Reload**, which replaces the editor buffer with current disk content after confirmation; or
- **Keep Editing**, which preserves the unsaved buffer.

There is no force-overwrite action in this increment. Any save failure leaves the file dirty and visible.

## Diff Viewer Architecture

The changed-file list and compact unified layout remain. The `<pre>` plus full-document `innerHTML` path is replaced by one reusable, read-only CodeMirror diff instance.

The viewer sets the diff text as a document and applies lightweight line decorations for additions, deletions, hunk headers, and metadata. CodeMirror viewport virtualization limits mounted DOM to visible lines instead of producing one node for every diff line.

Rapid selection is guarded by a monotonically increasing request generation. A response renders only if it still belongs to the selected project, path, staged state, and latest generation.

A small least-recently-used cache stores the most recently viewed diff responses by project, path, and staged state. Manual refresh and successful file saves invalidate affected cache entries.

## Diff Backend Contract

`git_diff` returns structured metadata rather than an unbounded string:

```text
GitDiffResult {
  text,
  bytes,
  lines,
  truncated
}
```

The backend caps returned diff text at 2 MiB on a valid UTF-8 boundary. The viewer displays the byte/line summary and a visible truncation notice. Untracked files retain the current all-additions fallback, subject to the same cap. Git path validation remains unchanged.

## Error Handling

- Loading, saving, and diff requests expose inline progress rather than blanking the surface.
- File read or save errors remain associated with the affected tab.
- A stale diff response is ignored silently.
- Binary, invalid UTF-8, oversized, and truncated files cannot enter editable mode.
- Failed saves never clear dirty state or refresh Git data as though the write succeeded.
- Missing projects and non-Git projects retain their existing empty states.

## Testing

Rust tests will cover:

- successful contained atomic writes;
- stale `expected_text` rejection;
- traversal, sibling-prefix, and symlink escape rejection;
- invalid UTF-8 rejection;
- permission preservation; and
- 2 MiB diff response truncation and metadata.

JavaScript/Vitest tests will cover:

- filename-to-language selection and plain-text fallback;
- dirty-to-clean transitions;
- `Command-S` and Save button wiring;
- Save, Discard, and Cancel navigation behavior;
- conflict Reload and Keep Editing behavior;
- editor read-only fallbacks;
- diff request generation and stale-response suppression;
- cache invalidation after refresh and save; and
- the CodeMirror-backed, read-only diff rendering contract.

Final verification will run the focused tests, full Vitest suite, TypeScript checks, Rust formatting/tests/check, root production build, and native Tauri application/DMG packaging.
