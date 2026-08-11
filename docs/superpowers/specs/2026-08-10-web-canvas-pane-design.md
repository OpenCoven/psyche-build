# Web Canvas Pane Design

## Goal

Remove the outer `Git | Web` dock switch. Keep the Git dock's `Changes | Commit`
sections, and move the project browser into the same tiled canvas used by shell
and agent panes.

## Interaction contract

- The right dock is Git-only and remains collapsible.
- The Git dock retains its `Changes` and `Commit` segmented tabs and changed-file
  count.
- The new-pane menu's Web action creates and focuses the worktree's browser pane
  when it is absent. It preserves restored tabs, creates a blank tab if none
  exist, and opens a new blank tab when the pane already exists.
- A browser pane is a canvas leaf. It can be focused, resized, repositioned,
  maximized, and closed using the same controls and pane-tree operations as
  terminal and agent panes.
- Closing the browser pane removes the canvas leaf and hides its native child
  webview. Saved browser tabs and history remain attached to the worktree, so
  reopening the pane restores them.
- Browser-tab controls remain inside the browser pane. `Command-T` opens a
  browser tab when the browser pane is focused and an agent pane otherwise.

## Architecture

Generalize the canvas from terminal-thread leaves to surface leaves without
changing the pane-tree data structure. Terminal and agent surfaces continue to
reference their existing thread records. The browser uses one stable surface
record per project worktree and reuses the existing `browsersByWorktree` model.

Rendering resolves each leaf to its surface kind. Terminal surfaces retain the
existing xterm body and PTY lifecycle. The browser surface owns the existing
browser toolbar, browser-tab strip, preview placeholder, and native-webview
bounds target. Shared pane chrome and pane-tree operations handle focus,
dragging, resize, maximize, and close.

The fixed top browser band, its resize handle, browser-column state, Web dock
buttons, and their layout handlers are removed. The main workbench becomes a
two-column layout only when the Git dock is open: canvas, splitter, Git dock.

## Native webview behavior

The current Tauri browser commands and per-tab native webview labels remain
unchanged. Bounds are calculated from the focused worktree's browser pane
preview element. If that pane is absent, hidden, or outside the active
worktree, all native browser webviews are hidden.

## Compatibility and scope

Existing persisted browser tabs and history continue to load. Obsolete saved
browser-column and top-band layout fields are ignored during restoration. This
change does not alter Git operations, filesystem operations, PTY launch
behavior, or browser navigation semantics.

## Verification

Add focused contract tests first to prove that:

- outer `Git | Web` controls and the top browser band are absent;
- `Changes | Commit` and the Git dock remain;
- Web is represented and rendered as a canvas pane surface;
- Web creation, focus, close, and native bounds follow the canvas lifecycle;
- obsolete browser-band layout and resize handlers are removed.

Then run the focused Tauri workspace-panel tests, the full test suite,
typecheck, and the web/native build gates applicable to the changed files.
