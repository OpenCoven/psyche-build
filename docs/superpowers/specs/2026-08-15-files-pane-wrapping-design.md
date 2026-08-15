# Files Pane Wrapping and Focus Design

## Goal

Make source lines wrap in the native Files pane while retaining its relationship to the selected source worktree: the pane reads as a distinct focused surface only through the existing accent border glow.

## Existing behavior

`web/main.js` renders a Files surface as a normal canvas pane scoped to one project and worktree. `web/styles.css` already gives `.terminal-pane.is-files.focused` an accent border, soft outer glow, and lightly tinted header; unfocused Files panes use the standard pane frame.

The CodeMirror state created in `web/editor/editor-entry.js` has no wrapping extension, so long source lines require horizontal scrolling.

## Design

Add CodeMirror's `EditorView.lineWrapping` extension to the Files editor state. This is the editor-native wrapping mechanism: it preserves gutter alignment, selections, cursor movement, and CodeMirror's scroll container.

Do not add a divider, a separate-worktree indicator, or new focus colors. The current `is-files.focused` CSS remains the only Files-specific visual distinction, so focus communicates the active surface without implying independent worktree ownership.

## Scope and verification

Change `native/desktop/psyche-build-tauri/web/editor/editor-entry.js`, regenerate `editor.bundle.js` through the native web build, and add a focused state assertion if the existing editor test seam can inspect extensions. Verify with the focused tests and `pnpm build:web` in `native/desktop/psyche-build-tauri`.

Out of scope: user-configurable wrapping, changing terminal wrapping, or modifying pane/worktree ownership and persistence.
