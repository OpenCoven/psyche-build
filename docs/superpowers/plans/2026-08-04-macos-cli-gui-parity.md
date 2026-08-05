# Psyche Build macOS CLI-to-GUI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Psyche Build macOS app a complete graphical client for the CLI/TUI's human-facing project, worktree, pane, agent, ritual, inspection, review, and recovery workflows.

**Architecture:** One long-lived Psyche host remains authoritative for tmux, worktrees, configuration, policy, and lifecycle mutations. The CLI, MCP server, compatibility bridges, and Tauri app consume the same versioned workspace snapshots, commands, and events. The macOS rail renders `project -> worktree -> panes/sessions`; Tauri-local persistence stores presentation preferences only.

**Tech Stack:** TypeScript 5.9, Node.js 18, Ink/React, tmux, Git worktrees, authenticated WebSocket control protocol, Tauri 2/Rust, xterm.js, CodeMirror 6, Vitest.

---

## Delivery Order

### Task 1: Establish the shared workspace projection

- [x] Add shared `ProjectSnapshot`, `WorktreeSnapshot`, `PaneSnapshot`, and `WorkspaceSnapshot` types.
- [x] Parse `git worktree list --porcelain` through the existing worktree discovery seam.
- [x] Group local panes and Coven sessions under canonical worktrees; preserve an explicit project-level group for unresolved sessions.
- [x] Aggregate running and attention state from panes to worktrees and projects.
- [x] Cover main, linked, external, detached, locked, prunable, missing, dirty, and multi-pane worktrees with focused tests.

### Task 2: Expose a revisioned read model

- [x] Add `workspace.snapshot` to the canonical control contract.
- [x] Add ordered `workspace.changed` events with revision and sequence identifiers.
- [x] Generate or validate protocol fixtures for TypeScript, Rust/Tauri, and Swift consumers.
- [ ] Preserve legacy protocol adapters as read-only compatibility paths.

### Task 3: Render the macOS project/worktree/pane rail

- [x] Replace the flat local-thread rail with expandable project and worktree groups.
- [ ] Render local panes and project-scoped Coven sessions through one normalized row model.
- [ ] Scope Files, Diffs, Git, browser state, and new-lane defaults to the selected worktree. (Files, Diffs, Git, and new-pane cwd are complete; browser persistence remains project-scoped.)
- [x] Preserve collapse, selection, and layout preferences without persisting runtime truth.
- [ ] Add search, keyboard navigation, context menus, accessibility labels, attention badges, and recoverable stale/missing states.

### Task 4: Add reversible GUI workflows

- [ ] Route single- and multi-agent lane creation through shared host commands with idempotency.
- [ ] Add attach, focus, resize, prompt, interrupt, rename, duplicate, hide, reopen, and non-destructive close actions.
- [ ] Preserve successful siblings when a multi-lane launch partially fails.
- [ ] Retain “Open Psyche Terminal” as a fallback until each workflow has packaged-app proof.

### Task 5: Add full human-facing workflow parity

- [ ] Expose rituals, agent and permission selection, settings precedence, hooks, logs, and diagnostics.
- [ ] Add review/verification surfaces over the existing Files, Diffs, Git, editor, and browser panels.
- [ ] Route merge, PR, archive, worktree removal, and branch cleanup through preview/approval/execute with stale-revision rejection.
- [ ] Keep MCP and machine-readable CLI entrypoints non-visual consumers of the same control plane.

### Task 6: Harden and roll out

- [ ] Reconcile host/app restart against tmux, Git, Psyche metadata, and Coven before enabling mutation.
- [ ] Test traversal, symlink escape, pane-ID injection, cross-project operations, expired previews, replayed commands, and unauthorized actors.
- [ ] Gate the new workspace behind `native_workspace_v2` and retain rollback for one release.
- [ ] Run root test/typecheck/build/smoke, protocol fixture diff checks, Rust format/test/check, native web build, packaged app/DMG build, and the manual multi-project lifecycle smoke.
- [ ] Promote after two consecutive releases complete the packaged smoke without using the embedded-TUI fallback.

## Acceptance Matrix

The implementation is complete only when the packaged macOS app can open two projects, display main and linked worktrees, create multiple isolated agent lanes, switch projects without stopping work, attach and control panes, recover after app restart, inspect and edit files, run verification, complete a reviewed PR or merge, archive a lane, and refuse unsafe cleanup of a dirty worktree.

## Scope and Compatibility

- macOS is the visual-parity target; iOS remains read/attach-oriented.
- CastCodes is not a dependency and no new desktop framework is introduced.
- Existing editor, diff, browser, and inspection surfaces are reused.
- Dirty session-centric and Coven-siderail worktrees are integration inputs and must not be overwritten.
- Destructive or external effects always require explicit approval.
