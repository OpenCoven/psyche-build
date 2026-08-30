// Mobile motion and accessibility semantics — reference implementation (v1).
//
// Contract: docs/a11y/MOBILE-MOTION-SEMANTICS.md
// Issue: OpenCoven/psyche-build#212 (Beads psyche-i7c.10.3).
//
// This module is the platform-neutral, executable form of the contract: typed
// status tokens that always carry a human textual equivalent (status is never
// color-only), combined pane/project/host summaries, selected-split
// announcement semantics, consequence-first confirmation phrasing, and a
// motion trait table whose matched-geometry and nonessential transitions are
// stripped under Reduce Motion.
//
// Every export is a pure function or frozen constant. There is no I/O, no
// clock, no randomness, and no imports, so the SwiftUI layer can mirror this
// table token-for-token and XCUITest can assert against the same strings.

/** Version of the contract this module implements (docs/a11y/MOBILE-MOTION-SEMANTICS.md). */
export const MOTION_SEMANTICS_CONTRACT_VERSION = 1;

/** Stable contract identifier, safe for logs and cross-layer assertions. */
export const MOTION_SEMANTICS_CONTRACT_ID = 'psyche.mobile.a11y.motion-semantics.v1';

/** Maximum normalized length of any single identity/status field in a summary. */
export const MAX_SUMMARY_FIELD_LENGTH = 120;

/** Maximum normalized length of the combined summary label (fail-closed, never truncated). */
export const MAX_SUMMARY_LENGTH = 280;

/** Maximum normalized length of any single field in confirmation copy. */
export const MAX_CONFIRMATION_FIELD_LENGTH = 120;

/** Maximum normalized length of the combined confirmation detail (fail-closed, never truncated). */
export const MAX_CONFIRMATION_LENGTH = 600;

// ---------------------------------------------------------------------------
// Status tokens (contract §2 — status is never color-only)
// ---------------------------------------------------------------------------

/**
 * Bounded pane status vocabulary for the mobile cockpit. Every token must
 * carry a non-empty textual equivalent in `PANE_STATUS_DESCRIPTORS`; adding a
 * token without text is a contract violation.
 */
export type PaneStatusToken =
  | 'needs-you'
  | 'running'
  | 'starting'
  | 'idle'
  | 'stale'
  | 'offline'
  | 'failed'
  | 'exited';

/** Relative urgency of a status, used for ordering — never a substitute for the text. */
export type PaneStatusSeverity = 'attention' | 'active' | 'neutral' | 'degraded';

export interface PaneStatusDescriptor {
  readonly token: PaneStatusToken;
  /** Required standalone textual equivalent (chip/badge text). Never color vocabulary. */
  readonly text: string;
  /** Required in-sentence textual equivalent used by combined summaries. */
  readonly summaryPhrase: string;
  readonly severity: PaneStatusSeverity;
}

export const PANE_STATUS_TOKENS: readonly PaneStatusToken[] = [
  'needs-you',
  'running',
  'starting',
  'idle',
  'stale',
  'offline',
  'failed',
  'exited',
];

export const PANE_STATUS_DESCRIPTORS: Readonly<
  Record<PaneStatusToken, PaneStatusDescriptor>
> = {
  'needs-you': {
    token: 'needs-you',
    text: 'Needs you',
    summaryPhrase: 'needs your attention',
    severity: 'attention',
  },
  running: {
    token: 'running',
    text: 'Running',
    summaryPhrase: 'running',
    severity: 'active',
  },
  starting: {
    token: 'starting',
    text: 'Starting',
    summaryPhrase: 'starting',
    severity: 'active',
  },
  idle: {
    token: 'idle',
    text: 'Idle',
    summaryPhrase: 'idle',
    severity: 'neutral',
  },
  stale: {
    token: 'stale',
    text: 'Stale',
    summaryPhrase: 'may be out of date',
    severity: 'degraded',
  },
  offline: {
    token: 'offline',
    text: 'Offline',
    summaryPhrase: 'host is offline',
    severity: 'degraded',
  },
  failed: {
    token: 'failed',
    text: 'Failed',
    summaryPhrase: 'failed',
    severity: 'degraded',
  },
  exited: {
    token: 'exited',
    text: 'Exited',
    summaryPhrase: 'exited',
    severity: 'degraded',
  },
};

/** Returns the descriptor for a token; unknown values fail closed. */
export function describePaneStatus(token: PaneStatusToken): PaneStatusDescriptor {
  const descriptor = (PANE_STATUS_DESCRIPTORS as Record<string, PaneStatusDescriptor | undefined>)[
    token
  ];
  if (!descriptor) {
    throw new TypeError(
      `motionSemantics: unknown pane status token ${JSON.stringify(token)}`
    );
  }
  return descriptor;
}

/** Returns the required standalone textual equivalent for a status token. */
export function paneStatusText(token: PaneStatusToken): string {
  return describePaneStatus(token).text;
}

// ---------------------------------------------------------------------------
// Combined pane/project/host summaries (contract §3, §4)
// ---------------------------------------------------------------------------

export type SummaryPartKind =
  | 'selected'
  | 'pane'
  | 'status'
  | 'project'
  | 'worktree'
  | 'branch'
  | 'host';

export interface PaneProjectHostSummaryInput {
  readonly paneTitle: string;
  readonly status: PaneStatusToken;
  readonly projectName: string;
  readonly hostName: string;
  readonly worktreeName?: string;
  readonly branchName?: string;
  /** True when this pane is the focused split; the label announces selection. */
  readonly isFocused?: boolean;
}

export interface PaneProjectHostSummaryPart {
  readonly kind: SummaryPartKind;
  readonly text: string;
}

export interface PaneProjectHostSummary {
  /** Combined accessibility label. Contains no color vocabulary, never truncated. */
  readonly label: string;
  /** Structured parts in announcement order, for platforms rendering elements separately. */
  readonly parts: readonly PaneProjectHostSummaryPart[];
  /** True when the pane is the focused split (selected state announced). */
  readonly isFocused: boolean;
  /** Status textual equivalents carried by this summary (summaryPhrase forms). */
  readonly statusText: string;
}

/**
 * Builds the combined pane/project/host accessibility label. The label always
 * carries pane identity, a textual status equivalent, project name, and host
 * name; worktree and branch are included when provided. Worktree and branch
 * identity is essential: callers that have them must pass them (contract §3.1,
 * §6). Fail closed on empty or oversize input — never truncate identity away.
 */
export function summaryForPaneProjectHost(
  input: PaneProjectHostSummaryInput
): PaneProjectHostSummary {
  const statusToken = assertPaneStatusToken(input.status, 'status');
  const paneTitle = normalizeRequiredField(input.paneTitle, 'paneTitle', MAX_SUMMARY_FIELD_LENGTH);
  const projectName = normalizeRequiredField(
    input.projectName,
    'projectName',
    MAX_SUMMARY_FIELD_LENGTH
  );
  const hostName = normalizeRequiredField(input.hostName, 'hostName', MAX_SUMMARY_FIELD_LENGTH);
  const worktreeName = normalizeOptionalField(
    input.worktreeName,
    'worktreeName',
    MAX_SUMMARY_FIELD_LENGTH
  );
  const branchName = normalizeOptionalField(
    input.branchName,
    'branchName',
    MAX_SUMMARY_FIELD_LENGTH
  );
  const isFocused = input.isFocused === true;

  const descriptor = describePaneStatus(statusToken);
  const parts: PaneProjectHostSummaryPart[] = [];
  if (isFocused) {
    // Contract §4: the focused split announces its selection first, as text,
    // in addition to the platform selected trait.
    parts.push({ kind: 'selected', text: 'Selected' });
  }
  parts.push(
    { kind: 'pane', text: `Pane "${paneTitle}"` },
    { kind: 'status', text: descriptor.summaryPhrase },
    { kind: 'project', text: `project "${projectName}"` }
  );
  if (worktreeName !== undefined) {
    parts.push({ kind: 'worktree', text: `worktree "${worktreeName}"` });
  }
  if (branchName !== undefined) {
    parts.push({ kind: 'branch', text: `branch "${branchName}"` });
  }
  parts.push({ kind: 'host', text: `host "${hostName}"` });

  const label = parts.map((part) => part.text).join('; ');
  if (label.length > MAX_SUMMARY_LENGTH) {
    throw new RangeError(
      `motionSemantics: combined summary label length ${label.length} exceeds maximum ${MAX_SUMMARY_LENGTH}; shorten display names instead of truncating identity`
    );
  }

  return Object.freeze({
    label,
    parts: Object.freeze(parts.map((part) => Object.freeze(part))),
    isFocused,
    statusText: descriptor.summaryPhrase,
  });
}

// ---------------------------------------------------------------------------
// Motion traits (contract §7 — Reduce Motion)
// ---------------------------------------------------------------------------

/** Bounded v1 transition vocabulary for cockpit surfaces. */
export type MotionTransitionKind =
  | 'pane-selection'
  | 'pane-focus-change'
  | 'pane-open'
  | 'pane-close'
  | 'action-sheet-present'
  | 'action-sheet-dismiss'
  | 'summary-refresh'
  | 'attention-pulse'
  | 'activity-progress';

/**
 * Semantic motion classes. `matched-geometry` and `nonessential-transition`
 * are stripped under Reduce Motion; `essential-state` conveys state and is
 * retained; `non-motion` changes state instantly by definition.
 */
export type MotionTraitClass =
  | 'matched-geometry'
  | 'nonessential-transition'
  | 'essential-state'
  | 'non-motion';

/** Concrete animation tokens; each maps to exactly one class via MOTION_TRAIT_CLASSES. */
export type MotionTrait =
  | 'matched-geometry'
  | 'slide-transition'
  | 'opacity-crossfade'
  | 'scale-transition'
  | 'move-transition'
  | 'pulse-animation'
  | 'spring-animation'
  | 'activity-indicator'
  | 'static-state-change';

export const MOTION_TRANSITION_KINDS: readonly MotionTransitionKind[] = [
  'pane-selection',
  'pane-focus-change',
  'pane-open',
  'pane-close',
  'action-sheet-present',
  'action-sheet-dismiss',
  'summary-refresh',
  'attention-pulse',
  'activity-progress',
];

export const MOTION_TRAIT_CLASSES: Readonly<Record<MotionTrait, MotionTraitClass>> = {
  'matched-geometry': 'matched-geometry',
  'slide-transition': 'nonessential-transition',
  'opacity-crossfade': 'nonessential-transition',
  'scale-transition': 'nonessential-transition',
  'move-transition': 'nonessential-transition',
  'pulse-animation': 'nonessential-transition',
  'spring-animation': 'nonessential-transition',
  // Essential: the only live signal that work is ongoing; retained under
  // Reduce Motion and additionally backed by textual status (contract §7.2).
  'activity-indicator': 'essential-state',
  'static-state-change': 'non-motion',
};

const MOTION_TRAITS_BY_KIND: Readonly<Record<MotionTransitionKind, readonly MotionTrait[]>> = {
  'pane-selection': ['matched-geometry'],
  'pane-focus-change': ['move-transition'],
  'pane-open': ['slide-transition', 'opacity-crossfade'],
  'pane-close': ['slide-transition', 'opacity-crossfade'],
  'action-sheet-present': ['slide-transition', 'spring-animation'],
  'action-sheet-dismiss': ['opacity-crossfade'],
  'summary-refresh': ['opacity-crossfade'],
  'attention-pulse': ['pulse-animation'],
  'activity-progress': ['activity-indicator'],
};

export interface MotionTraitPlan {
  readonly kind: MotionTransitionKind;
  /** Traits to apply after Reduce Motion is honored (instant change when empty). */
  readonly traits: readonly MotionTrait[];
  /** Traits removed because of Reduce Motion; empty when motion is allowed. */
  readonly reduceMotionStripped: readonly MotionTrait[];
  /** True when every trait was stripped: render the final state immediately. */
  readonly rendersInstantStateChange: boolean;
}

export interface MotionTraitOptions {
  /** When true, matched-geometry and nonessential-transition traits are stripped. */
  readonly reduceMotion?: boolean;
}

/**
 * Maps a transition kind to its motion traits. With `reduceMotion: true`,
 * matched-geometry and nonessential-transition traits are removed and the
 * caller must render the resulting state instantly (contract §7.1, §7.4).
 * Essential-state traits (`activity-indicator`) survive; no state may be
 * communicated only through motion (contract §7.3).
 */
export function motionTraitsFor(
  kind: MotionTransitionKind,
  options: MotionTraitOptions = {}
): MotionTraitPlan {
  assertMotionTransitionKind(kind, 'kind');
  const baseTraits = MOTION_TRAITS_BY_KIND[kind];
  if (options.reduceMotion !== true) {
    return Object.freeze({
      kind,
      traits: Object.freeze([...baseTraits]),
      reduceMotionStripped: Object.freeze([]),
      rendersInstantStateChange: false,
    });
  }

  const retained: MotionTrait[] = [];
  const stripped: MotionTrait[] = [];
  for (const trait of baseTraits) {
    const traitClass = MOTION_TRAIT_CLASSES[trait];
    if (traitClass === 'matched-geometry' || traitClass === 'nonessential-transition') {
      stripped.push(trait);
    } else {
      retained.push(trait);
    }
  }
  return Object.freeze({
    kind,
    traits: Object.freeze(retained),
    reduceMotionStripped: Object.freeze(stripped),
    rendersInstantStateChange: retained.length === 0,
  });
}

// ---------------------------------------------------------------------------
// Consequence-first confirmations (contract §5)
// ---------------------------------------------------------------------------

export type ConfirmationActionKind = 'stop-pane' | 'close-pane' | 'send-input';

export interface ConfirmationScope {
  readonly hostName: string;
  readonly projectName: string;
  readonly paneTitle: string;
  readonly worktreeName?: string;
  readonly branchName?: string;
  /** Replaces the first (consequence) sentence when provided. */
  readonly consequenceOverride?: string;
}

export interface ConfirmationCopy {
  readonly action: ConfirmationActionKind;
  /** Short header naming the action, e.g. `Stop pane "x"?`. */
  readonly title: string;
  /** Consequence-first detail: what happens now, then scope, then survival. */
  readonly detail: string;
  /** Verb-first confirm label naming the action. */
  readonly confirmLabel: string;
  /** Plain non-destructive cancel label. */
  readonly cancelLabel: string;
  /** True when the action is destructive (destructive styling may apply — text still required). */
  readonly destructive: boolean;
  /** True when the copy states that worktree and branch survive the action. */
  readonly namesWorktreeAndBranchSurvival: boolean;
}

const CONFIRMATION_ACTION_LABELS: Readonly<Record<ConfirmationActionKind, string>> = {
  'stop-pane': 'Stop pane',
  'close-pane': 'Close pane',
  'send-input': 'Send input',
};

/**
 * Builds consequence-first confirmation copy. The first sentence states the
 * consequence; the remaining sentences name pane, project, and host, and — for
 * stop/close — state that the worktree and branch survive (contract §5.2).
 */
export function confirmationCopy(
  action: ConfirmationActionKind,
  scope: ConfirmationScope
): ConfirmationCopy {
  assertConfirmationActionKind(action, 'action');
  const hostName = normalizeRequiredField(
    scope.hostName,
    'hostName',
    MAX_CONFIRMATION_FIELD_LENGTH
  );
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

  const actionLabel = CONFIRMATION_ACTION_LABELS[action];
  const destructive = action !== 'send-input';
  const namesWorktreeAndBranchSurvival = action === 'stop-pane' || action === 'close-pane';

  const consequence =
    scope.consequenceOverride === undefined
      ? defaultConsequence(action, paneTitle, hostName)
      : normalizeRequiredField(
          scope.consequenceOverride,
          'consequenceOverride',
          MAX_CONFIRMATION_FIELD_LENGTH
        );

  const scopeParts = [`project "${projectName}"`];
  if (worktreeName !== undefined) {
    scopeParts.push(`worktree "${worktreeName}"`);
  }
  if (branchName !== undefined) {
    scopeParts.push(`branch "${branchName}"`);
  }

  let detail = `${consequence} Scope: pane "${paneTitle}", ${scopeParts.join(', ')}, host "${hostName}".`;
  if (namesWorktreeAndBranchSurvival) {
    detail += ` The worktree and branch survive; only the pane's session ends.`;
  }
  if (detail.length > MAX_CONFIRMATION_LENGTH) {
    throw new RangeError(
      `motionSemantics: combined confirmation detail length ${detail.length} exceeds maximum ${MAX_CONFIRMATION_LENGTH}; shorten display names instead of truncating the consequence`
    );
  }

  return Object.freeze({
    action,
    title: `${actionLabel} "${paneTitle}"?`,
    detail,
    confirmLabel: actionLabel,
    cancelLabel: 'Cancel',
    destructive,
    namesWorktreeAndBranchSurvival,
  });
}

function defaultConsequence(
  action: ConfirmationActionKind,
  paneTitle: string,
  hostName: string
): string {
  switch (action) {
    case 'stop-pane':
      return `This stops pane "${paneTitle}" on host "${hostName}" now and ends its running session.`;
    case 'close-pane':
      return `This closes pane "${paneTitle}" on host "${hostName}" now and removes it from the cockpit.`;
    case 'send-input':
      return `This sends your input to pane "${paneTitle}" on host "${hostName}" now, exactly as typed.`;
  }
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
      `motionSemantics: ${field} must be a string, received ${typeof value}`
    );
  }
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw new RangeError(`motionSemantics: ${field} must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new RangeError(
      `motionSemantics: ${field} length ${normalized.length} exceeds maximum ${maxLength}`
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

function assertPaneStatusToken(value: unknown, field: string): PaneStatusToken {
  if (typeof value !== 'string' || !PANE_STATUS_TOKENS.includes(value as PaneStatusToken)) {
    throw new TypeError(
      `motionSemantics: ${field} must be one of ${PANE_STATUS_TOKENS.map((token) => JSON.stringify(token)).join(', ')}`
    );
  }
  return value as PaneStatusToken;
}

function assertMotionTransitionKind(value: unknown, field: string): MotionTransitionKind {
  if (
    typeof value !== 'string' ||
    !MOTION_TRANSITION_KINDS.includes(value as MotionTransitionKind)
  ) {
    throw new TypeError(
      `motionSemantics: ${field} must be one of ${MOTION_TRANSITION_KINDS.map((kind) => JSON.stringify(kind)).join(', ')}`
    );
  }
  return value as MotionTransitionKind;
}

function assertConfirmationActionKind(value: unknown, field: string): ConfirmationActionKind {
  const known: readonly ConfirmationActionKind[] = ['stop-pane', 'close-pane', 'send-input'];
  if (typeof value !== 'string' || !known.includes(value as ConfirmationActionKind)) {
    throw new TypeError(
      `motionSemantics: ${field} must be one of ${known.map((kind) => JSON.stringify(kind)).join(', ')}`
    );
  }
  return value as ConfirmationActionKind;
}
