# Project Browser URL Routing Design

## Goal

Make URL clicks in CLI and agent terminal panes open reliably in the owning
project and worktree's dedicated browser pane without emitting browser errors
into the terminal.

## User Experience

- Left-clicking an HTTP or HTTPS URL in a shell, Coven Code, Coven attach, or
  other terminal pane opens that URL in the browser pane associated with the
  source pane's project and worktree.
- The browser pane reuses its active tab. If the project/worktree has no
  browser pane or active tab, the existing browser lifecycle creates them.
- The browser pane becomes the focused pane after navigation starts.
- Right-click and context-menu external-open behavior remains unchanged.
- Navigation failures appear in desktop status/browser UI and never write
  `[browser_navigate]` output into a CLI or agent PTY.

## Architecture

Terminal link registration captures the owning thread instead of registering a
context-free callback. Link activation passes the thread's stable
`projectId`, `worktreePath`, and thread identity into a project-browser routing
helper.

The routing helper:

1. validates and normalizes the URL before creating UI;
2. verifies that the source thread is still live and belongs to the expected
   project/worktree;
3. focuses the source thread without restoring terminal keyboard focus, which
   activates its exact project and selected worktree;
4. finds or creates that project/worktree's dedicated `web` pane;
5. reuses the browser model's active tab, creating one only when none exists;
6. navigates only while the project, worktree, pane, and tab identities remain
   current.

`navigateBrowser` will accept explicit project/worktree context internally.
Existing browser toolbar and URL-input callers may continue using an
active-context wrapper, while terminal links use the explicit path.

## Error Handling

Link activation owns its asynchronous promise and catches failures. Invalid
URLs are rejected before browser pane creation. Stale or closing source panes,
browser panes, and tabs return a controlled false result.

Native browser navigation failures restore the previous tab snapshot and
report a bounded desktop status error. They do not call `writeToActive`, so a
browser failure cannot appear as CLI or agent output or interfere with agent
parsing.

The route must not silently fall back to the system browser when the project
browser is unavailable. External opening remains an explicit context-menu or
browser-toolbar action.

## Concurrency

Every asynchronous boundary revalidates the source thread, project,
worktree, browser pane, and active tab. A project switch, worktree switch,
pane close, or tab close during navigation cancels the stale route rather than
navigating another project's browser.

Repeated clicks serialize through the existing per-tab navigation tail.
Active-tab reuse does not create duplicate tabs.

## Testing

Focused tests will cover:

- shell and agent URL clicks route to their owning project/worktree;
- a click from a visible non-active project activates the correct scope;
- an existing dedicated browser pane and active tab are reused;
- a missing browser pane or tab is created exactly once;
- invalid URLs create no browser pane;
- stale/closing source panes, browser panes, and tabs cancel safely;
- native navigation failure restores tab state and reports desktop status;
- no navigation failure writes into a terminal or rejects without a handler;
- right-click external-open behavior remains unchanged;
- checked-in runtime bundle behavior remains synchronized with source.

## Completion

The change is complete when terminal and agent link clicks always target the
source project's dedicated browser pane, focused regression tests and
non-generating type checks pass, generated browser runtime artifacts are
synchronized in an isolated worktree, and the pull request has green CI with
no unresolved review threads.
