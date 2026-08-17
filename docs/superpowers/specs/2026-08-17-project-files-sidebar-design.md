# Project Files Sidebar Navigation Design

Date: 2026-08-17
Status: Approved for implementation

## Goal

Make Files a project-scoped drill-in from the Sessions rail instead of a global peer tab, and replace the icon-only create control with a full-width New Session button.

## Approved behavior

- Remove the global Sessions | Files segmented switcher.
- Sessions is the default and only startup sidebar view.
- Replace the icon-only plus control with a full-width text button labeled `New Session`.
- New Session continues to open the existing creation menu with Shell, Agent, Browser, Git, Focus Set, and Open Project actions.
- Add a compact `Files` button to the right side of every project header.
- Keep project headers visible when they have zero visible sessions, including when a session filter hides every row in that project.
- Clicking a project's Files button activates that project and browses its currently selected worktree.
- The file browser replaces the session list rather than expanding inline.
- While Files is visible, hide New Session and the session filters.
- The Files subbar contains Back to Sessions, the selected worktree path, and Refresh.
- Back to Sessions restores the session rail and returns focus to the originating project's Files button when that project still exists.

## Sidebar structure

The Sessions rail has two transient views:

1. `sessions`: full-width New Session, session filters, and project/session tree.
2. `files`: Back to Sessions, scoped path, Refresh, and the existing file tree.

This is drill-in navigation, not a tab system. Remove the sidebar tab markup, tab button listeners, selected-tab styling, and persisted `sidebarTab` setting. The application always initializes the sidebar in `sessions`.

The existing Files tree and file-opening behavior remain reusable. Files continues to open the selected file in the worktree-scoped Files canvas pane.

## Project header action

Each rendered project group includes one accessible Files button after the session count. The control:

- is labeled for its project, such as `Browse files in Psyche Build`;
- stops pointer and click events from reaching project selection or disclosure handlers;
- remains available whether the project has sessions or not;
- records its project identifier for Back focus restoration;
- does not change the project's collapsed state.

Clicking Files awaits activation of that project. The project retains its existing selected worktree; the action does not reset it to the root checkout. The sidebar enters Files view only after activation succeeds and the project still exists.

## New Session control

The existing `rail-new-tab` behavior and menu remain the single creation path. Its markup changes from an icon-only square button to a full-width text button labeled `New Session`.

The button retains its menu semantics, expanded state, keyboard handling, tooltips, and shortcut information. Only its visible label and rail geometry change.

## State and navigation

Use transient sidebar navigation state:

- current view: `sessions` or `files`;
- originating project identifier for Back focus restoration;
- request generation or scope token for the current file-tree load.

Do not persist the current view. Existing saved `sidebarTab` values are ignored, and future settings writes omit that field.

Entering Files:

1. Resolve the clicked project.
2. Activate it without changing its selected worktree.
3. Record the originating project identifier.
4. Switch sidebar chrome to Files.
5. Load the active worktree's file tree.

Returning to Sessions:

1. Invalidate any in-flight file-tree render.
2. Restore Sessions chrome and render the project tree.
3. Focus the originating project's Files button when available.
4. Otherwise focus the session tree's normal roving-tabindex target.

## Project visibility under filters

Session filters continue to determine which branches and session rows are shown, but they no longer remove the project group itself. A project with no matching sessions renders its header, zero count, and Files action without empty branch rows.

The existing filter summary and reset behavior remain. A zero-match result may show project headers while reporting zero matching sessions.

## Async and error handling

Project activation failure leaves the rail in Sessions and uses the existing status/error path.

File listing retains the existing per-directory error rows. Each Files render captures the active project, selected worktree root, and request generation. After asynchronous directory reads, it applies rows only when:

- the sidebar is still in Files view;
- the generation is current;
- the active project matches;
- the selected worktree root matches.

Back, project changes, and a later refresh invalidate earlier requests so stale results cannot replace the current file tree.

## Accessibility

- The sidebar remains labeled `Sessions` in Sessions view and exposes project groups through the existing tree semantics.
- Every project Files button has a project-specific accessible name.
- Back to Sessions is a real button with a clear accessible label.
- New Session remains a menu trigger with `aria-haspopup`, `aria-expanded`, and `aria-controls`.
- Files buttons are not tree items and do not disrupt disclosure or roving keyboard navigation.
- Focus returns to a meaningful control after Back even when the originating project was removed.

## Test strategy

Implementation proceeds test-first. Coverage must prove:

1. The sidebar tablist and `data-sidebar-tab` controls are absent.
2. Settings no longer load, normalize, save, or restore `sidebarTab`.
3. New Session is full width, visibly labeled, and still opens the existing menu.
4. Every project group renders a project-specific Files button.
5. Files button events do not toggle disclosure or trigger the project header click path.
6. Projects with zero filtered sessions remain visible with their Files action.
7. Clicking Files activates the selected project and retains its selected worktree.
8. Files view hides New Session and session filters while showing Back, path, Refresh, and file tree.
9. Back restores Sessions and focuses the originating Files button when possible.
10. Missing originating projects fall back to normal session-tree focus.
11. Slow or failed project activation does not enter Files.
12. Stale file-tree requests cannot paint after Back, refresh, project change, or worktree change.
13. Existing file opening, refresh, error rows, session filtering, tree navigation, and new-pane menu tests remain green.

## Out of scope

- Inline file trees inside project groups.
- A separate Files button for each worktree row.
- Changing the New Session menu contents or default action.
- Persisting the Files drill-in across app restarts.
- Changing Files pane tab, editor, save, close, hide, resize, or persistence behavior.
