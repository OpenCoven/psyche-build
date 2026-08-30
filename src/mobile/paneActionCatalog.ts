// Native pane action menu — action catalog and guarded confirmations (v1).
//
// Contract: docs/mobile/PANE-ACTION-MENU-CONTRACT.md
// Issue: OpenCoven/psyche-build#218 (Beads psyche-i7c.9.2).
//
// This module is the platform-neutral, executable form of the contract: the
// v1 pane action catalog (merge, create PR, stop, close and clean up, rename,
// files, rituals) with per-action consequence metadata, consequence-first
// confirmation copy that names the exact scope, availability rules that
// disable stale or already-running actions with a textual reason, and
// result/error/progress feedback states that always carry text. Stop and
// close/clean-up are deliberately distinct actions end to end (different ids,
// titles, consequences, and survival semantics); "clean up" routes through
// the single `close` action id — there is no separate cleanup action.
//
// Every export is a pure function or frozen constant. There is no I/O, no
// clock, no randomness, and no imports, so the SwiftUI layer can mirror this
// table token-for-token and XCUITest can assert against the same strings.
//
// Authority note: this catalog is presentation semantics only. It does not
// execute anything and never replaces control-plane confirmation, approval,
// or receipt requirements. The host remains the source of truth for merge
// validation, cleanup choices, action results, and error text.

/** Version of the contract this module implements (docs/mobile/PANE-ACTION-MENU-CONTRACT.md). */
export const PANE_ACTION_CATALOG_VERSION = 1;

/** Stable contract identifier, safe for logs and cross-layer assertions. */
export const PANE_ACTION_CATALOG_ID = 'psyche.mobile.pane-action-catalog.v1';

/** Maximum normalized length of any identity field in confirmation copy. */
export const MAX_CONFIRMATION_FIELD_LENGTH = 120;

/** Maximum normalized length of the combined confirmation detail (fail-closed, never truncated). */
export const MAX_CONFIRMATION_DETAIL_LENGTH = 600;

/** Maximum normalized length of any single catalog text field (titles, consequence summaries). */
export const MAX_ACTION_FIELD_LENGTH = 120;

/** Maximum normalized length of an availability reason (fail-closed, never truncated). */
export const MAX_AVAILABILITY_REASON_LENGTH = 200;

/** Maximum normalized length of caller-supplied feedback detail, e.g. host error text. */
export const MAX_FEEDBACK_DETAIL_LENGTH = 400;

// ---------------------------------------------------------------------------
// Action identity (contract §2 — one id per semantic action)
// ---------------------------------------------------------------------------

/**
 * Bounded v1 pane action vocabulary. `close` is the single id for the
 * "Close and Clean Up" flow: cleanup is a phase of close that enters the
 * host's cleanup choices, never a separate menu action (contract §4).
 */
export type PaneActionId =
  | 'merge'
  | 'create-pr'
  | 'stop'
  | 'close'
  | 'rename'
  | 'files'
  | 'rituals';

export const PANE_ACTION_IDS: readonly PaneActionId[] = [
  'merge',
  'create-pr',
  'stop',
  'close',
  'rename',
  'files',
  'rituals',
];

/** Scope surfaces a pane action can touch. Scope is always named in copy, never implied. */
export type PaneActionScopeKind = 'host' | 'project' | 'pane' | 'worktree' | 'branch';

/**
 * What survives the action. Stop and close are semantically distinct here by
 * construction: stop retains the pane (restartable), close removes it from
 * the cockpit after the host's cleanup choices complete.
 */
export type PaneSurvivalSemantics =
  | 'no-session-change'
  | 'session-ends-pane-retained'
  | 'session-ends-pane-removed';

export interface PaneActionDescriptor {
  readonly id: PaneActionId;
  /** Required menu title. Trailing ellipsis iff `opensFollowUpFlow` (contract §2.4). */
  readonly menuTitle: string;
  /**
   * True when the action is destructive and therefore requires guarded
   * confirmation in v1: `merge`, `stop`, `close` (contract §5.1).
   */
  readonly destructive: boolean;
  /** True when activation leads to further required input or a host flow (title carries "…"). */
  readonly opensFollowUpFlow: boolean;
  /** Scope surfaces this action mutates or navigates within. */
  readonly touches: readonly PaneActionScopeKind[];
  readonly survival: PaneSurvivalSemantics;
  /** True when the action itself keeps the worktree and branch (host cleanup choices may still decide on close). */
  readonly retainsWorktreeAndBranch: boolean;
  /** Standalone consequence text for listings and menu subtitles. Names the effect, never a color. */
  readonly consequenceSummary: string;
}

export const PANE_ACTION_CATALOG: Readonly<Record<PaneActionId, PaneActionDescriptor>> = Object
  .freeze({
    merge: Object.freeze({
      id: 'merge' as const,
      menuTitle: 'Merge…',
      destructive: true,
      opensFollowUpFlow: true,
      touches: Object.freeze(['project', 'worktree', 'branch'] as const),
      survival: 'no-session-change' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Merges the pane branch into its target branch after the host validates the merge.',
    }),
    'create-pr': Object.freeze({
      id: 'create-pr' as const,
      menuTitle: 'Create Pull Request…',
      destructive: false,
      opensFollowUpFlow: true,
      touches: Object.freeze(['project', 'branch'] as const),
      survival: 'no-session-change' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Opens pull request creation for the pane branch; no branches change until you submit it.',
    }),
    stop: Object.freeze({
      id: 'stop' as const,
      menuTitle: 'Stop Pane',
      destructive: true,
      opensFollowUpFlow: false,
      touches: Object.freeze(['pane'] as const),
      survival: 'session-ends-pane-retained' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Ends the pane running session. The pane stays in the cockpit and can be restarted.',
    }),
    close: Object.freeze({
      id: 'close' as const,
      menuTitle: 'Close and Clean Up…',
      destructive: true,
      opensFollowUpFlow: true,
      touches: Object.freeze(['pane', 'worktree', 'branch'] as const),
      survival: 'session-ends-pane-removed' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Ends the pane session and removes the pane from the cockpit after the host cleanup choices.',
    }),
    rename: Object.freeze({
      id: 'rename' as const,
      menuTitle: 'Rename…',
      destructive: false,
      opensFollowUpFlow: true,
      touches: Object.freeze(['pane'] as const),
      survival: 'no-session-change' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Changes the pane display title only. The session, worktree, and branch are unchanged.',
    }),
    files: Object.freeze({
      id: 'files' as const,
      menuTitle: 'Files',
      destructive: false,
      opensFollowUpFlow: false,
      touches: Object.freeze(['worktree'] as const),
      survival: 'no-session-change' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Opens the file browser for the pane worktree. Read-only navigation.',
    }),
    rituals: Object.freeze({
      id: 'rituals' as const,
      menuTitle: 'Rituals…',
      destructive: false,
      opensFollowUpFlow: true,
      touches: Object.freeze(['pane', 'project'] as const),
      survival: 'no-session-change' as const,
      retainsWorktreeAndBranch: true,
      consequenceSummary:
        'Opens the ritual list to run in this pane. Ritual approval gates still apply.',
    }),
  });

/** Returns the descriptor for an action id; unknown values fail closed. */
export function describePaneAction(action: PaneActionId): PaneActionDescriptor {
  const descriptor = (PANE_ACTION_CATALOG as Record<string, PaneActionDescriptor | undefined>)[
    action
  ];
  if (!descriptor) {
    throw new TypeError(
      `paneActionCatalog: unknown pane action ${JSON.stringify(action)}; expected one of ${PANE_ACTION_IDS.map((id) => JSON.stringify(id)).join(', ')}`
    );
  }
  return descriptor;
}

/** Narrowing guard for untrusted action ids (menu payloads, deep links, fixtures). */
export function isPaneActionId(value: unknown): value is PaneActionId {
  return typeof value === 'string' && PANE_ACTION_IDS.includes(value as PaneActionId);
}

function assertPaneActionId(value: unknown, field: string): PaneActionId {
  if (!isPaneActionId(value)) {
    throw new TypeError(
      `paneActionCatalog: ${field} must be one of ${PANE_ACTION_IDS.map((id) => JSON.stringify(id)).join(', ')}, received ${JSON.stringify(value)}`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Destructive set and guarded confirmation requirement (contract §5)
// ---------------------------------------------------------------------------

/** The subset of v1 actions that present guarded confirmations. */
type DestructivePaneActionId = 'merge' | 'stop' | 'close';

/** The v1 destructive set: confirmation is required exactly for these actions. */
export const PANE_ACTION_DESTRUCTIVE_IDS: readonly DestructivePaneActionId[] = [
  'merge',
  'stop',
  'close',
];

/**
 * Returns true when activating `action` must present a guarded confirmation
 * first. In v1 the destructive set is exactly `merge`, `stop`, and `close`:
 * merge moves branch history, stop ends a live session, and close removes the
 * pane and enters the host cleanup choices. Merge always confirms when it is
 * offered ("where applicable" is the host's decision to offer it — the host
 * validates mergeability; the catalog never skips the guard).
 */
export function confirmationRequiredFor(action: PaneActionId): boolean {
  return describePaneAction(action).destructive;
}

// ---------------------------------------------------------------------------
// Consequence-first confirmation copy (contract §5)
// ---------------------------------------------------------------------------

/** Ordered elements of a guarded confirmation. The consequence is read first; buttons come last. */
export type ConfirmationElementKind =
  | 'consequence'
  | 'scope'
  | 'disposition'
  | 'confirm-button'
  | 'cancel-button';

/** The required visual/reading order: consequence, then scope, then disposition, then buttons. */
export const CONFIRMATION_PRESENTATION_ORDER: readonly ConfirmationElementKind[] = Object.freeze([
  'consequence',
  'scope',
  'disposition',
  'confirm-button',
  'cancel-button',
]);

export interface PaneActionScope {
  readonly hostName: string;
  readonly projectName: string;
  readonly paneTitle: string;
  readonly worktreeName?: string;
  readonly branchName?: string;
  /** Merge target when the caller knows it; otherwise the host selects and validates it. */
  readonly mergeTargetBranchName?: string;
}

export interface PaneActionConfirmationCopy {
  readonly action: PaneActionId;
  /** Header naming the action and pane, e.g. `Stop Pane "api"?`. */
  readonly title: string;
  /** Consequence-first detail: consequence sentence, then scope, then disposition. */
  readonly detail: string;
  /** The consequence sentence alone (first sentence of `detail`), for reading-order assertions. */
  readonly consequenceSentence: string;
  /** The exact-scope sentence alone (second sentence of `detail`). */
  readonly scopeSentence: string;
  /** The disposition/survival sentence alone (third sentence of `detail`). */
  readonly dispositionSentence: string;
  /** Verb-first confirm label naming the action, e.g. `Stop Pane`. */
  readonly confirmLabel: string;
  /** Plain, non-destructive cancel label. */
  readonly cancelLabel: string;
  /** True for the destructive set; destructive styling may apply — text still carries the meaning. */
  readonly destructive: boolean;
  /** Required element order. `presentationOrder[0]` is always `consequence`; buttons are last. */
  readonly presentationOrder: readonly ConfirmationElementKind[];
}

const CONFIRM_VERBS: Readonly<Record<'merge' | 'stop' | 'close', string>> = Object.freeze({
  merge: 'Merge Branch',
  stop: 'Stop Pane',
  close: 'Close and Clean Up',
});

/**
 * Builds consequence-first confirmation copy for a destructive action. The
 * first sentence states what happens now; the second names the exact scope
 * (pane, project, worktree, branch when known, host); the third states the
 * disposition — what survives. Scope is always named as text; it is never
 * implied by color, icon, or button placement. Fails closed on unknown
 * actions, non-destructive actions (they present their menu title, not a
 * confirmation), empty/oversize fields, and an oversized combined detail.
 */
export function confirmationCopy(
  action: PaneActionId,
  scope: PaneActionScope
): PaneActionConfirmationCopy {
  const descriptor = describePaneAction(action);
  const destructiveAction = assertDestructiveAction(action, descriptor.menuTitle);

  const hostName = normalizeRequiredField(scope.hostName, 'hostName', MAX_CONFIRMATION_FIELD_LENGTH);
  const projectName = normalizeRequiredField(
    scope.projectName,
    'projectName',
    MAX_CONFIRMATION_FIELD_LENGTH
  );
  const paneTitle = normalizeRequiredField(
    scope.paneTitle,
    'paneTitle',
    MAX_CONFIRMATION_FIELD_LENGTH
  );
  const worktreeName = normalizeOptionalField(
    scope.worktreeName,
    'worktreeName',
    MAX_CONFIRMATION_FIELD_LENGTH
  );
  const branchName = normalizeOptionalField(
    scope.branchName,
    'branchName',
    MAX_CONFIRMATION_FIELD_LENGTH
  );
  const mergeTargetBranchName = normalizeOptionalField(
    scope.mergeTargetBranchName,
    'mergeTargetBranchName',
    MAX_CONFIRMATION_FIELD_LENGTH
  );

  const consequenceSentence = buildConsequenceSentence(
    destructiveAction,
    paneTitle,
    hostName,
    branchName,
    mergeTargetBranchName
  );
  const scopeParts = [`pane "${paneTitle}"`, `project "${projectName}"`];
  if (worktreeName !== undefined) {
    scopeParts.push(`worktree "${worktreeName}"`);
  }
  if (branchName !== undefined) {
    scopeParts.push(`branch "${branchName}"`);
  }
  const scopeSentence = `Scope: ${scopeParts.join(', ')}, host "${hostName}".`;
  const dispositionSentence = buildDispositionSentence(destructiveAction, mergeTargetBranchName);

  const detail = `${consequenceSentence} ${scopeSentence} ${dispositionSentence}`;
  if (detail.length > MAX_CONFIRMATION_DETAIL_LENGTH) {
    throw new RangeError(
      `paneActionCatalog: combined confirmation detail length ${detail.length} exceeds maximum ${MAX_CONFIRMATION_DETAIL_LENGTH}; shorten display names instead of truncating the consequence`
    );
  }

  const confirmLabel = CONFIRM_VERBS[destructiveAction];
  return Object.freeze({
    action,
    title: `${confirmLabel} "${paneTitle}"?`,
    detail,
    consequenceSentence,
    scopeSentence,
    dispositionSentence,
    confirmLabel,
    cancelLabel: 'Cancel',
    destructive: true,
    presentationOrder: CONFIRMATION_PRESENTATION_ORDER,
  });
}

/**
 * Runtime-checked narrowing to the destructive set. The descriptor table and
 * `PANE_ACTION_DESTRUCTIVE_IDS` must agree (asserted by the focused tests);
 * the membership check here is the runtime source of truth for the guard.
 */
function assertDestructiveAction(
  action: PaneActionId,
  menuTitle: string
): DestructivePaneActionId {
  if (!(PANE_ACTION_DESTRUCTIVE_IDS as readonly PaneActionId[]).includes(action)) {
    throw new RangeError(
      `paneActionCatalog: action ${JSON.stringify(action)} is not destructive in v1 and does not present a confirmation; render its menu title ${JSON.stringify(menuTitle)} directly`
    );
  }
  // Sound: the membership check above is the runtime guard for this cast.
  return action as DestructivePaneActionId;
}

function buildConsequenceSentence(
  action: DestructivePaneActionId,
  paneTitle: string,
  hostName: string,
  branchName: string | undefined,
  mergeTargetBranchName: string | undefined
): string {
  switch (action) {
    case 'merge': {
      const source = branchName ?? "the pane's branch";
      if (mergeTargetBranchName !== undefined) {
        return `This merges branch "${source}" into branch "${mergeTargetBranchName}" now, moving its commits onto the target branch.`;
      }
      return `This starts a merge of branch "${source}" now; the host validates the merge and selects the target branch.`;
    }
    case 'stop':
      return `This stops pane "${paneTitle}" on host "${hostName}" now and ends its running session.`;
    case 'close':
      return `This stops pane "${paneTitle}" on host "${hostName}" now and removes the pane from the cockpit once the host cleanup choices complete.`;
  }
}

function buildDispositionSentence(
  action: DestructivePaneActionId,
  mergeTargetBranchName: string | undefined
): string {
  switch (action) {
    case 'merge':
      return mergeTargetBranchName !== undefined
        ? `The worktree keeps running; the host reports the merge result for branch "${mergeTargetBranchName}".`
        : 'The worktree keeps running; the host validates the merge and reports the result before anything merges.';
    case 'stop':
      return 'The worktree and branch survive. The pane stays in the cockpit and can be restarted.';
    case 'close':
      return 'The worktree and branch are kept unless the host cleanup choices you make next remove them.';
  }
}

// ---------------------------------------------------------------------------
// Availability: stale and already-running actions are disabled (contract §6)
// ---------------------------------------------------------------------------

export type PaneActionDisabledReasonToken =
  | 'host-unreachable'
  | 'action-already-running'
  | 'another-action-running'
  | 'stale-context';

export interface PaneActionAvailabilityContext {
  /**
   * Explicit false disables every action. Omitting it asserts the caller has
   * no reason to believe the host is unreachable; it never overrides an
   * explicit false.
   */
  readonly hostReachable?: boolean;
  /**
   * True when the pane context may be out of date (the host reports a stale
   * or offline-degraded state). Stale context disables every action —
   * including read-only navigation — until the pane is refreshed, because
   * file listings and ritual runs address the same possibly-stale scope.
   * Omitting it asserts the caller is rendering a fresh context.
   */
  readonly isStale?: boolean;
  /**
   * The action currently running on this pane, if any. Actions are
   * single-flight per pane: the running action cannot be run again and no
   * other action may start until the host reports a terminal state.
   */
  readonly runningAction?: PaneActionId;
}

export interface PaneActionAvailability {
  readonly action: PaneActionId;
  readonly available: boolean;
  readonly disabled: boolean;
  /** Bounded reason token for cross-layer assertions; undefined when available. */
  readonly disabledReasonToken: PaneActionDisabledReasonToken | undefined;
  /** Required textual reason rendered in the same surface; undefined when available. */
  readonly disabledReason: string | undefined;
}

/**
 * Returns whether `action` may be offered on a pane right now, and the exact
 * textual reason when it may not. Precedence: host unreachable, then an
 * action already running, then stale context. Disabled reasons are text
 * rendered in the same surface as the disabled control — never color-only.
 */
export function availabilityFor(
  action: PaneActionId,
  context: PaneActionAvailabilityContext
): PaneActionAvailability {
  const descriptor = describePaneAction(action);

  if (context.hostReachable === false) {
    return disabled(
      action,
      'host-unreachable',
      `Host is unreachable. Reconnect before running "${descriptor.menuTitle}" on this pane.`
    );
  }

  if (context.runningAction !== undefined) {
    const running = describePaneAction(context.runningAction);
    if (running.id === action) {
      return disabled(
        action,
        'action-already-running',
        `"${descriptor.menuTitle}" is already running on this pane. Wait for it to finish before running it again.`
      );
    }
    return disabled(
      action,
      'another-action-running',
      `"${running.menuTitle}" is running on this pane. Wait for it to finish or cancel it before running "${descriptor.menuTitle}".`
    );
  }

  if (context.isStale === true) {
    return disabled(
      action,
      'stale-context',
      `The pane state may be out of date (stale). Refresh the pane before running "${descriptor.menuTitle}".`
    );
  }

  return Object.freeze({
    action,
    available: true,
    disabled: false,
    disabledReasonToken: undefined,
    disabledReason: undefined,
  });
}

function disabled(
  action: PaneActionId,
  token: PaneActionDisabledReasonToken,
  reason: string
): PaneActionAvailability {
  if (reason.length > MAX_AVAILABILITY_REASON_LENGTH) {
    throw new RangeError(
      `paneActionCatalog: availability reason length ${reason.length} exceeds maximum ${MAX_AVAILABILITY_REASON_LENGTH}`
    );
  }
  return Object.freeze({
    action,
    available: false,
    disabled: true,
    disabledReasonToken: token,
    disabledReason: reason,
  });
}

// ---------------------------------------------------------------------------
// Result / error / progress visibility states (contract §7)
// ---------------------------------------------------------------------------

/**
 * Bounded v1 feedback vocabulary for a started pane action. Every state must
 * render its textual equivalent in the same surface while it persists;
 * spinners and color are additive, never the only signal.
 */
export type PaneActionFeedbackState = 'in-progress' | 'succeeded' | 'failed';

export interface PaneActionFeedbackDescriptor {
  readonly state: PaneActionFeedbackState;
  /** Required standalone textual equivalent (status line / badge text). */
  readonly text: string;
  /** Required in-sentence equivalent following the action title. */
  readonly summaryPhrase: string;
}

export const PANE_ACTION_FEEDBACK_STATES: readonly PaneActionFeedbackState[] = [
  'in-progress',
  'succeeded',
  'failed',
];

export const PANE_ACTION_FEEDBACK_DESCRIPTORS: Readonly<
  Record<PaneActionFeedbackState, PaneActionFeedbackDescriptor>
> = Object.freeze({
  'in-progress': Object.freeze({
    state: 'in-progress' as const,
    text: 'In progress',
    summaryPhrase: 'is in progress',
  }),
  succeeded: Object.freeze({
    state: 'succeeded' as const,
    text: 'Completed',
    summaryPhrase: 'completed',
  }),
  failed: Object.freeze({
    state: 'failed' as const,
    text: 'Failed',
    summaryPhrase: 'failed',
  }),
});

/** Returns the descriptor for a feedback state; unknown values fail closed. */
export function describePaneActionFeedback(state: PaneActionFeedbackState): PaneActionFeedbackDescriptor {
  const descriptor = (PANE_ACTION_FEEDBACK_DESCRIPTORS as Record<
    string,
    PaneActionFeedbackDescriptor | undefined
  >)[state];
  if (!descriptor) {
    throw new TypeError(
      `paneActionCatalog: unknown pane action feedback state ${JSON.stringify(state)}; expected one of ${PANE_ACTION_FEEDBACK_STATES.map((token) => JSON.stringify(token)).join(', ')}`
    );
  }
  return descriptor;
}

/**
 * Builds the required feedback line for a started action, e.g.
 * `"Stop Pane" is in progress` or `"Merge…" failed: host rejected the target`.
 * `detail` (progress note, result text, or host-provided error) is passed
 * through as text — the host stays the source of truth — after whitespace
 * normalization, and fails closed instead of truncating. The line never
 * relies on color or a spinner alone.
 */
export function feedbackLineFor(
  action: PaneActionId,
  state: PaneActionFeedbackState,
  options: { readonly detail?: string } = {}
): string {
  const descriptor = describePaneAction(action);
  const feedback = describePaneActionFeedback(state);
  let line = `"${descriptor.menuTitle}" ${feedback.summaryPhrase}`;
  if (options.detail !== undefined) {
    const detail = normalizeRequiredField(options.detail, 'detail', MAX_FEEDBACK_DETAIL_LENGTH);
    line += `: ${detail}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Internal validation helpers (fail closed; pure)
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequiredField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `paneActionCatalog: ${field} must be a string, received ${typeof value}`
    );
  }
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw new RangeError(`paneActionCatalog: ${field} must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new RangeError(
      `paneActionCatalog: ${field} length ${normalized.length} exceeds maximum ${maxLength}`
    );
  }
  return normalized;
}

function normalizeOptionalField(
  value: unknown,
  field: string,
  maxLength: number
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeRequiredField(value, field, maxLength);
}
