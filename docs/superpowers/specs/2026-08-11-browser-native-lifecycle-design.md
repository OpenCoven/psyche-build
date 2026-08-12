# Native Browser Lifecycle Design

## Goal

Make embedded browser views behave like ordinary application panes:

- Interactive HTML overlays must appear above browser content.
- Closing a browser tab must destroy its native webview.
- Closing a Web pane must destroy its native webviews while preserving saved
  tab URLs, titles, and history for later reopening.

## Background

The embedded browser is a Tauri child webview. It is a native view layered
above the application's main HTML webview, so CSS `z-index` cannot place agent
pickers, dialogs, menus, or popovers above it.

The current hide operation only moves browser webviews offscreen and shrinks
them. Closing tabs and panes does not destroy those native views.

## Architecture

### Browser occlusion controller

Add a browser lifecycle controller in
`native/macos/psyche-build-tauri/web/main.js`. It owns a set of named occlusion
reasons.

- Adding the first reason hides every native browser webview.
- Adding an existing reason is idempotent.
- Removing a reason leaves browser views hidden while another reason remains.
- Removing the final reason calls `syncBrowserBounds()` to restore only the
  currently visible active tab.
- `syncBrowserBounds()` checks the controller and keeps every browser webview
  hidden while any reason remains active. Resize, focus, and layout events
  therefore cannot resurface a browser over an open overlay.

Each interactive surface registers its own stable reason when opened and
removes it on every close path:

- agent picker
- keyboard help
- command palette
- new-pane menu
- scope menu
- session context menu
- pane footer menus and usage popovers
- dirty-file dialog

Passive toasts, loading indicators, and pane-drag indicators are excluded
because they do not require readable or interactive content over the browser.

### Native browser destruction

Add Tauri commands in
`native/macos/psyche-build-tauri/src-tauri/src/lib.rs`:

- `browser_destroy` closes one browser webview by label.
- `browser_destroy_many` closes each browser webview identified by a supplied
  list of labels.

A missing webview is treated as already destroyed. Any other native error is
returned to the frontend.

### Dormant tabs

The existing browser tab model remains the source of persisted URLs, titles,
history, and active-tab selection. A tab whose native webview has been
destroyed is marked dormant by setting `created` to `false`.

Activating a dormant tab with a saved non-blank URL lazily recreates its native
webview through the existing navigation path. Restoration preserves the
existing history and history index instead of recording the restored URL as a
new visit. Blank dormant tabs remain blank and do not create a native webview.

## User Flows

### Opening and closing overlays

1. An interactive overlay adds its named occlusion reason.
2. The controller hides all native browser webviews.
3. The HTML overlay opens normally.
4. Closing the overlay removes its reason.
5. If no other overlay remains open, the controller restores the visible
   active browser tab at its current bounds.

Overlapping surfaces are safe: closing one cannot restore the browser while
another still owns an occlusion reason.

### Closing a browser tab

1. Resolve the tab's native browser label.
2. Destroy its native webview.
3. If destruction succeeds or the view is already absent, remove the tab from
   the saved browser model.
4. Activate the next tab using the existing selection behavior.

If native destruction fails, retain the tab and report the failure through the
existing status UI.

### Closing a Web pane

1. Collect native labels for every tab in the pane's project/worktree browser
   model.
2. Destroy those native webviews.
3. If destruction succeeds, mark all retained tabs dormant.
4. Close the pane through the existing pane lifecycle.

Reopening the Web pane preserves its tab strip, saved URLs, titles, and
history. The active tab is recreated lazily when the pane becomes visible.

If destruction fails, keep the pane open and report the failure rather than
presenting a successful close.

## Error Handling

- Native destroy commands propagate close failures to JavaScript.
- Frontend destroy callers report failures through the existing status UI.
- Tab and pane state changes occur only after native destruction succeeds.
- Browser occlusion failures are reported through the status UI; the overlay
  still opens so keyboard and pointer flows do not deadlock.
- Restoration navigation uses the existing browser navigation error path.

## Testing

Add focused source-contract and behavior tests for:

- registration of the native destroy commands
- single and batch destroy semantics
- tab removal only after successful destruction
- pane close preserving saved tab state while marking tabs dormant
- lazy dormant-tab recreation without duplicate history
- idempotent and overlapping occlusion reasons
- the `syncBrowserBounds()` occlusion guard
- wiring for every listed interactive overlay

Run the existing browser pane, physical pane, workspace panel, agent picker,
dirty-file dialog, pane footer, desktop tab, and browser shortcut tests as
regression coverage.
