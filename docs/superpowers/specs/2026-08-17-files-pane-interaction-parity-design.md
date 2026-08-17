# Files Pane Interaction Parity Design

Date: 2026-08-17
Status: Approved for implementation

## Goal

Make the native Files pane respond to pane-level interactions like every other canvas pane while preserving its file-specific lifecycle.

## Existing behavior

The Files pane is already a first-class leaf in the shared pane layout tree. It uses the generic split dividers, maximize control, hide and restore lifecycle, dirty-file close guard, leaf removal, and split collapse behavior.

Its header is the remaining interaction gap. Unlike terminal, Git, and browser pane headers, the Files header does not initiate pane repositioning when dragged and does not toggle maximize when double-clicked.

## Design

Update `mountFilesPane` in `native/desktop/psyche-build-tauri/web/main.js` to wire the same header interactions used by the other pane types:

- On header `pointerdown`, ignore events originating from buttons and delegate to `startPaneReposition(filesPane, event)`.
- On header `dblclick`, ignore events originating from buttons, prevent the default action, and delegate to `togglePaneMaximize(filesPane)`.

This is a surgical parity patch. It does not introduce a Files-specific movement or resize implementation and does not refactor stable pane controls.

## Interaction contract

- Dragging the Files header repositions or swaps the Files pane through the shared pane-tree movement path.
- Double-clicking the Files header maximizes or restores the pane.
- Dragging or keyboard-operating an adjacent divider resizes the split through the existing generic divider path.
- The hide control removes the Files leaf without closing its file tabs; selecting a file restores the pane.
- The close control applies existing dirty-file guards, closes every tab in that Files pane, removes its leaf, and collapses the vacated split.
- Header buttons never start a reposition or trigger the header double-click behavior.

## State and error handling

No state model changes are required. Files pane identity, open file buffers, active tab state, hidden state, pane layouts, and persisted layout data retain their existing ownership.

Dirty-file cancellation continues to abort whole-pane close without removing tabs or changing the layout. Repositioning, maximize, resizing, hide, and restore continue to use their current shared failure and minimum-size handling.

## Test strategy

Extend the native Files pane tests to verify:

1. Header pointer-down delegates to `startPaneReposition` for non-button targets.
2. Header double-click delegates to `togglePaneMaximize` and prevents the default action for non-button targets.
3. Button-originated header events do not trigger repositioning or double-click maximize.
4. Files continues to use generic divider resizing.
5. Hide and restore preserve file tabs.
6. Whole-pane close removes all scoped tabs and collapses the pane-tree split after dirty guards pass.

Run the focused native Files pane tests and the pane layout tests covering movement, split resizing, leaf removal, and collapse.

## Out of scope

- Changing whole-pane close to close only the active file tab.
- Changing file tab close behavior.
- Refactoring all pane headers behind a new controller or helper.
- Changing pane layout persistence, minimum dimensions, visuals, or keyboard shortcuts.
