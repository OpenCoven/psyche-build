# Mobile motion and accessibility semantics contract

- **Contract version:** v1 (`MOTION_SEMANTICS_CONTRACT_VERSION = 1`)
- **Scope:** mobile cockpit (Phase 10 family), platform-neutral semantics plus a
  TypeScript reference implementation. The SwiftUI/XCUITest integration that
  consumes this contract belongs to the mobile delivery track (canonical
  outcome: [gh-200](https://github.com/OpenCoven/psyche-build/issues/200)).
- **Reference implementation:** [`src/a11y/motionSemantics.ts`](../../src/a11y/motionSemantics.ts)
  (pure functions, no I/O, no imports — safe to port token-for-token to Swift).
- **Issue:** [OpenCoven/psyche-build#212](https://github.com/OpenCoven/psyche-build/issues/212)
  (Beads `psyche-i7c.10.3`).

## 1. Purpose and boundaries

This contract defines how the mobile cockpit communicates pane, project, and
host state to users who cannot rely on color, motion, or default text sizes,
and how motion degrades when the user turns it off. It is deliberately
platform-neutral: every rule below is expressed as data and pure functions in
the reference module, so the SwiftUI layer renders — and the XCUITest layer
asserts — exactly these semantics.

This document does not define SwiftUI view code, the Xcode project, or host
protocol payloads. It defines the semantics those layers must honor. Nothing
here weakens control-plane confirmation, idempotency, or receipt requirements;
confirmation copy in section 5 is presentation only, and the authority to
execute an action still comes from the control plane.

Versioning: v1 is additive-only. New status tokens, transition kinds, or
confirmation kinds may be added with their required copy; existing required
text may not be removed, made optional, or replaced by color/icon/motion-only
signaling. Bump the contract version and this document for any breaking change.

## 2. Status is never color-only

Every status a pane, project row, or host row can display carries a required
human textual equivalent. Color, glow, and border treatments (including the
exception-only treatments in the [pane status glow design](../superpowers/specs/2026-08-11-pane-status-glow-design.md))
are always additive to the text, never a replacement for it.

v1 status tokens and required text:

| Token | `text` (standalone equivalent) | `summaryPhrase` (in-summary) | Severity |
|---|---|---|---|
| `needs-you` | Needs you | needs your attention | attention |
| `running` | Running | running | active |
| `starting` | Starting | starting | active |
| `idle` | Idle | idle | neutral |
| `stale` | Stale | may be out of date | degraded |
| `offline` | Offline | host is offline | degraded |
| `failed` | Failed | failed | degraded |
| `exited` | Exited | exited | degraded |

Rules:

1. Any surface that renders status at all must render the token's textual
   equivalent in the same interaction surface (not behind an extra tap,
   hover, or long-press).
2. `text` is the required standalone equivalent (chip, badge suffix, or label).
   `summaryPhrase` is the required in-sentence equivalent for combined
   summaries. Both are non-empty by construction and validated by tests.
3. New tokens must ship with both strings in
   `PANE_STATUS_DESCRIPTORS` before any UI can render them; the
   `PaneStatusToken` union and the descriptor table must move together.
4. A token's text must never encode status by color words alone (no "green",
   "amber") — it names the state, not the paint.
5. Stale/offline/failed/exited states must remain visible as text while the
   underlying state persists; they may not auto-clear because fresh data
   arrived elsewhere on screen (stale-state reconciliation is owned by
   psyche-i7c.10.2; this contract only requires the text survives).

## 3. Combined pane/project/host summaries

`summaryForPaneProjectHost()` builds the single accessibility label used by Now
rows, pane headers, and action-sheet context lines. Rules:

1. **Identity completeness.** The label always includes pane identity, the
   status textual equivalent, project name, and host name. Worktree and branch
   are included whenever the caller has them; a caller that can supply them and
   does not is contract-violating (essential identity must survive — see
   section 6). Part order: selected-state (if focused), pane, status, project,
   worktree, branch, host.
2. **No color-only information.** The status part is the token's
   `summaryPhrase`, never a color, tint, or decoration reference. The output
   contains no color vocabulary.
3. **Selected-state announcement.** When the pane is the focused split, the
   label begins with the `selected` part (text `Selected`) so the announcement
   states selection before identity. Exactly one pane per split view may be
   focused at a time (see section 4).
4. **Normalization and caps (fail closed).** Each field is trimmed and internal
   whitespace runs collapse to single spaces. Empty-after-trim required fields
   are rejected. Any field over `MAX_SUMMARY_FIELD_LENGTH` (120) or a combined
   label over `MAX_SUMMARY_LENGTH` (280) is rejected with an error — the
   combiner never silently truncates, because truncation is how essential
   identity gets dropped. Callers shorten display names upstream instead.
5. **Structured parts.** The result includes `parts` (`pane`, `status`,
   `project`, `worktree`, `branch`, `host`, `selected`) so platforms can render
   the same semantics as separate, individually styled/textual elements without
   re-parsing the label string.

Example (`isFocused: true`):

```text
Selected; Pane "api-server" needs your attention; project "psyche"; worktree "wt/212"; branch "feat/a11y"; host "lan-box"
```

## 4. Selected-split trait rules

1. The focused pane of the active split announces its selection. On SwiftUI the
   focused element carries the `.isSelected` trait **and** the textual
   `Selected` part from section 3 — the trait alone is not sufficient, because
   the trait is not rendered on all assistive technologies and the label must
   stand alone.
2. Exactly one pane per visible split view is focused at a time; the cockpit
   must not announce two panes as selected simultaneously.
3. Selection changes are announced immediately (element relabel), not deferred
   to the end of any transition — and independently of whether motion ran
   (section 7): with Reduce Motion on, the selection announcement still fires.
4. A focused pane that is also stale/offline keeps both facts: `Selected`
   first, then status text. Selection never masks degraded state, and degraded
   state never hides selection.
5. Selected-state is conveyed by text and trait, never by color/border alone
   (the violet focused border of the desktop pane design remains decoration).

## 5. Consequence-first confirmations

Deliberate mutations (stop pane, close pane, send input) present confirmation
copy built by `confirmationCopy()`. Rules:

1. **Consequence first.** The detail copy's first sentence states what will
   happen now. Scope (pane, project, host, worktree, branch) follows. The
   consequence is never implied by color, icon, or button placement alone.
2. **Identity naming.** Stop/close confirmations name the pane, the project,
   and the host, and explicitly state that the worktree and branch survive —
   only the running session ends. This mirrors the desktop stop-confirmation
   requirement in the iOS live cockpit design.
3. **Verb-first, consequence-naming buttons.** The confirm button names the
   action ("Stop pane", "Close pane", "Send input"); the cancel button is a
   plain, non-destructive "Cancel". Buttons never rely on color or position to
   communicate which is destructive.
4. **Survival flag.** `namesWorktreeAndBranchSurvival` is `true` exactly for
   kinds whose subject can be resumed (`stop-pane`, `close-pane`); when the
   caller supplies worktree/branch names, the survival sentence names them.
5. **Overridable consequence, same rules.** `consequenceOverride` replaces the
   first sentence (e.g. for receipt-backed custom copy) and is validated like
   every other field: non-empty, capped, whitespace-normalized.
6. **Fail-closed caps.** Fields over `MAX_CONFIRMATION_FIELD_LENGTH` (120) or
   combined detail over `MAX_CONFIRMATION_LENGTH` (600) are rejected, never
   truncated.

v1 kinds: `stop-pane` (destructive), `close-pane` (destructive),
`send-input` (non-destructive).

## 6. Dynamic Type layout preservation

Accessibility text sizes must not cost the user essential identity. At every
supported text size, including the largest accessibility sizes:

1. Pane title, project name, worktree, branch, and host identity keep their own
   line or wrap — they are never clipped, faded out, or collapsed into a
   color/dot treatment.
2. Decoration collapses first: gloss, glow, badges, timestamps, and secondary
   summaries shrink or drop before any identity element does. The combined
   summary (section 3) is the minimum identity set that must remain visible.
3. Layout must not require horizontal scrolling or truncation-ellipsis on the
   identity fields above at accessibility sizes; rows grow vertically instead.
4. Status text (section 2) scales with Dynamic Type like all other text and is
   never conveyed by a fixed-size color swatch only.
5. Monospace/terminal content inside a pane may scroll; cockpit chrome around
   it may not trade identity away to preserve a fixed row height.

## 7. Reduce Motion

`motionTraitsFor()` maps each transition to motion traits classified as
`matched-geometry`, `nonessential-transition`, `essential-state`, or
`non-motion`. With `reduceMotion: true`, matched-geometry and
nonessential-transition traits are stripped; the UI renders the final state
instantly (`rendersInstantStateChange: true` when no trait remains).

v1 transition table:

| Kind | Traits (motion allowed) | Class | Under Reduce Motion |
|---|---|---|---|
| `pane-selection` | `matched-geometry` | matched-geometry | stripped → instant selection change; announcement still fires |
| `pane-focus-change` | `move-transition` | nonessential-transition | stripped → instant focus move |
| `pane-open` | `slide-transition`, `opacity-crossfade` | nonessential-transition | stripped → instant open |
| `pane-close` | `slide-transition`, `opacity-crossfade` | nonessential-transition | stripped → instant close |
| `action-sheet-present` | `slide-transition`, `spring-animation` | nonessential-transition | stripped → instant presentation |
| `action-sheet-dismiss` | `opacity-crossfade` | nonessential-transition | stripped → instant dismissal |
| `summary-refresh` | `opacity-crossfade` | nonessential-transition | stripped → instant text swap |
| `attention-pulse` | `pulse-animation` | nonessential-transition | stripped → static attention treatment + text |
| `activity-progress` | `activity-indicator` | essential-state | **retained** — it is the only live signal that work is ongoing |

Rules:

1. Matched geometry effects and nonessential transitions are removed under
   Reduce Motion. No transition may animate position/scale/opacity for
   decoration when the setting is on.
2. Essential state signals (activity indicators) are retained: they convey
   state, not decoration. They are additionally backed by textual status per
   section 2, so no state depends on animation to be perceived.
3. No state change may be communicated *only* through motion (a pulse, bounce,
   or glow animation without text/announcement).
4. Stripped transitions must not become long-running replacements (no
   crossfades standing in for slides); they become instant state changes.
5. New transition kinds must be added to the v1 table and the descriptor map
   together; an unclassified transition is a contract violation, not an
   implementation detail.

## 8. Stable identifier requirements

XCUITest and assistive tooling anchor to stable identifiers, not display text
(localized or user-renamed) or array indices:

1. Identifier grammar: `psyche.<surface>.<element>.<stable-id>`, kebab-case
   segments, e.g. `psyche.now-row.pane.<paneId>`,
   `psyche.pane.<paneId>`, `psyche.action-sheet.stop-pane`,
   `psyche.action-sheet.confirm`, `psyche.action-sheet.cancel`.
2. `<stable-id>` comes from durable identity the host already assigns (pane id,
   project root/canonical id, host id) — never from pane titles, row indices,
   timestamps, or localized strings.
3. Identifiers are stable across snapshot rebuilds, reconnects, and restore
   (they must survive the stale-state reconciliation this phase adds), so a UI
   test that selects a pane keeps addressing the same element after a refresh.
4. Elements that exist only transiently (confirmation buttons inside an action
   sheet) use fixed kind-scoped identifiers, because the sheet is always the
   same semantic surface regardless of which pane invoked it.
5. Identifiers are additive metadata; they never replace the accessibility
   label (sections 2–5) or the selected trait (section 4).

## 9. Accessibility UI test definition (Now → pane → action sheet)

The required accessibility UI test walks the primary mobile path end-to-end:

1. **Now.** From app launch (paired-host fixture), the Now view exposes rows
   with stable identifiers; a row for a pane in a `needs-you` state is present
   and its accessibility label contains the status textual equivalent
   ("needs your attention"), project, worktree, branch, and host identity.
2. **Pane.** Activating the row opens the pane workspace; the focused pane
   element announces selected state (trait + textual `Selected`) and its label
   preserves identity at accessibility text sizes (launch with the largest
   accessibility content size variant and assert identity fields are present,
   not clipped away).
3. **Action sheet.** Invoking the stop action presents the confirmation sheet
   (`psyche.action-sheet.stop-pane`); the sheet's detail copy is
   consequence-first, names pane/project/host, states that worktree and branch
   survive, and the confirm button is identified
   (`psyche.action-sheet.confirm`). Activating confirm dismisses the sheet and
   the pane reflects the stopped state as text; activating cancel (the negative
   path, exercised by a second run) leaves the pane unchanged.
4. **Reduce Motion variant.** With Reduce Motion enabled, the same flow
   completes with no transition-dependent waits: the sheet is present
   immediately after the action and selection announcement still fires.

This UI test requires a macOS host with the repository-pinned Xcode, iOS
simulator, and XcodeGen (`PSYCHE_AGENT_CHECK_IOS=1`); it cannot run on this
contract's Linux authoring host and is recorded as a proof gap in the working
record until the mobile track runs it. The TS reference implementation and its
unit tests are the v1 executable form of sections 2–7.

## 10. Reference implementation map

| Contract section | Module export |
|---|---|
| §2 status text | `PANE_STATUS_TOKENS`, `PANE_STATUS_DESCRIPTORS`, `describePaneStatus()`, `paneStatusText()` |
| §3 summaries | `summaryForPaneProjectHost()`, `MAX_SUMMARY_FIELD_LENGTH`, `MAX_SUMMARY_LENGTH` |
| §4 selected announcement | `summaryForPaneProjectHost()` `isFocused` input → `selected` part |
| §5 confirmations | `confirmationCopy()`, `MAX_CONFIRMATION_FIELD_LENGTH`, `MAX_CONFIRMATION_LENGTH` |
| §7 motion | `MOTION_TRANSITION_KINDS`, `MOTION_TRAIT_CLASSES`, `motionTraitsFor()` |
| version | `MOTION_SEMANTICS_CONTRACT_ID`, `MOTION_SEMANTICS_CONTRACT_VERSION` |

All exports are pure functions and frozen data; the module performs no I/O and
has no imports, so the Swift port can mirror it without runtime dependencies.
