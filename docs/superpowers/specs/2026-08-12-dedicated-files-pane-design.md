# Dedicated Files Pane Design

Date: 2026-08-12
Status: Approved for implementation

## Goal

Make file editing a first-class canvas activity. Opening a file from the Files sidebar creates one dedicated Files pane for the selected worktree. Additional files open as tabs inside that pane instead of replacing the entire canvas.

## Approved behavior

- Each project worktree owns at most one Files pane.
- Opening the first file creates the Files pane beside the currently focused canvas pane using a 50/50 horizontal split.
- If the worktree has no existing canvas pane, the Files pane owns the full canvas.
- Opening another file in the same worktree reuses the Files pane and adds or activates an internal file tab.
- Switching worktrees shows only that worktree's Files pane and tabs.
- Closing the active tab selects the nearest remaining tab.
- Closing the final tab removes the Files pane and lets the existing pane-tree removal logic collapse the vacated split.
- Existing dirty-file save, discard, conflict, reload, binary, truncation, and error behavior remains intact.

## Canvas model

Files is a first-class canvas leaf, but not a PTY, browser session, agent session, or synthetic thread. The pane-tree leaf identity remains opaque to the tree model; the desktop shell resolves a leaf to either a session-backed pane or the worktree's Files pane.

The Files pane is keyed by the existing project-and-worktree layout key. Its lifecycle is session-local, matching the existing open-file buffers: it is created when the first file opens and removed when the final file closes. The current workspace persistence schema does not gain unsaved editor buffers or synthetic session descriptors.

Pane-tree operations used by Files:

- `insertRelative(..., "right")` creates the initial horizontal split beside the focused leaf.
- `createLeaf` creates the Files leaf with a stable worktree-scoped surface identifier.
- `removeLeaf` removes the Files leaf and chooses the next remaining canvas leaf.
- Existing layout measurement and minimum-size checks decide whether the new split can be shown tiled. When it cannot fit, the Files leaf still joins the underlying layout, but becomes the maximized projection until the user restores the tiling.

Files panes are not members of session focus sets. When a focus set scopes terminal panes, the worktree Files pane remains eligible to render because it is a workspace tool rather than a process-backed session.

## Files pane structure

The existing file view moves from the terminal-area overlay into a reusable framed pane element:

1. Pane header: Files identity, active path context, span control, focus control, and close control.
2. Internal file tab strip: worktree-local open files only.
3. File toolbar: language, filename, dirty state, metadata, and save action.
4. Project-relative path row.
5. CodeMirror editor or existing read-only/error state.
6. File status bar with save state and cursor position.

The Files pane owns one CodeMirror instance. Activating a tab swaps that editor's document and restores the file's saved selection. Existing file buffer objects remain the source of truth for text, dirty state, save state, and selection.

## Focus and visual treatment

The Files pane participates in the same single-active-pane contract as terminal, agent, browser, and Git panes.

- Clicking a file tab, editor, toolbar, path, status bar, or pane header activates the Files pane.
- The entire pane frame glows together when active: focused border, connected header tint, and restrained violet shadow.
- Internal controls do not create separate glows.
- The active file tab remains visibly selected within the glowing pane.
- Activating another canvas pane removes the Files glow and transfers the existing focused treatment to that pane.
- `Esc` from file focus returns to the previously active terminal pane when it still exists; otherwise it focuses the nearest remaining pane.

The visual implementation reuses the current Psyche color tokens, mono typography, pane geometry, and focus styles. The signature is the connected whole-frame glow, not new decorative chrome.

## Input and commands

While the Files pane is active:

- `Command-1` through `Command-9` activate the corresponding file tab.
- `Command-W` closes the active file tab. Closing the last tab removes the pane.
- `Command-S` saves the active file.
- Middle-click closes the clicked file tab.
- Clicking an already-open file in the Files sidebar activates its existing tab and focuses the Files pane.

Terminal input routing remains unchanged because Files activation clears terminal input focus before CodeMirror receives keyboard input.

## State boundaries

Open files gain an explicit `workspaceRoot` scope and are grouped by project plus worktree, rather than project alone. Active-file selection is tracked per Files pane so switching worktrees does not overwrite another worktree's selected tab.

The desktop shell maintains a small worktree-scoped Files pane record containing:

- pane/surface identifier;
- project identifier;
- workspace root;
- pane DOM element;
- active file identifier;
- previous focused session identifier for `Esc` return;
- transient focus/projection state.

File contents and save state remain on existing open-file records. Pane layout remains in the existing `paneLayouts` map.

## Lifecycle and failure handling

- A file is loaded before it becomes editable; the pane may render its existing loading state immediately.
- If the new split cannot satisfy minimum geometry, opening the file still succeeds with the Files leaf maximized while preserving the underlying terminal layout.
- A failed load remains as an error tab in the Files pane.
- Dirty guards run before tab close, Files pane close, worktree/project switch, project removal, and window close.
- Closing the Files pane control applies the dirty guard to every tab in that pane, then removes all of them only after every decision succeeds.
- Project removal drops all of that project's worktree Files panes after existing dirty guards complete.
- Removing the terminal remembered for `Esc` return falls back to the nearest remaining process-backed pane.

## Accessibility

- The Files pane is labeled `Files pane` and exposes active/inactive state through the same pane semantics as other canvas panes.
- The internal tab strip uses `tablist`, `tab`, `aria-selected`, and roving keyboard focus.
- Close buttons retain file-specific accessible labels.
- Focus activation is not color-only: the active pane and active tab expose semantic selected/current state.
- Existing editor, status, save, conflict-dialog, and read-only announcements remain unchanged.

## Test strategy

Implementation proceeds test-first. Coverage must prove:

1. First-file open inserts one Files leaf to the right of the focused pane.
2. A worktree with no panes renders Files as its only leaf.
3. Later files reuse the same Files pane and become internal tabs.
4. Two worktrees maintain independent Files panes, active tabs, and buffers.
5. Closing the final tab removes the Files leaf and collapses the split.
6. The full Files pane gains and loses the focused class as canvas focus changes.
7. Focus-set projection retains the Files pane without adding it to session membership.
8. `Command-1...9`, `Command-W`, `Command-S`, middle-click, and `Esc` route correctly.
9. Dirty guards prevent tab, pane, worktree, project, and window closure until resolved.
10. Existing file loading, saving, conflict, binary, truncation, cursor, and selection tests remain green.
11. Existing terminal pane creation, movement, resize, span, maximize, focus, PTY input, and persistence tests remain green.

Live verification must open a terminal, open two real files, confirm both internal tabs, edit and save one file, switch focus to confirm the whole-frame glow transfers, close both tabs, and confirm the terminal layout restores.

## Out of scope

- Persisting unsaved file buffers across app restarts.
- Multiple Files panes for the same worktree.
- Dragging file tabs between worktrees.
- Reordering file tabs.
- Converting Files into a process-backed session.
- Redesigning the Files sidebar or CodeMirror editor.
