// Phase 10 integration gate contract (v1).
//
// Encodes the deliverable breakdown, dependency edges, and closure rules for
// Bead `psyche-i7c.10` (OpenCoven/psyche-build#209, "Phase 10: recovery,
// persistence, accessibility, and acceptance"). The execution plan this module
// mirrors lives in `docs/mobile/PHASE-10-RECOVERY-PLAN.md`; the Beads source
// remains authoritative for the child task definitions.
//
// This module is a planning/contract slice only: it does not implement any of
// the child deliverables (#210–#215) and it never infers runtime state. It is
// a pure, deterministic gate record model so a maintainer can decide whether
// the phase may close from explicit, evidence-backed child statuses.

/** Schema version of the gate record format produced and validated here. */
export const PHASE10_GATE_RECORD_VERSION = 1;

/** Bead id of the Phase 10 parent task. */
export const PHASE10_PHASE_ID = 'psyche-i7c.10';

/** Mirror issue number of the Phase 10 parent task. */
export const PHASE10_PARENT_ISSUE = 209;

/**
 * Canonical child ids of Phase 10, ordered by Bead sequence. Beads is the
 * source of truth for these identifiers; the GitHub mirror numbers are
 * tracking references only and never identify runtime state.
 */
export type Phase10ChildId =
  | 'psyche-i7c.10.1'
  | 'psyche-i7c.10.2'
  | 'psyche-i7c.10.3'
  | 'psyche-i7c.10.4'
  | 'psyche-i7c.10.5'
  | 'psyche-i7c.10.6';

/** GitHub mirror issue numbers for the Phase 10 children (#210–#215). */
export type Phase10MirrorIssue = 210 | 211 | 212 | 213 | 214 | 215;

export interface Phase10ChildDescriptor {
  readonly childId: Phase10ChildId;
  /** Mirror issue number in OpenCoven/psyche-build (tracking reference). */
  readonly mirrorIssue: Phase10MirrorIssue;
  /** Bead title, verbatim-faithful to the mirror issue subject. */
  readonly title: string;
  /** Child ids that must pass their gates before this child may integrate. */
  readonly dependsOn: readonly Phase10ChildId[];
}

/**
 * Phase 10 children in canonical Bead sequence. `dependsOn` mirrors the
 * "Blocked by" relationships declared by the Beads source.
 */
export const PHASE10_CHILDREN: readonly Phase10ChildDescriptor[] = [
  {
    childId: 'psyche-i7c.10.1',
    mirrorIssue: 210,
    title: 'Implement bounded protected workspace cache',
    dependsOn: [],
  },
  {
    childId: 'psyche-i7c.10.2',
    mirrorIssue: 211,
    title: 'Reconcile restored and live state with stale UX',
    dependsOn: ['psyche-i7c.10.1'],
  },
  {
    childId: 'psyche-i7c.10.3',
    mirrorIssue: 212,
    title: 'Complete accessibility and motion semantics',
    dependsOn: ['psyche-i7c.10.2'],
  },
  {
    childId: 'psyche-i7c.10.4',
    mirrorIssue: 213,
    title: 'Run performance and full acceptance matrix',
    dependsOn: ['psyche-i7c.10.1', 'psyche-i7c.10.2', 'psyche-i7c.10.3'],
  },
  {
    childId: 'psyche-i7c.10.5',
    mirrorIssue: 214,
    title: 'Update product and architecture documentation',
    dependsOn: ['psyche-i7c.10.2'],
  },
  {
    childId: 'psyche-i7c.10.6',
    mirrorIssue: 215,
    title: 'Complete final implementation review and branch handoff',
    dependsOn: ['psyche-i7c.10.3', 'psyche-i7c.10.4', 'psyche-i7c.10.5'],
  },
];

export interface Phase10DependencyEdge {
  /** Child that must pass first. */
  readonly prerequisite: Phase10ChildId;
  /** Child that may not close its gate until the prerequisite passes. */
  readonly dependent: Phase10ChildId;
}

/**
 * Explicit dependency edges (prerequisite → dependent), equivalent to the
 * `dependsOn` lists in {@link PHASE10_CHILDREN}. Exported separately so gate
 * tooling and the plan document can reason over edges without deriving them.
 */
export const PHASE10_DEPENDENCY_EDGES: readonly Phase10DependencyEdge[] = [
  { prerequisite: 'psyche-i7c.10.1', dependent: 'psyche-i7c.10.2' },
  { prerequisite: 'psyche-i7c.10.2', dependent: 'psyche-i7c.10.3' },
  { prerequisite: 'psyche-i7c.10.1', dependent: 'psyche-i7c.10.4' },
  { prerequisite: 'psyche-i7c.10.2', dependent: 'psyche-i7c.10.4' },
  { prerequisite: 'psyche-i7c.10.3', dependent: 'psyche-i7c.10.4' },
  { prerequisite: 'psyche-i7c.10.2', dependent: 'psyche-i7c.10.5' },
  { prerequisite: 'psyche-i7c.10.3', dependent: 'psyche-i7c.10.6' },
  { prerequisite: 'psyche-i7c.10.4', dependent: 'psyche-i7c.10.6' },
  { prerequisite: 'psyche-i7c.10.5', dependent: 'psyche-i7c.10.6' },
];

const CHILD_INDEX: ReadonlyMap<Phase10ChildId, number> = new Map(
  PHASE10_CHILDREN.map((child, index) => [child.childId, index]),
);

/**
 * Return a valid, deterministic topological integration order for the Phase
 * 10 children: every child appears exactly once, after all of its
 * prerequisites. Ties are broken by canonical Bead sequence, so the result is
 * stable across calls. Throws if the declared edges contain a cycle (a defect
 * in this module, not a runtime condition).
 */
export function gateOrder(): readonly Phase10ChildId[] {
  const remainingDeps = new Map<Phase10ChildId, Set<Phase10ChildId>>(
    PHASE10_CHILDREN.map((child) => [child.childId, new Set(child.dependsOn)]),
  );
  const dependentsOf = new Map<Phase10ChildId, Phase10ChildId[]>();
  for (const edge of PHASE10_DEPENDENCY_EDGES) {
    const list = dependentsOf.get(edge.prerequisite);
    if (list) {
      list.push(edge.dependent);
    } else {
      dependentsOf.set(edge.prerequisite, [edge.dependent]);
    }
  }

  const ordered: Phase10ChildId[] = [];
  const placed = new Set<Phase10ChildId>();
  while (ordered.length < PHASE10_CHILDREN.length) {
    let next: Phase10ChildId | undefined;
    for (const child of PHASE10_CHILDREN) {
      const deps = remainingDeps.get(child.childId);
      if (deps && deps.size === 0) {
        next = child.childId;
        break;
      }
    }
    if (next === undefined) {
      throw new Error(
        `phase10Gate: dependency cycle detected among ${PHASE10_CHILDREN.length - ordered.length} unresolved children`,
      );
    }
    remainingDeps.delete(next);
    placed.add(next);
    ordered.push(next);
    for (const dependent of dependentsOf.get(next) ?? []) {
      const deps = remainingDeps.get(dependent);
      if (deps) {
        deps.delete(next);
      }
    }
  }
  if (placed.size !== PHASE10_CHILDREN.length) {
    throw new Error('phase10Gate: topological order did not cover every child');
  }
  return ordered;
}

/** Gate status of a single child. `not-run` means no accepted evidence yet. */
export type Phase10ChildStatus = 'pass' | 'fail' | 'not-run';

/** One child's gate outcome with a pointer to its retained evidence. */
export interface Phase10GateEntry {
  readonly childId: Phase10ChildId;
  readonly status: Phase10ChildStatus;
  /**
   * Evidence pointer: working-record path, acceptance-record reference, CI run,
   * or — for `not-run` — a pointer naming the concrete blocker. Never inline
   * bulk logs.
   */
  readonly evidence: string;
}

/** Versioned record of every Phase 10 child's gate outcome. */
export interface Phase10GateRecord {
  readonly version: typeof PHASE10_GATE_RECORD_VERSION;
  /**
   * Whether the operator claims the phase may close. Setting this to true is
   * rejected by the validator while any child has not passed.
   */
  readonly phaseClosed: boolean;
  readonly entries: readonly Phase10GateEntry[];
}

export type Phase10GateProblemCode =
  | 'invalid-record'
  | 'invalid-version'
  | 'invalid-status'
  | 'unknown-child'
  | 'duplicate-child'
  | 'missing-child'
  | 'missing-evidence'
  | 'invalid-closure';

export interface Phase10GateProblem {
  readonly code: Phase10GateProblemCode;
  readonly message: string;
  /** Present when the problem is attributable to one child. */
  readonly childId?: Phase10ChildId;
}

export type Phase10GateValidation = readonly Phase10GateProblem[];

const VALID_STATUSES: readonly Phase10ChildStatus[] = ['pass', 'fail', 'not-run'];

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strictly validate a gate record. Unknown or duplicated child ids, missing
 * children, invalid statuses, and missing/empty evidence pointers are all
 * rejected; a record that claims `phaseClosed: true` while any child is not
 * `pass` (including `not-run` or `fail` children) is rejected as an invalid
 * closure. Returns the (possibly empty) list of problems; an empty list means
 * the record is structurally valid and, when it claims closure, closure-ready.
 *
 * The validator is defensive about record shape so a malformed record from an
 * untrusted surface fails closed with problems instead of throwing.
 */
export function validatePhaseGateRecord(record: Phase10GateRecord): Phase10GateValidation {
  const problems: Phase10GateProblem[] = [];
  if (!isRecordLike(record)) {
    return [
      { code: 'invalid-record', message: 'gate record must be an object' },
    ];
  }
  if (record.version !== PHASE10_GATE_RECORD_VERSION) {
    problems.push({
      code: 'invalid-version',
      message: `gate record version must be ${PHASE10_GATE_RECORD_VERSION}`,
    });
  }
  if (!Array.isArray(record.entries)) {
    problems.push({
      code: 'invalid-record',
      message: 'gate record entries must be an array',
    });
    return problems;
  }

  const seen = new Map<Phase10ChildId, number>();
  const statusByChild = new Map<Phase10ChildId, Phase10ChildStatus>();
  for (let index = 0; index < record.entries.length; index += 1) {
    const entry: unknown = record.entries[index];
    if (!isRecordLike(entry)) {
      problems.push({
        code: 'invalid-record',
        message: `entry ${index} must be an object`,
      });
      continue;
    }
    const childId = entry.childId;
    if (
      typeof childId !== 'string' ||
      !CHILD_INDEX.has(childId as Phase10ChildId)
    ) {
      problems.push({
        code: 'unknown-child',
        message: `entry ${index} has unknown child id ${JSON.stringify(childId ?? null)}`,
      });
      continue;
    }
    const knownChildId = childId as Phase10ChildId;
    const previousIndex = seen.get(knownChildId);
    if (previousIndex !== undefined) {
      problems.push({
        code: 'duplicate-child',
        message: `child ${knownChildId} appears at entries ${previousIndex} and ${index}`,
        childId: knownChildId,
      });
      continue;
    }
    seen.set(knownChildId, index);

    const status = entry.status;
    if (
      typeof status !== 'string' ||
      !VALID_STATUSES.includes(status as Phase10ChildStatus)
    ) {
      problems.push({
        code: 'invalid-status',
        message: `child ${knownChildId} has invalid status ${JSON.stringify(status ?? null)}; expected one of ${VALID_STATUSES.join('|')}`,
        childId: knownChildId,
      });
      continue;
    }
    const knownStatus = status as Phase10ChildStatus;
    statusByChild.set(knownChildId, knownStatus);

    const evidence = entry.evidence;
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      problems.push({
        code: 'missing-evidence',
        message: `child ${knownChildId} is missing a non-empty evidence pointer`,
        childId: knownChildId,
      });
    }
  }

  for (const child of PHASE10_CHILDREN) {
    if (!seen.has(child.childId)) {
      problems.push({
        code: 'missing-child',
        message: `child ${child.childId} (${child.title}) has no gate entry`,
        childId: child.childId,
      });
    }
  }

  if (record.phaseClosed === true) {
    for (const child of PHASE10_CHILDREN) {
      const status = statusByChild.get(child.childId);
      if (status !== undefined && status !== 'pass') {
        problems.push({
          code: 'invalid-closure',
          message: `phase cannot close while child ${child.childId} is ${status}`,
          childId: child.childId,
        });
      }
    }
  }

  return problems;
}

/** A child that may not gate through, with the concrete blocking reasons. */
export interface Phase10BlockedChild {
  readonly childId: Phase10ChildId;
  readonly reasons: readonly string[];
}

export interface Phase10ClosureReadiness {
  /** True only when the record is valid and every child gates through. */
  readonly canClose: boolean;
  readonly totalChildren: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly notRunCount: number;
  /** Children blocked directly or through an unpassed prerequisite. */
  readonly blockedChildren: readonly Phase10BlockedChild[];
  /** False when the record itself failed strict validation. */
  readonly recordValid: boolean;
  readonly problems: readonly Phase10GateProblem[];
}

function dependsOnMap(): ReadonlyMap<Phase10ChildId, readonly Phase10ChildId[]> {
  return new Map(PHASE10_CHILDREN.map((child) => [child.childId, child.dependsOn]));
}

/**
 * All direct and transitive prerequisites of a child, in canonical Bead
 * sequence order (deterministic, self-free).
 */
function transitivePrerequisites(childId: Phase10ChildId): Phase10ChildId[] {
  const dependsOn = dependsOnMap();
  const seen = new Set<Phase10ChildId>();
  const stack = [...(dependsOn.get(childId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    stack.push(...(dependsOn.get(current) ?? []));
  }
  return [...seen].sort((a, b) => (CHILD_INDEX.get(a) ?? 0) - (CHILD_INDEX.get(b) ?? 0));
}

/**
 * Summarize whether the phase can close given a validated gate record. A child
 * is blocked when its own status is not `pass` or when any direct or
 * transitive prerequisite has not passed — so a child cannot gate through on
 * top of a failed or not-run dependency. Blocked children prevent parent
 * closure: `canClose` is true only when the record validates cleanly and every
 * child has passed.
 */
export function phaseClosureReadiness(record: Phase10GateRecord): Phase10ClosureReadiness {
  const problems = validatePhaseGateRecord(record);
  const entries: readonly Phase10GateEntry[] = Array.isArray(
    (record as { entries?: unknown } | null)?.entries,
  )
    ? (record.entries as readonly Phase10GateEntry[])
    : [];
  const statusByChild = new Map<Phase10ChildId, Phase10ChildStatus>();
  for (const entry of entries) {
    if (
      isRecordLike(entry) &&
      typeof entry.childId === 'string' &&
      CHILD_INDEX.has(entry.childId as Phase10ChildId) &&
      typeof entry.status === 'string' &&
      VALID_STATUSES.includes(entry.status as Phase10ChildStatus)
    ) {
      statusByChild.set(entry.childId as Phase10ChildId, entry.status as Phase10ChildStatus);
    }
  }

  let passedCount = 0;
  let failedCount = 0;
  let notRunCount = 0;
  for (const status of statusByChild.values()) {
    if (status === 'pass') {
      passedCount += 1;
    } else if (status === 'fail') {
      failedCount += 1;
    } else {
      notRunCount += 1;
    }
  }

  const dependsOn = dependsOnMap();
  const blockedChildren: Phase10BlockedChild[] = [];
  for (const child of PHASE10_CHILDREN) {
    const own = statusByChild.get(child.childId);
    const reasons: string[] = [];
    if (own === undefined) {
      reasons.push('no gate entry');
    } else if (own === 'fail') {
      reasons.push('child gate failed');
    } else if (own === 'not-run') {
      reasons.push('child gate not run');
    }
    for (const prerequisite of transitivePrerequisites(child.childId)) {
      if (statusByChild.get(prerequisite) !== 'pass') {
        reasons.push(`prerequisite ${prerequisite} has not passed`);
      }
    }
    if (reasons.length > 0) {
      blockedChildren.push({ childId: child.childId, reasons });
    }
  }

  return {
    canClose: problems.length === 0 && blockedChildren.length === 0,
    totalChildren: PHASE10_CHILDREN.length,
    passedCount,
    failedCount,
    notRunCount,
    blockedChildren,
    recordValid: problems.length === 0,
    problems,
  };
}
