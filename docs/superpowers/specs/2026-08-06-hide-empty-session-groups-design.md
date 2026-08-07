# Hide Empty Session Groups Design

**Date:** 2026-08-06
**Status:** Approved

## Goal

Keep the macOS Psyche session rail focused on active app-origin sessions by
hiding every worktree or branch group that contains no visible session.

## Product behavior

- Show a worktree or branch group only when it contains at least one visible,
  non-hidden local Psyche session.
- Hide projects that have no populated worktree or branch groups.
- Apply session search before deciding whether a group is populated. A branch
  name match alone must not reveal an empty group.
- Keep unresolved sessions visible in their explicit fallback group because
  that group contains sessions.
- Do not delete, prune, or otherwise modify Git worktrees or branches.

## Architecture

Git worktree discovery and the shared session model continue returning the
complete workspace structure. The macOS rail renderer is the only boundary
that removes empty groups from presentation.

This preserves the full worktree list for selected-worktree state, pane
creation, file browsing, and other workspace features while keeping the rail
session-driven. It also prevents rail-specific presentation rules from
changing shared model or native discovery behavior.

## Data flow

1. Discover and retain all project worktrees and their branch metadata.
2. Filter visible local sessions by project, hidden state, and search query.
3. Group those sessions by their owning worktree.
4. Render only groups with one or more grouped sessions.
5. Omit the project header when no populated group remains.

## Error handling

Worktree discovery failures retain the existing main-checkout fallback. The
fallback group remains hidden until it owns a visible session. No new error
state is required because filtering is presentation-only.

## Verification

- Empty selected worktrees do not render.
- Empty groups do not render when only their branch name matches search.
- Populated groups retain session order, ownership, controls, and attention
  counts.
- Hiding a group's last session removes the group.
- Unresolved sessions remain visible in their fallback group.
- A rail with no visible sessions shows the existing empty-result message.

## Non-goals

- Deleting Git worktrees or branches.
- Changing native worktree discovery.
- Removing empty worktrees from file browsing, pane creation, or persisted
  workspace state.
- Changing CLI session or worktree behavior.
