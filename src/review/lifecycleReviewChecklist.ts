// Phase 9 lifecycle review checklist — record contract, version v1.
//
// Machine-checkable companion to `docs/review/LIFECYCLE-PHASE-REVIEW.md`
// (issue OpenCoven/psyche-build#221, bead `psyche-i7c.9.5`, "Validate and
// review full lifecycle actions"). The prose document defines *how* each
// checklist item is evaluated; this module defines the typed checklist item
// ids (host/core/UI suites + spec/security/quality review) and the strict,
// versioned record format used to report and validate the Phase 9 review.
//
// Phase 9 (`psyche-i7c.9`, #217) exposes complete guarded pane lifecycle
// actions on mobile by reusing the existing host action workflows for merge,
// PR, stop, close, and cleanup. The acceptance bar for the phase (#221) is:
// no bypass of existing merge/PR/cleanup safeguards remains, the lifecycle
// host/core/UI suites pass, and the spec/security/code-quality reviews
// approve the phase.
//
// This module is a review-contract slice only. It never executes suites,
// never infers runtime state, and never grants or denies authority by itself:
// a maintainer decides phase approval from explicit, evidence-backed item
// verdicts recorded here.

/** Record version of the phase-review record format produced and validated here. */
export const LIFECYCLE_REVIEW_RECORD_VERSION = 1;

/** Bead id of the validated phase task. */
export const LIFECYCLE_PHASE_ID = 'psyche-i7c.9.5';

/** Mirror issue number of the validated phase task. */
export const LIFECYCLE_PHASE_MIRROR_ISSUE = 221;

/** Bead id of the Phase 9 parent. */
export const LIFECYCLE_PARENT_PHASE_ID = 'psyche-i7c.9';

/** Mirror issue number of the Phase 9 parent. */
export const LIFECYCLE_PARENT_MIRROR_ISSUE = 217;

/** Checklist groups. Suites are grouped first, then the three review tracks. */
export const LIFECYCLE_REVIEW_GROUP_IDS = [
  'host-suites',
  'core-suites',
  'ui-suites',
  'spec-review',
  'security-review',
  'quality-review',
] as const;

export type LifecycleReviewGroupId = (typeof LIFECYCLE_REVIEW_GROUP_IDS)[number];

/**
 * Typed checklist item ids, grouped host/core/UI suites + spec/security/
 * quality review. Order matches the v1 protocol document; ids are stable
 * identifiers, not display labels.
 */
export const LIFECYCLE_REVIEW_ITEM_IDS = [
  // Host suites — existing host action-workflow regressions (run on main today).
  'host.merge-action-regressions',
  'host.close-cleanup-regressions',
  'host.worktree-cleanup-regressions',
  'host.pr-action-regressions',
  'host.remote-action-dispatch',
  // Core suites — merge/PR decision core, approvals, and the mobile boundary.
  'core.merge-validation-regressions',
  'core.merge-target-regressions',
  'core.multi-merge-orchestrator-regressions',
  'core.conflict-resolution-regressions',
  'core.pr-summary-regressions',
  'core.control-approval-chain',
  'core.mobile-gateway-action-boundary',
  // UI suites — menu regressions on main plus the #219/#220 fixture suites.
  'ui.pane-action-menu-regressions',
  'ui.merge-pr-interactive-fixtures',
  'ui.stop-close-cleanup-fixtures',
  'ui.in-progress-disable-fixtures',
  // Spec-compliance review.
  'spec.phase-9-acceptance-criteria',
  // Security review — no-bypass items; these may never be `not-run`.
  'security.merge-safeguard-preservation',
  'security.pr-review-safeguard-preservation',
  'security.stop-retention-boundary',
  'security.destructive-confirmation-integrity',
  'security.authority-scope-idempotency-preservation',
  // Code-quality review.
  'quality.code-review-severity-triage',
] as const;

export type LifecycleReviewItemId = (typeof LIFECYCLE_REVIEW_ITEM_IDS)[number];

/** One typed checklist item: what it covers and what evidence must show. */
export interface LifecycleChecklistItem {
  readonly id: LifecycleReviewItemId;
  readonly group: LifecycleReviewGroupId;
  /** Short, stable label for tables and reports. */
  readonly label: string;
  /** What this item requires for a `pass` verdict. */
  readonly requirement: string;
  /**
   * Existing suites to run for this item, exactly as passed to
   * `vitest --run`. Empty when the coverage is delivered by a phase-family
   * slice (see {@link deliveredByIssue}) rather than by mainline files.
   */
  readonly suites: readonly string[];
  /** Mirror issue that owns/delivers the coverage when it is not on main yet. */
  readonly deliveredByIssue?: number;
  /**
   * True for security no-bypass items: the record can never leave them
   * `not-run`; a reviewer must reach an explicit pass or fail verdict.
   */
  readonly securityClass?: boolean;
  /** What a valid evidence pointer for this item must point at. */
  readonly evidenceHint: string;
}

const ITEMS = [
  {
    id: 'host.merge-action-regressions',
    group: 'host-suites',
    label: 'Host merge action workflow regressions',
    requirement:
      'The existing merge action suite passes unchanged: merge reuses host validation, sibling-pane handling, and exact pane-identity teardown paths.',
    suites: ['__tests__/actions/mergeAction.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suites at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'host.close-cleanup-regressions',
    group: 'host-suites',
    label: 'Host close/cleanup action workflow regressions',
    requirement:
      'The existing close-action suite passes unchanged: close enters host cleanup choices, cleanup is opt-in, and prompt-file cleanup stays best-effort.',
    suites: ['__tests__/actions/closeAction.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'host.worktree-cleanup-regressions',
    group: 'host-suites',
    label: 'Host worktree cleanup service regressions',
    requirement:
      'The worktree cleanup service and cross-process suites pass unchanged: cleanup never removes a worktree still referenced by sibling panes and never runs unguarded across processes.',
    suites: [
      '__tests__/worktreeCleanupService.test.ts',
      '__tests__/worktreeCleanupCrossProcess.test.ts',
    ],
    evidenceHint:
      'Vitest run output for the listed suites at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'host.pr-action-regressions',
    group: 'host-suites',
    label: 'Host PR action workflow regressions',
    requirement:
      'The existing create-PR action suite passes unchanged: PR creation reuses the host flow, including review and message surfaces.',
    suites: ['__tests__/actions/createPullRequestAction.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'host.remote-action-dispatch',
    group: 'host-suites',
    label: 'Remote pane action dispatch regressions',
    requirement:
      'The remote pane action queue suite passes unchanged: mobile action requests are enqueued, drained, bound, and cleaned up through the host queue, not by client-side execution.',
    suites: ['__tests__/remotePaneActions.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.merge-validation-regressions',
    group: 'core-suites',
    label: 'Merge validation core regressions',
    requirement:
      'The merge validation suite passes unchanged: uncommitted-worktree and dirty-main detection and their user choices keep host ownership.',
    suites: ['__tests__/mergeValidation.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.merge-target-regressions',
    group: 'core-suites',
    label: 'Merge target core regressions',
    requirement:
      'The merge target suite passes unchanged: target selection, fallback targets, and base-branch rules stay host-owned.',
    suites: ['__tests__/mergeTargets.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.multi-merge-orchestrator-regressions',
    group: 'core-suites',
    label: 'Multi-merge orchestrator regressions',
    requirement:
      'The multi-merge orchestrator suite passes unchanged: per-worktree uncommitted choices and issue handling stay in the orchestrator, not in any client.',
    suites: ['__tests__/actions/multiMergeOrchestrator.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.conflict-resolution-regressions',
    group: 'core-suites',
    label: 'Conflict resolution regressions',
    requirement:
      'The conflict resolution suite passes unchanged: conflict and dirty-main handlers keep their existing prompts, choices, and terminal outcomes.',
    suites: ['__tests__/actions/conflictResolution.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.pr-summary-regressions',
    group: 'core-suites',
    label: 'PR summary core regressions',
    requirement:
      'The PR summary suite passes unchanged: generated PR summaries stay editable through the existing review surface with host-side generation.',
    suites: ['__tests__/prSummary.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.control-approval-chain',
    group: 'core-suites',
    label: 'Control approval chain regressions',
    requirement:
      'The control approval suite passes unchanged: approval transactions, consume assertions, lease revisions, and redacted effects preserve authority and one-time confirmation.',
    suites: ['__tests__/controlApprovals.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'core.mobile-gateway-action-boundary',
    group: 'core-suites',
    label: 'Mobile gateway action boundary regressions',
    requirement:
      'The mobile gateway and action-registration suites pass unchanged: action and pane scope are validated before the live executor runs, idempotency keys deduplicate execution, and owner sessions clear on disconnect.',
    suites: [
      '__tests__/bridge/mobileControlGateway.test.ts',
      '__tests__/bridge/mobileActionRegistration.test.ts',
    ],
    evidenceHint:
      'Vitest run output for the listed suites at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'ui.pane-action-menu-regressions',
    group: 'ui-suites',
    label: 'Pane action menu regressions',
    requirement:
      'The pane menu action suite passes unchanged: the action menu keeps its existing guarded availability and shortcut semantics.',
    suites: ['__tests__/paneMenuActions.test.ts'],
    evidenceHint:
      'Vitest run output for the listed suite at the reviewed head, showing all cases green (or a finding pointer when red).',
  },
  {
    id: 'ui.merge-pr-interactive-fixtures',
    group: 'ui-suites',
    label: 'Merge/PR interactive fixture coverage',
    requirement:
      'Deterministic fixture requesters and UI tests cover the merge confirmation/choice chains (#219 flows) and the PR review sheet (title/body editing, related files, final URL), reaching terminal outcomes with explicit single-use cancel paths.',
    suites: [],
    deliveredByIssue: 220,
    evidenceHint:
      'Run record for the #220 fixture suites delivering the #219 merge/PR flows on the phase branch (exact suite path plus green output), or a finding pointer when red.',
  },
  {
    id: 'ui.stop-close-cleanup-fixtures',
    group: 'ui-suites',
    label: 'Stop and close/cleanup fixture coverage',
    requirement:
      'Deterministic fixture UI tests cover stop versus close-and-clean-up as visually and semantically distinct flows, with cleanup routed through host cleanup choices.',
    suites: [],
    deliveredByIssue: 220,
    evidenceHint:
      'Run record for the #220 fixture suites delivered on the phase branch (exact suite path plus green output), or a finding pointer when red.',
  },
  {
    id: 'ui.in-progress-disable-fixtures',
    group: 'ui-suites',
    label: 'In-progress/stale action disabling fixture coverage',
    requirement:
      'Deterministic fixture UI tests cover in-progress and stale actions being disabled, with result/error/progress states visible.',
    suites: [],
    deliveredByIssue: 220,
    evidenceHint:
      'Run record for the #220 fixture suites delivered on the phase branch (exact suite path plus green output), or a finding pointer when red.',
  },
  {
    id: 'spec.phase-9-acceptance-criteria',
    group: 'spec-review',
    label: 'Phase 9 spec-compliance review',
    requirement:
      'Every Phase 9 acceptance criterion (#217) and every child gate (#218, #219, #220) is traced to implementation, tests, and evidence per the protocol document spec checklist; unresolved spec gaps are findings.',
    suites: [],
    evidenceHint:
      'Pointer to the completed spec-compliance checklist output for the Phase 9 diff (all rows traced with references).',
  },
  {
    id: 'security.merge-safeguard-preservation',
    group: 'security-review',
    label: 'Merge safeguards not bypassed',
    requirement:
      'Merge on every surface reuses the existing validation, sibling handling, uncommitted choices, and fallback targets; no client-side merge decision, no shortcut around host validation.',
    suites: [],
    securityClass: true,
    evidenceHint:
      'Security review note citing the merge code path(s) and the negative tests proving a bypass is rejected, not merely absent.',
  },
  {
    id: 'security.pr-review-safeguard-preservation',
    group: 'security-review',
    label: 'PR review safeguards not bypassed',
    requirement:
      'PR review keeps host authority for validation and generation; the client only edits and navigates. No path skips PR validation, review, or message handling.',
    suites: [],
    securityClass: true,
    evidenceHint:
      'Security review note citing the PR path(s) and the negative tests proving a bypass is rejected, not merely absent.',
  },
  {
    id: 'security.stop-retention-boundary',
    group: 'security-review',
    label: 'Stop retains worktree and branch',
    requirement:
      'Stop terminates the pane while retaining the worktree and branch; cleanup happens only through explicit host cleanup choices, never as a hidden side effect of stop or close.',
    suites: [],
    securityClass: true,
    evidenceHint:
      'Security review note citing the stop path(s) and the negative tests proving retained work is never discarded by stop.',
  },
  {
    id: 'security.destructive-confirmation-integrity',
    group: 'security-review',
    label: 'Destructive confirmations intact',
    requirement:
      'Every destructive flow names host/project/pane/worktree/branch and the consequence before its button, keeps explicit single-use cancel, and disables stale or already-running actions.',
    suites: [],
    securityClass: true,
    evidenceHint:
      'Security review note citing each destructive flow and its tested confirmation/cancel/disabled path.',
  },
  {
    id: 'security.authority-scope-idempotency-preservation',
    group: 'security-review',
    label: 'Authority, scope, receipt, and idempotency preserved',
    requirement:
      'The paired host remains the single source of truth for action validation and execution: no direct Psyche database reads, no duplicated protocol identity, operations scoped to published workspace resources, and confirmation/receipt/revocation/idempotency semantics unchanged.',
    suites: [],
    securityClass: true,
    evidenceHint:
      'Security review note citing the authority/scope/idempotency boundary checks (gateway scope validation, idempotency-key dedupe, approval chain) and any deviations found.',
  },
  {
    id: 'quality.code-review-severity-triage',
    group: 'quality-review',
    label: 'Code-quality review with severity triage',
    requirement:
      'The Phase 9 diff receives a whole-phase code-quality review with Critical/Important/Minor classification; no Critical or Important finding remains open, and Minors are explicitly deferred with owner acknowledgment.',
    suites: [],
    evidenceHint:
      'Pointer to the completed code-quality review output with the classified findings list and their resolutions.',
  },
] as const satisfies readonly LifecycleChecklistItem[];

/** The authoritative, ordered v1 checklist. */
export const LIFECYCLE_REVIEW_CHECKLIST: readonly LifecycleChecklistItem[] = ITEMS;

/** Map from checklist item id to its descriptor. */
export const LIFECYCLE_REVIEW_ITEMS_BY_ID: ReadonlyMap<
  LifecycleReviewItemId,
  LifecycleChecklistItem
> = new Map(LIFECYCLE_REVIEW_CHECKLIST.map((item) => [item.id, item]));

/** True when the item is a security no-bypass item that may never be `not-run`. */
export function isSecurityClassItem(itemId: LifecycleReviewItemId): boolean {
  return LIFECYCLE_REVIEW_ITEMS_BY_ID.get(itemId)?.securityClass === true;
}

/** Verdict for a single checklist item in a phase-review record. */
export type LifecycleReviewStatus = 'pass' | 'fail' | 'not-run';

const LIFECYCLE_REVIEW_STATUSES: readonly LifecycleReviewStatus[] = [
  'pass',
  'fail',
  'not-run',
];

/**
 * One recorded verdict. Every entry — including `not-run` — carries a
 * non-empty evidence pointer: for `pass`/`fail` it points at the run output,
 * review note, or finding; for `not-run` it names the concrete blocker or
 * owner gate that must still run.
 */
export interface LifecycleReviewEntry {
  readonly itemId: LifecycleReviewItemId;
  readonly status: LifecycleReviewStatus;
  /** Evidence pointer: durable file path, URL, run id, or blocker statement. */
  readonly evidence: string;
}

/**
 * A fillable phase-review record (version v1). `phaseApproved` is the
 * reviewer's claim that the phase may be approved; the validator rejects the
 * claim while any checklist item is not `pass`.
 */
export interface LifecyclePhaseReviewRecord {
  readonly version: typeof LIFECYCLE_REVIEW_RECORD_VERSION;
  /** Claimed phase approval; rejected while any item is not `pass`. */
  readonly phaseApproved: boolean;
  /** One entry per checklist item; every item must be present exactly once. */
  readonly items: readonly LifecycleReviewEntry[];
  /** Accountable reviewer or review agent (optional provenance). */
  readonly reviewer?: string;
  /** Exact head commit under review (optional provenance). */
  readonly reviewedHead?: string;
}

/** Normalized per-item verdict; `missing` means the record has no entry. */
export type LifecycleVerdict = LifecycleReviewStatus | 'missing';

export type LifecycleReviewProblemCode =
  | 'invalid-record'
  | 'invalid-version'
  | 'invalid-field-type'
  | 'unknown-field'
  | 'invalid-entry'
  | 'unknown-item'
  | 'duplicate-item'
  | 'invalid-status'
  | 'missing-evidence'
  | 'missing-item'
  | 'security-not-run'
  | 'invalid-approval';

export interface LifecycleReviewProblem {
  readonly code: LifecycleReviewProblemCode;
  readonly message: string;
  /** Present when the problem is attributable to one checklist item. */
  readonly itemId?: LifecycleReviewItemId;
  /** Present when the problem is attributable to one record field. */
  readonly field?: string;
}

export interface LifecycleReviewValidation {
  /** True only when the record is structurally well-formed and complete. */
  readonly valid: boolean;
  readonly problems: readonly LifecycleReviewProblem[];
  /** Normalized verdict per checklist item (`missing` when absent). */
  readonly verdicts: Record<LifecycleReviewItemId, LifecycleVerdict>;
}

const RECORD_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'phaseApproved',
  'items',
  'reviewer',
  'reviewedHead',
]);

const ENTRY_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'itemId',
  'status',
  'evidence',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isKnownItemId(value: string): value is LifecycleReviewItemId {
  return LIFECYCLE_REVIEW_ITEMS_BY_ID.has(value as LifecycleReviewItemId);
}

function isReviewStatus(value: unknown): value is LifecycleReviewStatus {
  return (
    value === 'pass' || value === 'fail' || value === 'not-run'
  );
}

/**
 * Strictly validate a phase-review record against the v1 contract.
 *
 * A returned `valid: true` means the record is well-formed: known version, no
 * unknown fields, every checklist item present exactly once, every verdict a
 * `pass`/`fail`/`not-run` with a non-empty evidence pointer, and no security
 * no-bypass item left `not-run`. Structural validity is necessary but not
 * sufficient for approval — see {@link phaseApproval} for the approved/blocked
 * decision.
 *
 * The validator is defensive about record shape so a malformed record from an
 * untrusted surface fails closed with problems instead of throwing.
 */
export function validatePhaseReview(record: unknown): LifecycleReviewValidation {
  const problems: LifecycleReviewProblem[] = [];
  const verdicts = Object.fromEntries(
    LIFECYCLE_REVIEW_CHECKLIST.map((item) => [item.id, 'missing' as const]),
  ) as Record<LifecycleReviewItemId, LifecycleVerdict>;

  if (!isPlainObject(record)) {
    problems.push({
      code: 'invalid-record',
      message: 'phase review record must be a JSON object',
    });
    return { valid: false, problems, verdicts };
  }

  // Reject unknown root fields before anything else so callers see the exact
  // contract violation instead of downstream type confusion.
  for (const key of Object.keys(record)) {
    if (!RECORD_ALLOWED_FIELDS.has(key)) {
      problems.push({
        code: 'unknown-field',
        field: key,
        message: `unknown phase review record field ${JSON.stringify(key)}`,
      });
    }
  }

  const version = record.version;
  if (version !== LIFECYCLE_REVIEW_RECORD_VERSION) {
    problems.push({
      code: 'invalid-version',
      field: 'version',
      message: `phase review record version must be ${LIFECYCLE_REVIEW_RECORD_VERSION}`,
    });
  }

  if (typeof record.phaseApproved !== 'boolean') {
    problems.push({
      code: 'invalid-field-type',
      field: 'phaseApproved',
      message: '"phaseApproved" must be a boolean',
    });
  }

  for (const optionalStringField of ['reviewer', 'reviewedHead'] as const) {
    const value = record[optionalStringField];
    if (value !== undefined && !isNonEmptyString(value)) {
      problems.push({
        code: 'invalid-field-type',
        field: optionalStringField,
        message: `"${optionalStringField}" must be a non-empty string when present`,
      });
    }
  }

  if (!Array.isArray(record.items)) {
    problems.push({
      code: 'invalid-record',
      field: 'items',
      message: '"items" must be an array of checklist entries',
    });
    return { valid: false, problems, verdicts };
  }

  const seen = new Map<LifecycleReviewItemId, number>();
  for (let index = 0; index < record.items.length; index += 1) {
    const entry: unknown = record.items[index];
    if (!isPlainObject(entry)) {
      problems.push({
        code: 'invalid-entry',
        message: `entry ${index} must be an object`,
      });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_ALLOWED_FIELDS.has(key)) {
        problems.push({
          code: 'unknown-field',
          field: `items[${index}].${key}`,
          message: `unknown entry field ${JSON.stringify(key)} at entry ${index}`,
        });
      }
    }

    const itemId = entry.itemId;
    if (typeof itemId !== 'string' || !isKnownItemId(itemId)) {
      problems.push({
        code: 'unknown-item',
        message: `entry ${index} has unknown checklist item id ${JSON.stringify(itemId ?? null)}`,
      });
      continue;
    }
    const knownItemId = itemId as LifecycleReviewItemId;
    const previousIndex = seen.get(knownItemId);
    if (previousIndex !== undefined) {
      problems.push({
        code: 'duplicate-item',
        itemId: knownItemId,
        message: `checklist item ${knownItemId} appears at entries ${previousIndex} and ${index}`,
      });
      continue;
    }
    seen.set(knownItemId, index);

    const status = entry.status;
    if (!isReviewStatus(status)) {
      problems.push({
        code: 'invalid-status',
        itemId: knownItemId,
        message: `checklist item ${knownItemId} has invalid status ${JSON.stringify(status ?? null)}; expected one of ${LIFECYCLE_REVIEW_STATUSES.join('|')}`,
      });
      continue;
    }
    verdicts[knownItemId] = status;

    const evidence = entry.evidence;
    if (!isNonEmptyString(evidence)) {
      problems.push({
        code: 'missing-evidence',
        itemId: knownItemId,
        message: `checklist item ${knownItemId} is missing a non-empty evidence pointer`,
      });
    } else if (status === 'not-run' && isSecurityClassItem(knownItemId)) {
      // A security no-bypass item may never stay `not-run`: the reviewer must
      // reach an explicit pass or fail verdict backed by evidence.
      problems.push({
        code: 'security-not-run',
        itemId: knownItemId,
        message: `security no-bypass item ${knownItemId} cannot be not-run; record an explicit pass or fail verdict with evidence`,
      });
    }
  }

  for (const item of LIFECYCLE_REVIEW_CHECKLIST) {
    if (!seen.has(item.id)) {
      problems.push({
        code: 'missing-item',
        itemId: item.id,
        message: `checklist item ${item.id} (${item.label}) has no entry`,
      });
    }
  }

  if (record.phaseApproved === true) {
    for (const item of LIFECYCLE_REVIEW_CHECKLIST) {
      const verdict = verdicts[item.id];
      if (verdict !== 'pass') {
        problems.push({
          code: 'invalid-approval',
          itemId: item.id,
          message: `phase cannot be approved while checklist item ${item.id} is ${verdict}`,
        });
      }
    }
  }

  return { valid: problems.length === 0, problems, verdicts };
}

/** Why the phase is not approved, with the concrete blocking item. */
export interface LifecycleApprovalReason {
  readonly code: 'record-invalid' | 'gate-missing' | 'gate-failed' | 'gate-not-run';
  readonly message: string;
  readonly itemId?: LifecycleReviewItemId;
}

export interface LifecycleApprovalCounts {
  readonly pass: number;
  readonly fail: number;
  readonly notRun: number;
  readonly missing: number;
  readonly total: number;
}

export interface LifecycleApprovalSummary {
  /** `approved` only when the record is valid and every checklist item passed. */
  readonly state: 'approved' | 'blocked';
  readonly approved: boolean;
  readonly reasons: readonly LifecycleApprovalReason[];
  readonly counts: LifecycleApprovalCounts;
  /** False when the record itself failed strict validation. */
  readonly recordValid: boolean;
  readonly problems: readonly LifecycleReviewProblem[];
}

/**
 * Summarize whether Phase 9 may be approved given a review record. Approval is
 * blocked while the record fails strict validation, any checklist item is
 * missing, or any item is `fail` or `not-run` — there is no path that approves
 * a phase over a failed gate, a skipped gate, or a security no-bypass item
 * without an explicit verdict.
 */
export function phaseApproval(record: unknown): LifecycleApprovalSummary {
  const validation = validatePhaseReview(record);
  const reasons: LifecycleApprovalReason[] = [];

  if (!validation.valid) {
    reasons.push({
      code: 'record-invalid',
      message: `phase review record failed strict validation (${validation.problems.length} problem${validation.problems.length === 1 ? '' : 's'}); see problems`,
    });
  }

  let pass = 0;
  let fail = 0;
  let notRun = 0;
  let missing = 0;
  for (const item of LIFECYCLE_REVIEW_CHECKLIST) {
    const verdict = validation.verdicts[item.id];
    if (verdict === 'pass') {
      pass += 1;
      continue;
    }
    if (verdict === 'fail') {
      fail += 1;
      reasons.push({
        code: 'gate-failed',
        itemId: item.id,
        message: `checklist item ${item.id} (${item.label}) failed: ${item.requirement}`,
      });
    } else if (verdict === 'not-run') {
      notRun += 1;
      reasons.push({
        code: 'gate-not-run',
        itemId: item.id,
        message: `checklist item ${item.id} (${item.label}) is not run${item.securityClass ? ' (security no-bypass items may never stay not-run)' : ''}`,
      });
    } else {
      missing += 1;
      reasons.push({
        code: 'gate-missing',
        itemId: item.id,
        message: `checklist item ${item.id} (${item.label}) has no entry`,
      });
    }
  }

  const blocked = reasons.length > 0;
  return {
    state: blocked ? 'blocked' : 'approved',
    approved: !blocked,
    reasons,
    counts: {
      pass,
      fail,
      notRun,
      missing,
      total: LIFECYCLE_REVIEW_CHECKLIST.length,
    },
    recordValid: validation.valid,
    problems: validation.problems,
  };
}
