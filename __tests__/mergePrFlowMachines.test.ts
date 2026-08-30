// Transition-table tests for the mobile merge/PR interactive flow machines
// (OpenCoven/psyche-build#219, Bead psyche-i7c.9.3).
//
// These tests assert the flow-contract invariants documented in
// `docs/mobile/MERGE-PR-INTERACTIVE-FLOWS.md`:
// - every destructive branch requires a confirmation step (structural audit
//   plus concrete path walks);
// - cancel is explicit and single-use (terminal, all further events rejected);
// - host-validation failures reach the typed error state;
// - sibling-pane and fallback-target paths are reachable;
// - unknown events (and unauthorized options/files) are rejected.

import { describe, expect, it } from 'vitest';

import { serializeActionResult } from '../src/actions/remoteActionSessions.js';
import type { ActionResult, RemoteActionResult } from '../src/actions/types.js';
import {
  CONFIRM_PURPOSE_BY_TITLE,
  FLOW_EVENT_TYPE_LIST,
  MERGE_PR_FLOW_MACHINE_VERSION,
  MERGE_FLOW_TRANSITIONS,
  PR_REVIEW_FLOW_TRANSITIONS,
  auditFlowMachine,
  flowOutcomeOf,
  hostResultFromRemoteActionResult,
  hostStepFromRemoteActionResult,
  isFlowTerminal,
  mergeFlowMachine,
  prReviewFlowMachine,
  type FlowEvent,
  type FlowTransition,
  type HostPrReviewStep,
  type HostStep,
  type MergeFlowState,
  type PrReviewFlowState,
  type TransitionResult,
} from '../src/mobile/mergePrFlowMachines.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyFlowState = MergeFlowState | PrReviewFlowState;
type AnyTransitionResult = TransitionResult<AnyFlowState>;
/** Both machines, callable with any well-formed flow state. */
type AnyMachine = {
  readonly reduce: (state: never, event: FlowEvent) => AnyTransitionResult;
};

const mergeMachine = mergeFlowMachine as unknown as AnyMachine;
const prMachine = prReviewFlowMachine as unknown as AnyMachine;

const UNCOMMITTED_OPTION_IDS = [
  'commit_automatic',
  'commit_ai_editable',
  'commit_manual',
  'stash_main',
  'cancel',
] as const;

const RELATED_FILES = ['src/a.ts', 'src/b.ts'] as const;

function mergeStartStep() {
  return {
    kind: 'confirm' as const,
    purpose: 'merge_start' as const,
    title: 'Merge Worktree',
    message: 'Merge "wt" into "main"?',
  };
}

function siblingCloseStep() {
  return {
    kind: 'confirm' as const,
    purpose: 'sibling_close' as const,
    title: 'Sibling Agents Active',
    message: '1 other agent(s) (sib) are using this worktree. Merging will close them all. Proceed?',
  };
}

function fallbackMergeStep() {
  return {
    kind: 'confirm' as const,
    purpose: 'fallback_target' as const,
    title: 'Parent Merge Target Unavailable',
    message: '"parent" is no longer available. Merge into "main" instead?',
  };
}

function uncommittedChoiceStep() {
  return {
    kind: 'choice' as const,
    purpose: 'uncommitted_changes' as const,
    title: 'Worktree Has Uncommitted Changes',
    message: 'This worktree has uncommitted changes that must be committed before merge.',
    optionIds: UNCOMMITTED_OPTION_IDS,
  };
}

function commitInputStep() {
  return {
    kind: 'input' as const,
    purpose: 'commit_message' as const,
    title: 'Commit Message',
    message: 'Write your own commit message',
    placeholder: 'feat: add new feature',
  };
}

function createPrStep() {
  return {
    kind: 'confirm' as const,
    purpose: 'create_pr' as const,
    title: 'Create Pull Request',
    message: 'Push "wt" and create a GitHub pull request into "parent"?',
  };
}

function prReviewStep(overrides: Partial<HostPrReviewStep> = {}): HostPrReviewStep {
  return {
    kind: 'pr_review',
    title: 'PR into "parent"',
    message: 'Review the AI-generated summary. First line is the title; blank line; then body.',
    initialSummary: 'feat: add thing\n\nBody text.',
    aiFailed: false,
    relatedFiles: RELATED_FILES,
    sourceBranch: 'psyche/feature',
    targetBranch: 'main',
    ...overrides,
  };
}

function hostStep(step: HostStep): FlowEvent {
  return { type: 'host_step', step };
}

function hostSucceeded(message: string): FlowEvent {
  return { type: 'host_result', result: { kind: 'succeeded', message } };
}

function hostFailed(message: string): FlowEvent {
  return { type: 'host_result', result: { kind: 'failed', message } };
}

/** Drives events, asserting every step is accepted along the way. */
function drive<M extends { readonly reduce: AnyMachine['reduce'] }, S extends AnyFlowState>(
  machine: M,
  state: S,
  events: readonly FlowEvent[],
): S {
  let current = state;
  for (const event of events) {
    const result = machine.reduce(current as never, event);
    if (!result.ok) {
      throw new Error(
        `drive: event ${event.type} rejected in status ${current.status}: ${String(result.reason)}`,
      );
    }
    current = result.state as S;
  }
  return current;
}

function expectRejected(result: AnyTransitionResult, reason: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
}

/** One event of every recognized type, for terminal-rejection sweeps. */
function everyEventKind(): FlowEvent[] {
  return [
    hostStep(mergeStartStep()),
    hostSucceeded('Merged'),
    hostFailed('Merge failed'),
    { type: 'host_validation_failed', reason: 'stale_pane_state', message: 'pane changed' },
    { type: 'host_session_lost' },
    { type: 'user_confirm', confirmed: true },
    { type: 'user_confirm', confirmed: false },
    { type: 'user_choice', optionId: 'commit_automatic' },
    { type: 'user_input', value: 'msg' },
    { type: 'user_review_edit', summary: 'x' },
    { type: 'user_review_focus_file', path: 'src/a.ts' },
    { type: 'user_review_close_file' },
    { type: 'user_review_submit', summary: 'x' },
    { type: 'user_cancel' },
  ];
}

// ---------------------------------------------------------------------------
// Machine identity and structural audit
// ---------------------------------------------------------------------------

describe('flow machine identity', () => {
  it('is versioned v1', () => {
    expect(MERGE_PR_FLOW_MACHINE_VERSION).toBe(1);
    expect(mergeFlowMachine.version).toBe(1);
    expect(prReviewFlowMachine.version).toBe(1);
  });

  it('starts idle and active', () => {
    expect(mergeFlowMachine.initialState).toEqual({ status: 'idle' });
    expect(prReviewFlowMachine.initialState).toEqual({ status: 'idle' });
    expect(isFlowTerminal(mergeFlowMachine.initialState)).toBe(false);
    expect(flowOutcomeOf(mergeFlowMachine.initialState)).toBeNull();
    expect(flowOutcomeOf(prReviewFlowMachine.initialState)).toBeNull();
  });

  it('recognizes exactly the documented event types', () => {
    expect([...FLOW_EVENT_TYPE_LIST]).toEqual([
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
    ]);
  });
});

describe('structural audit: destructive branches require confirmation steps', () => {
  it('merge flow table satisfies every invariant', () => {
    expect(auditFlowMachine(MERGE_FLOW_TRANSITIONS)).toEqual([]);
  });

  it('PR review flow table satisfies every invariant', () => {
    expect(auditFlowMachine(PR_REVIEW_FLOW_TRANSITIONS)).toEqual([]);
  });

  it('every consequential row is an explicit user execute from a sheet or review state', () => {
    for (const table of [MERGE_FLOW_TRANSITIONS, PR_REVIEW_FLOW_TRANSITIONS]) {
      for (const [status, rows] of Object.entries(table)) {
        for (const row of rows ?? []) {
          if (row.initiates === 'consequential') {
            expect(row.effect, `${status}:${row.on}`).toBe('execute');
            expect(row.on.startsWith('user_'), `${status}:${row.on}`).toBe(true);
            expect(['sheet', 'review'], `${status}:${row.on}`).toContain(status);
          }
        }
      }
    }
  });

  it('audit flags a table whose terminal state still declares rows', () => {
    const broken = {
      cancelled: [
        {
          on: 'user_cancel',
          effect: 'abort',
          note: 'bogus extra row',
          next: (state: MergeFlowState) => state,
        } as FlowTransition<MergeFlowState>,
      ],
    };
    const violations = auditFlowMachine(broken);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.status).toBe('cancelled');
  });

  it('audit flags a consequential row fired from idle (no confirmation step)', () => {
    const broken = {
      idle: [
        {
          on: 'user_confirm',
          effect: 'execute',
          initiates: 'consequential',
          note: 'bogus: merge without a confirm sheet',
          next: () => ({ status: 'awaiting_host', purpose: 'merge_start' }),
        } as FlowTransition<MergeFlowState>,
      ],
    };
    const problems = auditFlowMachine(broken).map((v) => v.problem);
    expect(problems.some((p) => p.includes('host-opened sheet or review state'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merge flow: destructive branches require confirmation
// ---------------------------------------------------------------------------

describe('merge flow destructive branches', () => {
  it('rejects a confirm event before the host opened a confirm sheet', () => {
    expectRejected(
      mergeMachine.reduce(mergeFlowMachine.initialState as never, { type: 'user_confirm', confirmed: true }),
      'event_not_applicable',
    );
  });

  it('sibling-close path: confirm-yes hands the host the teardown (and only from the sheet)', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(siblingCloseStep())]);
    expect(sheet).toEqual({ status: 'sheet', sheet: { kind: 'confirm', step: siblingCloseStep() } });

    const accepted = mergeMachine.reduce(sheet as never, { type: 'user_confirm', confirmed: true });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.state).toEqual({ status: 'awaiting_host', purpose: 'sibling_close' });
    }
  });

  it('merge-start path requires the "Merge Worktree" confirm sheet', () => {
    const declined = mergeFlowMachine.reduce(
      drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]),
      { type: 'user_confirm', confirmed: false },
    );
    expect(declined.ok).toBe(true);
    if (declined.ok) {
      expect(declined.state.status).toBe('cancelled');
      expect(flowOutcomeOf(declined.state)).toBe('cancelled');
    }

    const accepted = mergeFlowMachine.reduce(
      drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]),
      { type: 'user_confirm', confirmed: true },
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.state).toEqual({ status: 'awaiting_host', purpose: 'merge_start' });
    }
  });

  it('fallback-target path is reachable and confirm-gated', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(fallbackMergeStep())]);
    expectRejected(
      mergeMachine.reduce(sheet as never, { type: 'user_choice', optionId: 'proceed' }),
      'event_not_applicable',
    );
    const accepted = mergeMachine.reduce(sheet as never, { type: 'user_confirm', confirmed: true });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.state).toEqual({ status: 'awaiting_host', purpose: 'fallback_target' });
    }
  });

  it('uncommitted-changes choices reach the host only for authorized option ids', () => {
    for (const optionId of ['commit_automatic', 'commit_ai_editable', 'commit_manual', 'stash_main']) {
      const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]);
      const result = mergeMachine.reduce(sheet as never, { type: 'user_choice', optionId });
      expect(result.ok, optionId).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual({ status: 'awaiting_host', purpose: 'host_option' });
      }
    }

    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]);
    expectRejected(
      mergeMachine.reduce(sheet as never, { type: 'user_choice', optionId: 'force_merge_now' }),
      'option_not_authorized',
    );
  });

  it('the cancel option on a choice sheet aborts the chain', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]);
    const result = mergeMachine.reduce(sheet as never, { type: 'user_choice', optionId: 'cancel' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.status).toBe('cancelled');
    }
  });

  it('commit-message input transports the value; content validation stays host-side', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(commitInputStep())]);
    // Empty string is accepted by the machine: the host decides whether a
    // commit message is valid ('Commit message cannot be empty' is host-side).
    const empty = mergeMachine.reduce(sheet as never, { type: 'user_input', value: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.state).toEqual({ status: 'awaiting_host', purpose: 'host_input' });
    }
  });

  it('walks the full sibling → merge confirmation chain to a succeeded outcome', () => {
    const final = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(siblingCloseStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
      hostSucceeded('Merged "wt" into "main".'),
    ]);
    expect(final).toEqual({
      status: 'terminal',
      outcome: 'succeeded',
      message: 'Merged "wt" into "main".',
    });
    expect(flowOutcomeOf(final)).toBe('succeeded');
    expect(isFlowTerminal(final)).toBe(true);
  });

  it('walks the uncommitted → commit input → retry chain', () => {
    const final = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(uncommittedChoiceStep()),
      { type: 'user_choice', optionId: 'commit_manual' },
      hostStep(commitInputStep()),
      { type: 'user_input', value: 'feat: save work' },
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
      hostSucceeded('Merged.'),
    ]);
    expect(final.status).toBe('terminal');
    expect(flowOutcomeOf(final)).toBe('succeeded');
  });

  it('walks the fallback-target chain', () => {
    const final = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(fallbackMergeStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
      hostSucceeded('Merged into fallback target.'),
    ]);
    expect(flowOutcomeOf(final)).toBe('succeeded');
  });

  it('maps the conflict-resolution navigation handoff to recovery_required', () => {
    const awaiting = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
    ]);
    const handedOff = mergeMachine.reduce(awaiting as never, {
      type: 'host_result',
      result: {
        kind: 'navigated',
        message: 'Conflict Resolution Started',
        targetPaneId: 'pane-123',
      },
    });
    expect(handedOff.ok).toBe(true);
    if (handedOff.ok) {
      expect(handedOff.state).toEqual({
        status: 'terminal',
        outcome: 'recovery_required',
        message: 'Conflict Resolution Started (target pane: pane-123)',
      });
      expect(flowOutcomeOf(handedOff.state)).toBe('recovery_required');
    }
  });

  it('records host failure as a failed outcome', () => {
    const awaiting = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
    ]);
    const failed = mergeMachine.reduce(awaiting as never, hostFailed('Merge failed: conflict'));
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.state).toEqual({
        status: 'terminal',
        outcome: 'failed',
        message: 'Merge failed: conflict',
      });
    }
  });

  it('treats an informational host result (e.g. "Merge cancelled") as a no-outcome close', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]);
    const closed = mergeMachine.reduce(sheet as never, {
      type: 'host_result',
      result: { kind: 'informational', message: 'Merge cancelled' },
    });
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.state).toEqual({ status: 'cancelled', message: 'Merge cancelled' });
      expect(flowOutcomeOf(closed.state)).toBe('cancelled');
    }
  });
});

// ---------------------------------------------------------------------------
// PR review flow
// ---------------------------------------------------------------------------

describe('PR review flow', () => {
  it('walks confirm → review (creation confirmed) → edit → navigation → submit → final URL', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    expect(review.status).toBe('review');
    if (review.status === 'review') {
      expect(review.review.creationConfirmed).toBe(true);
      expect(review.review.summary).toBe('feat: add thing\n\nBody text.');
      expect(review.review.aiFailed).toBe(false);
      expect(review.review.focusedFile).toBeNull();
      expect(review.review.sourceBranch).toBe('psyche/feature');
      expect(review.review.targetBranch).toBe('main');
    }

    const edited = drive(prMachine, review, [
      { type: 'user_review_edit', summary: 'feat: add thing\n\nEdited body.' },
      { type: 'user_review_focus_file', path: 'src/a.ts' },
    ]);
    expect(edited.status).toBe('review');
    if (edited.status === 'review') {
      expect(edited.review.summary).toBe('feat: add thing\n\nEdited body.');
      expect(edited.review.focusedFile).toBe('src/a.ts');
    }

    const closedPeek = drive(prMachine, edited, [{ type: 'user_review_close_file' }]);
    expect(closedPeek.status).toBe('review');
    if (closedPeek.status === 'review') {
      expect(closedPeek.review.focusedFile).toBeNull();
    }

    const submitting = prMachine.reduce(closedPeek as never, {
      type: 'user_review_submit',
      summary: 'feat: add thing\n\nEdited body.',
    });
    expect(submitting.ok).toBe(true);
    if (!submitting.ok) throw new Error('submit should be accepted');
    expect(submitting.state).toEqual({ status: 'awaiting_host', purpose: 'review_submit' });

    const final = drive(prMachine, submitting.state, [
      hostSucceeded('Created PR: https://github.example/pull/42'),
    ]);
    expect(final).toEqual({
      status: 'terminal',
      outcome: 'succeeded',
      message: 'Created PR: https://github.example/pull/42',
    });
  });

  it('rejects PR creation submit when no confirmed creation step was observed', () => {
    // Host opened the review sheet directly (no machine-observed confirm):
    // render/edit/peek still work, but creation fails closed.
    const review = drive(prMachine, prReviewFlowMachine.initialState, [hostStep(prReviewStep())]);
    expect(review.status).toBe('review');
    if (review.status === 'review') {
      expect(review.review.creationConfirmed).toBe(false);
    }
    expectRejected(
      prMachine.reduce(review as never, { type: 'user_review_submit', summary: 'title\n\nbody' }),
      'creation_not_confirmed',
    );
  });

  it('supports the fallback-target confirm before review', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep({
        kind: 'confirm',
        purpose: 'fallback_target',
        title: 'Parent PR Target Unavailable',
        message: '"parent" is no longer available. Create a pull request into "main" instead?',
      }),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    expect(review.status).toBe('review');
    if (review.status === 'review') {
      expect(review.review.creationConfirmed).toBe(true);
    }
  });

  it('carries the aiFailed flag from the host step', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(
        prReviewStep({
          aiFailed: true,
          message: '⚠️ AI summary failed. Edit title (first line), blank line, then markdown body.',
          initialSummary: '',
        }),
      ),
    ]);
    expect(review.status).toBe('review');
    if (review.status === 'review') {
      expect(review.review.aiFailed).toBe(true);
      expect(review.review.summary).toBe('');
    }
  });

  it('rejects navigation to files the host did not authorize', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    expectRejected(
      prMachine.reduce(review as never, { type: 'user_review_focus_file', path: '../secrets.env' }),
      'file_not_authorized',
    );
  });

  it('does not validate summary content (host parses title/body on submit)', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    // Empty title is a host-side rejection ('PR title cannot be empty'); the
    // machine accepts the edit and the submit and lets the host decide.
    const edited = drive(prMachine, review, [{ type: 'user_review_edit', summary: '' }]);
    const submitting = prMachine.reduce(edited as never, {
      type: 'user_review_submit',
      summary: '',
    });
    expect(submitting.ok).toBe(true);
  });

  it('a superseding pr_review step starts a fresh, unconfirmed review session', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
      { type: 'user_review_focus_file', path: 'src/b.ts' },
    ]);
    const superseded = prMachine.reduce(review as never, hostStep(prReviewStep()));
    expect(superseded.ok).toBe(true);
    if (superseded.ok && superseded.state.status === 'review') {
      expect(superseded.state.review.creationConfirmed).toBe(false);
      expect(superseded.state.review.focusedFile).toBeNull();
    }
  });

  it('review is cancellable and edit does not lose the focused file', () => {
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
      { type: 'user_review_focus_file', path: 'src/a.ts' },
      { type: 'user_review_edit', summary: 'new draft' },
    ]);
    expect(review.status).toBe('review');
    if (review.status === 'review') {
      expect(review.review.focusedFile).toBe('src/a.ts');
      expect(review.review.summary).toBe('new draft');
    }
    const cancelled = prMachine.reduce(review as never, { type: 'user_cancel' });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.state.status).toBe('cancelled');
    }
  });
});

// ---------------------------------------------------------------------------
// Single-use cancel semantics
// ---------------------------------------------------------------------------

describe('single-use cancel semantics', () => {
  function cancellableStates(): Array<{ readonly label: string; readonly state: AnyFlowState; readonly machine: AnyMachine }> {
    return [
      { label: 'merge idle', state: mergeFlowMachine.initialState, machine: mergeMachine },
      {
        label: 'merge confirm sheet',
        state: drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]),
        machine: mergeMachine,
      },
      {
        label: 'merge choice sheet',
        state: drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]),
        machine: mergeMachine,
      },
      {
        label: 'merge input sheet',
        state: drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(commitInputStep())]),
        machine: mergeMachine,
      },
      { label: 'pr idle', state: prReviewFlowMachine.initialState, machine: prMachine },
      {
        label: 'pr review sheet',
        state: drive(prMachine, prReviewFlowMachine.initialState, [
          hostStep(createPrStep()),
          { type: 'user_confirm', confirmed: true },
          hostStep(prReviewStep()),
        ]),
        machine: prMachine,
      },
    ];
  }

  it('cancel is accepted exactly once from every cancellable state', () => {
    for (const { label, state, machine } of cancellableStates()) {
      const cancelled = machine.reduce(state as never, { type: 'user_cancel' });
      expect(cancelled.ok, label).toBe(true);
      if (cancelled.ok) {
        expect(cancelled.state.status, label).toBe('cancelled');
        expect(flowOutcomeOf(cancelled.state), label).toBe('cancelled');
      }
    }
  });

  it('a cancelled session cannot accept further events (including a second cancel)', () => {
    for (const { label, state, machine } of cancellableStates()) {
      const cancelledResult = machine.reduce(state as never, { type: 'user_cancel' });
      if (!cancelledResult.ok) throw new Error(`cancel failed for ${label}`);
      for (const event of everyEventKind()) {
        const result = machine.reduce(cancelledResult.state as never, event);
        expectRejected(result, 'session_closed');
      }
    }
  });

  it('cancel cannot preempt an in-flight continuation; the host reports next', () => {
    const awaiting = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
    ]);
    expectRejected(mergeMachine.reduce(awaiting as never, { type: 'user_cancel' }), 'event_not_applicable');
    expectRejected(
      mergeMachine.reduce(awaiting as never, { type: 'user_choice', optionId: 'cancel' }),
      'event_not_applicable',
    );
    // The host still answers, and the flow then reaches cancel from the sheet.
    const nextSheet = drive(mergeMachine, awaiting, [hostStep(uncommittedChoiceStep())]);
    const cancelled = mergeMachine.reduce(nextSheet as never, { type: 'user_cancel' });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.state.status).toBe('cancelled');
    }
  });
});

// ---------------------------------------------------------------------------
// Host-validation failures, unknown outcomes, unknown events
// ---------------------------------------------------------------------------

describe('typed host-validation failures', () => {
  const reasons = [
    'action_session_not_found',
    'action_session_expired',
    'action_session_limit',
    'stale_pane_state',
    'unexpected_action_result',
    'host_rejected_input',
  ] as const;

  it('each typed reason reaches the typed terminal state from an active flow', () => {
    for (const reason of reasons) {
      const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]);
      const result = mergeMachine.reduce(sheet as never, {
        type: 'host_validation_failed',
        reason,
        message: 'host rejected the event',
      });
      expect(result.ok, reason).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual({
          status: 'host_validation_failed',
          reason,
          message: 'host rejected the event',
        });
        expect(flowOutcomeOf(result.state)).toBe('recovery_required');
        expect(isFlowTerminal(result.state)).toBe(true);
        // Terminal: no further events accepted.
        expectRejected(mergeMachine.reduce(result.state as never, { type: 'user_cancel' }), 'session_closed');
      }
    }
  });
});

describe('unknown outcomes and lost sessions', () => {
  it('session loss while a continuation is in flight yields outcome unknown', () => {
    const awaiting = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
    ]);
    const lost = mergeMachine.reduce(awaiting as never, { type: 'host_session_lost' });
    expect(lost.ok).toBe(true);
    if (lost.ok) {
      expect(lost.state.status).toBe('terminal');
      expect(flowOutcomeOf(lost.state)).toBe('unknown');
      expect((lost.state as { message: string }).message).toContain('merge_start');
    }
  });

  it('session loss with nothing in flight yields recovery_required', () => {
    for (const state of [
      mergeFlowMachine.initialState,
      drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]),
      drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]),
    ]) {
      const lost = mergeMachine.reduce(state as never, { type: 'host_session_lost' });
      expect(lost.ok).toBe(true);
      if (lost.ok) {
        expect(flowOutcomeOf(lost.state)).toBe('recovery_required');
      }
    }
    const prReview = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    const prLost = prMachine.reduce(prReview as never, { type: 'host_session_lost' });
    expect(prLost.ok).toBe(true);
    if (prLost.ok) {
      expect(flowOutcomeOf(prLost.state)).toBe('recovery_required');
    }
  });

  it('session loss after PR submit yields unknown (the PR may exist)', () => {
    const submitting = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
      { type: 'user_review_submit', summary: 'title\n\nbody' },
    ]);
    expect(submitting.status).toBe('awaiting_host');
    const lost = prMachine.reduce(submitting as never, { type: 'host_session_lost' });
    expect(lost.ok).toBe(true);
    if (lost.ok) {
      expect(flowOutcomeOf(lost.state)).toBe('unknown');
    }
  });

  it('unknown events are rejected without state change', () => {
    const cases: Array<{ readonly label: string; readonly state: AnyFlowState; readonly machine: AnyMachine }> = [
      { label: 'idle', state: mergeFlowMachine.initialState, machine: mergeMachine },
      {
        label: 'sheet',
        state: drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]),
        machine: mergeMachine,
      },
      {
        label: 'awaiting',
        state: drive(mergeMachine, mergeFlowMachine.initialState, [
          hostStep(mergeStartStep()),
          { type: 'user_confirm', confirmed: true },
        ]),
        machine: mergeMachine,
      },
      {
        label: 'pr review',
        state: drive(prMachine, prReviewFlowMachine.initialState, [
          hostStep(createPrStep()),
          { type: 'user_confirm', confirmed: true },
          hostStep(prReviewStep()),
        ]),
        machine: prMachine,
      },
    ];
    for (const { label, state, machine } of cases) {
      const bogus = { type: 'user_teleport', paneId: 'x' } as unknown as FlowEvent;
      const result = machine.reduce(state as never, bogus);
      expectRejected(result, 'unknown_event');
      expect(result.state, label).toBe(state);
    }
  });

  it('user events are not applicable to states without a matching surface', () => {
    const idle = mergeFlowMachine.initialState;
    expectRejected(mergeMachine.reduce(idle as never, { type: 'user_review_submit', summary: 'x' }), 'event_not_applicable');
    expectRejected(mergeMachine.reduce(idle as never, { type: 'user_review_edit', summary: 'x' }), 'event_not_applicable');
    const review = drive(prMachine, prReviewFlowMachine.initialState, [
      hostStep(createPrStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(prReviewStep()),
    ]);
    expectRejected(
      prMachine.reduce(review as never, { type: 'user_choice', optionId: 'commit_automatic' }),
      'event_not_applicable',
    );
    // The merge machine never renders a pr_review sheet.
    expectRejected(
      mergeMachine.reduce(mergeFlowMachine.initialState as never, hostStep(prReviewStep())),
      'event_not_applicable',
    );
  });
});

// ---------------------------------------------------------------------------
// Host supersede behavior
// ---------------------------------------------------------------------------

describe('host sheet supersede', () => {
  it('the host may replace an open sheet (authoritative)', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(mergeStartStep())]);
    const replaced = mergeMachine.reduce(sheet as never, hostStep(uncommittedChoiceStep()));
    expect(replaced.ok).toBe(true);
    if (replaced.ok && replaced.state.status === 'sheet') {
      expect(replaced.state.sheet.kind).toBe('choice');
    }
  });

  it('a continuation can chain through multiple sheets', () => {
    const final = drive(mergeMachine, mergeFlowMachine.initialState, [
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
      hostStep(uncommittedChoiceStep()),
      { type: 'user_choice', optionId: 'stash_main' },
      hostStep(mergeStartStep()),
      { type: 'user_confirm', confirmed: true },
      hostSucceeded('Merged after stash.'),
    ]);
    expect(flowOutcomeOf(final)).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Wiring adapters (existing action results -> machine events)
// ---------------------------------------------------------------------------

describe('hostStepFromRemoteActionResult', () => {
  it('maps known confirm titles to purposes', () => {
    expect(CONFIRM_PURPOSE_BY_TITLE['Sibling Agents Active']).toBe('sibling_close');
    expect(CONFIRM_PURPOSE_BY_TITLE['Merge Worktree']).toBe('merge_start');
    expect(CONFIRM_PURPOSE_BY_TITLE['Parent Merge Target Unavailable']).toBe('fallback_target');
    expect(CONFIRM_PURPOSE_BY_TITLE['Create Pull Request']).toBe('create_pr');
    expect(CONFIRM_PURPOSE_BY_TITLE['Parent PR Target Unavailable']).toBe('fallback_target');
  });

  it('fails closed on unrecognized confirm titles without a hint', () => {
    const result: RemoteActionResult = {
      type: 'confirm',
      title: 'Some Brand New Sheet',
      message: 'm',
    };
    expect(hostStepFromRemoteActionResult(result)).toBeNull();
    const hinted = hostStepFromRemoteActionResult(result, 'merge_start');
    expect(hinted).toEqual({
      type: 'host_step',
      step: { kind: 'confirm', purpose: 'merge_start', title: 'Some Brand New Sheet', message: 'm' },
    });
  });

  it('maps the uncommitted choice via data.kind and extracts authorized option ids', () => {
    const result: RemoteActionResult = {
      type: 'choice',
      title: 'Worktree Has Uncommitted Changes',
      message: 'must be committed before merge',
      options: [
        { id: 'commit_automatic', label: 'AI commit (automatic)', default: true },
        { id: 'commit_manual', label: 'Manual commit message' },
        { id: 'cancel', label: 'Cancel merge' },
      ],
      data: { kind: 'merge_uncommitted', targetBranch: 'main' },
    };
    expect(hostStepFromRemoteActionResult(result)).toEqual({
      type: 'host_step',
      step: {
        kind: 'choice',
        purpose: 'uncommitted_changes',
        title: 'Worktree Has Uncommitted Changes',
        message: 'must be committed before merge',
        optionIds: ['commit_automatic', 'commit_manual', 'cancel'],
      },
    });
  });

  it('fails closed on choices without the uncommitted marker', () => {
    const result: RemoteActionResult = {
      type: 'choice',
      title: 'Pick one',
      message: 'm',
      options: [{ id: 'a', label: 'A' }],
    };
    expect(hostStepFromRemoteActionResult(result)).toBeNull();
  });

  it('maps input sheets with placeholder and default value', () => {
    const result: RemoteActionResult = {
      type: 'input',
      title: 'Commit Message',
      message: 'm',
      placeholder: 'feat: add new feature',
      defaultValue: 'feat: generated',
    };
    expect(hostStepFromRemoteActionResult(result)).toEqual({
      type: 'host_step',
      step: {
        kind: 'input',
        purpose: 'commit_message',
        title: 'Commit Message',
        message: 'm',
        placeholder: 'feat: add new feature',
        defaultValue: 'feat: generated',
      },
    });
  });

  it('maps pr_review with review data, aiFailed, and related files', () => {
    const result: RemoteActionResult = {
      type: 'pr_review',
      title: 'PR into "parent"',
      message: 'Review the AI-generated summary.',
      defaultValue: 'feat: x\n\nBody.',
      reviewData: {
        repoPath: '/repo',
        sourceBranch: 'feature',
        targetBranch: 'main',
        files: ['src/a.ts'],
        aiFailed: true,
      },
    };
    expect(hostStepFromRemoteActionResult(result)).toEqual({
      type: 'host_step',
      step: {
        kind: 'pr_review',
        title: 'PR into "parent"',
        message: 'Review the AI-generated summary.',
        initialSummary: 'feat: x\n\nBody.',
        aiFailed: true,
        relatedFiles: ['src/a.ts'],
        sourceBranch: 'feature',
        targetBranch: 'main',
      },
    });
  });

  it('returns null for response-free results', () => {
    const success: RemoteActionResult = { type: 'success', message: 'ok' };
    expect(hostStepFromRemoteActionResult(success)).toBeNull();
  });
});

describe('hostResultFromRemoteActionResult', () => {
  it('maps definitive results', () => {
    expect(hostResultFromRemoteActionResult({ type: 'success', message: 'Created PR: u' })).toEqual({
      type: 'host_result',
      result: { kind: 'succeeded', message: 'Created PR: u' },
    });
    expect(hostResultFromRemoteActionResult({ type: 'error', message: 'boom' })).toEqual({
      type: 'host_result',
      result: { kind: 'failed', message: 'boom' },
    });
    expect(
      hostResultFromRemoteActionResult({ type: 'navigation', message: 'nav', targetPaneId: 'p1' }),
    ).toEqual({
      type: 'host_result',
      result: { kind: 'navigated', message: 'nav', targetPaneId: 'p1' },
    });
    expect(hostResultFromRemoteActionResult({ type: 'info', message: 'Merge cancelled' })).toEqual({
      type: 'host_result',
      result: { kind: 'informational', message: 'Merge cancelled' },
    });
  });

  it('returns null for sheets and progress', () => {
    expect(
      hostResultFromRemoteActionResult({ type: 'confirm', title: 'Merge Worktree', message: 'm' }),
    ).toBeNull();
    expect(
      hostResultFromRemoteActionResult({ type: 'progress', message: 'working', progress: 40 }),
    ).toBeNull();
  });
});

describe('wire-level integration: serialized action results drive the machines', () => {
  it('an uncommitted choice result survives serialization and opens the choice sheet', () => {
    const actionResult: ActionResult = {
      type: 'choice',
      title: 'Worktree Has Uncommitted Changes',
      message: 'This worktree has uncommitted changes that must be committed before merge.',
      options: [
        { id: 'commit_automatic', label: 'AI commit (automatic)', default: true },
        { id: 'cancel', label: 'Cancel merge' },
      ],
      data: { kind: 'merge_uncommitted', repoPath: '/repo', targetBranch: 'main' },
      dismissable: true,
    };
    const wire = serializeActionResult(actionResult);
    const event = hostStepFromRemoteActionResult(wire);
    expect(event).not.toBeNull();
    const sheet = mergeMachine.reduce(mergeFlowMachine.initialState as never, event as FlowEvent);
    expect(sheet.ok).toBe(true);
    if (sheet.ok && sheet.state.status === 'sheet' && sheet.state.sheet.kind === 'choice') {
      expect(sheet.state.sheet.step.optionIds).toEqual(['commit_automatic', 'cancel']);
    }
  });

  it('a pr_review result survives serialization and opens a confirmed review after the confirm chain', () => {
    const confirmResult: ActionResult = {
      type: 'confirm',
      title: 'Create Pull Request',
      message: 'Push "wt" and create a GitHub pull request into "parent"?',
      confirmLabel: 'Create PR',
      cancelLabel: 'Cancel',
      dismissable: true,
    };
    const confirmEvent = hostStepFromRemoteActionResult(serializeActionResult(confirmResult));
    expect(confirmEvent).not.toBeNull();

    const reviewResult: ActionResult = {
      type: 'pr_review',
      title: 'PR into "parent"',
      message: 'Review the AI-generated summary. First line is the title; blank line; then body.',
      defaultValue: 'feat: x\n\nBody.',
      reviewData: {
        repoPath: '/repo',
        sourceBranch: 'feature',
        targetBranch: 'main',
        files: ['src/a.ts', 'src/b.ts'],
      },
      dismissable: true,
    };
    const wire = serializeActionResult(reviewResult);
    const reviewEvent = hostStepFromRemoteActionResult({
      ...wire,
      relatedFiles: ['src/a.ts', 'src/b.ts'],
    });
    expect(reviewEvent).not.toBeNull();

    const afterConfirm = prMachine.reduce(
      prReviewFlowMachine.initialState as never,
      confirmEvent as FlowEvent,
    );
    expect(afterConfirm.ok).toBe(true);
    if (!afterConfirm.ok) throw new Error('confirm sheet should open');
    const confirmed = prMachine.reduce(afterConfirm.state as never, { type: 'user_confirm', confirmed: true });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('confirm should be accepted');
    const review = prMachine.reduce(confirmed.state as never, reviewEvent as FlowEvent);
    expect(review.ok).toBe(true);
    if (review.ok && review.state.status === 'review') {
      expect(review.state.review.creationConfirmed).toBe(true);
      expect(review.state.review.relatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
      expect(review.state.review.sourceBranch).toBe('feature');
    }
  });

  it('a serialized navigation result closes the merge flow as recovery_required', () => {
    const actionResult: ActionResult = {
      type: 'navigation',
      title: 'Conflict Resolution Started',
      message: 'Created pane "resolve" to resolve conflicts.',
      targetPaneId: 'pane-9',
      dismissable: true,
    };
    const event = hostResultFromRemoteActionResult(serializeActionResult(actionResult));
    expect(event).not.toBeNull();
    const done = mergeMachine.reduce(mergeFlowMachine.initialState as never, event as FlowEvent);
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(flowOutcomeOf(done.state)).toBe('recovery_required');
    }
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('purity and determinism', () => {
  it('reduce is deterministic and does not mutate its inputs', () => {
    const sheet = drive(mergeMachine, mergeFlowMachine.initialState, [hostStep(uncommittedChoiceStep())]);
    const frozen = JSON.parse(JSON.stringify(sheet)) as MergeFlowState;
    const event: FlowEvent = { type: 'user_choice', optionId: 'commit_automatic' };
    const first = mergeMachine.reduce(sheet as never, event);
    const second = mergeMachine.reduce(sheet as never, event);
    expect(first).toEqual(second);
    expect(sheet).toEqual(frozen);
  });
});
