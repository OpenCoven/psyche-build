# Desktop Project Header Appearance Design

## Goal

Make project identity visually prominent in the desktop session sidebar without
using a textual `CURRENT` badge. Each project receives a stable accent
automatically and can be customized with a curated accent and optional glyph.

This work is part of completing PR #114. The PR retains its approved native
scope: it provides the reusable iOS remote-action reducer, store, and sheet, but
does not wire action launches into PsycheApp.

## User Experience

### Project Header

Each project header becomes a full-width tinted band containing:

1. The existing disclosure control.
2. An optional decorative glyph.
3. The project name.
4. The existing session and attention counts.

The `CURRENT` element is removed. The active project is communicated through
the header treatment instead:

- Active projects use their resolved accent at higher opacity with a subtle
  accent border or glow.
- Inactive projects retain a quieter tint of their resolved accent.
- Hover and focus remain visibly distinct from both active and inactive states.
- The project name remains text, and the optional glyph is hidden from
  accessibility APIs.

The full-width treatment preserves the existing sticky header, collapse
behavior, tree semantics, project activation, and nested session layout.

### Customization Entry Point

The project header receives a `contextmenu` handler using the existing desktop
context-menu system. It adds a **Customize appearance** action. Selecting that
action closes the context menu and opens a compact appearance popover anchored
to the project header.

The same menu is available from the focused project tree item with the
Context Menu key or Shift+F10.

The popover contains:

- A curated grid of eight accent presets: `ruby`, `amber`, `lime`, `teal`,
  `cyan`, `blue`, `violet`, and `magenta`.
- A curated grid of eight glyph presets: `spark`, `diamond`, `command`,
  `branch`, `terminal`, `moon`, `bolt`, and `circle`.
- A **No glyph** choice.
- A **Reset to automatic** action.

Accent choices are fixed semantic IDs rather than arbitrary CSS values. Glyphs
are fixed application-owned presets rather than user-entered text. This keeps
contrast, sizing, storage, and rendering predictable.

The non-modal popover uses dialog semantics, supports pointer and keyboard
operation, traps neither focus nor the rest of the application, closes on
Escape or outside interaction, and returns focus to the project tree item
after a selection or dismissal.

## Appearance Model

Add a focused project-appearance model to the existing sessions bundle. The
pure model owns:

- The supported accent IDs and their CSS color tokens.
- The supported glyph IDs and their display values.
- Project-path key normalization.
- Validation of stored appearance values.
- Deterministic automatic accent selection.
- Resolution of stored overrides into a renderable appearance.

`main.js` remains responsible for local storage, DOM creation, context-menu and
popover interaction, and rerendering. `createProjectGroup()` consumes a
resolved appearance and exposes it as classes, data attributes, and CSS custom
properties rather than containing palette or hashing logic.

### Automatic Appearance

Before customization, a project receives a deterministic accent from its
project root:

1. Use the existing canonical project root when available.
2. Normalize separators to `/`.
3. Remove trailing separators except for a filesystem root.
4. Lowercase only a Windows drive letter; preserve the remainder because path
   case may be meaningful.
5. Hash the normalized key with a stable, platform-independent string hash.
6. Select one of the eight accent presets by hash modulo palette length.

Automatic appearance does not assign a glyph.

## Persistence

Store appearance overrides in desktop `localStorage` under the versioned key
`psyche.tauri.project-appearances.v1`. The value is an object keyed by
normalized project root:

```json
{
  "/Users/example/project": {
    "accent": "violet",
    "glyph": "spark"
  }
}
```

Both properties are optional:

- Missing `accent` means use the deterministic automatic accent.
- Missing `glyph` means render no glyph.
- Reset removes the entire project entry.

Appearance remains separate from `psyche.tauri.workspace.v1`. It is a personal
desktop preference, is not written to native shared workspace state, and is
not synchronized across machines. Removing a project does not delete its
entry, so adding the same path later restores its customization.

Loading malformed JSON or unsupported preset IDs falls back to automatic
appearance. A storage write failure leaves the in-memory appearance active for
the current session and reports an error through the existing desktop status
surface rather than preventing the sidebar from rendering.

## Styling

Project appearance uses dedicated `.session-project-head` rules layered over
the generic `.session-group-head` behavior. CSS variables hold the resolved
accent channels so the stylesheet can derive:

- Quiet inactive background tint.
- Stronger active background tint.
- Active border or glow.
- Glyph and project-name foreground color.
- Hover and focus-visible states with sufficient contrast.

The treatment must work across every existing application theme and both
vibrant and solid background modes. Reduced-motion settings require no special
animation because appearance changes are immediate and do not animate.

## Error Handling

- Invalid or unknown accent IDs are ignored and resolve to the automatic
  accent.
- Invalid or unknown glyph IDs are ignored and resolve to no glyph.
- Missing project roots use the project title as a deterministic fallback key
  for rendering but are not persisted until a root is available.
- A failed local-storage write is surfaced with `setStatus()` and does not
  revert the visible selection.
- The appearance popover cannot apply raw CSS, HTML, or user-provided glyph
  content.

## PR #114 Completion Scope

In addition to project appearance, completing PR #114 includes:

- Update the branch from current `main`.
- Disable input and PR-summary editing while `RemoteActionStore` is submitting.
- Change progress fixtures and assertions from `0.75` to `75.0` to match the
  documented 0–100 wire scale.
- Correct the PR description so it describes reusable sheet rendering support
  without claiming PsycheApp launch-flow wiring.
- Diagnose and fix the actual TypeScript/Rust CI failure after the branch
  update.
- Resolve review threads, obtain required approval, pass required checks, and
  merge the PR.

Wiring action launch controls or presenting `ActionSheetView` from PsycheApp is
explicitly outside this PR.

## Testing

### Pure Appearance Model

Add focused tests for:

- Path normalization on POSIX and Windows-shaped paths.
- Stable automatic accent selection.
- Automatic no-glyph behavior.
- Valid stored accent and glyph overrides.
- Accent-only and glyph-only overrides.
- Unknown preset fallback.
- Reset semantics.

### Desktop Sidebar Integration

Extend the existing Tauri sidebar tests to cover:

- No `session-current-badge` or `CURRENT` text is created.
- Project headers receive resolved appearance hooks.
- Active and inactive projects retain distinct styling hooks.
- A configured glyph is rendered as decorative content.
- No glyph element is rendered by default.
- The project context menu exposes **Customize appearance**.
- Selecting, clearing, and resetting appearance persists the expected value and
  rerenders the sidebar.
- Malformed storage does not prevent project rendering.
- Storage write failures use the status surface.

Existing tests must continue to cover activation, collapse, rename, worktree
and session rendering, focus, tree semantics, and keyboard behavior.

### Native Review Fixes

Update PsycheCore and PsycheApp tests to assert:

- Input and PR-summary controls are disabled during submission.
- Determinate progress fixtures use the 0–100 scale.

## Acceptance Criteria

- No textual `CURRENT` badge appears beside a project name.
- Every rooted project receives a stable automatic background accent.
- The active project is apparent without additional status text.
- Users can choose an accent and optional glyph from the project context menu.
- Users can remove a glyph or reset the complete appearance to automatic.
- Appearance persists locally by normalized project path and safely rejects
  malformed values.
- Existing sidebar interactions and accessibility semantics remain intact.
- PR #114 accurately describes its native scope, resolves all actionable review
  feedback, passes required checks, and is merged.
