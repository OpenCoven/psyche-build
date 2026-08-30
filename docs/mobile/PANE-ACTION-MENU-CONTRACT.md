# Native pane action menu and guarded confirmations contract

- **Contract version:** v1 (`PANE_ACTION_CATALOG_VERSION = 1`)
- **Scope:** mobile cockpit pane action menu (Phase 9 family: full lifecycle
  merge, PR, stop, close, and cleanup), platform-neutral menu semantics plus a
  TypeScript reference implementation. The SwiftUI menu itself and the
  interactive merge/PR flows that consume this contract are owned by the
  mobile delivery track (canonical outcome:
  [gh-200](https://github.com/OpenCoven/psyche-build/issues/200)); the phase
  plan and scoped action context schema are #217, and the interactive
  choice/PR-review flows are #219.
- **Reference implementation:** [`src/mobile/paneActionCatalog.ts`](../../src/mobile/paneActionCatalog.ts)
  (pure functions, no I/O, no imports — safe to port token-for-token to Swift).
- **Issue:** [OpenCoven/psyche-build#218](https://github.com/OpenCoven/psyche-build/issues/218)
  (Beads `psyche-i7c.9.2`).

## 1. Purpose and boundaries

This contract defines what the mobile pane action menu offers, how destructive
actions are guarded, when actions are disabled, and how progress, results, and
errors stay visible. It is deliberately platform-neutral: every rule below is
expressed as data and pure functions in the reference module, so the SwiftUI
layer renders — and the XCUITest layer asserts — exactly these semantics.

This document does not define SwiftUI view code, the Xcode project, host
protocol payloads, or the merge/PR interactive flows. It defines the semantics
those layers must honor.

**Authority.** The catalog is presentation semantics only. It never executes an
action and never replaces control-plane confirmation, approval, receipt, or
idempotency requirements. The host remains the source of truth for merge
validation and targets, cleanup choices, sibling-pane handling, uncommitted
change decisions, action results, and error text. Disabling in this contract is
a UI guard; it can only be more restrictive than the host, never a bypass.

Versioning: v1 is additive-only. New actions may be added with their required
metadata and copy; existing ids, required text, destructive classification, and
ordering rules may not be removed, weakened, or replaced by color/icon/motion-only
signaling. Bump the contract version and this document for any breaking change.

## 2. Action catalog (v1)

The pane action menu offers exactly these actions, in this order:

| Id | Menu title | Destructive (confirmation required) | Follow-up flow | Touches | Survival | Consequence summary |
|---|---|---|---|---|---|---|
| `merge` | `Merge…` | yes | yes | project, worktree, branch | no session change | Merges the pane branch into its target branch after the host validates the merge. |
| `create-pr` | `Create Pull Request…` | no | yes | project, branch | no session change | Opens pull request creation for the pane branch; no branches change until you submit it. |
| `stop` | `Stop Pane` | yes | no | pane | session ends, pane retained | Ends the pane running session. The pane stays in the cockpit and can be restarted. |
| `close` | `Close and Clean Up…` | yes | yes | pane, worktree, branch | session ends, pane removed | Ends the pane session and removes the pane from the cockpit after the host cleanup choices. |
| `rename` | `Rename…` | no | yes | pane | no session change | Changes the pane display title only. The session, worktree, and branch are unchanged. |
| `files` | `Files` | no | no | worktree | no session change | Opens the file browser for the pane worktree. Read-only navigation. |
| `rituals` | `Rituals…` | no | yes | pane, project | no session change | Opens the ritual list to run in this pane. Ritual approval gates still apply. |

Rules:

1. **One id per semantic action.** Menu entries, confirmations, running-state
   badges, and receipts address actions by id (`PaneActionId`), never by row
   index, icon, or localized title.
2. **Cleanup routes through `PaneAction.CLOSE`.** "Clean up" is not a separate
   action id. Any clean-up affordance anywhere in the pane surface maps to the
   `close` action and enters the host's cleanup choices after activation; it
   uses the `close` confirmation, survival semantics, and destructive guard.
   A `cleanup` id must not be added to the menu (contract §3.5).
3. **Destructive set.** In v1, `confirmationRequiredFor()` is true exactly for
   `merge`, `stop`, and `close`. Merge always confirms when it is offered:
   "where applicable" is the host's decision to offer a merge (the host
   validates mergeability, siblings, and fallback targets); the catalog never
   skips the guard. `create-pr`, `rename`, `files`, and `rituals` do not
   present this confirmation — they present their own flows, and rituals keep
   their own approval gates.
4. **Ellipsis means more input.** A menu title ends with `…` if and only if
   `opensFollowUpFlow` is true (activation leads to required further input or a
   host flow: merge choices, PR review, host cleanup choices, rename input,
   ritual selection). Single-step actions (`Stop Pane`, `Files`) carry no
   ellipsis; the stop confirmation is a guard, not a follow-up step.
5. **Consequence text is required.** Every descriptor carries a non-empty
   `consequenceSummary` that names the effect in plain words — never color
   vocabulary, never emoji. Menus may render it as a subtitle; they may not
   omit it where this contract requires it (disabled reasons, confirmations).
6. **Action order.** The v1 menu order is the table order: merge, create PR,
   stop, close and clean up, rename, files, rituals. Destructive actions are
   grouped away from navigation actions rather than interleaved with them.

## 3. Stop vs. Close and Clean Up: visual and semantic distinctness

Stop and close/clean-up are different actions with different outcomes and must
be distinguishable without relying on color, icons, or position:

1. **Different ids.** `stop` and `close` are distinct `PaneActionId` values;
   they are never aliases and never share a menu entry.
2. **Different titles.** `Stop Pane` vs `Close and Clean Up…`. The words
   "Stop" and "Close" never appear interchangeably: stopping is described as
   stopping (session ends, pane remains), closing is described as closing
   (session ends, pane is removed from the cockpit).
3. **Different consequences.** Stop: "Ends the pane running session. The pane
   stays in the cockpit and can be restarted." Close: "Ends the pane session
   and removes the pane from the cockpit after the host cleanup choices." The
   two sentences must never be equal or swappable.
4. **Different survival semantics.** Stop maps to `session-ends-pane-retained`;
   close maps to `session-ends-pane-removed`. Confirmation copy states this:
   stop says the pane stays in the cockpit and can be restarted; close says the
   pane is removed once the host cleanup choices complete. Both state that the
   worktree and branch survive the pane action itself (for close, "unless the
   host cleanup choices you make next remove them" — the host's cleanup
   workflow owns that disposition, and the copy must say so).
5. **Cleanup routing.** Any "Clean Up" affordance routes through `close`: it
   presents the close confirmation (naming removal and the host cleanup
   choices) and then enters the host's cleanup choices. It must not present a
   weaker confirmation or none.
6. **Visual distinctness is additive.** Destructive tint, icons, and placement
   may differ between the two, but the titles, consequence text, and
   confirmation copy above are the required distinctness carriers. A menu that
   distinguishes them by color alone is contract-violating.

## 4. Guarded confirmations: ordering and copy

Destructive actions present confirmation copy built by `confirmationCopy()`
before anything executes. Rules:

1. **Consequence is read before its button.** The required presentation order
   is `consequence`, `scope`, `disposition`, then the buttons:
   `CONFIRMATION_PRESENTATION_ORDER = [consequence, scope, disposition,
   confirm-button, cancel-button]`. The first sentence of the detail states
   what will happen now; the destructive button is never the first (or only)
   carrier of the consequence. SwiftUI must lay the elements out in this
   reading order (and VoiceOver order), and XCUITest may assert it through
   `consequenceSentence` / `scopeSentence` / `dispositionSentence`.
2. **Exact scope is named as text.** The scope sentence names the pane, the
   project, and the host, plus the worktree and branch whenever the caller has
   them (a caller that has them and omits them is contract-violating). Merge
   additionally names the target branch when known; when unknown, the
   consequence states that the host validates the merge and selects the target.
   Scope is never implied by color, icon, emoji, or button placement.
3. **Verb-first, consequence-naming confirm button.** The confirm label names
   the action (`Merge Branch`, `Stop Pane`, `Close and Clean Up`); the cancel
   button is a plain, non-destructive `Cancel`. Buttons never rely on color or
   position to communicate which is destructive.
4. **Title names action and pane.** `Stop Pane "api"?`,
   `Close and Clean Up "api"?`, `Merge Branch "api"?`.
5. **No color vocabulary, no emoji.** Required copy (titles, consequence
   summaries, confirmation detail, availability reasons, feedback lines)
   contains no color words and no emoji; meaning is carried by words.
6. **Fail-closed caps, no truncation.** Fields over
   `MAX_CONFIRMATION_FIELD_LENGTH` (120) or a combined detail over
   `MAX_CONFIRMATION_DETAIL_LENGTH` (600) are rejected, never truncated —
   truncation is how consequences get silently dropped. Callers shorten
   display names upstream instead. Whitespace is normalized (runs collapse,
   trim); empty required fields are rejected.
7. **Fail closed on non-destructive actions.** `confirmationCopy()` rejects
   non-destructive ids: they present their own flows, not this guard.
8. **Nothing executes on presentation.** Presenting the confirmation changes
   nothing; execution happens only after the confirm activation, through the
   control plane, with its receipts and idempotency semantics intact.

## 5. Availability: stale and already-running actions are disabled

`availabilityFor(action, context)` decides whether a menu action may be
offered. Rules:

1. **Stale context disables everything.** When the pane context may be out of
   date (`isStale: true`), every action is disabled — including read-only
   navigation — until the pane is refreshed, because file listings and ritual
   runs address the same possibly-stale scope. The reason is text naming the
   action: "The pane state may be out of date (stale). Refresh the pane before
   running `<title>`." A stale pane never silently re-enables on its own; only
   a refresh that clears the stale state does.
2. **Actions are single-flight per pane.** While an action is running
   (`runningAction` set), no menu action may start: the running action itself
   is disabled with "is already running on this pane. Wait for it to finish
   before running it again.", and every other action is disabled with a reason
   naming the running action. The disabled state persists until the host
   reports a terminal state for the running action — the catalog never marks
   an action finished on its own timer or on optimistic UI.
3. **Unreachable host disables everything.** `hostReachable: false` disables
   every action with a reconnect-first reason.
4. **Precedence.** Host unreachable → action already running → stale context.
   The most specific reason wins; exactly one reason is reported.
5. **Reasons are text in the same surface.** A disabled control carries its
   `disabledReason` (accessibility value or visible hint) — never a color-only
   or icon-only treatment. Reasons are capped at
   `MAX_AVAILABILITY_REASON_LENGTH` (200) and fail closed.
6. **Fail closed on unknown ids.** Unknown action ids — including unknown
   `runningAction` values from untrusted payloads — throw rather than guess.

## 6. Result, error, and progress visibility

Once started, an action's state remains visible as text until the host reports
a newer state. Rules:

1. **Bounded states.** `in-progress`, `succeeded`, `failed`
   (`PANE_ACTION_FEEDBACK_STATES`). Each carries a required standalone text
   (`In progress` / `Completed` / `Failed`) and an in-sentence phrase;
   `feedbackLineFor()` builds `"Stop Pane" is in progress` — the action is
   always named.
2. **Never spinner- or color-only.** Spinners, tint, and glow are additive to
   the text. A state the user cannot read as text is not rendered.
3. **Progress stays visible while it runs.** The in-progress line renders in
   the same surface as the menu for as long as the action runs; it may not be
   auto-dismissed, hidden behind a color change, or replaced by an optimistic
   "done" before the host confirms.
4. **Results name the action and outcome.** Success lines name the action and
   carry the host-provided result (for create PR, the host-provided URL is
   shown verbatim as text, not as a color-only link).
5. **Errors are preserved verbatim.** Failure lines name the action and include
   the host-provided error text passed through (whitespace-normalized, capped
   at `MAX_FEEDBACK_DETAIL_LENGTH` (400), never truncated away, never
   paraphrased into "something went wrong"). The host stays the source of
   truth; the catalog adds the action name, not a substitute diagnosis.
6. **Terminal states persist.** A succeeded/failed line remains until replaced
   by a newer state for that pane or the user dismisses it; it may not
   auto-clear because other screen data refreshed (stale-state reconciliation
   elsewhere must not erase the last observed action outcome).
7. **Failure keeps the guard.** A failed action leaves the menu in the
   disabled/single-flight state until the host reports the action terminal
   (§5.2); the failure message must not be the thing that re-enables actions.

## 7. SwiftUI and XCUITest mirror requirements

1. The SwiftUI menu mirrors the catalog token-for-token: ids, titles, ellipsis
   rule, destructive set, confirmation copy, availability reasons, and feedback
   lines come from (or are generated from) this module's strings — not
   re-authored in Swift.
2. Stable identifiers follow the repo grammar
   (`psyche.<surface>.<element>.<stable-id>`, e.g.
   `psyche.pane-action-sheet.stop`, `psyche.pane-action-sheet.confirm`,
   `psyche.pane-action-sheet.cancel`), anchored on action ids and host-assigned
   pane identity, never titles or indices.
3. The required UI test walks: open pane → open action menu → assert the seven
   v1 actions with distinct stop/close entries → activate stop → assert the
   confirmation shows the consequence sentence before the confirm button and
   names pane/project/host with worktree/branch survival → confirm, and
   separately cancel, asserting the pane state after each → for a stale fixture,
   assert every action is disabled with its textual reason → assert the
   in-progress line appears while a fixture action runs and the terminal line
   persists.
4. This UI test requires a macOS host with the repository-pinned Xcode, iOS
   simulator, and XcodeGen (`PSYCHE_AGENT_CHECK_IOS=1`); it cannot run on the
   Linux authoring host and is recorded as a proof gap in the working record
   until the mobile track runs it. The TS reference implementation and its unit
   tests are the v1 executable form of sections 2–6.

## 8. Versioning

`PANE_ACTION_CATALOG_VERSION` and `PANE_ACTION_CATALOG_ID`
(`psyche.mobile.pane-action-catalog.v1`) identify this contract for logs and
cross-layer assertions. v1 changes are additive-only (§1); any breaking change
to ids, destructive classification, ordering, required copy, or disabling rules
bumps the version and this document together.
