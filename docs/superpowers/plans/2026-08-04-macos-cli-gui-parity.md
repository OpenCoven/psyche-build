# Psyche Build macOS CLI-to-GUI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Psyche Build macOS app a complete graphical client for the CLI/TUI's human-facing project, worktree, pane, agent, ritual, inspection, review, and recovery workflows.

**Architecture:** One long-lived Psyche host remains authoritative for tmux, worktrees, configuration, policy, and lifecycle mutations. The CLI, MCP server, compatibility bridges, and Tauri app consume the same versioned workspace snapshots, commands, and events. The macOS rail renders `project -> worktree -> panes/sessions`; Tauri-local persistence stores presentation preferences only.

**Tech Stack:** TypeScript 5.9, Node.js 18, Ink/React, tmux, Git worktrees, authenticated WebSocket control protocol, Tauri 2/Rust, xterm.js, CodeMirror 6, Vitest.

---

## Current Status

**Updated:** 2026-08-05 after the control foundation and app-origin rail merges

- PR [#30](https://github.com/OpenCoven/psyche-build/pull/30) delivered the canonical project/worktree workspace rail and scoped workspace panels.
- PR [#32](https://github.com/OpenCoven/psyche-build/pull/32), finalized by the app-origin rail merge, set the product boundary: the macOS rail renders app-origin local threads only. It does not poll, advertise, or attach daemon-discovered Coven sessions; the bounded native adapter remains compatibility plumbing.
- PR [#33](https://github.com/OpenCoven/psyche-build/pull/33) added a fail-closed desktop-only release dispatch for signed and notarized macOS artifacts and Homebrew publication without TestFlight credentials.
- The merged control foundation provides the behavior-neutral protocol, canonical project identity, owner fencing, durable journal, lane leases, and scope validation. It is not yet imported by the daemon, bridge, MCP, TUI, or cockpit.
- The remaining critical path is no-replay prompt dispatch, live control-runtime wiring, ordered workspace events, revision-checked mutations, workflow approval surfaces, restart reconciliation, and packaged multi-project lifecycle proof.

**Next delivery sequence:**

1. Complete the pure no-replay prompt-dispatch module and full control-foundation validation.
2. Wire the control runtime, server, client, host process, ordered `workspace.changed` broadcast, and production legacy adapters.
3. Route lane creation and lifecycle mutations through revision-checked, journaled host commands.
4. Add review, verification, merge, PR, archive, and cleanup approval surfaces.
5. Prove restart recovery and the complete packaged multi-project lifecycle before promotion.

---

## Delivery Order

### Task 1: Establish the shared workspace projection

- [x] Add shared `ProjectSnapshot`, `WorktreeSnapshot`, `PaneSnapshot`, and `WorkspaceSnapshot` types.
- [x] Parse `git worktree list --porcelain` through the existing worktree discovery seam.
- [x] Group app-origin local panes under canonical worktrees and preserve an explicit project-level group for unresolved sessions.
- [x] Aggregate running and attention state from panes to worktrees and projects.
- [x] Cover main, linked, external, detached, locked, prunable, missing, dirty, and multi-pane worktrees with focused tests.

### Task 2: Expose a revisioned read model

- [x] Add `workspace.snapshot` to the canonical control contract.
- [ ] Add ordered `workspace.changed` events with revision and sequence identifiers. (Connection-local emission exists; host-wide broadcast ordering remains.)
- [x] Generate or validate protocol fixtures for TypeScript, Rust/Tauri, and Swift consumers.
- [ ] Preserve legacy protocol adapters as read-only compatibility paths. (The detached projection exists and is tested; production bridge wiring remains.)

### Task 3: Render the macOS project/worktree/pane rail

- [x] Replace the flat local-thread rail with expandable project and worktree groups.
- [x] Render app-origin local panes through one normalized row model without synthesizing daemon-discovered Coven rows.
- [x] Scope Files, Diffs, Git, browser state, and new-lane defaults to the selected worktree.
- [x] Preserve collapse, selection, and layout preferences without persisting runtime truth.
- [x] Add search, keyboard navigation, context menus, accessibility labels, attention badges, and recoverable stale/missing states.

The app-origin rail is complete on `main`. Daemon session discovery remains outside the visual rail until it has a host-authoritative lifecycle contract and an approved product design.

### Task 4: Add reversible GUI workflows

- [ ] Route single- and multi-agent lane creation through shared host commands with idempotency.
- [x] Add attach, focus, resize, prompt, interrupt, rename, duplicate, hide, reopen, and non-destructive close actions.
- [x] Preserve successful siblings when a multi-lane launch partially fails.
- [x] Retain “Open Psyche Terminal” as a fallback until each workflow has packaged-app proof.

Existing direct GUI actions do not satisfy host-authoritative mutation; shared host-command routing depends on the remaining control-foundation and runtime-wiring work.

### Task 5: Add full human-facing workflow parity

- [ ] Expose rituals, agent and permission selection, settings precedence, hooks, logs, and diagnostics.
- [ ] Add review/verification surfaces over the existing Files, Diffs, Git, editor, and browser panels.
- [ ] Route merge, PR, archive, worktree removal, and branch cleanup through preview/approval/execute with stale-revision rejection.
- [ ] Keep MCP and machine-readable CLI entrypoints non-visual consumers of the same control plane.

### Task 6: Harden and roll out

- [ ] Reconcile host/app restart against tmux, Git, Psyche metadata, and Coven before enabling mutation.
- [ ] Test traversal, symlink escape, pane-ID injection, cross-project operations, expired previews, replayed commands, and unauthorized actors.
- [ ] Gate the new workspace behind `native_workspace_v2` and retain rollback for one release. (Discovery is gated; a true flat-rail rollback remains.)
- [ ] Run root test/typecheck/build/smoke, protocol fixture diff checks, Rust format/test/check, native web build, packaged app/DMG build, and the manual multi-project lifecycle smoke. (The merged workspace, app-origin rail, release-dispatch, and control-foundation slices each passed their applicable CI. The interactive packaged multi-project lifecycle remains.)
- [ ] Promote after two consecutive releases complete the packaged smoke without using the embedded-TUI fallback.

## Acceptance Matrix

The implementation is complete only when the packaged macOS app can open two projects, display main and linked worktrees, create multiple isolated agent lanes, switch projects without stopping work, attach and control panes, recover after app restart, inspect and edit files, run verification, complete a reviewed PR or merge, archive a lane, and refuse unsafe cleanup of a dirty worktree.

## Scope and Compatibility

- macOS is the visual-parity target; iOS remains read/attach-oriented.
- CastCodes is not a dependency and no new desktop framework is introduced.
- Existing editor, diff, browser, and inspection surfaces are reused.
- Session and control-foundation integration work is merged; future work extends the canonical model on `main` rather than introducing parallel runtime state.
- The visual rail is app-origin only. Daemon-discovered Coven sessions must not reappear without an approved product design and host-authoritative lifecycle contract.
- Destructive or external effects always require explicit approval.
