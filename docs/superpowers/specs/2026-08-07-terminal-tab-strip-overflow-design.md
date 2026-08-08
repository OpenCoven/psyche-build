# Terminal Tab Strip Vertical Overflow Design

## Problem

The native macOS terminal tab strip is horizontally scrollable, but it does not explicitly suppress vertical overflow. When the tab contents fill the fixed-height grid row, WebKit can expose an unintended vertical scrollbar in the tab strip.

## Design

Keep the existing tab-strip height and horizontal overflow behavior. Add `overflow-y: hidden` to `.tab-strip` so terminal tabs remain horizontally scrollable without becoming vertically scrollable. Do not change tab height, terminal geometry, browser-tab behavior, or scrollbar styling elsewhere.

## Verification

Add a focused assertion to the existing Tauri desktop tab test that requires `.tab-strip` to retain `overflow-x: auto` and explicitly set `overflow-y: hidden`. Run the focused Vitest file, then the repository typecheck and build.
