# Siderail Project Closing and Empty-Project Visibility

**Date:** 2026-08-20
**Status:** Approved

## Goal

Let users close a project from its Sessions siderail context menu and keep the
rail focused by always omitting projects that own no sessions.

## Product behavior

- Add a danger-styled **Close project** action after **Customize appearance**
  in each rendered project context menu.
- Expose the same project actions from pointer context menus, the Context Menu
  key, and Shift+F10.
- Route **Close project** through the existing `removeProject(project.id)`
  lifecycle.
- Omit a project from the Sessions siderail only when it owns no underlying
  session.
- Treat a project as populated when it owns either:
  - a non-dormant local thread, including a hidden thread; or
  - an assigned Coven session.
- Determine project eligibility before applying the active search query or
  sidebar filter. A populated project remains rendered when none of its rows
  match the current query or filter.
- Keep omitted projects in workspace state. This feature does not close,
  delete, prune, or mutate a project merely because the rail does not render
  it.
- Do not add a setting or toggle for empty projects; they are always hidden.

An empty project cannot expose a siderail context menu because it is not
rendered. Existing project-closing surfaces, including the workspace shortcut,
remain available when such a project is active.

## Architecture

Keep empty-project eligibility at the native desktop Sessions siderail renderer
boundary.

For each workspace project, the renderer first gathers:

1. all local threads that belong to the project and are not dormant, without
   excluding hidden threads; and
2. the project's assigned Coven sessions.

If both collections are empty, the renderer skips that project's sidebar model.
Otherwise, it builds the existing sidebar model from the currently visible
local rows and assigned Coven rows. Search and filter behavior remains owned by
`buildSidebarProjectModel`; eligibility remains independent of those
presentation filters.

This preserves the complete workspace model for active-project state, Files,
pane lifecycle, browser state, persistence, and other non-siderail consumers.
It also avoids adding workspace-membership policy to the shared sidebar model.

The project context-menu helper remains the single source for both pointer and
keyboard menus. It returns:

1. **Customize appearance**
2. **Close project**, marked dangerous and bound to `removeProject(project.id)`

## Data flow

### Rendering

1. Read the complete project list from workspace state.
2. Resolve each project's non-dormant local threads and assigned Coven
   sessions.
3. Skip the project when both underlying collections are empty.
4. Build the sidebar model using visible, non-hidden local rows plus the
   assigned Coven rows, current query, current filter, and current selection.
5. Render the retained project header even when its filtered model contains no
   child rows.
6. Preserve the existing global empty-result message when no session row
   matches the current query or filter.

### Closing

1. Open the project context menu from pointer or keyboard input.
2. Select **Close project**.
3. Invoke `removeProject(project.id)`.
4. Reuse its dirty-file guard, thread shutdown, files-pane and tab cleanup,
   active-project fallback, browser synchronization, persistence, and status
   refresh.

## Error handling

- A canceled dirty-file guard leaves the project and its resources unchanged.
- A failed thread close prevents project removal through the existing
  `removeProject` result handling.
- Existing file, pane, browser, persistence, and status errors continue through
  their current surfaces; the context-menu action does not catch or suppress
  them.
- Omitting an empty project is presentation-only and cannot produce a
  success-shaped close result.
- Coven discovery and lifecycle status handling remains unchanged. A project
  becomes eligible when an assigned Coven session is present in the renderer's
  current discovery data.

## Accessibility and interaction

- The existing menu `role`, focus restoration, keyboard navigation, and danger
  styling apply to **Close project**.
- Keyboard-opened menus use the same action list as pointer-opened menus.
- If project removal is canceled or fails, the existing project remains
  available on the next render.
- No new icon-only control or pointer-only interaction is introduced.

## Verification

Renderer and model-adjacent tests cover:

- a project with no non-dormant local thread and no assigned Coven session is
  omitted;
- a project with a hidden non-dormant local thread remains rendered;
- a project with an assigned Coven session remains rendered;
- a populated project remains rendered when search yields zero matching rows;
- a populated project remains rendered when the active filter yields zero
  matching rows;
- pointer and keyboard project context menus include **Customize appearance**
  followed by **Close project**;
- **Close project** is marked dangerous and calls `removeProject` with the
  owning project ID; and
- existing project-removal, dirty-file, thread-shutdown, pane-cleanup,
  persistence, focus-restoration, and active-project fallback tests remain
  authoritative.

## Non-goals

- Adding a **Show empty projects** preference.
- Removing projects from workspace state merely because they are empty.
- Changing shared workspace restoration or persistence.
- Changing session search, filter, hidden-session, or dormant-session semantics.
- Adding a new close confirmation beyond the existing dirty-file and lifecycle
  guards.
- Changing CLI or iOS project lists.
