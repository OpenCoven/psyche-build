// Merge and PR interactive flow machines for mobile clients (v1).
//
// Encodes the interaction contracts for exercising merge and pull-request
// workflows from the mobile cockpit (OpenCoven/psyche-build#219, Bead
// `psyche-i7c.9.3`). The flow contracts this module mirrors live in
// `docs/mobile/MERGE-PR-INTERACTIVE-FLOWS.md`; the GitHub mirror issue and its
// Beads source remain authoritative for the deliverable definition.
//
// This module is a pure interaction-contract slice: it performs no I/O, reads
// no clock, validates no host state, and infers no runtime condition. It wires
// client-side flow state to the *existing* merge/PR action results
// (`src/actions/types.ts` `ActionResult`/`RemoteActionResult`,
// `src/actions/remoteActionSessions.ts` sessions, and the concrete handlers in
// `src/actions/implementations/mergeAction.ts`,
// `src/actions/merge/issueHandlers/*`, and
// `src/actions/implementations/createPullRequestAction.ts`).
//
// Non-negotiable properties enforced here and asserted by
// `__tests__/mergePrFlowMachines.test.ts`:
//
// 1. The host remains the source of truth for all validation. The machines
//    never validate git, pane, worktree, branch, or PR state; they only track
//    which interaction surface the host has opened and transport the user's
//    explicit response back. Content rules (non-empty commit messages, PR
//    title parsing, conflict detection, target resolution) are host-side.
// 2. Every destructive branch requires a confirmation step: a transition that
//    hands the host a consequential operation (`initiates: 'consequential'`)
//    may only fire from a host-opened sheet and only on an explicit user
//    event, and the terminal destructive steps (merge execution, sibling-pane
//    teardown, fallback-target override, PR creation) are additionally gated
//    by a `confirm` sheet the user explicitly accepted (or, for PR creation,
//    by a review session the machine observed opening through such a confirm).
// 3. Cancel is explicit and single-use: every cancellable state accepts
//    `user_cancel` exactly once; the resulting `cancelled` state is terminal
//    and rejects every further event.
// 4. Terminal outcomes are exactly `succeeded`, `failed`, `unknown`, and
//    `recovery_required` (plus the user-abort exit `cancelled`, which is not
//    an outcome of the operation — see `flowOutcomeOf`).
// 5. Host-validation failures land in a typed terminal state
//    (`host_validation_failed`) carrying a machine-readable reason.

import type { RemoteActionResult } from '../actions/types.js';

/** Schema version of the flow-machine contract produced and validated here. */
export const MERGE_PR_FLOW_MACHINE_VERSION = 1;

/**
 * Terminal outcomes of a flow run, in the sense of the issue's acceptance
 * criteria ("merge confirmation/choice chains reach terminal outcomes").
 *
 * - `succeeded`: the host reported the chain completed (e.g. merge applied,
 *   `Created PR: <url>` / `PR already exists: <url>`).
 * - `failed`: the host reported a definitive failure for the chain.
 * - `unknown`: contact with the host was lost while a continuation was in
 *   flight, so the client cannot know whether the operation executed. The
 *   host must be re-queried; the client must not assume either way.
 * - `recovery_required`: the host definitively reported a condition that
 *   needs operator action or re-entry (conflict-resolution handoff, session
 *   loss with nothing in flight, typed host-validation failure).
 */
export type FlowOutcome = 'succeeded' | 'failed' | 'unknown' | 'recovery_required';

/** Statuses that accept no further events of any kind. */
export const TERMINAL_FLOW_STATUSES: readonly string[] = Object.freeze([
  'terminal',
  'host_validation_failed',
  'cancelled',
] as const);

/**
 * Why the host (not the client) rejected or could not continue the flow.
 * Calibrated to the existing action-session and bridge error surfaces:
 * `action_session_not_found`, `action_session_expired`, and
 * `action_session_limit` mirror `src/actions/remoteActionSessions.ts`
 * failure codes; the remainder cover stale workspace state, results the
 * composition layer cannot wire, and host-side input rejection.
 */
export type HostValidationFailureReason =
  | 'action_session_not_found'
  | 'action_session_expired'
  | 'action_session_limit'
  | 'stale_pane_state'
  | 'unexpected_action_result'
  | 'host_rejected_input';

/**
 * Why the machine refused an event. `session_closed` covers every terminal
 * status (including `cancelled`) and is how single-use semantics surface.
 */
export type RejectionReason =
  | 'session_closed'
  | 'unknown_event'
  | 'event_not_applicable'
  | 'option_not_authorized'
  | 'file_not_authorized'
  | 'creation_not_confirmed';

// ---------------------------------------------------------------------------
// Host-reported steps (the sheets the host asks the client to render)
// ---------------------------------------------------------------------------

/** Purposes of `confirm` sheets observed in the existing merge/PR chains. */
export type HostConfirmPurpose =
  | 'sibling_close' // mergeAction "Sibling Agents Active" — merging closes sibling agent panes
  | 'merge_start' // mergeAction "Merge Worktree" — executes the merge
  | 'fallback_target' // "Parent Merge Target Unavailable" / "Parent PR Target Unavailable"
  | 'create_pr'; // createPullRequestAction "Create Pull Request"

/** Purpose of `choice` sheets observed in the existing merge/PR chains. */
export type HostChoicePurpose = 'uncommitted_changes';

/** Purpose of `input` sheets observed in the existing merge/PR chains. */
export type HostInputPurpose = 'commit_message';

/** What the host is executing after an accepted user response. */
export type AwaitingPurpose =
  | HostConfirmPurpose
  | 'host_option' // a non-cancel option chosen on a `choice` sheet
  | 'host_input' // an `input` sheet submitted
  | 'review_submit'; // a PR review sheet submitted

export interface HostConfirmStep {
  readonly kind: 'confirm';
  readonly purpose: HostConfirmPurpose;
  readonly title: string;
  readonly message: string;
}

export interface HostChoiceStep {
  readonly kind: 'choice';
  readonly purpose: HostChoicePurpose;
  readonly title: string;
  readonly message: string;
  /** Exact option ids the host authorized for this sheet. */
  readonly optionIds: readonly string[];
}

export interface HostInputStep {
  readonly kind: 'input';
  readonly purpose: HostInputPurpose;
  readonly title: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

export interface HostPrReviewStep {
  readonly kind: 'pr_review';
  readonly title: string;
  readonly message: string;
  /** Initial editable summary: first line is the title, blank line, then body. */
  readonly initialSummary: string;
  /** Host reports the AI summary generation failed; the sheet must say so. */
  readonly aiFailed: boolean;
  /** Related files the host authorized for navigation/diff peek. */
  readonly relatedFiles: readonly string[];
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

/**
 * A sheet the host opened and authorized the client to render. The machine
 * renders exactly what the host reports and accepts only responses the
 * reported sheet authorizes.
 */
export type HostStep =
  | HostConfirmStep
  | HostChoiceStep
  | HostInputStep
  | HostPrReviewStep;

/**
 * Definitive host terminal results (result shapes that do not ask for a
 * response): `success`, `error`, `navigation` (e.g. the conflict-resolution
 * pane handoff in `multiMergeOrchestrator.ts`), and `info` (chain ended
 * without an operation being attributed, e.g. "Merge cancelled").
 */
export type HostTerminalResult =
  | { readonly kind: 'succeeded'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'navigated';
      readonly message: string;
      readonly targetPaneId?: string;
    }
  | { readonly kind: 'informational'; readonly message: string };

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

/** The open interaction surface (never a `pr_review` sheet in the merge machine). */
export type SheetState =
  | { readonly kind: 'confirm'; readonly step: HostConfirmStep }
  | { readonly kind: 'choice'; readonly step: HostChoiceStep }
  | { readonly kind: 'input'; readonly step: HostInputStep };

/**
 * Live PR review session. `creationConfirmed` is the machine-observed record
 * that the review was reached through an explicitly accepted `create_pr` (or
 * `fallback_target`) confirm sheet; PR creation can only be submitted while
 * it is true. The draft `summary` is client-local — the host parses and
 * validates it on submit (first line = title, blank line, then body).
 */
export interface PrReviewSession {
  readonly creationConfirmed: boolean;
  readonly summary: string;
  readonly aiFailed: boolean;
  readonly relatedFiles: readonly string[];
  readonly focusedFile: string | null;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

/**
 * Structural constraint every flow state satisfies. The optional surface
 * fields let the generic engine read the open sheet/review (for rejection
 * classification) without casts: exactly one of them is present when the
 * status says so, and both are absent otherwise.
 */
interface FlowStateShape {
  readonly status: string;
  readonly sheet?: SheetState;
  readonly review?: PrReviewSession;
}

/**
 * Terminal-state vocabulary shared verbatim by both machines; every member is
 * structurally assignable to both `MergeFlowState` and `PrReviewFlowState`.
 */
type SharedTerminalState =
  | { readonly status: 'terminal'; readonly outcome: FlowOutcome; readonly message: string }
  | {
      readonly status: 'host_validation_failed';
      readonly reason: HostValidationFailureReason;
      readonly message: string;
    }
  | { readonly status: 'cancelled'; readonly message: string };

export type MergeFlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'sheet'; readonly sheet: SheetState }
  | { readonly status: 'awaiting_host'; readonly purpose: AwaitingPurpose }
  | SharedTerminalState;

export type PrReviewFlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'sheet'; readonly sheet: SheetState }
  | { readonly status: 'review'; readonly review: PrReviewSession }
  | { readonly status: 'awaiting_host'; readonly purpose: AwaitingPurpose }
  | SharedTerminalState;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const FLOW_EVENT_TYPES = [
  'host_step',
  'host_result',
  'host_validation_failed',
  'host_session_lost',
  'user_confirm',
  'user_choice',
  'user_input',
  'user_review_edit',
  'user_review_focus_file',
  'user_review_close_file',
  'user_review_submit',
  'user_cancel',
] as const;

export type FlowEventType = (typeof FLOW_EVENT_TYPES)[number];

/** All event types the machines recognize (host-mediated plus user intents). */
export const FLOW_EVENT_TYPE_LIST: readonly FlowEventType[] = FLOW_EVENT_TYPES;

/**
 * Events driving the flow machines.
 *
 * `host_*` events are authoritative reports from the host: the sheet it
 * opened, the definitive result of the chain, a typed validation failure, or
 * loss of the action session. `user_*` events are the user's explicit
 * responses, shaped after `RemoteActionResponse` (`confirm`/`choice`/
 * `input`/`cancel`) plus the PR-review interactions the `pr_review` sheet
 * supports (summary editing, related-file navigation, submission).
 */
export type FlowEvent =
  | { readonly type: 'host_step'; readonly step: HostStep }
  | { readonly type: 'host_result'; readonly result: HostTerminalResult }
  | {
      readonly type: 'host_validation_failed';
      readonly reason: HostValidationFailureReason;
      readonly message: string;
    }
  | { readonly type: 'host_session_lost' }
  | { readonly type: 'user_confirm'; readonly confirmed: boolean }
  | { readonly type: 'user_choice'; readonly optionId: string }
  | { readonly type: 'user_input'; readonly value: string }
  | { readonly type: 'user_review_edit'; readonly summary: string }
  | { readonly type: 'user_review_focus_file'; readonly path: string }
  | { readonly type: 'user_review_close_file' }
  | { readonly type: 'user_review_submit'; readonly summary: string }
  | { readonly type: 'user_cancel' };

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(FLOW_EVENT_TYPES);

// ---------------------------------------------------------------------------
// Transition tables
// ---------------------------------------------------------------------------

/** How a transition is classified for the confirmation-invariant audit. */
export type FlowTransitionEffect = 'execute' | 'view' | 'abort' | 'observe';

export interface FlowTransition<S extends FlowStateShape> {
  /** Event type this row responds to. */
  readonly on: FlowEventType;
  /** Extra predicate (e.g. sheet purpose, option authorization). Pure. */
  readonly guard?: (state: S, event: FlowEvent) => boolean;
  /** Pure next-state function. Only invoked when the guard passed. */
  readonly next: (state: S, event: FlowEvent) => S;
  readonly effect: FlowTransitionEffect;
  /** Set when this transition hands the host a consequential operation. */
  readonly initiates?: 'consequential';
  /**
   * What gates this consequential transition: a `confirm` sheet the user
   * explicitly accepted, or a PR review session reached through one.
   */
  readonly gatedBy?: 'confirm_sheet' | 'confirmed_review';
  /** Documented rationale; surfaced by the audit and in review. */
  readonly note: string;
}

/**
 * Explicit transition table keyed by state status. Rows within a status are
 * evaluated in declaration order; the first row whose `on` matches and whose
 * `guard` passes wins. A row must never be declared for a terminal status.
 */
export type FlowTransitionTable<S extends FlowStateShape> = {
  readonly [status: string]: readonly FlowTransition<S>[] | undefined;
};

const USER_CANCELLED_MESSAGE = 'User cancelled the flow.';

const HOST_RESULT_NOTE =
  'Host reported a definitive result for the chain; the machine records it verbatim (host remains source of truth).';

const HOST_VALIDATION_NOTE =
  'Host reported a typed validation failure; the machine records the typed terminal state.';

function cancelledState(): SharedTerminalState {
  return { status: 'cancelled', message: USER_CANCELLED_MESSAGE };
}

function hostResultToState(result: HostTerminalResult): SharedTerminalState {
  switch (result.kind) {
    case 'succeeded':
      return { status: 'terminal', outcome: 'succeeded', message: result.message };
    case 'failed':
      return { status: 'terminal', outcome: 'failed', message: result.message };
    case 'navigated':
      // Definitive host handoff (e.g. conflict-resolution pane): the operator
      // must act elsewhere, so this is recovery_required, not 'unknown'.
      return {
        status: 'terminal',
        outcome: 'recovery_required',
        message: result.targetPaneId
          ? `${result.message} (target pane: ${result.targetPaneId})`
          : result.message,
      };
    case 'informational':
      // The host ended the chain without attributing an outcome (e.g.
      // "Merge cancelled"). No operation is attributed to this run.
      return { status: 'cancelled', message: result.message };
  }
}

function sheetFromStep(step: HostStep): SheetState {
  switch (step.kind) {
    case 'confirm':
      return { kind: 'confirm', step };
    case 'choice':
      return { kind: 'choice', step };
    case 'input':
      return { kind: 'input', step };
    case 'pr_review':
      // A review sheet cannot be rendered as a plain sheet; every caller that
      // can reach one handles `pr_review` explicitly before calling this.
      throw new RangeError(
        'mergePrFlowMachines: pr_review steps require a review-aware state machine',
      );
  }
}

function reviewSessionFromStep(step: HostPrReviewStep, creationConfirmed: boolean): PrReviewSession {
  return {
    creationConfirmed,
    summary: step.initialSummary,
    aiFailed: step.aiFailed,
    relatedFiles: step.relatedFiles,
    focusedFile: null,
    sourceBranch: step.sourceBranch,
    targetBranch: step.targetBranch,
  };
}

// --- internal-defect helpers (unreachable when the tables below are well-formed) ---

function expectHostStep(event: FlowEvent): Extract<FlowEvent, { type: 'host_step' }> {
  if (event.type !== 'host_step') {
    throw new RangeError(`mergePrFlowMachines: host_step handler received ${event.type}`);
  }
  return event;
}

function expectUserConfirm(event: FlowEvent): Extract<FlowEvent, { type: 'user_confirm' }> {
  if (event.type !== 'user_confirm') {
    throw new RangeError(`mergePrFlowMachines: user_confirm handler received ${event.type}`);
  }
  return event;
}

function expectSheetState(
  state: MergeFlowState | PrReviewFlowState,
): Extract<MergeFlowState | PrReviewFlowState, { status: 'sheet' }> {
  if (state.status !== 'sheet') {
    throw new RangeError(`mergePrFlowMachines: sheet handler received ${state.status}`);
  }
  return state;
}

function expectReviewState(
  state: PrReviewFlowState,
): Extract<PrReviewFlowState, { status: 'review' }> {
  if (state.status !== 'review') {
    throw new RangeError(`mergePrFlowMachines: review handler received ${state.status}`);
  }
  return state;
}

function expectAwaitingState<S extends FlowStateShape>(
  state: S,
): Extract<S, { status: 'awaiting_host' }> {
  if (state.status !== 'awaiting_host') {
    throw new RangeError(`mergePrFlowMachines: awaiting_host handler received ${state.status}`);
  }
  return state as Extract<S, { status: 'awaiting_host' }>;
}

/** Internal-defect guard for row `next` functions that must never see this. */
function throwRowDefect(row: string, seen: string): never {
  throw new RangeError(`mergePrFlowMachines: ${row} handler received ${seen}`);
}

// --- shared row builders (concrete per machine, so no casts are needed) ------

function hostResultRowMerge(): FlowTransition<MergeFlowState> {
  return {
    on: 'host_result',
    effect: 'observe',
    note: HOST_RESULT_NOTE,
    next: (_state, event) =>
      event.type === 'host_result'
        ? hostResultToState(event.result)
        : throwRowDefect('host_result', event.type),
  };
}

function hostResultRowPr(): FlowTransition<PrReviewFlowState> {
  return {
    on: 'host_result',
    effect: 'observe',
    note: HOST_RESULT_NOTE,
    next: (_state, event) =>
      event.type === 'host_result'
        ? hostResultToState(event.result)
        : throwRowDefect('host_result', event.type),
  };
}

function hostValidationRowMerge(): FlowTransition<MergeFlowState> {
  return {
    on: 'host_validation_failed',
    effect: 'observe',
    note: HOST_VALIDATION_NOTE,
    next: (_state, event) =>
      event.type === 'host_validation_failed'
        ? { status: 'host_validation_failed', reason: event.reason, message: event.message }
        : throwRowDefect('host_validation_failed', event.type),
  };
}

function hostValidationRowPr(): FlowTransition<PrReviewFlowState> {
  return {
    on: 'host_validation_failed',
    effect: 'observe',
    note: HOST_VALIDATION_NOTE,
    next: (_state, event) =>
      event.type === 'host_validation_failed'
        ? { status: 'host_validation_failed', reason: event.reason, message: event.message }
        : throwRowDefect('host_validation_failed', event.type),
  };
}

function confirmSheetFrom(
  event: FlowEvent,
): { readonly status: 'sheet'; readonly sheet: { readonly kind: 'confirm'; readonly step: Extract<HostStep, { kind: 'confirm' }> } } {
  const step = expectHostStep(event).step;
  if (step.kind !== 'confirm') {
    return throwRowDefect('confirm sheet handler', step.kind);
  }
  return { status: 'sheet', sheet: { kind: 'confirm', step } };
}

function choiceSheetFrom(
  event: FlowEvent,
): { readonly status: 'sheet'; readonly sheet: { readonly kind: 'choice'; readonly step: Extract<HostStep, { kind: 'choice' }> } } {
  const step = expectHostStep(event).step;
  if (step.kind !== 'choice') {
    return throwRowDefect('choice sheet handler', step.kind);
  }
  return { status: 'sheet', sheet: { kind: 'choice', step } };
}

function inputSheetFrom(
  event: FlowEvent,
): { readonly status: 'sheet'; readonly sheet: { readonly kind: 'input'; readonly step: Extract<HostStep, { kind: 'input' }> } } {
  const step = expectHostStep(event).step;
  if (step.kind !== 'input') {
    return throwRowDefect('input sheet handler', step.kind);
  }
  return { status: 'sheet', sheet: { kind: 'input', step } };
}

function nonReviewSheetFrom(event: FlowEvent): SheetState {
  const step = expectHostStep(event).step;
  if (step.kind === 'pr_review') {
    return throwRowDefect('merge sheet handler', step.kind);
  }
  return sheetFromStep(step);
}

function reviewFromStep(event: FlowEvent, creationConfirmed: boolean): PrReviewFlowState {
  const step = expectHostStep(event).step;
  if (step.kind !== 'pr_review') {
    return throwRowDefect('pr_review sheet handler', step.kind);
  }
  return { status: 'review', review: reviewSessionFromStep(step, creationConfirmed) };
}

// ---------------------------------------------------------------------------
// mergeFlowMachine table
// ---------------------------------------------------------------------------

/**
 * Explicit transition table for the merge flow, wired to the existing merge
 * action chain: sibling-pane teardown confirmation and merge confirmation
 * (`mergeAction.ts`), uncommitted-changes choices (`worktreeUncommittedHandler.ts`
 * / `mainDirtyHandler.ts`), commit-message input (`commitMessageHandler.ts`),
 * fallback-target confirmation (`buildMergeTargetFallbackConfirmation`), and
 * the conflict-resolution navigation handoff (`multiMergeOrchestrator.ts`).
 */
export const MERGE_FLOW_TRANSITIONS: FlowTransitionTable<MergeFlowState> = {
  idle: [
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'confirm' && e.step.purpose === 'sibling_close',
      effect: 'view',
      note: 'Host opened the "Sibling Agents Active" confirm sheet.',
      next: (_s, e) => confirmSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'confirm' && e.step.purpose === 'merge_start',
      effect: 'view',
      note: 'Host opened the "Merge Worktree" confirm sheet.',
      next: (_s, e) => confirmSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'confirm' && e.step.purpose === 'fallback_target',
      effect: 'view',
      note: 'Host opened a "Parent Merge Target Unavailable" fallback confirm sheet.',
      next: (_s, e) => confirmSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'choice' && e.step.purpose === 'uncommitted_changes',
      effect: 'view',
      note: 'Host reported uncommitted changes and opened the commit/stash choice sheet.',
      next: (_s, e) => choiceSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'input' && e.step.purpose === 'commit_message',
      effect: 'view',
      note: 'Host opened a commit-message input sheet.',
      next: (_s, e) => inputSheetFrom(e),
    },
    hostResultRowMerge(),
    hostValidationRowMerge(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Action session lost at idle: nothing was in flight, so nothing is unknown; recovery is to restart the merge.',
      next: () => ({
        status: 'terminal',
        outcome: 'recovery_required',
        message: 'Action session lost before the merge started; restart the merge from the pane menu.',
      }),
    },
    {
      on: 'user_cancel',
      effect: 'abort',
      note: 'Explicit cancel path: abandon before the host reports anything.',
      next: () => cancelledState(),
    },
  ],

  sheet: [
    {
      on: 'user_confirm',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'confirm' &&
        e.type === 'user_confirm' &&
        e.confirmed,
      effect: 'execute',
      initiates: 'consequential',
      gatedBy: 'confirm_sheet',
      note: 'User accepted the confirm sheet (sibling teardown, merge execution, or fallback-target override); the host executes that branch.',
      next: (s, e) => {
        const sheet = expectSheetState(s);
        expectUserConfirm(e);
        if (sheet.sheet.kind !== 'confirm') {
          return throwRowDefect('confirm accept', sheet.sheet.kind);
        }
        return { status: 'awaiting_host', purpose: sheet.sheet.step.purpose };
      },
    },
    {
      on: 'user_confirm',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'confirm' &&
        e.type === 'user_confirm' &&
        !e.confirmed,
      effect: 'abort',
      note: 'User declined the confirm sheet: explicit abort of this chain.',
      next: () => cancelledState(),
    },
    {
      on: 'user_choice',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'choice' &&
        e.type === 'user_choice' &&
        e.optionId === 'cancel',
      effect: 'abort',
      note: 'Host convention: option id "cancel" on a choice sheet aborts the chain.',
      next: () => cancelledState(),
    },
    {
      on: 'user_choice',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'choice' &&
        e.type === 'user_choice' &&
        e.optionId !== 'cancel' &&
        s.sheet.step.optionIds.includes(e.optionId),
      effect: 'execute',
      initiates: 'consequential',
      note: 'User selected a host-authorized option (commit automatic/editable/manual, stash); the host executes that branch. The explicit selection is the guarded confirmation the host designed for this branch.',
      next: () => ({ status: 'awaiting_host', purpose: 'host_option' }),
    },
    {
      on: 'user_input',
      guard: (s) => s.status === 'sheet' && s.sheet.kind === 'input',
      effect: 'execute',
      initiates: 'consequential',
      note: 'User submitted the commit message; the host validates content (e.g. non-empty) and commits. The machine transports the value without judging it.',
      next: () => ({ status: 'awaiting_host', purpose: 'host_input' }),
    },
    {
      on: 'user_cancel',
      effect: 'abort',
      note: 'Explicit single-use cancel from any open sheet.',
      next: () => cancelledState(),
    },
    {
      on: 'host_step',
      effect: 'view',
      note: 'Host superseded the open sheet with a new one (authoritative; e.g. re-issued sheet).',
      next: (s, e) => {
        void expectSheetState(s);
        return { status: 'sheet', sheet: nonReviewSheetFrom(e) };
      },
    },
    hostResultRowMerge(),
    hostValidationRowMerge(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Session lost with only a sheet open: no continuation was in flight, so nothing is unknown; recovery is to restart the flow.',
      next: () => ({
        status: 'terminal',
        outcome: 'recovery_required',
        message:
          'Action session lost while a sheet was open; no operation was in flight. Restart the flow.',
      }),
    },
  ],

  awaiting_host: [
    {
      on: 'host_step',
      effect: 'view',
      note: 'The in-flight continuation returned the next sheet in the chain (e.g. sibling confirm → merge confirm → uncommitted choice → commit input).',
      next: (_s, e) => ({ status: 'sheet', sheet: nonReviewSheetFrom(e) }),
    },
    hostResultRowMerge(),
    hostValidationRowMerge(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Session lost while a continuation was in flight: the merge may or may not have executed. Outcome is unknown; the host must be re-queried.',
      next: (s) => ({
        status: 'terminal',
        outcome: 'unknown' as const,
        message: `Action session lost while the host was executing "${expectAwaitingState(s).purpose}". Re-query the host; do not assume the merge ran.`,
      }),
    },
  ],
};

// ---------------------------------------------------------------------------
// prReviewFlowMachine table
// ---------------------------------------------------------------------------

/**
 * Explicit transition table for the PR review flow, wired to the existing
 * create-PR action chain: creation/fallback confirmations
 * (`buildCreatePullRequestConfirmation` / `buildFallbackPullRequestConfirmation`
 * in `createPullRequestAction.ts`), the `pr_review` sheet (editable summary,
 * related-file navigation, generated-summary editing, `aiFailed` warning), and
 * the final URL messages (`Created PR: <url>` / `PR already exists: <url>`).
 */
export const PR_REVIEW_FLOW_TRANSITIONS: FlowTransitionTable<PrReviewFlowState> = {
  idle: [
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'confirm' && e.step.purpose === 'create_pr',
      effect: 'view',
      note: 'Host opened the "Create Pull Request" confirm sheet.',
      next: (_s, e) => confirmSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'confirm' && e.step.purpose === 'fallback_target',
      effect: 'view',
      note: 'Host opened a "Parent PR Target Unavailable" fallback confirm sheet.',
      next: (_s, e) => confirmSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'choice' && e.step.purpose === 'uncommitted_changes',
      effect: 'view',
      note: 'Host reported uncommitted changes and opened the commit choice sheet.',
      next: (_s, e) => choiceSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) =>
        e.type === 'host_step' && e.step.kind === 'input' && e.step.purpose === 'commit_message',
      effect: 'view',
      note: 'Host opened a commit-message input sheet.',
      next: (_s, e) => inputSheetFrom(e),
    },
    {
      on: 'host_step',
      guard: (_s, e) => e.type === 'host_step' && e.step.kind === 'pr_review',
      effect: 'view',
      note: 'Host opened the PR review sheet directly. Creation stays unconfirmed: submit is rejected until a machine-observed confirm sheet is accepted.',
      next: (_s, e) => reviewFromStep(e, false),
    },
    hostResultRowPr(),
    hostValidationRowPr(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Action session lost at idle: nothing was in flight; recovery is to restart the PR flow.',
      next: () => ({
        status: 'terminal',
        outcome: 'recovery_required',
        message: 'Action session lost before the PR flow started; restart it from the pane menu.',
      }),
    },
    {
      on: 'user_cancel',
      effect: 'abort',
      note: 'Explicit cancel path: abandon before the host reports anything.',
      next: () => cancelledState(),
    },
  ],

  sheet: [
    {
      on: 'user_confirm',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'confirm' &&
        e.type === 'user_confirm' &&
        e.confirmed,
      effect: 'execute',
      initiates: 'consequential',
      gatedBy: 'confirm_sheet',
      note: 'User accepted the PR creation (or fallback-target) confirm sheet; the host generates the summary and opens the review sheet.',
      next: (s, e) => {
        const sheet = expectSheetState(s);
        expectUserConfirm(e);
        if (sheet.sheet.kind !== 'confirm') {
          return throwRowDefect('confirm accept', sheet.sheet.kind);
        }
        return { status: 'awaiting_host', purpose: sheet.sheet.step.purpose };
      },
    },
    {
      on: 'user_confirm',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'confirm' &&
        e.type === 'user_confirm' &&
        !e.confirmed,
      effect: 'abort',
      note: 'User declined the confirm sheet: explicit abort of this chain.',
      next: () => cancelledState(),
    },
    {
      on: 'user_choice',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'choice' &&
        e.type === 'user_choice' &&
        e.optionId === 'cancel',
      effect: 'abort',
      note: 'Host convention: option id "cancel" on a choice sheet aborts the chain.',
      next: () => cancelledState(),
    },
    {
      on: 'user_choice',
      guard: (s, e) =>
        s.status === 'sheet' &&
        s.sheet.kind === 'choice' &&
        e.type === 'user_choice' &&
        e.optionId !== 'cancel' &&
        s.sheet.step.optionIds.includes(e.optionId),
      effect: 'execute',
      initiates: 'consequential',
      note: 'User selected a host-authorized option; the host executes that branch.',
      next: () => ({ status: 'awaiting_host', purpose: 'host_option' }),
    },
    {
      on: 'user_input',
      guard: (s) => s.status === 'sheet' && s.sheet.kind === 'input',
      effect: 'execute',
      initiates: 'consequential',
      note: 'User submitted the commit message; the host validates content and commits.',
      next: () => ({ status: 'awaiting_host', purpose: 'host_input' }),
    },
    {
      on: 'user_cancel',
      effect: 'abort',
      note: 'Explicit single-use cancel from any open sheet.',
      next: () => cancelledState(),
    },
    {
      on: 'host_step',
      effect: 'view',
      note: 'Host superseded the open sheet; a direct pr_review supersede keeps creation unconfirmed (fail closed).',
      next: (s, e) => {
        void expectSheetState(s);
        const step = expectHostStep(e).step;
        if (step.kind === 'pr_review') {
          return reviewFromStep(e, false);
        }
        return { status: 'sheet', sheet: sheetFromStep(step) };
      },
    },
    hostResultRowPr(),
    hostValidationRowPr(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Session lost with only a sheet open: nothing was in flight; recovery is to restart the flow.',
      next: () => ({
        status: 'terminal',
        outcome: 'recovery_required',
        message:
          'Action session lost while a sheet was open; no operation was in flight. Restart the flow.',
      }),
    },
  ],

  review: [
    {
      on: 'user_review_edit',
      guard: (s) => s.status === 'review',
      effect: 'view',
      note: 'User edited the summary draft (title/body). Client-local only; the host parses and validates on submit (first line = title, blank line, then body).',
      next: (s, e) => {
        const review = expectReviewState(s);
        if (e.type !== 'user_review_edit') {
          return throwRowDefect('review edit', e.type);
        }
        return { status: 'review', review: { ...review.review, summary: e.summary } };
      },
    },
    {
      on: 'user_review_focus_file',
      guard: (s, e) =>
        s.status === 'review' &&
        e.type === 'user_review_focus_file' &&
        s.review.relatedFiles.includes(e.path),
      effect: 'view',
      note: 'User opened a host-authorized related file for navigation/diff peek.',
      next: (s, e) => {
        const review = expectReviewState(s);
        if (e.type !== 'user_review_focus_file') {
          return throwRowDefect('review focus', e.type);
        }
        return { status: 'review', review: { ...review.review, focusedFile: e.path } };
      },
    },
    {
      on: 'user_review_close_file',
      guard: (s) => s.status === 'review',
      effect: 'view',
      note: 'User closed the file peek and returned to the review sheet.',
      next: (s) => {
        const review = expectReviewState(s);
        return { status: 'review', review: { ...review.review, focusedFile: null } };
      },
    },
    {
      on: 'user_review_submit',
      guard: (s) => s.status === 'review' && s.review.creationConfirmed,
      effect: 'execute',
      initiates: 'consequential',
      gatedBy: 'confirmed_review',
      note: 'User submitted the reviewed summary for PR creation. Gated on the machine-observed confirmed creation confirm; the host validates the content (e.g. non-empty title).',
      next: (_s, e) => {
        if (e.type !== 'user_review_submit') {
          return throwRowDefect('review submit', e.type);
        }
        return { status: 'awaiting_host', purpose: 'review_submit' };
      },
    },
    {
      on: 'user_cancel',
      effect: 'abort',
      note: 'Explicit single-use cancel from the review sheet.',
      next: () => cancelledState(),
    },
    {
      on: 'host_step',
      effect: 'view',
      note: 'Host superseded the review sheet; a fresh pr_review step starts a fresh (unconfirmed) review session.',
      next: (s, e) => {
        void expectReviewState(s);
        const step = expectHostStep(e).step;
        if (step.kind === 'pr_review') {
          return reviewFromStep(e, false);
        }
        return { status: 'sheet', sheet: sheetFromStep(step) };
      },
    },
    hostResultRowPr(),
    hostValidationRowPr(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Session lost with only the review sheet open: no continuation was in flight; recovery is to restart the PR flow.',
      next: () => ({
        status: 'terminal',
        outcome: 'recovery_required',
        message:
          'Action session lost while the PR review sheet was open; no operation was in flight. Restart the flow.',
      }),
    },
  ],

  awaiting_host: [
    {
      on: 'host_step',
      guard: (_s, e) => e.type === 'host_step' && e.step.kind === 'pr_review',
      effect: 'view',
      note: 'The in-flight continuation (summary generation) returned the PR review sheet. creationConfirmed is inherited from the accepted confirm purpose, so submit stays gated.',
      next: (s, e) => {
        const awaiting = expectAwaitingState(s);
        const confirmed =
          awaiting.purpose === 'create_pr' || awaiting.purpose === 'fallback_target';
        return reviewFromStep(e, confirmed);
      },
    },
    {
      on: 'host_step',
      guard: (_s, e) => e.type === 'host_step' && e.step.kind !== 'pr_review',
      effect: 'view',
      note: 'The in-flight continuation returned another sheet (e.g. uncommitted choice or commit input).',
      next: (_s, e) => {
        const step = expectHostStep(e).step;
        if (step.kind === 'pr_review') {
          return throwRowDefect('pr_review dispatch', step.kind);
        }
        return { status: 'sheet', sheet: sheetFromStep(step) };
      },
    },
    hostResultRowPr(),
    hostValidationRowPr(),
    {
      on: 'host_session_lost',
      effect: 'observe',
      note: 'Session lost while a continuation was in flight (summary generation or PR creation): the PR may or may not exist. Outcome is unknown; the host must be re-queried.',
      next: (s) => ({
        status: 'terminal',
        outcome: 'unknown' as const,
        message: `Action session lost while the host was executing "${expectAwaitingState(s).purpose}". Re-query the host; do not assume the PR exists.`,
      }),
    },
  ],
};

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

export interface FlowMachine<S extends FlowStateShape> {
  readonly version: typeof MERGE_PR_FLOW_MACHINE_VERSION;
  readonly initialState: S;
  readonly transitions: FlowTransitionTable<S>;
  readonly reduce: (state: S, event: FlowEvent) => TransitionResult<S>;
}

/** Pure state machine for the mobile merge flow (no I/O, no clock). */
export const mergeFlowMachine: FlowMachine<MergeFlowState> = {
  version: MERGE_PR_FLOW_MACHINE_VERSION,
  initialState: { status: 'idle' },
  transitions: MERGE_FLOW_TRANSITIONS,
  reduce: (state, event) => reduceFlow(MERGE_FLOW_TRANSITIONS, state, event),
};

/** Pure state machine for the mobile PR review flow (no I/O, no clock). */
export const prReviewFlowMachine: FlowMachine<PrReviewFlowState> = {
  version: MERGE_PR_FLOW_MACHINE_VERSION,
  initialState: { status: 'idle' },
  transitions: PR_REVIEW_FLOW_TRANSITIONS,
  reduce: (state, event) => reduceFlow(PR_REVIEW_FLOW_TRANSITIONS, state, event),
};

// ---------------------------------------------------------------------------
// Reducer engine
// ---------------------------------------------------------------------------

export type TransitionResult<S extends FlowStateShape> =
  | { readonly ok: true; readonly state: S }
  | { readonly ok: false; readonly state: S; readonly reason: RejectionReason };

/**
 * Pure reducer over an explicit transition table. First matching row wins.
 * Terminal states (including `cancelled`) reject every event with
 * `session_closed` — that is the whole of the single-use guarantee.
 */
export function reduceFlow<S extends FlowStateShape>(
  table: FlowTransitionTable<S>,
  state: S,
  event: FlowEvent,
): TransitionResult<S> {
  if (TERMINAL_FLOW_STATUSES.includes(state.status)) {
    return { ok: false, state, reason: 'session_closed' };
  }
  const rows = table[state.status] ?? [];
  for (const row of rows) {
    if (row.on !== event.type) continue;
    if (row.guard && !row.guard(state, event)) continue;
    return { ok: true, state: row.next(state, event) };
  }
  if (!KNOWN_EVENT_TYPES.has(event.type)) {
    return { ok: false, state, reason: 'unknown_event' };
  }
  if (!rows.some((row) => row.on === event.type)) {
    return { ok: false, state, reason: 'event_not_applicable' };
  }
  // A row exists for this event type in this status, but every guard rejected
  // it: classify the failure precisely. A mismatch between the event and the
  // open surface (e.g. a choice response on a confirm sheet) is
  // `event_not_applicable`; a mismatch with what the host authorized
  // (option id, related file, confirmed creation) gets its own reason.
  const openSheetKind = state.status === 'sheet' ? state.sheet?.kind : undefined;
  const openReview = state.status === 'review' ? state.review : undefined;
  switch (event.type) {
    case 'user_choice':
      return {
        ok: false,
        state,
        reason:
          openSheetKind === 'choice' ? 'option_not_authorized' : 'event_not_applicable',
      };
    case 'user_review_focus_file':
      return {
        ok: false,
        state,
        reason: openReview !== undefined ? 'file_not_authorized' : 'event_not_applicable',
      };
    case 'user_review_submit':
      return {
        ok: false,
        state,
        reason:
          openReview !== undefined && !openReview.creationConfirmed
            ? 'creation_not_confirmed'
            : 'event_not_applicable',
      };
    default:
      return { ok: false, state, reason: 'event_not_applicable' };
  }
}

/** True once the machine will accept no further events (single-use closure). */
export function isFlowTerminal(state: MergeFlowState | PrReviewFlowState): boolean {
  return TERMINAL_FLOW_STATUSES.includes(state.status);
}

/**
 * Contract outcome of a run: one of the four terminal outcomes, the explicit
 * user/host abort exit `cancelled` (no outcome is attributed — the host
 * reported no result), or `null` while the flow is still active.
 */
export function flowOutcomeOf(
  state: MergeFlowState | PrReviewFlowState,
): FlowOutcome | 'cancelled' | null {
  switch (state.status) {
    case 'terminal':
      return state.outcome;
    case 'host_validation_failed':
      return 'recovery_required';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Structural audit: destructive branches require confirmation steps
// ---------------------------------------------------------------------------

export interface FlowAuditViolation {
  /** State status the violating row is declared under. */
  readonly status: string;
  /** Index of the row within that status (-1 for table-level problems). */
  readonly ruleIndex: number;
  readonly problem: string;
}

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_FLOW_STATUSES);

/**
 * Audits a transition table against the flow-contract invariants. Returns an
 * empty list when the table is well-formed. The checks are structural:
 *
 * 1. Terminal statuses declare no rows (single-use closure is total).
 * 2. Every cancellable non-terminal status other than `awaiting_host`
 *    declares exactly one `user_cancel` row, classified as `abort`
 *    (explicit cancel paths everywhere).
 * 3. `awaiting_host` declares no user rows (an in-flight continuation cannot
 *    be cancelled client-side; the host will report the next state).
 * 4. Every consequential transition is an explicit user `execute` from a
 *    sheet/review state — never fired automatically or by a host event.
 * 5. `gatedBy` annotations match the source state kind, and every gated row
 *    is consequential (the terminal destructive steps are confirm-gated).
 */
export function auditFlowMachine<S extends FlowStateShape>(
  transitions: FlowTransitionTable<S>,
): readonly FlowAuditViolation[] {
  const violations: FlowAuditViolation[] = [];

  for (const [status, rows] of Object.entries(transitions)) {
    const tableRows = rows ?? [];
    if (TERMINAL_STATUS_SET.has(status)) {
      for (let index = 0; index < tableRows.length; index += 1) {
        violations.push({
          status,
          ruleIndex: index,
          problem: `terminal status "${status}" must not declare transitions`,
        });
      }
      continue;
    }

    if (status === 'awaiting_host') {
      tableRows.forEach((row, index) => {
        if (row.on.startsWith('user_')) {
          violations.push({
            status,
            ruleIndex: index,
            problem: 'an in-flight continuation must not accept user events',
          });
        }
      });
    } else {
      const cancelRows = tableRows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.on === 'user_cancel');
      if (cancelRows.length !== 1) {
        violations.push({
          status,
          ruleIndex: -1,
          problem: `cancellable status "${status}" must declare exactly one user_cancel row (found ${cancelRows.length})`,
        });
      }
      for (const { row, index } of cancelRows) {
        if (row.effect !== 'abort') {
          violations.push({
            status,
            ruleIndex: index,
            problem: 'user_cancel rows must be classified as "abort"',
          });
        }
      }
    }

    tableRows.forEach((row, index) => {
      if (row.initiates === 'consequential') {
        if (row.effect !== 'execute') {
          violations.push({
            status,
            ruleIndex: index,
            problem: 'consequential transitions must be classified as "execute"',
          });
        }
        if (!row.on.startsWith('user_')) {
          violations.push({
            status,
            ruleIndex: index,
            problem: 'consequential transitions must be triggered by explicit user events',
          });
        }
        if (status !== 'sheet' && status !== 'review') {
          violations.push({
            status,
            ruleIndex: index,
            problem:
              'consequential transitions must originate from a host-opened sheet or review state',
          });
        }
      }
      if (row.gatedBy === 'confirm_sheet' && status !== 'sheet') {
        violations.push({
          status,
          ruleIndex: index,
          problem: 'gatedBy "confirm_sheet" requires the source state to be a sheet',
        });
      }
      if (row.gatedBy === 'confirmed_review' && status !== 'review') {
        violations.push({
          status,
          ruleIndex: index,
          problem: 'gatedBy "confirmed_review" requires the source state to be a review',
        });
      }
      if (row.gatedBy !== undefined && row.initiates !== 'consequential') {
        violations.push({
          status,
          ruleIndex: index,
          problem: 'gated rows must be consequential',
        });
      }
      if (row.note.trim().length === 0) {
        violations.push({
          status,
          ruleIndex: index,
          problem: 'every row must document its rationale',
        });
      }
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Wiring adapters: existing action results -> machine events (pure)
// ---------------------------------------------------------------------------

/**
 * Confirm-sheet titles observed in the existing merge/PR chains, mapped to
 * machine purposes. Composition layers may pass an explicit purpose hint
 * instead when the host adds a machine-readable marker; unrecognized titles
 * without a hint fail closed (the adapter returns `null`).
 */
export const CONFIRM_PURPOSE_BY_TITLE: Readonly<
  Record<string, HostConfirmPurpose | undefined>
> = Object.freeze({
  // mergeAction.ts: sibling teardown confirmation
  'Sibling Agents Active': 'sibling_close',
  // mergeAction.ts buildMergeConfirmation
  'Merge Worktree': 'merge_start',
  // mergeAction.ts buildMergeTargetFallbackConfirmation
  'Parent Merge Target Unavailable': 'fallback_target',
  // createPullRequestAction.ts buildCreatePullRequestConfirmation
  'Create Pull Request': 'create_pr',
  // createPullRequestAction.ts buildFallbackPullRequestConfirmation
  'Parent PR Target Unavailable': 'fallback_target',
});

/**
 * Maps a serialized (callback-free) action result — exactly what a mobile
 * client receives over the bridge after `RemoteActionSessions.start`/`respond`
 * — to the `host_step` event the machines consume. Returns `null` for result
 * shapes that are not response-requiring sheets (use
 * {@link hostResultFromRemoteActionResult} for those) and for sheets it
 * cannot classify (fail closed: treat as `unexpected_action_result`).
 */
export function hostStepFromRemoteActionResult(
  result: RemoteActionResult,
  confirmPurposeHint?: HostConfirmPurpose,
): { readonly type: 'host_step'; readonly step: HostStep } | null {
  switch (result.type) {
    case 'confirm': {
      const purpose =
        confirmPurposeHint ??
        (result.title !== undefined ? CONFIRM_PURPOSE_BY_TITLE[result.title] : undefined);
      if (purpose === undefined) return null;
      return {
        type: 'host_step',
        step: {
          kind: 'confirm',
          purpose,
          title: result.title ?? '',
          message: result.message,
        },
      };
    }
    case 'choice': {
      // The existing uncommitted-changes handlers mark their payload with
      // data.kind = 'merge_uncommitted' (both merge and PR chains).
      if (result.data?.kind !== 'merge_uncommitted') return null;
      return {
        type: 'host_step',
        step: {
          kind: 'choice',
          purpose: 'uncommitted_changes',
          title: result.title ?? '',
          message: result.message,
          optionIds: (result.options ?? []).map((option) => option.id),
        },
      };
    }
    case 'input':
      return {
        type: 'host_step',
        step: {
          kind: 'input',
          purpose: 'commit_message',
          title: result.title ?? '',
          message: result.message,
          ...(result.placeholder !== undefined ? { placeholder: result.placeholder } : {}),
          ...(result.defaultValue !== undefined ? { defaultValue: result.defaultValue } : {}),
        },
      };
    case 'pr_review': {
      const reviewData = result.reviewData;
      if (!reviewData) return null;
      return {
        type: 'host_step',
        step: {
          kind: 'pr_review',
          title: result.title ?? '',
          message: result.message,
          initialSummary: result.defaultValue ?? '',
          aiFailed: reviewData.aiFailed ?? false,
          relatedFiles: result.relatedFiles ?? reviewData.files,
          sourceBranch: reviewData.sourceBranch,
          targetBranch: reviewData.targetBranch,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Maps a serialized action result to the definitive `host_result` event.
 * Returns `null` for response-requiring sheets (use
 * {@link hostStepFromRemoteActionResult}) and for `progress` (a transient
 * display concern the machines do not model).
 */
export function hostResultFromRemoteActionResult(
  result: RemoteActionResult,
): { readonly type: 'host_result'; readonly result: HostTerminalResult } | null {
  switch (result.type) {
    case 'success':
      return { type: 'host_result', result: { kind: 'succeeded', message: result.message } };
    case 'error':
      return { type: 'host_result', result: { kind: 'failed', message: result.message } };
    case 'navigation':
      return {
        type: 'host_result',
        result: {
          kind: 'navigated',
          message: result.message,
          ...(result.targetPaneId !== undefined ? { targetPaneId: result.targetPaneId } : {}),
        },
      };
    case 'info':
      return { type: 'host_result', result: { kind: 'informational', message: result.message } };
    default:
      return null;
  }
}
