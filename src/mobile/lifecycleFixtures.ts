// Mobile lifecycle action fixtures — reference implementation (v1).
//
// Contract: docs/mobile/LIFECYCLE-UI-COVERAGE.md
// Issue: OpenCoven/psyche-build#220 (Beads psyche-i7c.9.4).
//
// This module is the platform-neutral, executable form of the lifecycle UI
// coverage contract: deterministic fixture requesters for each lifecycle
// action scenario (merge, PR review, stop, close/cleanup choice, errors, and
// in-progress disabling). Every fixture carries scoped metadata (host,
// project, pane, worktree, branch, and — where applicable — the merge/PR
// target branch), consequence-first text, and the expected confirmation,
// cancel, and disabled UI states a mobile lifecycle surface must render.
//
// Every export is a pure function or frozen constant. There is no I/O, no
// clock, no randomness, and no imports: calling a requester twice with the
// same arguments yields deep-equal fixtures, so the SwiftUI layer and UI
// tests can assert against the same strings. The strict validators fail
// closed on unknown fields, unknown enum values, empty or oversize text, and
// any inconsistent expected state.

/** Version of the contract this module implements (docs/mobile/LIFECYCLE-UI-COVERAGE.md). */
export const LIFECYCLE_FIXTURES_CONTRACT_VERSION = 1;

/** Stable contract identifier, safe for logs and cross-layer assertions. */
export const LIFECYCLE_FIXTURES_CONTRACT_ID = 'psyche.mobile.lifecycle.fixtures.v1';

/** Stable prefix for fixture requester ids; the scenario id is always appended. */
export const LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX = 'psyche.mobile.lifecycle.fixture';

/** Maximum normalized length of any single identity field in a fixture scope. */
export const MAX_LIFECYCLE_FIELD_LENGTH = 120;

/** Maximum normalized length of consequence-first text. */
export const MAX_LIFECYCLE_CONSEQUENCE_LENGTH = 400;

/** Maximum normalized length of a survival note. */
export const MAX_LIFECYCLE_SURVIVAL_NOTE_LENGTH = 280;

/** Maximum normalized length of an error detail. */
export const MAX_LIFECYCLE_ERROR_TEXT_LENGTH = 320;

/** Maximum normalized length of a disabled reason. */
export const MAX_LIFECYCLE_DISABLED_REASON_LENGTH = 280;

/** Maximum normalized length of a dialog title or message. */
export const MAX_LIFECYCLE_DIALOG_TEXT_LENGTH = 240;

/** Maximum normalized length of a confirm/cancel label or option id/label. */
export const MAX_LIFECYCLE_LABEL_LENGTH = 60;

// ---------------------------------------------------------------------------
// Vocabulary (contract §2 — the v1 lifecycle action-catalog shape)
// ---------------------------------------------------------------------------

/** Bounded v1 lifecycle action vocabulary for the mobile cockpit. */
export type LifecycleActionKind = 'merge' | 'pr-review' | 'stop' | 'close';

/**
 * Scenario role inside an action's flow: the guarded confirmation, the cancel
 * path, the error state, and the in-progress state that disables the entry
 * point. Every action kind must cover all four roles.
 */
export type LifecycleScenarioRole = 'confirm' | 'cancel' | 'error' | 'in-progress';

/**
 * Dialog a scenario must render. `none` means no dialog at all: the action's
 * entry point is disabled while work is in progress.
 */
export type LifecycleDialogKind = 'confirmation' | 'choice' | 'error' | 'info' | 'none';

export const LIFECYCLE_ACTION_KINDS: readonly LifecycleActionKind[] = Object.freeze([
  'merge',
  'pr-review',
  'stop',
  'close',
]);

export const LIFECYCLE_SCENARIO_ROLES: readonly LifecycleScenarioRole[] = Object.freeze([
  'confirm',
  'cancel',
  'error',
  'in-progress',
]);

export const LIFECYCLE_DIALOG_KINDS: readonly LifecycleDialogKind[] = Object.freeze([
  'confirmation',
  'choice',
  'error',
  'info',
  'none',
]);

/**
 * Action kinds whose flows can destroy uncommitted or persisted work (merge
 * moves the target branch and may close sibling panes; stop ends a running
 * session; close removes a pane and optionally its worktree and branch).
 * `pr-review` is consequential — it publishes — but not destructive.
 */
export const DESTRUCTIVE_LIFECYCLE_ACTION_KINDS: readonly LifecycleActionKind[] = Object.freeze([
  'merge',
  'stop',
  'close',
]);

/**
 * The v1 action-catalog shape this slice pins: every lifecycle action kind
 * must expose a confirmation, a cancel path, an error state, and an
 * in-progress state. The fixture set is complete exactly when it covers every
 * `kind.role` pair below. (The owning action-catalog deliverable is
 * OpenCoven/psyche-build#218; this table is the coverage contract those
 * catalog entries must satisfy, not a second catalog.)
 */
export const LIFECYCLE_ACTION_CATALOG_SHAPE: Readonly<
  Record<LifecycleActionKind, readonly LifecycleScenarioRole[]>
> = Object.freeze({
  merge: Object.freeze(['confirm', 'cancel', 'error', 'in-progress'] as const),
  'pr-review': Object.freeze(['confirm', 'cancel', 'error', 'in-progress'] as const),
  stop: Object.freeze(['confirm', 'cancel', 'error', 'in-progress'] as const),
  close: Object.freeze(['confirm', 'cancel', 'error', 'in-progress'] as const),
});

/** Stable scenario id: `<action-kind>.<scenario-role>`. */
export type LifecycleScenarioId =
  | 'merge.confirm'
  | 'merge.cancel'
  | 'merge.error'
  | 'merge.in-progress'
  | 'pr-review.confirm'
  | 'pr-review.cancel'
  | 'pr-review.error'
  | 'pr-review.in-progress'
  | 'stop.confirm'
  | 'stop.cancel'
  | 'stop.error'
  | 'stop.in-progress'
  | 'close.confirm'
  | 'close.cancel'
  | 'close.error'
  | 'close.in-progress';

/** Canonical, deterministic ordering of every required scenario id. */
export const LIFECYCLE_SCENARIO_IDS: readonly LifecycleScenarioId[] = Object.freeze(
  LIFECYCLE_ACTION_KINDS.flatMap((kind) =>
    LIFECYCLE_ACTION_CATALOG_SHAPE[kind].map((role) => `${kind}.${role}`),
  ) as LifecycleScenarioId[],
);

/** True when the action kind can destroy uncommitted or persisted work. */
export function isDestructiveLifecycleActionKind(kind: LifecycleActionKind): boolean {
  assertLifecycleActionKind(kind, 'kind');
  return DESTRUCTIVE_LIFECYCLE_ACTION_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

/**
 * Scoped metadata every fixture must name. `targetBranchName` is the merge or
 * PR target for `merge`/`pr-review` and exactly `null` for `stop`/`close`.
 */
export interface LifecycleFixtureScope {
  readonly hostName: string;
  readonly projectName: string;
  readonly paneTitle: string;
  readonly worktreeName: string;
  readonly branchName: string;
  readonly targetBranchName: string | null;
}

/** One selectable option in a choice dialog (close/cleanup choice). */
export interface LifecycleFixtureOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** True when choosing this option destroys work (destructive styling may apply — text still required). */
  readonly danger: boolean;
  /** True when this option is the default selection; at most one per dialog. */
  readonly default: boolean;
}

/** The complete expected UI state a lifecycle surface must render for a scenario. */
export interface LifecycleFixtureExpectedState {
  readonly dialog: LifecycleDialogKind;
  readonly title: string;
  readonly message: string;
  /** Verb-first confirm label; exactly `null` when the dialog has no confirm control. */
  readonly confirmLabel: string | null;
  /** Non-destructive cancel/dismiss label; exactly `null` when the dialog has no cancel control. */
  readonly cancelLabel: string | null;
  /** Choice options; empty for every dialog kind except `choice`. */
  readonly options: readonly LifecycleFixtureOption[];
  /** False exactly while the action is in progress (entry point disabled). */
  readonly actionEnabled: boolean;
  /** Non-null exactly when `actionEnabled` is false; states what is running. */
  readonly disabledReason: string | null;
  /** True exactly for in-progress scenarios. */
  readonly inProgress: boolean;
  /** Non-null exactly for error dialogs; names what stopped and what was preserved. */
  readonly errorText: string | null;
  /** True when the dialog's cancel/dismiss control performs no side effect. */
  readonly cancelHasNoSideEffects: boolean;
}

/** One deterministic lifecycle scenario fixture. */
export interface LifecycleActionFixture {
  readonly scenarioId: LifecycleScenarioId;
  readonly actionKind: LifecycleActionKind;
  readonly scenarioRole: LifecycleScenarioRole;
  /** Fixed requester id (`<prefix>.<scenarioId>`); never random, never time-based. */
  readonly requesterId: string;
  /** True when the underlying action can destroy uncommitted or persisted work. */
  readonly destructive: boolean;
  readonly scope: LifecycleFixtureScope;
  /** Consequence-first text: what happens now, with full scope. */
  readonly consequenceText: string;
  /** What survives (or was preserved): always names the worktree and the branch. */
  readonly survivalNote: string;
  readonly expected: LifecycleFixtureExpectedState;
}

/** A complete, validated fixture set covering the whole catalog shape. */
export interface LifecycleFixtureSet {
  readonly contractVersion: typeof LIFECYCLE_FIXTURES_CONTRACT_VERSION;
  readonly contractId: string;
  readonly fixtures: readonly LifecycleActionFixture[];
  readonly byScenarioId: Readonly<Record<string, LifecycleActionFixture>>;
}

// ---------------------------------------------------------------------------
// Fixed fixture scope (deterministic: fixed ids, no randomness, no timestamps)
// ---------------------------------------------------------------------------

const MERGE_SCOPE: LifecycleFixtureScope = Object.freeze({
  hostName: 'lan-host-1',
  projectName: 'psyche',
  paneTitle: 'agent-merge',
  worktreeName: 'wt/merge-demo',
  branchName: 'feat/merge-demo',
  targetBranchName: 'main',
});

const PR_REVIEW_SCOPE: LifecycleFixtureScope = Object.freeze({
  hostName: 'lan-host-1',
  projectName: 'psyche',
  paneTitle: 'agent-pr',
  worktreeName: 'wt/pr-demo',
  branchName: 'feat/pr-demo',
  targetBranchName: 'main',
});

const STOP_SCOPE: LifecycleFixtureScope = Object.freeze({
  hostName: 'lan-host-1',
  projectName: 'psyche',
  paneTitle: 'agent-stop',
  worktreeName: 'wt/stop-demo',
  branchName: 'feat/stop-demo',
  targetBranchName: null,
});

const CLOSE_SCOPE: LifecycleFixtureScope = Object.freeze({
  hostName: 'lan-host-1',
  projectName: 'psyche',
  paneTitle: 'agent-close',
  worktreeName: 'wt/close-demo',
  branchName: 'feat/close-demo',
  targetBranchName: null,
});

function scopeForKind(kind: LifecycleActionKind): LifecycleFixtureScope {
  switch (kind) {
    case 'merge':
      return MERGE_SCOPE;
    case 'pr-review':
      return PR_REVIEW_SCOPE;
    case 'stop':
      return STOP_SCOPE;
    case 'close':
      return CLOSE_SCOPE;
  }
}

// ---------------------------------------------------------------------------
// Canonical scenario table (contract §3 — one fixture per kind.role pair)
// ---------------------------------------------------------------------------

interface LifecycleFixtureSpec {
  readonly destructive: boolean;
  readonly consequenceText: string;
  readonly survivalNote: string;
  readonly expected: LifecycleFixtureExpectedState;
}

// Option ids and copy mirror the host close action's cleanup choice
// (src/actions/implementations/closeAction.ts) so mobile fixtures assert the
// same three-way choice the host renders.
const CLOSE_CLEANUP_OPTIONS: readonly LifecycleFixtureOption[] = Object.freeze([
  Object.freeze({
    id: 'kill_only',
    label: 'Just close pane',
    description: 'Keep worktree and branch',
    danger: false,
    default: true,
  }),
  Object.freeze({
    id: 'kill_and_clean',
    label: 'Close and remove worktree',
    description: 'Delete worktree but keep branch',
    danger: true,
    default: false,
  }),
  Object.freeze({
    id: 'kill_clean_branch',
    label: 'Close and delete everything',
    description: 'Remove worktree and delete branch',
    danger: true,
    default: false,
  }),
]);

function state(spec: LifecycleFixtureExpectedState): LifecycleFixtureExpectedState {
  return Object.freeze({
    ...spec,
    options: Object.freeze(spec.options.map((option) => Object.freeze({ ...option }))),
  });
}

const LIFECYCLE_FIXTURE_SPECS: Readonly<Record<LifecycleScenarioId, LifecycleFixtureSpec>> =
  Object.freeze({
    // --- merge (destructive: moves the target branch, may close siblings) ---
    'merge.confirm': Object.freeze({
      destructive: true,
      consequenceText:
        'This merges branch "feat/merge-demo" from pane "agent-merge" and worktree '
        + '"wt/merge-demo" into "main" for project "psyche" on host "lan-host-1" now; the merge '
        + 'is recorded on "main" immediately.',
      survivalNote:
        'Worktree "wt/merge-demo" and branch "feat/merge-demo" survive the merge; only the '
        + 'target branch "main" moves forward.',
      expected: state({
        dialog: 'confirmation',
        title: 'Merge Worktree',
        message: 'Merge "agent-merge" into main?',
        confirmLabel: 'Merge',
        cancelLabel: 'Cancel',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: true,
      }),
    }),
    'merge.cancel': Object.freeze({
      destructive: true,
      consequenceText:
        'This cancels the merge flow for branch "feat/merge-demo" for project "psyche" on host '
        + '"lan-host-1". No merge runs: "main", worktree "wt/merge-demo", and pane "agent-merge" '
        + 'are unchanged.',
      survivalNote:
        'Nothing changed: worktree "wt/merge-demo" and branch "feat/merge-demo" survive untouched.',
      expected: state({
        dialog: 'info',
        title: 'Merge Cancelled',
        message: 'Merge cancelled — "main" was not modified.',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),
    'merge.error': Object.freeze({
      destructive: true,
      consequenceText:
        'This merge attempt for project "psyche" stopped on a conflict before "main" changed: '
        + 'nothing was recorded on host "lan-host-1" for branch "feat/merge-demo" or pane '
        + '"agent-merge".',
      survivalNote:
        'Worktree "wt/merge-demo" and branch "feat/merge-demo" survive; the target branch '
        + '"main" is left unchanged.',
      expected: state({
        dialog: 'error',
        title: 'Merge Conflict',
        message: 'The merge stopped on a conflict.',
        confirmLabel: null,
        cancelLabel: 'Dismiss',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText:
          'Merging branch "feat/merge-demo" into "main" stopped on a merge conflict on host '
          + '"lan-host-1". The target branch "main" was left unchanged and pane "agent-merge" '
          + 'still holds worktree "wt/merge-demo"; resolve the conflict, then retry the merge.',
        cancelHasNoSideEffects: true,
      }),
    }),
    'merge.in-progress': Object.freeze({
      destructive: true,
      consequenceText:
        'This merge is already running for pane "agent-merge" for project "psyche" on host '
        + '"lan-host-1": branch "feat/merge-demo" is being merged into "main" and a second '
        + 'merge is disabled until it finishes.',
      survivalNote:
        'Worktree "wt/merge-demo" and branch "feat/merge-demo" are not touched by the disabled '
        + 'entry point; the running merge owns them.',
      expected: state({
        dialog: 'none',
        title: '',
        message: '',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: false,
        disabledReason:
          'A merge for pane "agent-merge" is already in progress on host "lan-host-1"; wait for '
          + 'it to finish before starting another.',
        inProgress: true,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),

    // --- pr-review (consequential: publishes; not destructive) ---
    'pr-review.confirm': Object.freeze({
      destructive: false,
      consequenceText:
        'This publishes branch "feat/pr-demo" from pane "agent-pr" and worktree "wt/pr-demo" as '
        + 'a pull request targeting "main" for project "psyche" on host "lan-host-1" now.',
      survivalNote:
        'Worktree "wt/pr-demo" and branch "feat/pr-demo" survive; publishing a pull request '
        + 'changes nothing locally.',
      expected: state({
        dialog: 'confirmation',
        title: 'Create Pull Request',
        message: 'Create a pull request for "feat/pr-demo"?',
        confirmLabel: 'Create PR',
        cancelLabel: 'Cancel',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: true,
      }),
    }),
    'pr-review.cancel': Object.freeze({
      destructive: false,
      consequenceText:
        'This cancels pull request creation for branch "feat/pr-demo" for project "psyche" on '
        + 'host "lan-host-1". Nothing is published: no pull request against "main" exists for '
        + 'pane "agent-pr".',
      survivalNote:
        'Worktree "wt/pr-demo" and branch "feat/pr-demo" survive untouched; nothing was published.',
      expected: state({
        dialog: 'info',
        title: 'Pull Request Cancelled',
        message: 'Pull request creation cancelled — nothing was published.',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),
    'pr-review.error': Object.freeze({
      destructive: false,
      consequenceText:
        'This pull request attempt for project "psyche" stopped before anything was published: '
        + 'no pull request against "main" exists for branch "feat/pr-demo", and nothing changed '
        + 'on host "lan-host-1" for pane "agent-pr".',
      survivalNote:
        'Worktree "wt/pr-demo" and branch "feat/pr-demo" survive; no pull request exists and '
        + 'nothing was published.',
      expected: state({
        dialog: 'error',
        title: 'Pull Request Failed',
        message: 'The pull request could not be published.',
        confirmLabel: null,
        cancelLabel: 'Dismiss',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText:
          'Publishing the pull request for branch "feat/pr-demo" failed on host "lan-host-1": '
          + 'the branch could not be pushed. Nothing was published, and pane "agent-pr" and its '
          + 'worktree "wt/pr-demo" are unchanged.',
        cancelHasNoSideEffects: true,
      }),
    }),
    'pr-review.in-progress': Object.freeze({
      destructive: false,
      consequenceText:
        'This pull request is already being published for pane "agent-pr" for project "psyche" '
        + 'on host "lan-host-1": branch "feat/pr-demo" is being pushed against "main" and the '
        + 'create-PR control is disabled until it finishes.',
      survivalNote:
        'Worktree "wt/pr-demo" and branch "feat/pr-demo" are not touched by the disabled entry point.',
      expected: state({
        dialog: 'none',
        title: '',
        message: '',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: false,
        disabledReason:
          'Pull request creation for pane "agent-pr" is already in progress on host '
          + '"lan-host-1"; the create-PR control stays disabled until it finishes.',
        inProgress: true,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),

    // --- stop (destructive: ends the running session) ---
    'stop.confirm': Object.freeze({
      destructive: true,
      consequenceText:
        'This stops the running session in pane "agent-stop" behind branch "feat/stop-demo" for '
        + 'project "psyche" on host "lan-host-1" now and ends its in-flight work.',
      survivalNote:
        'The worktree "wt/stop-demo" and branch "feat/stop-demo" survive; only the session in '
        + 'pane "agent-stop" ends.',
      expected: state({
        dialog: 'confirmation',
        title: 'Stop Pane Session',
        message: 'Stop the running session in "agent-stop"?',
        confirmLabel: 'Stop',
        cancelLabel: 'Cancel',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: true,
      }),
    }),
    'stop.cancel': Object.freeze({
      destructive: true,
      consequenceText:
        'This cancels the stop flow for pane "agent-stop" for project "psyche" on host '
        + '"lan-host-1". The running session keeps running and nothing ends behind branch '
        + '"feat/stop-demo".',
      survivalNote:
        'Nothing ended: worktree "wt/stop-demo" and branch "feat/stop-demo" survive untouched '
        + 'and the session keeps running.',
      expected: state({
        dialog: 'info',
        title: 'Stop Cancelled',
        message: 'Stop cancelled — the session keeps running.',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),
    'stop.error': Object.freeze({
      destructive: true,
      consequenceText:
        'This stop attempt for project "psyche" found no running session in pane "agent-stop" '
        + 'on host "lan-host-1" and ended nothing behind branch "feat/stop-demo".',
      survivalNote:
        'Worktree "wt/stop-demo" and branch "feat/stop-demo" survive; the exited session left '
        + 'nothing running.',
      expected: state({
        dialog: 'error',
        title: 'Nothing To Stop',
        message: 'There is no running session to stop.',
        confirmLabel: null,
        cancelLabel: 'Dismiss',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText:
          'The session in pane "agent-stop" on host "lan-host-1" already exited, so there was '
          + 'nothing to stop. The pane and worktree "wt/stop-demo" remain in place.',
        cancelHasNoSideEffects: true,
      }),
    }),
    'stop.in-progress': Object.freeze({
      destructive: true,
      consequenceText:
        'This stop is already running for pane "agent-stop" for project "psyche" on host '
        + '"lan-host-1": the session in the pane behind branch "feat/stop-demo" is being torn '
        + 'down and the stop control is disabled until it finishes.',
      survivalNote:
        'Worktree "wt/stop-demo" and branch "feat/stop-demo" are not touched by the disabled entry point.',
      expected: state({
        dialog: 'none',
        title: '',
        message: '',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: false,
        disabledReason:
          'A stop for pane "agent-stop" is already in progress on host "lan-host-1"; the stop '
          + 'control stays disabled until the teardown finishes.',
        inProgress: true,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),

    // --- close (destructive: removes the pane and optionally worktree/branch) ---
    'close.confirm': Object.freeze({
      destructive: true,
      consequenceText:
        'This closes pane "agent-close" for project "psyche" on host "lan-host-1" now; the '
        + 'cleanup choice below decides what happens to worktree "wt/close-demo" and branch '
        + '"feat/close-demo".',
      survivalNote:
        'The default choice keeps worktree "wt/close-demo" and branch "feat/close-demo"; the '
        + 'destructive choices remove the worktree, the branch, or both.',
      expected: state({
        dialog: 'choice',
        title: 'Close Pane',
        message: 'How do you want to close "agent-close"?',
        confirmLabel: null,
        cancelLabel: 'Cancel',
        options: CLOSE_CLEANUP_OPTIONS,
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: true,
      }),
    }),
    'close.cancel': Object.freeze({
      destructive: true,
      consequenceText:
        'This cancels the close flow for pane "agent-close" for project "psyche" on host '
        + '"lan-host-1". The pane stays open, its session keeps running, and no cleanup runs '
        + 'behind branch "feat/close-demo".',
      survivalNote:
        'Nothing was removed: pane "agent-close", worktree "wt/close-demo", and branch '
        + '"feat/close-demo" all survive.',
      expected: state({
        dialog: 'info',
        title: 'Close Cancelled',
        message: 'Close cancelled — the pane stays open.',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),
    'close.error': Object.freeze({
      destructive: true,
      consequenceText:
        'This close completed for pane "agent-close" for project "psyche" on host '
        + '"lan-host-1", but cleanup stopped before touching the shared worktree behind branch '
        + '"feat/close-demo".',
      survivalNote:
        'Worktree "wt/close-demo" and branch "feat/close-demo" survive for the sibling panes '
        + 'that still use them.',
      expected: state({
        dialog: 'error',
        title: 'Cleanup Skipped',
        message: 'The pane closed, but cleanup was skipped.',
        confirmLabel: null,
        cancelLabel: 'Dismiss',
        options: [],
        actionEnabled: true,
        disabledReason: null,
        inProgress: false,
        errorText:
          'Pane "agent-close" closed on host "lan-host-1", but worktree cleanup for '
          + '"wt/close-demo" was skipped because sibling panes still use the worktree; branch '
          + '"feat/close-demo" was not deleted.',
        cancelHasNoSideEffects: true,
      }),
    }),
    'close.in-progress': Object.freeze({
      destructive: true,
      consequenceText:
        'This close is already running for pane "agent-close" for project "psyche" on host '
        + '"lan-host-1": the pane behind branch "feat/close-demo" is being torn down and the '
        + 'close control is disabled until it finishes.',
      survivalNote:
        'Worktree "wt/close-demo" and branch "feat/close-demo" are not touched by the disabled entry point.',
      expected: state({
        dialog: 'none',
        title: '',
        message: '',
        confirmLabel: null,
        cancelLabel: null,
        options: [],
        actionEnabled: false,
        disabledReason:
          'A close for pane "agent-close" is already in progress on host "lan-host-1"; the '
          + 'close control stays disabled until the teardown finishes.',
        inProgress: true,
        errorText: null,
        cancelHasNoSideEffects: false,
      }),
    }),
  });

// ---------------------------------------------------------------------------
// Deterministic requesters
// ---------------------------------------------------------------------------

/**
 * Returns the deterministic fixture for a scenario id. Calling this twice
 * with the same id yields deep-equal, deeply frozen fixtures: ids are fixed,
 * and no randomness, clock, I/O, or environment input is consulted. Unknown
 * ids fail closed.
 */
export function requestLifecycleFixture(scenarioId: LifecycleScenarioId): LifecycleActionFixture {
  assertLifecycleScenarioId(scenarioId, 'scenarioId');
  return buildFixture(scenarioId);
}

/**
 * Returns the complete deterministic fixture set: one fixture for every
 * `kind.role` pair in `LIFECYCLE_ACTION_CATALOG_SHAPE`, in canonical
 * `LIFECYCLE_SCENARIO_IDS` order. Deep-frozen and deterministic.
 */
export function requestLifecycleFixtureSet(): LifecycleFixtureSet {
  return assembleFixtureSet(LIFECYCLE_SCENARIO_IDS.map((id) => buildFixture(id)));
}

function buildFixture(scenarioId: LifecycleScenarioId): LifecycleActionFixture {
  const spec = LIFECYCLE_FIXTURE_SPECS[scenarioId];
  const separator = scenarioId.indexOf('.');
  const actionKind = scenarioId.slice(0, separator) as LifecycleActionKind;
  const scenarioRole = scenarioId.slice(separator + 1) as LifecycleScenarioRole;
  return Object.freeze({
    scenarioId,
    actionKind,
    scenarioRole,
    requesterId: `${LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX}.${scenarioId}`,
    destructive: spec.destructive,
    scope: Object.freeze({ ...scopeForKind(actionKind) }),
    consequenceText: spec.consequenceText,
    survivalNote: spec.survivalNote,
    expected: state(spec.expected),
  });
}

function assembleFixtureSet(fixtures: readonly LifecycleActionFixture[]): LifecycleFixtureSet {
  const byScenarioId: Record<string, LifecycleActionFixture> = {};
  for (const fixture of fixtures) {
    byScenarioId[fixture.scenarioId] = fixture;
  }
  return deepFreeze({
    contractVersion: LIFECYCLE_FIXTURES_CONTRACT_VERSION,
    contractId: LIFECYCLE_FIXTURES_CONTRACT_ID,
    fixtures: Object.freeze([...fixtures]),
    byScenarioId: Object.freeze(byScenarioId),
  });
}

// ---------------------------------------------------------------------------
// Strict validators (fail closed; pure)
// ---------------------------------------------------------------------------

/**
 * Validates one lifecycle fixture strictly: unknown fields are rejected,
 * enums are checked, text must be non-empty, already-normalized, and within
 * caps, consequence text must carry the full scope, and every expected state
 * must be internally consistent with its scenario role. Returns the fixture
 * deep-frozen in canonical shape; never mutates or normalizes the input.
 */
export function validateLifecycleFixture(candidate: unknown): LifecycleActionFixture {
  if (!isPlainObject(candidate)) {
    throw new TypeError(
      `lifecycleFixtures: fixture must be an object, received ${describeType(candidate)}`
    );
  }
  requireExactKeys(
    candidate,
    [
      'scenarioId',
      'actionKind',
      'scenarioRole',
      'requesterId',
      'destructive',
      'scope',
      'consequenceText',
      'survivalNote',
      'expected',
    ],
    'fixture',
  );

  const scenarioId = candidate.scenarioId;
  assertLifecycleScenarioId(scenarioId, 'fixture.scenarioId');

  const actionKind = candidate.actionKind;
  assertLifecycleActionKind(actionKind, 'fixture.actionKind');

  const scenarioRole = candidate.scenarioRole;
  assertLifecycleScenarioRole(scenarioRole, 'fixture.scenarioRole');

  if (scenarioId !== `${actionKind}.${scenarioRole}`) {
    throw new RangeError(
      `lifecycleFixtures: fixture.scenarioId ${JSON.stringify(scenarioId)} must equal `
        + `${JSON.stringify(`${actionKind}.${scenarioRole}`)} (actionKind + "." + scenarioRole)`
    );
  }

  const requesterId = requireStrictText(candidate.requesterId, 'fixture.requesterId', MAX_LIFECYCLE_FIELD_LENGTH);
  const expectedRequesterId = `${LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX}.${scenarioId}`;
  if (requesterId !== expectedRequesterId) {
    throw new RangeError(
      `lifecycleFixtures: fixture.requesterId must be ${JSON.stringify(expectedRequesterId)}, received ${JSON.stringify(requesterId)}`
    );
  }

  if (typeof candidate.destructive !== 'boolean') {
    throw new TypeError(
      `lifecycleFixtures: fixture.destructive must be a boolean, received ${describeType(candidate.destructive)}`
    );
  }
  const destructive = DESTRUCTIVE_LIFECYCLE_ACTION_KINDS.includes(actionKind);
  if (candidate.destructive !== destructive) {
    throw new RangeError(
      `lifecycleFixtures: fixture.destructive must be ${String(destructive)} for action kind ${JSON.stringify(actionKind)}`
    );
  }

  const scope = validateScope(candidate.scope, actionKind);
  const consequenceText = validateConsequenceText(candidate.consequenceText, scope, scenarioRole);
  const survivalNote = requireStrictText(
    candidate.survivalNote,
    'fixture.survivalNote',
    MAX_LIFECYCLE_SURVIVAL_NOTE_LENGTH
  );
  if (!survivalNote.includes(scope.worktreeName) || !survivalNote.includes(scope.branchName)) {
    throw new RangeError(
      'lifecycleFixtures: fixture.survivalNote must name both the worktree and the branch it preserves'
    );
  }

  const expected = validateExpectedState(candidate.expected, scope, scenarioRole);

  return Object.freeze({
    scenarioId,
    actionKind,
    scenarioRole,
    requesterId,
    destructive,
    scope,
    consequenceText,
    survivalNote,
    expected,
  });
}

/**
 * Validates a complete fixture set strictly: unknown fields are rejected at
 * the set, fixture, scope, expected-state, and option levels; every fixture
 * must be individually valid; the set must cover the whole
 * `LIFECYCLE_ACTION_CATALOG_SHAPE` exactly once with unique requester ids;
 * and every destructive flow must carry both a confirmation and a cancel
 * fixture. An optional `byScenarioId` index is accepted (and re-verified
 * against the fixtures) so the canonical requester output round-trips.
 * Returns the set deep-frozen with a rebuilt `byScenarioId` index.
 */
export function validateFixtureSet(candidate: unknown): LifecycleFixtureSet {
  if (!isPlainObject(candidate)) {
    throw new TypeError(
      `lifecycleFixtures: fixture set must be an object, received ${describeType(candidate)}`
    );
  }
  const allowedSetKeys = ['contractVersion', 'contractId', 'fixtures', 'byScenarioId'];
  const setKeys = Object.keys(candidate);
  const unknownSetKeys = setKeys.filter((key) => !allowedSetKeys.includes(key));
  if (unknownSetKeys.length > 0) {
    throw new TypeError(
      `lifecycleFixtures: fixture set has unknown field(s) ${unknownSetKeys
        .map((key) => JSON.stringify(key))
        .join(', ')}; allowed: ${allowedSetKeys.map((key) => JSON.stringify(key)).join(', ')}`
    );
  }
  for (const requiredKey of ['contractVersion', 'contractId', 'fixtures'] as const) {
    if (!(requiredKey in candidate)) {
      throw new TypeError(
        `lifecycleFixtures: fixture set is missing required field ${JSON.stringify(requiredKey)}`
      );
    }
  }

  if (candidate.contractVersion !== LIFECYCLE_FIXTURES_CONTRACT_VERSION) {
    throw new RangeError(
      `lifecycleFixtures: contractVersion must be ${LIFECYCLE_FIXTURES_CONTRACT_VERSION}, received ${describeType(candidate.contractVersion)}`
    );
  }
  if (candidate.contractId !== LIFECYCLE_FIXTURES_CONTRACT_ID) {
    throw new RangeError(
      `lifecycleFixtures: contractId must be ${JSON.stringify(LIFECYCLE_FIXTURES_CONTRACT_ID)}, received ${describeType(candidate.contractId)}`
    );
  }
  if (!Array.isArray(candidate.fixtures)) {
    throw new TypeError(
      `lifecycleFixtures: fixtures must be an array, received ${describeType(candidate.fixtures)}`
    );
  }

  const fixtures = candidate.fixtures.map((entry) => validateLifecycleFixture(entry));

  const seenScenarioIds = new Set<string>();
  const seenRequesterIds = new Set<string>();
  for (const fixture of fixtures) {
    if (seenScenarioIds.has(fixture.scenarioId)) {
      throw new RangeError(
        `lifecycleFixtures: duplicate fixture for scenario ${JSON.stringify(fixture.scenarioId)}`
      );
    }
    if (seenRequesterIds.has(fixture.requesterId)) {
      throw new RangeError(
        `lifecycleFixtures: duplicate requester id ${JSON.stringify(fixture.requesterId)}`
      );
    }
    seenScenarioIds.add(fixture.scenarioId);
    seenRequesterIds.add(fixture.requesterId);
  }

  const requiredIds = new Set<string>(LIFECYCLE_SCENARIO_IDS);
  for (const requiredId of LIFECYCLE_SCENARIO_IDS) {
    if (!seenScenarioIds.has(requiredId)) {
      throw new RangeError(
        `lifecycleFixtures: fixture set is missing required scenario ${JSON.stringify(requiredId)} from the action-catalog shape`
      );
    }
  }
  for (const seenId of seenScenarioIds) {
    if (!requiredIds.has(seenId)) {
      throw new TypeError(
        `lifecycleFixtures: fixture set contains scenario ${JSON.stringify(seenId)} outside the action-catalog shape`
      );
    }
  }

  for (const kind of LIFECYCLE_ACTION_KINDS) {
    for (const role of ['confirm', 'cancel'] as const) {
      if (!seenScenarioIds.has(`${kind}.${role}`)) {
        throw new RangeError(
          `lifecycleFixtures: destructive and consequential flows both need a tested ${role} path; action ${JSON.stringify(kind)} is missing one`
        );
      }
    }
  }

  // Optional byScenarioId index: when present it must agree with the fixtures
  // exactly (same key set, same requester id per scenario); the returned set
  // always carries a rebuilt index.
  if ('byScenarioId' in candidate) {
    const index = candidate.byScenarioId;
    if (!isPlainObject(index)) {
      throw new TypeError(
        `lifecycleFixtures: byScenarioId must be an object when present, received ${describeType(index)}`
      );
    }
    const indexKeys = Object.keys(index);
    const indexKeySet = new Set(indexKeys);
    if (indexKeys.length !== seenScenarioIds.size) {
      throw new RangeError(
        'lifecycleFixtures: byScenarioId index keys must match the fixture scenario ids exactly'
      );
    }
    for (const [scenarioId, entry] of Object.entries(index)) {
      if (!seenScenarioIds.has(scenarioId)) {
        throw new TypeError(
          `lifecycleFixtures: byScenarioId index names scenario ${JSON.stringify(scenarioId)} outside the fixture set`
        );
      }
      if (!isPlainObject(entry)) {
        throw new TypeError(
          `lifecycleFixtures: byScenarioId[${JSON.stringify(scenarioId)}] must be a fixture object, received ${describeType(entry)}`
        );
      }
      if (entry.scenarioId !== scenarioId) {
        throw new RangeError(
          `lifecycleFixtures: byScenarioId[${JSON.stringify(scenarioId)}].scenarioId does not match its index key`
        );
      }
    }
    for (const fixture of fixtures) {
      if (!indexKeySet.has(fixture.scenarioId)) {
        throw new RangeError(
          `lifecycleFixtures: byScenarioId index is missing fixture ${JSON.stringify(fixture.scenarioId)}`
        );
      }
    }
  }

  return assembleFixtureSet(fixtures);
}

// ---------------------------------------------------------------------------
// Internal validation helpers (fail closed; pure)
// ---------------------------------------------------------------------------

function validateScope(candidate: unknown, actionKind: LifecycleActionKind): LifecycleFixtureScope {
  if (!isPlainObject(candidate)) {
    throw new TypeError(
      `lifecycleFixtures: fixture.scope must be an object, received ${describeType(candidate)}`
    );
  }
  requireExactKeys(
    candidate,
    ['hostName', 'projectName', 'paneTitle', 'worktreeName', 'branchName', 'targetBranchName'],
    'fixture.scope'
  );

  const needsTarget = actionKind === 'merge' || actionKind === 'pr-review';
  if (needsTarget) {
    if (typeof candidate.targetBranchName !== 'string') {
      throw new TypeError(
        `lifecycleFixtures: fixture.scope.targetBranchName must be a string for action ${JSON.stringify(actionKind)}, received ${describeType(candidate.targetBranchName)}`
      );
    }
  } else if (candidate.targetBranchName !== null) {
    throw new RangeError(
      `lifecycleFixtures: fixture.scope.targetBranchName must be exactly null for action ${JSON.stringify(actionKind)}, received ${describeType(candidate.targetBranchName)}`
    );
  }

  return Object.freeze({
    hostName: requireStrictText(candidate.hostName, 'fixture.scope.hostName', MAX_LIFECYCLE_FIELD_LENGTH),
    projectName: requireStrictText(
      candidate.projectName,
      'fixture.scope.projectName',
      MAX_LIFECYCLE_FIELD_LENGTH
    ),
    paneTitle: requireStrictText(
      candidate.paneTitle,
      'fixture.scope.paneTitle',
      MAX_LIFECYCLE_FIELD_LENGTH
    ),
    worktreeName: requireStrictText(
      candidate.worktreeName,
      'fixture.scope.worktreeName',
      MAX_LIFECYCLE_FIELD_LENGTH
    ),
    branchName: requireStrictText(
      candidate.branchName,
      'fixture.scope.branchName',
      MAX_LIFECYCLE_FIELD_LENGTH
    ),
    targetBranchName:
      needsTarget
        ? requireStrictText(
            candidate.targetBranchName,
            'fixture.scope.targetBranchName',
            MAX_LIFECYCLE_FIELD_LENGTH
          )
        : null,
  });
}

function validateConsequenceText(
  candidate: unknown,
  scope: LifecycleFixtureScope,
  scenarioRole: LifecycleScenarioRole
): string {
  const text = requireStrictText(
    candidate,
    'fixture.consequenceText',
    MAX_LIFECYCLE_CONSEQUENCE_LENGTH
  );
  if (!text.startsWith('This ')) {
    throw new RangeError(
      'lifecycleFixtures: fixture.consequenceText must be consequence-first and start with "This "'
    );
  }
  const requiredScopeParts = [
    scope.paneTitle,
    scope.projectName,
    scope.hostName,
    scope.branchName,
    ...(scope.targetBranchName === null ? [] : [scope.targetBranchName]),
  ];
  for (const part of requiredScopeParts) {
    if (!text.includes(part)) {
      throw new RangeError(
        `lifecycleFixtures: fixture.consequenceText must name scoped metadata ${JSON.stringify(part)}`
      );
    }
  }
  if (scenarioRole === 'confirm' && !text.includes('now')) {
    throw new RangeError(
      'lifecycleFixtures: confirmation consequence text must state immediacy (contain "now")'
    );
  }
  if (scenarioRole === 'cancel' && !text.includes('This cancels')) {
    throw new RangeError(
      'lifecycleFixtures: cancel-path consequence text must start with "This cancels" and state that nothing happens'
    );
  }
  if (scenarioRole === 'in-progress' && !text.includes('already')) {
    throw new RangeError(
      'lifecycleFixtures: in-progress consequence text must state that the action is already running'
    );
  }
  return text;
}

function validateExpectedState(
  candidate: unknown,
  scope: LifecycleFixtureScope,
  scenarioRole: LifecycleScenarioRole
): LifecycleFixtureExpectedState {
  if (!isPlainObject(candidate)) {
    throw new TypeError(
      `lifecycleFixtures: fixture.expected must be an object, received ${describeType(candidate)}`
    );
  }
  requireExactKeys(
    candidate,
    [
      'dialog',
      'title',
      'message',
      'confirmLabel',
      'cancelLabel',
      'options',
      'actionEnabled',
      'disabledReason',
      'inProgress',
      'errorText',
      'cancelHasNoSideEffects',
    ],
    'fixture.expected'
  );

  const dialog = candidate.dialog;
  assertLifecycleDialogKind(dialog, 'fixture.expected.dialog');

  for (const booleanField of ['actionEnabled', 'inProgress', 'cancelHasNoSideEffects'] as const) {
    if (typeof candidate[booleanField] !== 'boolean') {
      throw new TypeError(
        `lifecycleFixtures: fixture.expected.${booleanField} must be a boolean, received ${describeType(candidate[booleanField])}`
      );
    }
  }
  const actionEnabled = candidate.actionEnabled as boolean;
  const inProgress = candidate.inProgress as boolean;
  const cancelHasNoSideEffects = candidate.cancelHasNoSideEffects as boolean;

  // Role/dialog binding: confirm renders a confirmation or choice dialog,
  // cancel renders the no-op info outcome, error renders an error dialog, and
  // in-progress renders nothing (the entry point is disabled instead).
  if (scenarioRole === 'confirm') {
    if (dialog !== 'confirmation' && dialog !== 'choice') {
      throw new RangeError(
        `lifecycleFixtures: confirm role must render a confirmation or choice dialog, received ${JSON.stringify(dialog)}`
      );
    }
  } else if (scenarioRole === 'cancel') {
    if (dialog !== 'info') {
      throw new RangeError(
        `lifecycleFixtures: cancel role must render the no-op info outcome, received ${JSON.stringify(dialog)}`
      );
    }
  } else if (scenarioRole === 'error') {
    if (dialog !== 'error') {
      throw new RangeError(
        `lifecycleFixtures: error role must render an error dialog, received ${JSON.stringify(dialog)}`
      );
    }
  } else if (dialog !== 'none') {
    throw new RangeError(
      `lifecycleFixtures: in-progress role must render no dialog at all (entry point disabled), received ${JSON.stringify(dialog)}`
    );
  }

  const title =
    dialog === 'none'
      ? requireEmptyText(candidate.title, 'fixture.expected.title')
      : requireStrictText(candidate.title, 'fixture.expected.title', MAX_LIFECYCLE_DIALOG_TEXT_LENGTH);
  const message =
    dialog === 'none'
      ? requireEmptyText(candidate.message, 'fixture.expected.message')
      : requireStrictText(
          candidate.message,
          'fixture.expected.message',
          MAX_LIFECYCLE_DIALOG_TEXT_LENGTH
        );

  const confirmLabel = validateOptionalLabel(candidate.confirmLabel, 'fixture.expected.confirmLabel');
  const cancelLabel = validateOptionalLabel(candidate.cancelLabel, 'fixture.expected.cancelLabel');
  const disabledReason = validateNullableText(
    candidate.disabledReason,
    'fixture.expected.disabledReason',
    MAX_LIFECYCLE_DISABLED_REASON_LENGTH
  );
  const errorText = validateNullableText(
    candidate.errorText,
    'fixture.expected.errorText',
    MAX_LIFECYCLE_ERROR_TEXT_LENGTH
  );

  const options = validateOptions(candidate.options, dialog);

  // Control invariants per dialog kind.
  if (dialog === 'confirmation') {
    if (confirmLabel === null || cancelLabel === null) {
      throw new RangeError(
        'lifecycleFixtures: a confirmation dialog must offer both a confirm and a cancel label'
      );
    }
  } else if (dialog === 'choice') {
    if (cancelLabel === null) {
      throw new RangeError(
        'lifecycleFixtures: a choice dialog must offer a cancel control so every destructive choice is escapable'
      );
    }
    if (confirmLabel !== null) {
      throw new RangeError(
        'lifecycleFixtures: a choice dialog must not also carry a confirm label'
      );
    }
    if (options.length === 0) {
      throw new RangeError('lifecycleFixtures: a choice dialog must list at least one option');
    }
  } else if (confirmLabel !== null) {
    throw new RangeError(
      `lifecycleFixtures: dialog ${JSON.stringify(dialog)} must not carry a confirm label`
    );
  }
  if (dialog === 'info' || dialog === 'none') {
    if (cancelLabel !== null) {
      throw new RangeError(
        `lifecycleFixtures: dialog ${JSON.stringify(dialog)} must not carry a cancel control`
      );
    }
  }

  // Disabled-state invariants: the entry point is disabled exactly while the
  // action is in progress, and the reason must name the running work.
  const inProgressRole = scenarioRole === 'in-progress';
  if (inProgress !== inProgressRole) {
    throw new RangeError(
      `lifecycleFixtures: fixture.expected.inProgress must be ${String(inProgressRole)} for scenario role ${JSON.stringify(scenarioRole)}`
    );
  }
  if (actionEnabled === inProgressRole) {
    throw new RangeError(
      `lifecycleFixtures: fixture.expected.actionEnabled must be ${String(!inProgressRole)} for scenario role ${JSON.stringify(scenarioRole)}`
    );
  }
  if (inProgressRole) {
    if (disabledReason === null) {
      throw new RangeError(
        'lifecycleFixtures: a disabled entry point must state a disabledReason'
      );
    }
    if (!disabledReason.includes('in progress')) {
      throw new RangeError(
        'lifecycleFixtures: disabledReason must state that the action is already in progress'
      );
    }
  } else if (disabledReason !== null) {
    throw new RangeError(
      'lifecycleFixtures: disabledReason must be exactly null while the entry point is enabled'
    );
  }

  // Error-state invariants: error detail exists exactly for error dialogs and
  // must name the pane and host it happened on.
  const errorRole = scenarioRole === 'error';
  if (errorRole && errorText === null) {
    throw new RangeError('lifecycleFixtures: an error dialog must carry errorText');
  }
  if (!errorRole && errorText !== null) {
    throw new RangeError(
      'lifecycleFixtures: errorText must be exactly null outside error dialogs'
    );
  }
  if (errorText !== null) {
    for (const part of [scope.paneTitle, scope.hostName] as const) {
      if (!errorText.includes(part)) {
        throw new RangeError(
          `lifecycleFixtures: fixture.expected.errorText must name scoped metadata ${JSON.stringify(part)}`
        );
      }
    }
  }

  // Cancel-path invariant: whenever a cancel/dismiss control exists, choosing
  // it must have no side effect.
  if (cancelHasNoSideEffects !== (cancelLabel !== null)) {
    throw new RangeError(
      'lifecycleFixtures: cancelHasNoSideEffects must be true exactly when a cancel or dismiss control is offered'
    );
  }

  return state({
    dialog,
    title,
    message,
    confirmLabel,
    cancelLabel,
    options,
    actionEnabled,
    disabledReason,
    inProgress,
    errorText,
    cancelHasNoSideEffects,
  });
}

function validateOptions(candidate: unknown, dialog: LifecycleDialogKind): readonly LifecycleFixtureOption[] {
  if (!Array.isArray(candidate)) {
    throw new TypeError(
      `lifecycleFixtures: fixture.expected.options must be an array, received ${describeType(candidate)}`
    );
  }
  const options = candidate.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new TypeError(
        `lifecycleFixtures: option must be an object, received ${describeType(entry)}`
      );
    }
    requireExactKeys(entry, ['id', 'label', 'description', 'danger', 'default'], 'option');
    if (typeof entry.danger !== 'boolean') {
      throw new TypeError(
        `lifecycleFixtures: option.danger must be a boolean, received ${describeType(entry.danger)}`
      );
    }
    if (typeof entry.default !== 'boolean') {
      throw new TypeError(
        `lifecycleFixtures: option.default must be a boolean, received ${describeType(entry.default)}`
      );
    }
    return Object.freeze({
      id: requireStrictText(entry.id, 'option.id', MAX_LIFECYCLE_LABEL_LENGTH),
      label: requireStrictText(entry.label, 'option.label', MAX_LIFECYCLE_LABEL_LENGTH),
      description: requireStrictText(
        entry.description,
        'option.description',
        MAX_LIFECYCLE_DIALOG_TEXT_LENGTH
      ),
      danger: entry.danger,
      default: entry.default,
    });
  });

  const ids = new Set<string>();
  let defaultCount = 0;
  for (const option of options) {
    if (ids.has(option.id)) {
      throw new RangeError(
        `lifecycleFixtures: duplicate option id ${JSON.stringify(option.id)} in one dialog`
      );
    }
    ids.add(option.id);
    if (option.default) {
      defaultCount += 1;
    }
  }
  if (options.length > 0 && defaultCount !== 1) {
    throw new RangeError(
      'lifecycleFixtures: a choice dialog must mark exactly one option as the default'
    );
  }
  if (dialog !== 'choice' && options.length > 0) {
    throw new RangeError(
      `lifecycleFixtures: dialog ${JSON.stringify(dialog)} must not carry options`
    );
  }
  return Object.freeze(options);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string
): void {
  const actual = Object.keys(value);
  const unknownKeys = actual.filter((key) => !keys.includes(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `lifecycleFixtures: ${context} has unknown field(s) ${unknownKeys
        .map((key) => JSON.stringify(key))
        .join(', ')}; allowed: ${keys.map((key) => JSON.stringify(key)).join(', ')}`
    );
  }
  const missingKeys = keys.filter((key) => !actual.includes(key));
  if (missingKeys.length > 0) {
    throw new TypeError(
      `lifecycleFixtures: ${context} is missing required field(s) ${missingKeys
        .map((key) => JSON.stringify(key))
        .join(', ')}`
    );
  }
}

function requireStrictText(candidate: unknown, field: string, maxLength: number): string {
  if (typeof candidate !== 'string') {
    throw new TypeError(
      `lifecycleFixtures: ${field} must be a string, received ${describeType(candidate)}`
    );
  }
  if (candidate.trim().length === 0) {
    throw new RangeError(`lifecycleFixtures: ${field} must not be empty`);
  }
  if (candidate !== candidate.trim()) {
    throw new RangeError(`lifecycleFixtures: ${field} must not have leading or trailing whitespace`);
  }
  if (/\s{2,}/.test(candidate) || /[\n\r\t]/.test(candidate)) {
    throw new RangeError(`lifecycleFixtures: ${field} must be single-line normalized text`);
  }
  if (candidate.length > maxLength) {
    throw new RangeError(
      `lifecycleFixtures: ${field} length ${candidate.length} exceeds maximum ${maxLength}`
    );
  }
  return candidate;
}

function requireEmptyText(candidate: unknown, field: string): '' {
  if (candidate !== '') {
    throw new RangeError(
      `lifecycleFixtures: ${field} must be exactly '' when no dialog is rendered, received ${describeType(candidate)}`
    );
  }
  return '';
}

function validateOptionalLabel(candidate: unknown, field: string): string | null {
  if (candidate === null) {
    return null;
  }
  return requireStrictText(candidate, field, MAX_LIFECYCLE_LABEL_LENGTH);
}

function validateNullableText(candidate: unknown, field: string, maxLength: number): string | null {
  if (candidate === null) {
    return null;
  }
  return requireStrictText(candidate, field, maxLength);
}

function assertLifecycleActionKind(value: unknown, field: string): asserts value is LifecycleActionKind {
  if (typeof value !== 'string' || !LIFECYCLE_ACTION_KINDS.includes(value as LifecycleActionKind)) {
    throw new TypeError(
      `lifecycleFixtures: ${field} must be one of ${LIFECYCLE_ACTION_KINDS.map((kind) => JSON.stringify(kind)).join(', ')}`
    );
  }
}

function assertLifecycleScenarioRole(
  value: unknown,
  field: string
): asserts value is LifecycleScenarioRole {
  if (
    typeof value !== 'string' ||
    !LIFECYCLE_SCENARIO_ROLES.includes(value as LifecycleScenarioRole)
  ) {
    throw new TypeError(
      `lifecycleFixtures: ${field} must be one of ${LIFECYCLE_SCENARIO_ROLES.map((role) => JSON.stringify(role)).join(', ')}`
    );
  }
}

function assertLifecycleDialogKind(
  value: unknown,
  field: string
): asserts value is LifecycleDialogKind {
  if (typeof value !== 'string' || !LIFECYCLE_DIALOG_KINDS.includes(value as LifecycleDialogKind)) {
    throw new TypeError(
      `lifecycleFixtures: ${field} must be one of ${LIFECYCLE_DIALOG_KINDS.map((kind) => JSON.stringify(kind)).join(', ')}`
    );
  }
}

function assertLifecycleScenarioId(
  value: unknown,
  field: string
): asserts value is LifecycleScenarioId {
  if (typeof value !== 'string' || !LIFECYCLE_SCENARIO_IDS.includes(value as LifecycleScenarioId)) {
    throw new TypeError(
      `lifecycleFixtures: ${field} must be one of ${LIFECYCLE_SCENARIO_IDS.map((id) => JSON.stringify(id)).join(', ')}`
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value);
  }
  return value;
}
