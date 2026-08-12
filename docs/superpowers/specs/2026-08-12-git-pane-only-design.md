# Git Pane-Only Workspace Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning

## Goal

Remove the macOS workspace's permanent right Git panel and make Git an on-demand canvas pane. The existing **Changes** and **Commit** sections remain available inside that pane, while the canvas becomes the only detail surface beside the sessions sidebar.

## Product Decisions

- Git opens only on demand. It does not occupy canvas space when a project opens.
- New Pane → Git, `/git`, and `⌘G` all open or focus Git.
- A project/worktree may own at most one Git pane. Repeating an open action focuses the existing pane instead of creating a duplicate.
- Closing Git removes it from the canvas. Reopening it creates a pane through the normal placement rules.
- The right dock, its collapsed rail, its splitter, and its dock-specific commands and shortcuts are removed completely.

## Architecture

### Pane-only Git surface

The current implementation already moves one `#git-surface` element between the right dock and a temporary Git tool pane. The new implementation promotes that tool pane to the sole visible Git home.

`#git-surface` remains a single DOM instance so its selected tab, rendered diff, and scroll state cannot diverge. When no Git pane is open, a neutral hidden staging host retains the surface outside the canvas. This host has no panel chrome, width, splitter, layout state, or user-visible right-side reservation.

The Git pane participates in the existing pane tree and reuses its placement, focus, drag, span, maximize, resize, close, and active-project behavior. Git is a tool pane, not a PTY-backed agent or shell.

### Project and worktree ownership

Git-pane lookup is scoped to the active project and selected worktree rather than searching globally for any `kind: "git"` thread. Each open action:

1. Resolves the active project and workspace root.
2. Focuses the non-closing Git pane already owned by that project/worktree, if present.
3. Otherwise requests a normal pane-tree placement and creates a Git tool thread for that owner.

Only the active project's Git pane mounts the shared Git surface. Switching projects rerenders the surface against the newly active workspace root and mounts it into that project's pane when present. A project without a Git pane remains canvas-only until the user opens one.

### Shell layout removal

The workspace shell no longer has terminal-versus-split-dock modes. The detail area always gives its full bounds to the pane canvas or file view. Remove:

- the `.git-dock` section and its panel header;
- the dock splitter;
- the collapsed `#rail-right` panel rail;
- pop-out, return-to-dock, and dock-collapse controls;
- `data-dock`, `data-panel`, panel switching, dock resize, and dock visibility state;
- `/split`, `⌘\`, and `⌘⌥B` dock behavior;
- dock-only CSS, labels, help text, and persistence fields.

Legacy saved project layouts that contain `split`, `panel: "git"`, `splitFrac`, or the historical `side` field normalize to the canvas-only layout during restore. Migration never auto-opens Git.

## Git Pane UI

The ordinary pane header remains responsible for the Git title and standard pane controls: reposition, span, maximize, and close.

Inside `#git-surface`, a compact Git toolbar preserves the controls currently owned by the dock header:

- active branch or detached-head label;
- Open repository on GitHub;
- Refresh Git state.

The existing segmented **Changes** and **Commit** tabs follow the toolbar. Their contents and data contracts remain unchanged:

- **Changes** shows the changed-file count, file list, diff summary, layout selection, truncation state, and diff rows.
- **Commit** shows branch tracking state, changed paths, recent commits, and remote commit links.

Closing and reopening Git must not create duplicate IDs, duplicate listeners, or parallel refresh ownership.

## Entry Points and Keyboard Behavior

- Add **Git** to the New Pane menu alongside Shell, Agent, and Browser.
- Add `/git` to the command palette with the description “Open or focus the Git pane.”
- `⌘G` invokes the same open-or-focus function.
- Remove `/split` and the old `⌘\` and `⌘⌥B` dock shortcuts from behavior, help text, and tests.

All entry points share one function so single-instance, ownership, capacity, focus, and error behavior cannot drift.

## Errors and Edge Cases

- With no active project, opening Git reports `No project open` and changes nothing.
- If the pane tree has no capacity, opening Git reports `Not enough space for another pane` and changes nothing.
- An in-progress or closing Git pane is not duplicated. Repeated commands either focus the stable existing pane or wait until a subsequent invocation can create one.
- Closing a Git pane stages the shared surface before removing the pane DOM, preventing accidental destruction of the Git controls.
- Project switching must never render one project's branch, changes, or history under another project's ownership.
- Git refresh failures continue to render through the existing panel error states and do not close the pane.

## Accessibility

- New Pane → Git is a normal `menuitem` and receives the same keyboard navigation as the existing launchers.
- `⌘G` prevents the browser default only when Psyche handles the command.
- The Git pane keeps the existing pane title and close labels, updated to say “Close Git pane” rather than “Return Git to the dock.”
- Changes and Commit retain tablist, tab, `aria-selected`, and single-visible-panel semantics.
- Toolbar controls retain descriptive labels for refresh and opening the repository remotely.

## Verification

Contract tests must prove:

- no right dock, splitter, collapsed panel rail, pop-out/back controls, or dock-only layout state remains;
- the single Git surface lives in a neutral staging host when closed and mounts into the active Git pane when opened;
- New Pane → Git, `/git`, and `⌘G` call one open-or-focus path;
- Git-pane deduplication is scoped to project/worktree ownership;
- closing, reopening, project switching, and capacity failure preserve the pane tree and Git surface;
- legacy split-dock persistence normalizes to canvas-only without auto-opening Git;
- Changes/Commit switching, counts, diff rendering, refresh, branch metadata, remote links, and history remain functional.

Implementation verification will run the focused workspace-panel and physical-pane suites, the complete native UI test set, typecheck, native web build, root build, formatting checks, and `git diff --check`. Manual acceptance must confirm the canvas consumes the former right-panel width and Git tiles, focuses, resizes, spans, maximizes, closes, and reopens like the other pane kinds.

## Out of Scope

- Git mutations such as stage, commit, push, merge, reset, or clean.
- Multiple Git panes for one project/worktree.
- Persisting or auto-opening Git panes across application launches.
- Redesigning diff or commit content beyond relocating the existing controls into the pane.
- Changing the left Sessions/Files sidebar.
