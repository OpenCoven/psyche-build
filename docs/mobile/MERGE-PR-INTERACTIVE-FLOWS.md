# Mobile merge and PR interactive flow contracts (v1)

- Issue: [OpenCoven/psyche-build#219](https://github.com/OpenCoven/psyche-build/issues/219) — `[psyche-i7c.9.3]` Exercise merge and PR interactive workflows on mobile (Bead `psyche-i7c.9.3`)
- Status: contract slice — the interaction contracts and their executable state machines. No sheet UI ships in this slice (documented gap below).
- Machine module: `src/mobile/mergePrFlowMachines.ts` (version `MERGE_PR_FLOW_MACHINE_VERSION = 1`)
- Tests: `__tests__/mergePrFlowMachines.test.ts`
- Parent phase: #217 (`psyche-i7c.9`, context schema) · sibling #218 (`psyche-i7c.9.2`, native pane action menu and guarded confirmations). This slice deliberately does not touch #217/#218 files.

## Purpose

Define — and enforce as pure, versioned state machines — how a mobile client may exercise the
*existing* merge and pull-request action chains over the wire:

1. **Merge flow** (`mergeFlowMachine`): the confirm/choice chain wired to the merge action's
   existing results — sibling-pane teardown confirmation, merge-start confirmation,
   uncommitted-changes choices, commit-message input, fallback-target confirmation, the
   conflict-resolution navigation handoff, and terminal outcomes.
2. **PR review flow** (`prReviewFlowMachine`): the confirm/`pr_review` chain wired to the
   create-PR action's existing results — creation/fallback confirmation, title/body summary
   editing, related-file navigation, generated-summary editing (including the `aiFailed`
   warning path), and final URL messages.

The machines are explicit transition tables: no I/O, no clock, no host-state inference, no
content validation. They are the client-side half of the conversation; the host remains the
source of truth for everything real.

## Non-goals

- No sheet/UX implementation. Rendering, gestures, a11y, and pane composition are the mobile
  client's job (and #218 owns the native pane action menu surface).
- No merge/PR semantics. Target resolution, conflict detection, commits, stashes, pushes, and
  PR creation stay exactly where they are (`src/actions/**`, the Coven daemon).
- No context-schema work (#217) and no action-catalog work (#218).
- No claims about iOS availability, TestFlight, or physical-device behavior (gh-200 owns the
  remaining post-release track; no Psyche protocol conformance is claimed).

## The host-remains-source-of-truth rule

The machines never validate git, pane, worktree, branch, or PR state. Concretely:

- A sheet exists only because the host reported one (`host_step`). The machine renders exactly
  what the host reported, including the authorized option ids and the authorized related-file
  list.
- A response is forwarded verbatim. Content rules are host-side: "Commit message cannot be
  empty", PR title parsing ("first line is the title; blank line; then body"), "PR title cannot
  be empty", conflict detection, and target resolution are all existing host behavior. The
  machines deliberately accept, e.g., an empty commit message or an empty summary and let the
  host be the one to reject it (asserted by tests).
- A definitive answer (`host_result`) is recorded verbatim; a typed failure
  (`host_validation_failed`) is recorded with its machine-readable reason.
- The client cannot cancel an in-flight continuation. Cancel is honored at interaction
  surfaces only; while the host is executing (`awaiting_host`), user events are refused and
  the client waits for the host's next report.

## Event vocabulary

Machine events come in two families. Host events are authoritative reports; user events are
the user's explicit responses (shaped after the existing `RemoteActionResponse` kinds).

| Event | Meaning | Existing seam |
|---|---|---|
| `host_step` | The host opened (or replaced) a sheet: `confirm`, `choice`, `input`, or `pr_review` | Response-requiring `ActionResult` types, serialized by `RemoteActionSessions` |
| `host_result` | Definitive chain end: `succeeded`, `failed`, `navigated` (e.g. conflict-pane handoff), `informational` (e.g. "Merge cancelled") | `success` / `error` / `navigation` / `info` action results |
| `host_validation_failed` | Typed host-side failure: `action_session_not_found`, `action_session_expired`, `action_session_limit`, `stale_pane_state`, `unexpected_action_result`, `host_rejected_input` | `remoteActionSessions` failure codes; bridge stale-workspace signals |
| `host_session_lost` | The action session is gone. Outcome is derived by the machine: `unknown` if a continuation was in flight, `recovery_required` otherwise | Session TTL / transport loss |
| `user_confirm` | Answer to a `confirm` sheet (`{ confirmed }`) | `RemoteActionResponse {kind:'confirm'}` |
| `user_choice` | Answer to a `choice` sheet (`{ optionId }`, must be host-authorized) | `RemoteActionResponse {kind:'choice'}` |
| `user_input` | Answer to an `input` sheet (`{ value }`, forwarded unvalidated) | `RemoteActionResponse {kind:'input'}` |
| `user_review_edit` | Edited the PR summary draft | `pr_review` sheet editing |
| `user_review_focus_file` / `user_review_close_file` | Related-file navigation (path must be host-authorized) | `pr_review` file list / `relatedFiles` |
| `user_review_submit` | Submitted the reviewed summary for PR creation | `pr_review` submit → `createGitHubPullRequest` |
| `user_cancel` | Explicit cancel (single-use; see below) | `RemoteActionResponse {kind:'cancel'}` / sheet dismissal |

Pure adapters convert the serialized action results a mobile client actually receives into
these events: `hostStepFromRemoteActionResult` (confirm/choice/input/pr_review — including the
known confirm-title → purpose map, e.g. `"Sibling Agents Active"` → `sibling_close`,
`"Merge Worktree"` → `merge_start`, `"Create Pull Request"` → `create_pr`) and
`hostResultFromRemoteActionResult` (success/error/navigation/info). Both fail closed: an
unclassifiable result maps to `null`, which composition layers must surface as an
`unexpected_action_result` host-validation failure rather than guessing.

## Merge flow

States: `idle` → (`sheet` | `awaiting_host`)* → one of the terminals. The table
(`MERGE_FLOW_TRANSITIONS`) is the contract; the summary below is navigation, not a substitute.

### Destructive confirmation chain (wired to existing results)

```
idle
  └─ host_step confirm "Sibling Agents Active"        (sibling_close)
       sheet ── user_confirm(true) ──► awaiting_host   [host tears down sibling agent panes]
                 user_confirm(false)/user_cancel ──► cancelled
       └─ host_step confirm "Merge Worktree"           (merge_start)
            sheet ── user_confirm(true) ──► awaiting_host  [host executes the merge]
                      user_confirm(false)/user_cancel ──► cancelled
            └─ host_result succeeded/failed ──► terminal
```

Sibling panes and the merge itself are separate host confirmations, exactly as
`mergeAction.ts` chains them today; the machine requires each to be its own explicitly
accepted `confirm` sheet (`gatedBy: 'confirm_sheet'`).

### Uncommitted changes (choice sheet, both `main_dirty` and `worktree_uncommitted`)

The host reports the issue and opens the choice sheet (`data.kind = 'merge_uncommitted'`) with
its existing options: `commit_automatic`, `commit_ai_editable`, `commit_manual`, `stash_main`
(main-dirty only), `cancel`. The machine accepts exactly the host-authorized ids; anything
else is rejected with `option_not_authorized` and leaves state unchanged. Option id `cancel`
follows the host's universal convention and aborts the chain. Commit options reach
`awaiting_host` (the explicit selection is the guarded confirmation the host designed for this
branch); a `commit_manual`/`commit_ai_editable` chain continues with the host's commit-message
`input` sheet, whose value the machine forwards without judging it.

### Fallback target confirmation

When the resolved target needs confirmation (`MergeTargetResolution.requiresConfirmation` —
`fallbackReason` `missing` / `merged` / `branch_changed`), the host opens the fallback
`confirm` sheet ("Parent Merge Target Unavailable" / "Parent PR Target Unavailable"). Merge
continues only on an explicit accept; declining or cancelling aborts.

### Conflict handoff and other definitive ends

The conflict path returns a `navigation` result (conflict-resolution pane). The machine maps
it to a terminal `recovery_required` outcome carrying the message and target pane: the merge
did not complete, the host gave a definitive answer, and the operator has work to do
elsewhere. `success` → terminal `succeeded`; `error` → terminal `failed`; `info` (e.g. "Merge
cancelled") → `cancelled` with the host message — the chain ended without attributing an
outcome.

## PR review flow

States add `review` (the live `pr_review` session). The table (`PR_REVIEW_FLOW_TRANSITIONS`)
is the contract.

### Creation confirmation gate

PR creation is destructive, so the machine enforces its own record of the confirmation chain:
a `pr_review` step reached after an accepted `create_pr` (or `fallback_target`) confirm sets
`creationConfirmed: true`; a review sheet opened without a machine-observed confirm keeps
`creationConfirmed: false`, renders fine for editing/peeking, but **rejects
`user_review_submit`** with `creation_not_confirmed` (fail closed; the existing host contract
always sends the confirm first). A superseding fresh `pr_review` step starts a fresh
unconfirmed session.

### Title/body editing and generated-summary editing

The review session carries the host-provided draft (`initialSummary` — first line is the
title, blank line, then body), the `aiFailed` flag (the sheet must show the host's warning
when the AI summary failed), and the editable draft. `user_review_edit` updates the draft
locally; parsing and validation happen host-side on submit.

### Related-file navigation

`user_review_focus_file` may only open paths in the host-authorized list
(`relatedFiles` on the wire, falling back to `reviewData.files`); anything else is rejected
with `file_not_authorized`. `user_review_close_file` returns to the review sheet. Navigation
is view-only and repeatable; the diff-peek content remains a host/composition concern.

### Final URL messages

After submit (`awaiting_host`, purpose `review_submit`), the host's definitive answer is
recorded verbatim: `Created PR: <url>` / `PR already exists: <url>` as terminal `succeeded`,
errors as terminal `failed`.

## Terminal outcomes

`flowOutcomeOf` maps terminal states to the run's outcome:

| Outcome | Reached by |
|---|---|
| `succeeded` | Host `success` result (merge applied, PR created, PR already existed) |
| `failed` | Host `error` result |
| `unknown` | `host_session_lost` while `awaiting_host` — a continuation was in flight; the merge/PR may or may not have executed. Re-query the host; never assume locally. |
| `recovery_required` | Typed `host_validation_failed`; the conflict-pane navigation handoff; session loss with nothing in flight |
| `cancelled` (not an outcome) | Explicit user cancel or host `info` end — the chain closed without attributing a result |

`host_validation_failed` is a typed terminal state carrying `HostValidationFailureReason`
(`action_session_not_found` / `action_session_expired` / `action_session_limit` /
`stale_pane_state` / `unexpected_action_result` / `host_rejected_input`) and always resolves
to `recovery_required`.

## Explicit, single-use cancel

- Every cancellable state (`idle`, every sheet, the review session) declares exactly one
  `user_cancel` row; the structural audit (`auditFlowMachine`) fails if any is missing.
- The first accepted cancel (or a declined confirm, or the host's `info` end) moves the
  machine to `cancelled`, which is terminal: **every** further event — including a second
  cancel, a late host result, and a host step — is rejected with `session_closed`. There is no
  resume-after-cancel.
- Cancel cannot preempt `awaiting_host`: an in-flight continuation may already have executed,
  so the client waits for the host's definitive report (which may still be a `failed`
  result), then can cancel the next surface. This keeps "cancel" honest: it never claims an
  un-executed operation was cancelled.

## Enforced invariants (audited + tested)

`auditFlowMachine` walks each table and rejects:

1. any row declared on a terminal status (single-use closure is total);
2. a cancellable status without exactly one `user_cancel` row classified `abort`;
3. user rows under `awaiting_host` (no client-side preemption of the host);
4. a consequential transition (`initiates: 'consequential'` — the merge execution, sibling
   teardown, fallback override, commit/stash, PR creation) that is not an explicit user
   `execute` originating from a host-opened sheet or review state;
5. `gatedBy` rows whose source state does not match the gate (`confirm_sheet` → sheet,
   `confirmed_review` → review).

The test suite asserts both tables pass the audit, walks every destructive branch end-to-end
(sibling → merge, fallback → merge, uncommitted → commit input → retry, PR confirm → review →
submit → final URL), proves the negative paths (no confirm sheet → no execution; unconfirmed
review → no PR creation; unauthorized option/file → rejected; unknown event → rejected;
cancel → single-use), and checks the adapters against `serializeActionResult` output.

## Integration notes for the mobile client (future slices)

1. Invoke the pane action (#218's catalog). Feed the serialized response-requiring result
   through `hostStepFromRemoteActionResult` (optionally with an explicit confirm-purpose hint
   if the host grows a machine-readable marker) and dispatch the resulting `host_step`.
2. Render the sheet from the machine state; send `user_*` events for interactions; forward
   accepted responses to the bridge as `RemoteActionResponse` and feed whatever comes back
   through the adapters as the next machine event.
3. Treat adapter `null` as `host_validation_failed { reason: 'unexpected_action_result' }`.
4. On `flowOutcomeOf(state) === 'unknown'`, re-query the host (workspace snapshot / pane
   state) — never assume the merge or PR exists or does not.
5. Sheet UI integration (rendering these states, gestures, a11y) is the documented gap of
   this slice and lands with the mobile delivery track.

## Versioning

`MERGE_PR_FLOW_MACHINE_VERSION = 1`. Additive changes (new sheet purposes, new failure
reasons, new authorized options) extend the tables and bump nothing; anything that changes
existing transitions, outcome semantics, or the cancel contract bumps the version and must
revisit the audit and tests.
