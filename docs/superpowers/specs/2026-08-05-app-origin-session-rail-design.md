# App-Origin Session Rail Design

**Date:** 2026-08-05
**Status:** Approved

## Goal

Make the macOS session rail predictable by showing only threads created inside Psyche. Remove daemon-discovered Coven rows and their implicit Attach behavior from the visible application.

## Product behavior

- Render the rail exclusively from Psyche's persisted local `state.threads`.
- Continue showing every local thread created by the app, including an existing thread whose command attaches to a Coven session.
- Do not render a separate Coven subsection, remote-only projects, daemon discovery states, or remote session metadata.
- Do not offer Attach by clicking a remote row or through a remote-session context menu.
- Preserve normal local-thread navigation, attention state, rename, hide, stop, filtering, worktree grouping, and terminal fallback behavior.
- When no local threads match, use the existing local empty state without mentioning Coven discovery.

## Architecture

The macOS rail becomes a single-source projection of `state.threads`. Its render path no longer joins `covenDiscovery.sessionsByProject` into project or worktree groups.

The UI boot and lifecycle paths stop scheduling Coven discovery polls because no visible consumer remains. The remote row renderer, Attach handler, and remote context actions are removed from the web UI. This avoids hidden network work and prevents an unused action path from drifting back into the interface.

The native `coven_sessions` command, bounded local transport, shared session model helpers, and daemon protocol remain available. They are outside this focused UI simplification and may support future explicit workflows or other clients.

## Data flow

1. Psyche loads persisted projects and local threads.
2. The rail groups local threads by project and owning worktree.
3. Filtering and attention counts operate only on those local threads.
4. Selecting a row opens its existing local terminal thread.

No daemon-discovered session is eligible to create a rail group or row.

## Error handling

Removing background discovery also removes Coven loading, unavailable, incompatible, and error states from the rail. Existing local-thread errors and terminal fallback behavior remain unchanged.

## Verification

Implementation will proceed test-first.

- Add a failing rail regression proving daemon-only sessions do not render or create remote-only projects.
- Add a failing interaction regression proving no Attach action can be triggered from the rail.
- Preserve coverage proving app-created local attachment threads still render as ordinary local rows.
- Update lifecycle/source-contract tests to prove the UI no longer starts Coven polling or exposes the remote Attach path.
- Rebuild generated web bundles and verify source/bundle parity.
- Run focused rail/lifecycle tests, the full TypeScript suite, typecheck, Rust checks, and the macOS app build and launch smoke.

## Non-goals

- Deleting or redesigning the native Coven adapter.
- Changing daemon workspace snapshots or cross-client protocol fixtures.
- Migrating or deleting existing local attachment threads.
- Altering CLI behavior.
