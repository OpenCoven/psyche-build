# Browser Dice Button Design

## Goal

Add a dice icon button to the browser pane toolbar that opens a new embedded
browser tab at this exact URL:

`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv`

## User Interface

- Place the button immediately before the existing external-open button in the
  browser toolbar.
- Reuse the existing `icon-btn ghost-btn` styling and toolbar dimensions.
- Render the dice as an inline SVG so it matches the existing navigation icons.
- Provide a tooltip and accessible label: `Open surprise in new tab`.
- Keep the button enabled when the current tab is blank because the action
  creates a separate tab.

## Implementation

Define the destination as a fixed constant near the browser-tab helpers in
`native/macos/psyche-build-tauri/web/main.js`.

Add an `openDiceBrowserTab()` helper that:

1. Creates and activates a fresh embedded browser tab through the existing
   browser-tab flow.
2. Stops if tab creation fails, preserving the existing tab-limit status.
3. Navigates the newly created tab, identified by its tab ID, to the fixed URL.

Attach the toolbar button's click handler to this helper. No settings,
workspace persistence, native command, or schema changes are required.

## Failure Handling

Reuse the existing browser-tab limit messaging and `navigateBrowser()` error
reporting. The new helper must not redirect the current tab when creation of a
new tab fails.

## Tests

Add a focused Vitest source-contract test covering:

- The dice button appears immediately before `open-external`.
- The button exposes the expected tooltip and accessible label.
- The helper contains the exact destination URL.
- The helper creates a new embedded tab before navigating that tab by ID.

