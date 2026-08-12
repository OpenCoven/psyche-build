# Dia-Inspired Native Shell Design

**Date:** 2026-08-12
**Status:** Approved

## Goal

Replace the current macOS Psyche title bar and sidebar header with a
Dia-inspired application shell:

- Psyche identity occupies the full-height sidebar cap;
- the main workspace cuts inward with a rounded top-left corner;
- the sidebar toggle moves to the workspace title-bar boundary;
- browser-style and status controls leave the title bar;
- sidebar search moves into a `?` mode in the bottom composer; and
- the bottom edge remains flat.

## Product Decisions

1. The existing Tauri window, native traffic lights, and drag behavior remain.
2. The left title-bar zone shows the Psyche brand logo and the label `Psyche`.
3. The left title-bar zone uses exactly the same background surface as the
   sidebar below it.
4. The workspace title bar contains only the sidebar toggle at its left
   boundary. Its remaining area is an empty drag region.
5. Existing daemon status, shell status, help, and browser-like controls do not
   remain in the title bar.
6. The workspace owns a rounded, concave top-left corner that visually cuts
   into the sidebar. The exposed corner behind it uses the sidebar background,
   avoiding a mismatched patch.
7. The workspace and sidebar bottoms are flat. No bottom-left or bottom-right
   corner radius is introduced.
8. The sidebar keeps its Sessions and Files tabs, session filter chips, grouped
   session tree, file tree, New Session action, settings, and resizing.
9. The sidebar search field and sidebar-local collapse button are removed.
10. A leading `?` in the bottom composer opens session-search mode with results
    in a popover above the composer.

## Scope

This design owns:

- the native web shell markup and title-bar structure;
- title-bar, sidebar, workspace, and corner geometry;
- relocation of the sidebar collapse toggle;
- removal of title-bar controls that no longer belong there;
- removal of sidebar search presentation;
- extraction of reusable session matching;
- composer `?` search mode and results popover;
- keyboard and pointer interaction for session results;
- accessibility labels, focus management, and empty states; and
- focused native source-contract and behavioral tests.

It does not:

- change Tauri window decorations or native traffic-light placement;
- add browser navigation to the title bar;
- change sidebar tabs, filters, grouping, resizing, or persistence;
- redesign terminal panes, file views, Git tools, or the dock;
- change ordinary composer commands or prompt submission;
- add global file/content search;
- introduce a new search index or backend API; or
- change session lifecycle or PTY behavior.

## Visual Layout

### Window shell

The shell is divided into two aligned horizontal zones:

```text
┌─────────────────────────┬──────────────────────────────────────┐
│ traffic lights  Psyche  │ [sidebar toggle]     empty drag bar │
├─────────────────────────┤╭─────────────────────────────────────┤
│ Sessions / Files        ││                                     │
│ filters                 ││          workspace content          │
│ session tree            ││                                     │
│                         ││                                     │
│ New Session             ││                                     │
└─────────────────────────┴┴─────────────────────────────────────┘
```

The left cap and sidebar form one continuous surface. The workspace title bar
and workspace content form a second continuous surface. The workspace's
top-left radius creates the Dia-style inward cut at their boundary.

Only the top-left workspace corner is rounded. The workspace bottom aligns
flush with the window and remains square.

### Sidebar

The sidebar starts at the top of the window rather than below a full-width
title bar. Its identity cap contains:

- the packaged Psyche brand mark; and
- `Psyche` with title-bar-appropriate weight and contrast.

Below the identity cap, the existing Sessions/Files segmented control, filter
chips, and sidebar content remain. The search row disappears. New Session
remains available without sharing a row with search or collapse controls.

### Workspace title bar

The main title bar begins at the sidebar boundary. Its first control is the
sidebar toggle, aligned just inside the concave workspace edge. The rest of the
bar is empty and draggable.

No daemon pill, shell status pill, help button, browser address field, browser
navigation button, or right-side icon occupies this bar.

## Composer Search Mode

### Entry and exit

Typing `?` as the first character in the bottom composer enters session-search
mode. The `?` acts as a mode prefix and is not submitted to a pane.

Search mode exits when:

- the leading `?` is deleted;
- Escape is pressed;
- a result is selected; or
- the composer is cleared.

Exiting returns the composer to its normal command and prompt behavior.

### Matching

Search mode reuses the current sidebar search semantics for:

- project names and roots;
- worktree branches and paths;
- local agent and shell names;
- Coven session labels and metadata; and
- stable session identifiers already included by current matching.

The matching logic becomes a reusable helper rather than remaining coupled to
the removed sidebar input.

The sidebar tree does not filter or rerender in composer search mode.

### Results popover

Matches appear in a composer-owned popover directly above the bottom input.
Each result identifies enough context to distinguish similar sessions, such as
session name, project, and branch.

Interaction:

- Up and Down move the active result;
- Enter focuses or attaches the active result through existing session paths;
- Escape closes search mode;
- clicking a result selects it; and
- an empty query shows currently visible sessions in existing sidebar order.

If there are no matches, the popover shows a clear `No matching sessions`
state and Enter performs no action.

Stale results are revalidated before selection. A session that disappeared
does not produce a success-shaped response or send composer text.

## Architecture

### Shell structure

Reshape the existing markup into:

```text
app
├── sidebar-titlebar
│   └── brand identity
├── workspace-titlebar
│   └── sidebar toggle + drag region
├── workbench
│   ├── sidebar
│   ├── workspace
│   └── dock
└── footer stack / composer
```

The title-bar grid and workbench use the same `--sidebar-w` value so the
identity cap, sidebar, toggle, and concave edge stay aligned while resizing.
Collapsed sidebar geometry continues to use the existing collapsed-width
contract.

### Surface and radius tokens

Use shared CSS variables for:

- sidebar/cap background;
- workspace/title-bar background;
- workspace top-left radius; and
- title-bar height.

The corner behind the workspace radius resolves to the sidebar surface, not a
third color. The workspace radius applies only to the top-left corner.

### Sidebar toggle

The existing sidebar collapse behavior and shortcut remain the source of
truth. Only the button's DOM location and styling change. Its pressed state,
accessible label, tooltip, and collapsed mini-rail behavior remain synchronized
through the existing update path.

### Search model

Extract session matching into a pure helper that accepts:

- the available session/sidebar model;
- a normalized query; and
- the current project/session context needed for labels.

Composer search owns the visible results and selection state. The sidebar
renderer continues to render its ordinary unfiltered model.

Composer search state contains only:

```text
{
  open,
  query,
  results,
  activeIndex
}
```

The popover delegates focus and attach actions to existing functions rather
than duplicating session lifecycle logic.

## Accessibility

- Both title-bar zones remain valid Tauri drag regions except interactive
  controls.
- The brand mark is decorative when the adjacent `Psyche` text supplies the
  accessible name.
- The sidebar toggle retains its current dynamic collapse/expand label.
- The search popover uses an accessible listbox pattern with one active option.
- The composer exposes search-mode state and result count without turning
  ordinary typing into a live-region flood.
- Keyboard navigation does not leak Up, Down, Enter, or Escape into the active
  PTY while search mode is open.
- Focus returns to the composer after selection or dismissal.

## Error Handling

- Missing brand artwork falls back to the existing app mark treatment rather
  than showing a broken image.
- A stale search result is ignored with visible neutral feedback and no pane
  input.
- A failed existing focus or attach action surfaces through its current status
  path.
- Search-mode errors do not submit the `?` query as terminal input.
- Missing title-bar elements fail through existing boot diagnostics rather
  than silently disabling unrelated workspace behavior.

## Testing

Extend focused native web tests to cover:

- the new two-zone title-bar markup;
- brand identity in the sidebar cap;
- removal of daemon, shell-status, help, and browser controls from the title
  bar;
- the sidebar toggle's new location and unchanged behavior;
- removal of sidebar search markup and sidebar-local collapse control;
- retained Sessions/Files tabs, filters, New Session, and sidebar tree;
- shared sidebar/corner background tokens;
- top-left-only workspace radius and flat bottom corners;
- alignment to `--sidebar-w` in open and collapsed states;
- composer `?` mode entry and exit;
- query normalization and matching parity with the former sidebar search;
- results popover rendering, active option, keyboard movement, click selection,
  no-results state, and stale-result guard;
- search keys not reaching the PTY;
- normal composer commands and prompt submission remaining unchanged; and
- source/bundle contracts required by the native Tauri packaging flow.

## Acceptance Criteria

1. The sidebar visually begins at the top of the window with the Psyche logo
   and name.
2. The left cap and sidebar use the same background without a mismatched
   top-left patch.
3. The workspace curves inward at only its top-left corner.
4. The full bottom edge is flat.
5. The title bar's main region contains only the sidebar toggle and empty drag
   space.
6. The sidebar no longer contains search or its collapse button.
7. Sessions/Files tabs, filters, New Session, and sidebar content remain.
8. Typing `?` first in the composer opens a results popover above it.
9. Search results can be navigated and selected without sending query text to
   the PTY.
10. Normal composer behavior is unchanged outside search mode.
