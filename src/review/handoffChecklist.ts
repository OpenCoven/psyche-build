/**
 * Mobile branch handoff checklist — record contract, schema v1.
 *
 * Machine-checkable companion to `docs/review/MOBILE-BRANCH-HANDOFF.md`
 * (issue OpenCoven/psyche-build#215, bead `psyche-i7c.10.6`). The prose
 * document defines *how* each gate is evaluated; this module defines the
 * typed checklist item ids and the strict, versioned record format used to
 * report and validate the final mobile-branch handoff.
 *
 * Contract (v1):
 * - Every checklist item in a complete handoff record carries one status of
 *   `pass`, `fail`, or `not-applicable` plus a non-empty evidence pointer.
 * - An item may alternatively carry the explicit status `not-run`, which must
 *   not claim evidence and always blocks the handoff.
 * - Unknown item ids, unknown fields (at any level), and missing items are
 *   rejected; the validator never silently ignores input it does not know.
 * - `handoffReadiness()` reports `ready` only when the record is valid and no
 *   gate is `fail` or `not-run`.
 *
 * Versioning: schema v1 is immutable. Additive checklist items or status
 * semantics changes require bumping `HANDOFF_RECORD_SCHEMA_VERSION` and a
 * matching doc revision; records from unsupported versions are rejected, never
 * reinterpreted.
 */

/** Schema version of the handoff record contract implemented by this module. */
export const HANDOFF_RECORD_SCHEMA_VERSION = 1;

/** Top-level phase groups of the mobile multiproject/multipane cockpit track. */
export const HANDOFF_PHASE_IDS = ['i7c.9', 'i7c.10', 'handoff'] as const;

export type HandoffPhaseId = (typeof HANDOFF_PHASE_IDS)[number];

/**
 * Checklist item ids grouped by phase gate. Each `i7c.*` id closes exactly one
 * phase-gate Bead; `handoff.*` ids are the cross-cutting branch handoff gates.
 */
export const HANDOFF_CHECKLIST_ITEM_IDS = [
  // psyche-i7c.9 — Phase 9: full lifecycle merge, PR, stop, close, and cleanup.
  'i7c.9.2.pane-action-menu-confirmations',
  'i7c.9.3.merge-pr-workflow-evidence',
  'i7c.9.4.lifecycle-ui-host-coverage',
  'i7c.9.5.lifecycle-review-signoff',
  // psyche-i7c.10 — Phase 10: recovery, persistence, accessibility, acceptance.
  'i7c.10.1.workspace-cache-protection',
  'i7c.10.2.stale-state-reconciliation',
  'i7c.10.3.accessibility-motion-semantics',
  'i7c.10.4.performance-acceptance-matrix',
  'i7c.10.5.documentation-currency',
  'i7c.10.6.final-review-handoff',
  // Cross-cutting branch handoff gates.
  'handoff.spec-review',
  'handoff.code-quality-review',
  'handoff.beads-lint',
  'handoff.beads-dep-cycles',
  'handoff.clean-worktree',
  'handoff.required-checks-green',
  'handoff.independent-review',
  'handoff.integration-ready',
] as const;

export type HandoffChecklistItemId = (typeof HANDOFF_CHECKLIST_ITEM_IDS)[number];

/** Verdict for one checklist item, as recorded in a handoff record. */
export type HandoffItemStatus = 'pass' | 'fail' | 'not-run' | 'not-applicable';

const HANDOFF_ITEM_STATUSES: readonly HandoffItemStatus[] = [
  'pass',
  'fail',
  'not-run',
  'not-applicable',
];

/** GitHub mirror issue that carries the public phase-gate outcome. */
export interface HandoffGateReference {
  /** Beads id of the phase gate (or `handoff` for cross-cutting gates). */
  bead: string;
  /** Mirror issue number on OpenCoven/psyche-build, when the gate has one. */
  issue?: number;
}

/** One typed checklist entry: what the gate is and what evidence must show. */
export interface HandoffChecklistItem {
  id: HandoffChecklistItemId;
  phase: HandoffPhaseId;
  /** Short, stable label for tables and reports. */
  label: string;
  gate: HandoffGateReference;
  /** What a valid evidence pointer for this item must point at. */
  evidenceHint: string;
}

const CHECKLIST_ITEMS = [
  {
    id: 'i7c.9.2.pane-action-menu-confirmations',
    phase: 'i7c.9',
    label: 'Native pane action menu and guarded confirmations',
    gate: { bead: 'psyche-i7c.9.2', issue: 218 },
    evidenceHint:
      'Review note or UI-test run showing stop/cleanup are distinct, the confirmation names the consequence before its button, and stale actions are disabled.',
  },
  {
    id: 'i7c.9.3.merge-pr-workflow-evidence',
    phase: 'i7c.9',
    label: 'Merge and PR interactive workflows exercised on mobile',
    gate: { bead: 'psyche-i7c.9.3', issue: 219 },
    evidenceHint:
      'Run record showing merge confirmation/choice chains reach terminal outcomes, PR review supports editing, and cancel paths are explicit and single-use.',
  },
  {
    id: 'i7c.9.4.lifecycle-ui-host-coverage',
    phase: 'i7c.9',
    label: 'Lifecycle action UI and host coverage',
    gate: { bead: 'psyche-i7c.9.4', issue: 220 },
    evidenceHint:
      'Test-report pointer showing every destructive flow has a tested confirmation/cancel path and existing merge/action host regressions stay green.',
  },
  {
    id: 'i7c.9.5.lifecycle-review-signoff',
    phase: 'i7c.9',
    label: 'Full lifecycle action validation and review signoff',
    gate: { bead: 'psyche-i7c.9.5', issue: 221 },
    evidenceHint:
      'Phase review verdict (spec/security/code-quality) with no bypass of existing merge/PR/cleanup safeguards and passing lifecycle host/core/UI suites.',
  },
  {
    id: 'i7c.10.1.workspace-cache-protection',
    phase: 'i7c.10',
    label: 'Bounded protected workspace cache',
    gate: { bead: 'psyche-i7c.10.1', issue: 210 },
    evidenceHint:
      'Test/report pointer covering atomic storage, complete-until-first-auth protection, host identity keying, size/draft bounds, and absence of credentials, full source, or transcripts in the cache.',
  },
  {
    id: 'i7c.10.2.stale-state-reconciliation',
    phase: 'i7c.10',
    label: 'Restored vs live state reconciliation with stale UX',
    gate: { bead: 'psyche-i7c.10.2', issue: 211 },
    evidenceHint:
      'Test/report pointer showing cached state is never presented as live, live actions stay disabled until recovery, and deleted/renamed panes reconcile safely.',
  },
  {
    id: 'i7c.10.3.accessibility-motion-semantics',
    phase: 'i7c.10',
    label: 'Accessibility and motion semantics complete',
    gate: { bead: 'psyche-i7c.10.3', issue: 212 },
    evidenceHint:
      'Accessibility/motion review or audit pointer covering the phase-gate semantics for the mobile surfaces in scope.',
  },
  {
    id: 'i7c.10.4.performance-acceptance-matrix',
    phase: 'i7c.10',
    label: 'Run performance and full acceptance matrix',
    gate: { bead: 'psyche-i7c.10.4', issue: 213 },
    evidenceHint:
      'Acceptance-matrix run record with per-gate results, including the pane/stream bounds and offline behavior gates.',
  },
  {
    id: 'i7c.10.5.documentation-currency',
    phase: 'i7c.10',
    label: 'Product and architecture documentation updated',
    gate: { bead: 'psyche-i7c.10.5', issue: 214 },
    evidenceHint:
      'Pointer to the documentation change set that makes the docs reflect the live mobile architecture.',
  },
  {
    id: 'i7c.10.6.final-review-handoff',
    phase: 'i7c.10',
    label: 'Final implementation review and branch handoff record',
    gate: { bead: 'psyche-i7c.10.6', issue: 215 },
    evidenceHint:
      'This handoff record itself: completed §2/§3 checklists, triaged findings, and the filled §9 handoff record in the handoff PR.',
  },
  {
    id: 'handoff.spec-review',
    phase: 'handoff',
    label: 'Whole-branch spec review checklist executed',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Pointer to the completed §2 spec-review checklist output for the whole feature branch (all acceptance criteria of the epic traced).',
  },
  {
    id: 'handoff.code-quality-review',
    phase: 'handoff',
    label: 'Whole-branch code-quality review executed',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Pointer to the completed §3 code-quality review with every Critical/Important finding resolved or explicitly deferred by the owner.',
  },
  {
    id: 'handoff.beads-lint',
    phase: 'handoff',
    label: 'Beads lint clean (gate for the branch owner)',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Owner-run `bd lint` output showing no findings. bd is not runnable on the review host, so this evidence must come from the owner environment.',
  },
  {
    id: 'handoff.beads-dep-cycles',
    phase: 'handoff',
    label: 'Beads dependency graph free of cycles (gate for the branch owner)',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Owner-run `bd dep` (cycle report) output showing no dependency cycles across the phase family.',
  },
  {
    id: 'handoff.clean-worktree',
    phase: 'handoff',
    label: 'Clean-worktree validation steps pass',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Pointer to the §5 clean-worktree validation transcript (status, diff check, generated-output check) for the handoff head.',
  },
  {
    id: 'handoff.required-checks-green',
    phase: 'handoff',
    label: 'Required CI checks terminal and green on the handoff head',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Pointer to the PR checks page or run ids for the exact head SHA, with every required check terminal and green (skipped counts as green).',
  },
  {
    id: 'handoff.independent-review',
    phase: 'handoff',
    label: 'Independent review reports no Critical or Important defects',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Independent-reviewer sign-off (not a slice author) with severity-classified findings and their resolutions.',
  },
  {
    id: 'handoff.integration-ready',
    phase: 'handoff',
    label: 'Branch-ready definition satisfied',
    gate: { bead: 'handoff' },
    evidenceHint:
      'Pointer to the §7 branch-ready checklist confirmation (clean, documented, tested, integration-ready) recorded in the handoff PR.',
  },
] as const satisfies readonly HandoffChecklistItem[];

/** The authoritative, ordered v1 checklist. */
export const HANDOFF_CHECKLIST: readonly HandoffChecklistItem[] = CHECKLIST_ITEMS;

/** Every checklist item id, typed. */
export type HandoffRecordItemStatus = HandoffItemStatus;

/** One recorded verdict for a checklist item. */
export interface HandoffItemRecord {
  status: HandoffItemStatus;
  /** Pointer to durable evidence (file path, URL, run id, or command output). */
  evidence?: string;
}

/** A fillable handoff record (schema v1). */
export interface HandoffRecord {
  schemaVersion: number;
  /** Integration branch under review, e.g. `feat/mobile-multiproject-cockpit`. */
  branch?: string;
  /** Exact head commit under review. */
  reviewedHead?: string;
  /** Accountable reviewer or review agent. */
  reviewer?: string;
  /** Verdict per checklist item id; unknown ids are rejected. */
  items: { [itemId: string]: HandoffItemRecord };
}

const RECORD_OPTIONAL_STRING_FIELDS = ['branch', 'reviewedHead', 'reviewer'] as const;

const RECORD_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'items',
  ...RECORD_OPTIONAL_STRING_FIELDS,
]);

const ITEM_RECORD_FIELDS: ReadonlySet<string> = new Set(['status', 'evidence']);

/** Normalized per-item verdict; `missing` means the record has no entry. */
export type HandoffVerdict = HandoffItemStatus | 'missing';

export type HandoffIssueCode =
  | 'invalid-record'
  | 'schema-version-missing'
  | 'schema-version-unsupported'
  | 'invalid-field-type'
  | 'unknown-field'
  | 'unknown-item'
  | 'invalid-item-shape'
  | 'invalid-status'
  | 'missing-evidence'
  | 'evidence-not-allowed'
  | 'missing-item';

export interface HandoffValidationIssue {
  code: HandoffIssueCode;
  message: string;
  itemId?: HandoffChecklistItemId;
  field?: string;
}

export interface HandoffValidationResult {
  /** True only when the record is structurally well-formed and complete. */
  valid: boolean;
  issues: HandoffValidationIssue[];
  /** Normalized verdict per checklist item (`missing` when absent). */
  verdicts: Record<HandoffChecklistItemId, HandoffVerdict>;
}

export interface HandoffReadinessReason {
  code: 'record-invalid' | 'gate-failed' | 'gate-not-run';
  message: string;
  itemId?: HandoffChecklistItemId;
}

export interface HandoffVerdictCounts {
  pass: number;
  fail: number;
  notRun: number;
  notApplicable: number;
  total: number;
}

export interface HandoffReadiness {
  state: 'ready' | 'blocked';
  reasons: HandoffReadinessReason[];
  counts: HandoffVerdictCounts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHandoffItemStatus(value: unknown): value is HandoffItemStatus {
  return (
    value === 'pass'
    || value === 'fail'
    || value === 'not-run'
    || value === 'not-applicable'
  );
}

function isKnownItemId(value: string): value is HandoffChecklistItemId {
  return (HANDOFF_CHECKLIST_ITEM_IDS as readonly string[]).includes(value);
}

/**
 * Strictly validate a handoff record against the v1 checklist contract.
 *
 * A returned `valid: true` means the record is well-formed: known schema
 * version, no unknown fields, every checklist item present, and every verdict
 * either `pass`/`fail`/`not-applicable` with an evidence pointer or explicitly
 * `not-run` without one. Structural validity is necessary but not sufficient
 * for handoff — see {@link handoffReadiness} for the ready/blocked decision.
 */
export function validateHandoffRecord(record: unknown): HandoffValidationResult {
  const issues: HandoffValidationIssue[] = [];
  const verdicts = Object.fromEntries(
    HANDOFF_CHECKLIST.map((item) => [item.id, 'missing' as const]),
  ) as Record<HandoffChecklistItemId, HandoffVerdict>;

  if (!isPlainObject(record)) {
    issues.push({
      code: 'invalid-record',
      message: 'Handoff record must be a JSON object.',
    });
    return { valid: false, issues, verdicts };
  }

  // Root shape: reject unknown fields before anything else so callers see the
  // exact contract violation instead of downstream type confusion.
  for (const key of Object.keys(record)) {
    if (!RECORD_ALLOWED_FIELDS.has(key)) {
      issues.push({
        code: 'unknown-field',
        field: key,
        message: `Unknown handoff record field "${key}".`,
      });
    }
  }

  const schemaVersion = record.schemaVersion;
  if (schemaVersion === undefined) {
    issues.push({
      code: 'schema-version-missing',
      field: 'schemaVersion',
      message: 'Handoff record is missing "schemaVersion".',
    });
  } else if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    issues.push({
      code: 'invalid-field-type',
      field: 'schemaVersion',
      message: '"schemaVersion" must be an integer.',
    });
  } else if (schemaVersion !== HANDOFF_RECORD_SCHEMA_VERSION) {
    issues.push({
      code: 'schema-version-unsupported',
      field: 'schemaVersion',
      message: `Unsupported handoff record schemaVersion ${schemaVersion}; this validator only understands ${HANDOFF_RECORD_SCHEMA_VERSION}.`,
    });
  }

  for (const field of RECORD_OPTIONAL_STRING_FIELDS) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (!isNonEmptyString(value)) {
      issues.push({
        code: 'invalid-field-type',
        field,
        message: `"${field}" must be a non-empty string when present.`,
      });
    }
  }

  const items = record.items;
  if (!isPlainObject(items)) {
    issues.push({
      code: 'invalid-field-type',
      field: 'items',
      message: '"items" must be an object keyed by checklist item id.',
    });
    return finalize();
  }

  for (const [itemId, entry] of Object.entries(items)) {
    if (!isKnownItemId(itemId)) {
      issues.push({
        code: 'unknown-item',
        field: `items.${itemId}`,
        message: `Unknown checklist item id "${itemId}".`,
      });
      continue;
    }

    if (!isPlainObject(entry)) {
      issues.push({
        code: 'invalid-item-shape',
        itemId,
        message: `Entry for checklist item "${itemId}" must be an object with a "status" field.`,
      });
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!ITEM_RECORD_FIELDS.has(key)) {
        issues.push({
          code: 'unknown-field',
          itemId,
          field: `items.${itemId}.${key}`,
          message: `Unknown field "${key}" in checklist item "${itemId}".`,
        });
      }
    }

    const status = entry.status;
    if (status === undefined) {
      issues.push({
        code: 'invalid-status',
        itemId,
        field: 'status',
        message: `Checklist item "${itemId}" is missing a status.`,
      });
      continue;
    }
    if (!isHandoffItemStatus(status)) {
      issues.push({
        code: 'invalid-status',
        itemId,
        field: 'status',
        message: `Checklist item "${itemId}" has invalid status ${JSON.stringify(status)}; expected pass, fail, not-run, or not-applicable.`,
      });
      continue;
    }

    verdicts[itemId] = status;

    const evidence = entry.evidence;
    if (status === 'not-run') {
      if (typeof evidence === 'string' && evidence.trim().length > 0) {
        issues.push({
          code: 'evidence-not-allowed',
          itemId,
          field: 'evidence',
          message: `Checklist item "${itemId}" is not-run and must not claim evidence.`,
        });
      }
      continue;
    }

    if (evidence === undefined || typeof evidence !== 'string' || evidence.trim().length === 0) {
      issues.push({
        code: 'missing-evidence',
        itemId,
        field: 'evidence',
        message: `Checklist item "${itemId}" with status "${status}" requires a non-empty evidence pointer.`,
      });
      continue;
    }
  }

  return finalize();

  function finalize(): HandoffValidationResult {
    // Completeness: a valid record must give every checklist item a verdict.
    for (const item of HANDOFF_CHECKLIST) {
      if (verdicts[item.id] === 'missing') {
        issues.push({
          code: 'missing-item',
          itemId: item.id,
          message: `Handoff record has no entry for checklist item "${item.id}" (treated as not-run).`,
        });
      }
    }
    return { valid: issues.length === 0, issues, verdicts };
  }
}

/** Group the checklist items by phase, preserving checklist order. */
export function groupHandoffChecklistByPhase(): Record<HandoffPhaseId, HandoffChecklistItem[]> {
  const grouped = Object.fromEntries(
    HANDOFF_PHASE_IDS.map((phase) => [phase, [] as HandoffChecklistItem[]]),
  ) as Record<HandoffPhaseId, HandoffChecklistItem[]>;
  for (const item of HANDOFF_CHECKLIST) {
    grouped[item.phase].push(item);
  }
  return grouped;
}

/**
 * Summarize whether the mobile branch may be handed off.
 *
 * Blocked when the record is invalid, any gate is `fail`, or any gate is
 * `not-run` (explicitly or by omission). Ready only when every checklist item
 * is `pass` or `not-applicable` with an evidence pointer.
 */
export function handoffReadiness(record: unknown): HandoffReadiness {
  const validation = validateHandoffRecord(record);
  const reasons: HandoffReadinessReason[] = validation.issues.map((issue) => ({
    code: 'record-invalid',
    message: issue.message,
    itemId: issue.itemId,
  }));

  for (const item of HANDOFF_CHECKLIST) {
    const verdict = validation.verdicts[item.id];
    if (verdict === 'fail') {
      reasons.push({
        code: 'gate-failed',
        itemId: item.id,
        message: `Gate "${item.id}" (${item.label}) failed; the handoff is blocked until it passes.`,
      });
    } else if (verdict === 'not-run' || verdict === 'missing') {
      reasons.push({
        code: 'gate-not-run',
        itemId: item.id,
        message: `Gate "${item.id}" (${item.label}) has not been run; the handoff is blocked.`,
      });
    }
  }

  let pass = 0;
  let fail = 0;
  let notRun = 0;
  let notApplicable = 0;
  for (const item of HANDOFF_CHECKLIST) {
    const verdict = validation.verdicts[item.id];
    if (verdict === 'pass') {
      pass += 1;
    } else if (verdict === 'fail') {
      fail += 1;
    } else if (verdict === 'not-applicable') {
      notApplicable += 1;
    } else {
      // Explicit `not-run` and omitted entries both block the handoff.
      notRun += 1;
    }
  }

  return {
    state: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
    counts: {
      pass,
      fail,
      notRun,
      notApplicable,
      total: HANDOFF_CHECKLIST.length,
    },
  };
}
