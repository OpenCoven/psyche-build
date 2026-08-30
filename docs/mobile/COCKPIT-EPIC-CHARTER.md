# Mobile Multiproject and Multipane Cockpit — Epic Charter

- Bead: `psyche-i7c` (mirror: [OpenCoven/psyche-build#208](https://github.com/OpenCoven/psyche-build/issues/208), P1 epic, `in_progress`)
- Canonical outcome: [OpenCoven/psyche-build#200](https://github.com/OpenCoven/psyche-build/issues/200) — *Deliver the Psyche Build iOS internal beta and continuity loop*. Earlier broad prose references for this iOS family are historical/superseded; gh-200 is the source of truth for the remaining post-release track.
- Phase-plan slices: Phase 10 is planned and gated in [OpenCoven/psyche-build#209](https://github.com/OpenCoven/psyche-build/issues/209) (`docs/mobile/PHASE-10-RECOVERY-PLAN.md`, `src/mobile/phase10Gate.ts` on its branch); Phase 9 is planned in [OpenCoven/psyche-build#217](https://github.com/OpenCoven/psyche-build/issues/217) with children #218–#221. This charter owns neither phase's implementation.
- Charter authored: 2026-08-30 (issue body and open mirrors read at authoring time; the Beads source remains authoritative).
- Status: charter + Now-inbox ranking/snapshot schema seam. This document and `src/mobile/nowInboxRanking.ts` do **not** implement any phase child deliverable.

## Objective

Ship a universal iPhone/iPad cockpit that:

1. opens into a **cross-project Now inbox** — one ranked surface across every registered project, with Needs You first, then Running, then Recent;
2. presents **adaptive one/two-pane terminal workspaces** — one focused pane on iPhone, two explicit panes in landscape/iPad — never more than two attached terminal streams;
3. exposes the **complete pane lifecycle through the paired host** — creation, terminal streams, files/diffs, guarded actions, merge/PR/stop/close/cleanup, persistence, and recovery — where the paired host remains the sole authority for every consequential operation.

The cockpit is a client of the paired host, never a second brain. It renders host-published state and forwards guarded requests; it does not infer authority, completion, or liveness from a UI selection, tmux observation, path, worktree, branch, or issue.

## Architecture invariants

1. **Protocol-v3 typed control envelopes over the paired TLS/Bonjour bridge.** All control traffic is typed control envelopes (`control` envelopes around the canonical daemon control/workspace messages) carried by the existing paired TLS bridge with Bonjour `_psyche._tcp` discovery. The TypeScript mirror is `src/services/bridge/wireProtocol.ts` (`PROTOCOL_VERSION = 3`, `SUPPORTED_PROTOCOL_VERSIONS = [2, 3]`); the Swift encoders in `native/ios/PsycheCore` stay byte-identical to it. Legacy v2 message names and fields are never removed to serve v3.
2. **One canonical multiproject workspace snapshot.** The host publishes one canonical multiproject workspace snapshot (`mobile.workspace.snapshot.result` carrying `ReadonlyWorkspaceSnapshot`), which the Swift `WorkspaceStore` (`native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceStore.swift`) applies authoritatively with its sequence. The store asks for a full snapshot rather than patching holes; mobile code must not duplicate canonical protocol state or infer it elsewhere. The TypeScript-side schema/ranking seam for this snapshot is `src/mobile/nowInboxRanking.ts` (v1), including the strict `validateWorkspaceSnapshot` gate for untrusted wire input and the deterministic `rankNowInbox` ordering.
3. **Only one or two terminal streams attached.** The client keeps at most two terminal streams attached/rendered at any time (one focused pane on iPhone; two explicit panes in landscape/iPad). Everything else is projected from the snapshot, not from live streams. Attach/detach is explicit (`panes.attach` / `panes.detach` with bounded replay), and detach happens on navigation away.
4. **Reuse existing host file/action/lifecycle logic.** File browsing/diffs, actions, pane lifecycle, merge/PR/cleanup, persistence, and recovery reuse the existing host file/action/lifecycle workflows — their confirmations, choices, merge-target logic, receipts, and revocation semantics are not re-implemented or weakened client-side. The cockpit adds a bounded, mobile-shaped surface over those seams; it never bypasses project scope, confirmation, receipt, revocation, idempotency, work preservation, or recovery behavior.

## Constraints

- **Preserve protocol-v2 clients.** Legacy v2 clients stay byte-compatible; every v3 addition is additive around them (`SUPPORTED_PROTOCOL_VERSIONS = [2, 3]`). Any change that would break v2 is out of scope for this epic and requires its own approved design.
- **Pin the self-signed certificate.** The bridge uses a self-signed TLS certificate (`src/services/bridge/TLSCertificate.ts`); clients pin the certificate presented at pairing so subsequent connections fail closed against substitution. No plaintext LAN control surface is introduced.
- **Scope all operations to published workspace resources.** Every pane id, file, diff, and action address comes from the authoritative workspace snapshot or a response to a request the client itself made. A pane id is command text: shape-validate, never trust, and never operate on resources outside the published workspace.
- **Offline state is visibly stale.** Disconnected or unreconciled state is presented as stale (bounded cache, last-confirmed timestamps, live input/mutations disabled) until an authoritative snapshot recovers; restored state is never presented as live.
- **Validate on iPhone and iPad.** Every phase's acceptance runs on both iPhone and iPad (adaptive one/two-pane), including accessibility, performance, and offline gates. Physical-device, TestFlight, and distribution claims require separate acceptance evidence this epic's phases do not produce by default.
- **No Psyche protocol conformance claims.** The immutable Psyche profile pin and compatibility canary (gh-253) have not landed; this epic must not claim Psyche protocol conformance.
- **Baseline discipline.** Repository baseline: typecheck passes; the full Vitest run has known unrelated environment failures (installed pnpm version drift, two releaseWorkflow checks assuming BSD stat). Do not modify release code for those; use targeted suites and record the baseline in final acceptance.

## Now-inbox ranking and snapshot schema seam (this slice)

`src/mobile/nowInboxRanking.ts` (model version `NOW_INBOX_RANKING_VERSION = 1`) is the pure, deterministic TypeScript-side seam of the "one canonical multiproject workspace snapshot" invariant:

- `projectNowInboxEntries(snapshot)` — typed projection of the canonical snapshot (from `src/workspace/snapshot.ts`, the same shape carried by `mobile.workspace.snapshot.result` and applied by the Swift `WorkspaceStore`) into one flat entry per pane across all projects, worktrees, and project-level pane lists.
- `nowInboxBucketOf(pane)` — Needs You (`needsAttention`), else Running (host running statuses, mirroring `isRunning()` in `src/workspace/snapshot.ts`), else Recent.
- `rankNowInbox(snapshot, options)` — deterministic ranking per the acceptance criteria: Needs You → Running → Recent, most recent canonical `lastActivity` first within a bucket, then project id → worktree path → pane id by code-unit comparison. Bounded result (`NOW_INBOX_ENTRY_LIMIT = 256`) with pre-truncation bucket totals and an explicit `truncated` flag. Pure: no clock, no locale comparison, no iteration state.
- `validateWorkspaceSnapshot(input)` — strict, fail-closed validator for untrusted wire input: unknown fields rejected (even when `undefined`), required fields/types/enums enforced, canonical Z-form ISO-8601 `lastActivity` enforced, and bounded sizes (`MAX_WORKSPACE_PROJECTS`, `MAX_WORKTREES_PER_PROJECT`, `MAX_PANES_PER_CONTAINER`, `MAX_WORKSPACE_PANES_TOTAL`, per-string limits) checked before enumeration so hostile input costs bounded work.

The Swift WorkspaceStore consumes the same canonical snapshot; this module does not replace or re-model it — it is the shared contract's TypeScript-side gate and the ranking the Now inbox UI must present.

## Success criteria and phase mapping

The epic's success criteria: all ten phased children close with targeted TypeScript, PsycheCore, and UI tests passing; the full acceptance matrix passes; documentation reflects the live architecture; and the branch is ready for review. Phased children are Beads `psyche-i7c.1`–`psyche-i7c.10`; `psyche-i7c.11` (Bonjour discovery wiring into a connectable host flow) is tracked on the same epic. Mirrors visible today: phases 9 and 10 (open, with children); phases 1–8 mirrors are closed/superseded history — Beads is authoritative for all of them.

| Success criterion (epic acceptance criteria, verbatim-faithful) | Owner |
|---|---|
| Now inbox ranks Needs You, Running, and Recent across projects | Now-inbox children (phases 1–8, closed history) + this seam's `rankNowInbox` ordering; presentation owned by the mobile UI children |
| iPhone supports one focused pane; landscape/iPad can show two explicit panes | Mobile workspace/navigation children (phases 1–8, closed history) |
| Pairing, certificate pinning, terminal streams, files/diffs, actions, pane creation, merge/PR/cleanup, persistence, and recovery work end-to-end | Phase 9 lifecycle (#217, #218–#221), Phase 10 recovery/persistence (#209, #210–#215), Bonjour wiring (#216), closed phase history |
| No more than two terminal sessions are attached/rendered | Mobile workspace/stream children (phases 1–8, closed history); invariant re-checked by the Phase 10 acceptance matrix (#213) |
| Existing protocol-v2 behavior remains compatible | Bridge/protocol surfaces (`src/services/bridge/**`); verified per phase and by the Phase 10 matrix (#213) |
| Accessibility, performance, and offline acceptance gates pass | #212 (a11y/motion), #213 (performance + matrix), #211 (stale/live reconciliation), #210 (protected cache) |
| Documentation reflects the live architecture | #214 (`docs/PRODUCT-SPEC.md` + protocol/mobile architecture docs) |
| All ten phased children close; branch ready for review | Phase gate records (`validatePhaseGateRecord`) and final review/handoff (#215) |

Acceptance matrix closure is gated by the Beads source's own child statuses, mirrored into gate records (see the Phase 10 plan's `validatePhaseGateRecord` contract); a phase cannot close over an unpassed prerequisite.

## Non-goals

- **No implementation of phase children in this slice.** The charter and the ranking/schema seam do not implement Now-inbox UI, pairing, streams, lifecycle, cache, or recovery; the phase children own their code, tests, and evidence.
- **No desktop/macOS track claims** and no availability/support-matrix claims — gh-200 and the support matrix own those.
- **No TestFlight/distribution/physical-device claims** — those require separate acceptance evidence.
- **No upstream GitHub write-backs** from the issue-agent pipeline (upstream PR/issue writes are token-denied; work runs on the fork with real CI, ready for maintainer handoff).
- **No weakening of bridge security, confirmation, receipt, revocation, idempotency, scope, or recovery behavior** anywhere in the epic.

## Plan change log

- 2026-08-30: Initial epic charter authored for OpenCoven/psyche-build#208, including the v1 Now-inbox ranking/snapshot schema seam (`src/mobile/nowInboxRanking.ts`, `__tests__/nowInboxRanking.test.ts`).
