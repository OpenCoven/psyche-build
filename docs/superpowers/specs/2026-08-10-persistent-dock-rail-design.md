# Persistent Dock Rail Design

## Goal

Remove the expanded Files/Git/Web tab strip from the macOS workspace tools
dock while preserving access to every panel through the compact icon-only
right rail.

## Interaction

The right rail remains visible whether the tools dock is open or collapsed.
Its existing panel buttons retain their current behavior:

- clicking Files, Git, or Web opens that panel;
- clicking a different icon switches the open panel;
- clicking the active icon collapses the tools dock.

The approved Git panel continues to contain repository status and diffs. This
change does not restore a separate Diffs panel or alter panel contents.

## Layout

Remove the `.dock-tabs` element and its Files/Git/Web text buttons from
`index.html`. The dock becomes a single-row grid so the active panel uses the
space previously reserved by `--dock-tabs-h`.

The existing `#rail-right` navigation becomes persistent rather than
collapsed-only. The workbench always reserves `var(--mini-rail-w)` for it,
including when the dock is open and when the sessions sidebar is collapsed.
The rail remains at the right edge even when the dock content is positioned on
another side.

The removed top-row collapse button is not replaced. Clicking the active
right-rail icon already collapses the dock, and the existing keyboard shortcut
continues to work.

## State and accessibility

Panel selection continues to use the existing `data-panel-btn` event path and
`aria-pressed` synchronization. The persistent rail keeps
`role="toolbar"`, vertical orientation, icon titles, and accessible labels.

`syncDockChrome` continues to set `data-dock` for layout state but no longer
hides the right rail when the dock opens.

## Tests

Update the Tauri workspace panel contracts to require:

- no `.dock-tabs` markup or `.dock-tab` buttons;
- Files, Git, and Web panel buttons remain in `#rail-right`;
- the right rail is not emitted with `hidden`;
- `syncDockChrome` does not assign `dockMiniEl.hidden`;
- the workbench always reserves the mini-rail column;
- `.browser-pane` uses one content row and panels occupy that row.

Run the existing workspace panel, editor integration, and desktop tab tests.
Rebuild the committed web bundles and require the bundle drift test to pass.

## Non-goals

- Removing Files, Git, diffs, or Web functionality.
- Changing which panel opens by default.
- Changing browser tab, file tab, or terminal tab behavior.
- Redesigning the icons or the rail width.
