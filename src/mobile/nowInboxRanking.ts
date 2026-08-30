// Now inbox ranking and workspace-snapshot schema contract (v1).
//
// Encodes the TypeScript-side seam of Bead `psyche-i7c` (OpenCoven/
// psyche-build#208, "Mobile multiproject and multipane cockpit"): the
// cross-project Now inbox opens from one canonical multiproject workspace
// snapshot, ranked "Needs You" first, then Running, then Recent, exactly as
// the epic's acceptance criteria require. The epic charter lives in
// `docs/mobile/COCKPIT-EPIC-CHARTER.md`; the Beads source remains
// authoritative for the epic's phased children (#209/#217 own their phase
// plans).
//
// This module is a pure, deterministic contract slice. It implements no UI,
// transport, pairing, or lifecycle behavior, never infers runtime state, and
// never touches tmux, git, the filesystem, or the network. It consumes the
// canonical workspace snapshot shape that the paired host publishes over the
// protocol-v3 bridge (`mobile.workspace.snapshot.result` carrying
// `ReadonlyWorkspaceSnapshot`), which the Swift `WorkspaceStore` applies
// authoritatively; the type-only import below is erased at runtime.

import type {
  PaneSnapshot,
  ReadonlyWorkspaceSnapshot,
  WorkspacePaneKind,
} from '../workspace/snapshot.js';

/** Schema/model version of the Now inbox projection produced here. */
export const NOW_INBOX_RANKING_VERSION = 1;

/**
 * Default and maximum number of entries `rankNowInbox` returns. The Now inbox
 * renders a bounded surface; a snapshot may legally contain more panes, which
 * is reported via `truncated` instead of silent hiding or unbounded growth.
 */
export const NOW_INBOX_ENTRY_LIMIT = 256;

/** Bound on projects per workspace snapshot (fail closed above this). */
export const MAX_WORKSPACE_PROJECTS = 64;

/** Bound on worktrees per project (fail closed above this). */
export const MAX_WORKTREES_PER_PROJECT = 64;

/** Bound on panes per container (one worktree's `panes`, or `projectPanes`). */
export const MAX_PANES_PER_CONTAINER = 128;

/** Bound on the total number of panes in one workspace snapshot. */
export const MAX_WORKSPACE_PANES_TOTAL = 4096;

/**
 * Per-string length bounds for snapshot fields, pinned so callers and tests
 * can state the exact contract. Values are code-unit counts.
 */
export const WORKSPACE_STRING_LIMITS: Readonly<{
  id: number;
  path: number;
  head: number;
  branch: number;
  title: number;
  status: number;
  agent: number;
  detail: number;
  isoTimestamp: number;
}> = Object.freeze({
  id: 128,
  path: 1024,
  head: 64,
  branch: 256,
  title: 256,
  status: 64,
  agent: 128,
  detail: 256,
  isoTimestamp: 40,
});

/**
 * Pane statuses the host counts as running. Mirrors the canonical
 * `isRunning()` helper in `src/workspace/snapshot.ts` so the Now inbox ranks
 * "Running" exactly like the host's own running counts; keep the lists in
 * sync by review, since `snapshot.ts` intentionally stays free of
 * mobile-side dependencies.
 */
export const NOW_INBOX_RUNNING_STATUSES: readonly string[] = [
  'starting',
  'running',
  'working',
  'analyzing',
];

/**
 * The three Now inbox buckets from the epic's acceptance criteria, in
 * presentation order: Needs You first, then Running, then Recent.
 */
export type NowInboxBucket = 'needs-you' | 'running' | 'recent';

export const NOW_INBOX_BUCKETS: readonly NowInboxBucket[] = [
  'needs-you',
  'running',
  'recent',
];

const BUCKET_RANK: Readonly<Record<NowInboxBucket, number>> = Object.freeze({
  'needs-you': 0,
  running: 1,
  recent: 2,
});

/**
 * Assign a pane to its Now inbox bucket. Needs You wins over Running: the
 * host marks attention-needing panes (for example a waiting coven session)
 * independently of whether the process is still alive, and a pane that needs
 * the user outranks one that merely runs.
 */
export function nowInboxBucketOf(pane: {
  readonly status: string;
  readonly needsAttention?: boolean;
}): NowInboxBucket {
  if (pane.needsAttention === true) {
    return 'needs-you';
  }
  if (NOW_INBOX_RUNNING_STATUSES.includes(pane.status)) {
    return 'running';
  }
  return 'recent';
}

/** One flattened pane reference in the cross-project Now inbox. */
export interface NowInboxEntry {
  /** Best-effort stable identity composed from project, worktree, and pane. */
  readonly entryId: string;
  readonly bucket: NowInboxBucket;
  readonly projectId: string;
  readonly projectTitle: string;
  /** Worktree path, or `null` for a project-level pane outside any worktree. */
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly paneId: string;
  readonly kind: WorkspacePaneKind;
  readonly title: string;
  readonly status: string;
  readonly needsAttention: boolean;
  /** Canonical Z-form ISO-8601 timestamp, or `null` when absent/unparseable. */
  readonly lastActivity: string | null;
}

const FIELD_SEPARATOR = '\u001f';

/**
 * Flatten a canonical workspace snapshot into Now inbox entries — one per
 * pane, across every project, worktree, and project-level pane list.
 * Traversal follows the snapshot's own array order, so the projection is
 * deterministic for a given snapshot; presentation ordering happens only in
 * {@link rankNowInbox}.
 *
 * Total over any typed snapshot (never throws): optional fields are treated
 * as absent and a non-canonical `lastActivity` degrades to `null` rather than
 * poisoning the order. Untrusted wire input must pass
 * {@link validateWorkspaceSnapshot} before it reaches this function; that
 * boundary is what makes the lenient treatment here safe.
 */
export function projectNowInboxEntries(
  snapshot: ReadonlyWorkspaceSnapshot,
): readonly NowInboxEntry[] {
  const entries: NowInboxEntry[] = [];
  const projects = snapshot.projects;
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const project = projects[projectIndex];
    const worktrees = project.worktrees;
    for (let worktreeIndex = 0; worktreeIndex < worktrees.length; worktreeIndex += 1) {
      const worktree = worktrees[worktreeIndex];
      for (const pane of worktree.panes) {
        entries.push(makeEntry(project, worktree.path, worktree.branch ?? null, pane));
      }
    }
    for (const pane of project.projectPanes) {
      entries.push(makeEntry(project, null, null, pane));
    }
  }
  return entries;
}

function makeEntry(
  project: ReadonlyWorkspaceSnapshot['projects'][number],
  worktreePath: string | null,
  worktreeBranch: string | null,
  pane: PaneSnapshot,
): NowInboxEntry {
  return {
    entryId: [project.id, worktreePath ?? '', pane.id].join(FIELD_SEPARATOR),
    bucket: nowInboxBucketOf(pane),
    projectId: project.id,
    projectTitle: project.title,
    worktreePath,
    worktreeBranch,
    paneId: pane.id,
    kind: pane.kind,
    title: pane.title ?? '',
    status: pane.status,
    needsAttention: pane.needsAttention === true,
    lastActivity: canonicalTimestampOrNull(pane.lastActivity),
  };
}

/**
 * Canonical-timestamp pattern: Z-form ISO-8601 with an optional millisecond
 * fraction — exactly what the host's `normalizeIsoDateString` emits on the
 * wire. Anything else degrades to `null` in the projection; the strict
 * validator rejects it outright.
 */
const CANONICAL_ISO_Z_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function canonicalTimestampOrNull(value: string | undefined): string | null {
  if (value === undefined || !CANONICAL_ISO_Z_TIMESTAMP.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : null;
}

function activityTime(lastActivity: string | null): number | null {
  if (lastActivity === null) {
    return null;
  }
  const time = Date.parse(lastActivity);
  return Number.isFinite(time) ? time : null;
}

export interface NowInboxRankingOptions {
  /**
   * Maximum number of returned entries. Must be a non-negative finite
   * integer; values above {@link NOW_INBOX_ENTRY_LIMIT} clamp to it, keeping
   * the result size bounded. Defaults to {@link NOW_INBOX_ENTRY_LIMIT}.
   */
  readonly limit?: number;
}

/** Per-bucket totals over every pane in the snapshot (before truncation). */
export type NowInboxBucketCounts = Readonly<Record<NowInboxBucket, number>>;

/** Deterministic, bounded Now inbox ranking over one canonical snapshot. */
export interface NowInboxRanking {
  readonly version: typeof NOW_INBOX_RANKING_VERSION;
  /** Revision of the snapshot this ranking was computed from. */
  readonly snapshotRevision: number;
  /** Leading entries in presentation order, bounded by the effective limit. */
  readonly entries: readonly NowInboxEntry[];
  /** Pre-truncation totals per bucket, so overflow stays observable. */
  readonly bucketCounts: NowInboxBucketCounts;
  /** Total panes projected from the snapshot. */
  readonly totalPaneCount: number;
  /** True when panes beyond the limit were cut from `entries`. */
  readonly truncated: boolean;
}

/**
 * Rank a canonical workspace snapshot for the cross-project Now inbox.
 *
 * Ordering contract (epic #208 acceptance criteria — "Now inbox ranks Needs
 * You, Running, and Recent across projects"):
 *   1. bucket: Needs You, then Running, then Recent;
 *   2. within a bucket: most recent canonical `lastActivity` first, unknown
 *      timestamps last;
 *   3. remaining ties: project id, then worktree path (project-level panes
 *      first), then pane id — all by code-unit comparison.
 *
 * The result is a pure function of the input: no clock, no locale-aware
 * comparison, and no dependence on the input's array order except as the
 * final stable-sort tie among fully equal keys. Identical input always yields
 * identical output on every engine. This module never infers runtime state —
 * buckets come only from the snapshot's own `needsAttention`, `status`, and
 * `lastActivity` fields, never from a UI selection, tmux observation, path,
 * or tracker record.
 */
export function rankNowInbox(
  snapshot: ReadonlyWorkspaceSnapshot,
  options: NowInboxRankingOptions = {},
): NowInboxRanking {
  const limit = resolveRankingLimit(options.limit);

  const entries = projectNowInboxEntries(snapshot);
  const mutableBucketCounts: Record<NowInboxBucket, number> = {
    'needs-you': 0,
    running: 0,
    recent: 0,
  };
  for (const entry of entries) {
    mutableBucketCounts[entry.bucket] += 1;
  }
  const bucketCounts: NowInboxBucketCounts = Object.freeze(mutableBucketCounts);

  const sorted = [...entries].sort(compareNowInboxEntries);
  const bounded = sorted.slice(0, limit);

  return {
    version: NOW_INBOX_RANKING_VERSION,
    snapshotRevision: snapshot.revision,
    entries: bounded,
    bucketCounts,
    totalPaneCount: entries.length,
    truncated: entries.length > bounded.length,
  };
}

function resolveRankingLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return NOW_INBOX_ENTRY_LIMIT;
  }
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TypeError('nowInboxRanking: limit must be a finite number');
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError('nowInboxRanking: limit must be a non-negative integer');
  }
  return Math.min(limit, NOW_INBOX_ENTRY_LIMIT);
}

/**
 * Total-order comparator for Now inbox entries: bucket order, then
 * epoch-millisecond recency (unknown timestamps last), then code-unit string
 * tie-breakers. Entries that compare fully equal fall back to stable-sort
 * order, which is itself deterministic for a given snapshot traversal.
 */
function compareNowInboxEntries(left: NowInboxEntry, right: NowInboxEntry): number {
  if (left.bucket !== right.bucket) {
    return BUCKET_RANK[left.bucket] - BUCKET_RANK[right.bucket];
  }
  const leftTime = activityTime(left.lastActivity);
  const rightTime = activityTime(right.lastActivity);
  if (leftTime !== rightTime) {
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  }
  if (left.projectId !== right.projectId) {
    return compareCodeUnits(left.projectId, right.projectId);
  }
  if (left.worktreePath !== right.worktreePath) {
    if (left.worktreePath === null) return -1;
    if (right.worktreePath === null) return 1;
    return compareCodeUnits(left.worktreePath, right.worktreePath);
  }
  if (left.paneId !== right.paneId) {
    return compareCodeUnits(left.paneId, right.paneId);
  }
  return 0;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Strict workspace-snapshot validation
// ---------------------------------------------------------------------------

export type WorkspaceSnapshotProblemCode =
  | 'invalid-snapshot'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-field'
  | 'exceeds-bound';

export interface WorkspaceSnapshotProblem {
  readonly code: WorkspaceSnapshotProblemCode;
  /** Locator into the snapshot, e.g. `projects[0].worktrees[1].panes[0]`. */
  readonly path: string;
  readonly message: string;
}

export type WorkspaceSnapshotValidation = readonly WorkspaceSnapshotProblem[];

const WORKSPACE_SNAPSHOT_KEYS: readonly string[] = ['revision', 'projects'];
const PROJECT_KEYS: readonly string[] = [
  'id',
  'root',
  'title',
  'worktrees',
  'projectPanes',
  'runningCount',
  'attentionCount',
];
const WORKTREE_KEYS: readonly string[] = [
  'path',
  'head',
  'branch',
  'isMain',
  'detached',
  'bare',
  'locked',
  'lockReason',
  'prunable',
  'pruneReason',
  'dirty',
  'missing',
  'panes',
  'runningCount',
  'attentionCount',
];
const PANE_KEYS: readonly string[] = [
  'id',
  'cwd',
  'title',
  'kind',
  'agent',
  'status',
  'needsAttention',
  'lastActivity',
  'recoverability',
];

const WORKSPACE_PANE_KINDS: readonly string[] = ['agent', 'terminal', 'coven-session'];
const WORKSPACE_RECOVERABILITY_VALUES: readonly string[] = ['healthy', 'missing-worktree'];

const SNAPSHOT_KEY_SET: ReadonlySet<string> = new Set(WORKSPACE_SNAPSHOT_KEYS);
const PROJECT_KEY_SET: ReadonlySet<string> = new Set(PROJECT_KEYS);
const WORKTREE_KEY_SET: ReadonlySet<string> = new Set(WORKTREE_KEYS);
const PANE_KEY_SET: ReadonlySet<string> = new Set(PANE_KEYS);

/**
 * Reject any object whose own keys are not a subset of the known keys.
 * Unknown keys fail closed even when their value is `undefined`, so a field
 * this schema does not model can never slip through as "absent". Known keys
 * carrying `undefined` are treated as absent, matching the canonical fixture
 * encoding (`lockReason: undefined` and friends).
 */
function checkUnknownFields(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  path: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      problems.push({
        code: 'unknown-field',
        path,
        message: `unknown field ${JSON.stringify(key)} at ${path === '' ? 'snapshot root' : path}`,
      });
    }
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAbsent(value: unknown): boolean {
  return value === undefined;
}

function joinField(path: string, field: string): string {
  return path === '' ? field : `${path}.${field}`;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireString(
  container: Record<string, unknown>,
  field: string,
  limit: number,
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  const fieldPath = joinField(containerPath, field);
  const fieldValue = container[field];
  if (isAbsent(fieldValue)) {
    problems.push({
      code: 'missing-field',
      path: fieldPath,
      message: `missing required string field ${field} at ${fieldPath}`,
    });
    return;
  }
  if (typeof fieldValue !== 'string') {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be a string, got ${describeType(fieldValue)}`,
    });
    return;
  }
  if (fieldValue.length > limit) {
    problems.push({
      code: 'exceeds-bound',
      path: fieldPath,
      message: `string at ${fieldPath} has ${fieldValue.length} code units, exceeding the bound of ${limit}`,
    });
  }
}

function requireOptionalString(
  container: Record<string, unknown>,
  field: string,
  limit: number,
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  const fieldPath = joinField(containerPath, field);
  const fieldValue = container[field];
  if (isAbsent(fieldValue)) {
    return;
  }
  if (typeof fieldValue !== 'string') {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be a string when present, got ${describeType(fieldValue)}`,
    });
    return;
  }
  if (fieldValue.length > limit) {
    problems.push({
      code: 'exceeds-bound',
      path: fieldPath,
      message: `string at ${fieldPath} has ${fieldValue.length} code units, exceeding the bound of ${limit}`,
    });
  }
}

function requireBoolean(
  container: Record<string, unknown>,
  field: string,
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  const fieldPath = joinField(containerPath, field);
  const fieldValue = container[field];
  if (isAbsent(fieldValue)) {
    problems.push({
      code: 'missing-field',
      path: fieldPath,
      message: `missing required boolean field ${field} at ${fieldPath}`,
    });
    return;
  }
  if (typeof fieldValue !== 'boolean') {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be a boolean, got ${describeType(fieldValue)}`,
    });
  }
}

function requireCount(
  container: Record<string, unknown>,
  field: string,
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  const fieldPath = joinField(containerPath, field);
  const fieldValue = container[field];
  if (isAbsent(fieldValue)) {
    problems.push({
      code: 'missing-field',
      path: fieldPath,
      message: `missing required count field ${field} at ${fieldPath}`,
    });
    return;
  }
  if (typeof fieldValue !== 'number' || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be a non-negative safe integer, got ${describeValue(fieldValue)}`,
    });
  }
}

function requireEnum(
  container: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  const fieldPath = joinField(containerPath, field);
  const fieldValue = container[field];
  if (isAbsent(fieldValue)) {
    problems.push({
      code: 'missing-field',
      path: fieldPath,
      message: `missing required field ${field} at ${fieldPath}; expected one of ${allowed.join('|')}`,
    });
    return;
  }
  if (typeof fieldValue !== 'string' || !allowed.includes(fieldValue)) {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be one of ${allowed.join('|')}, got ${describeValue(fieldValue)}`,
    });
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return describeType(value);
}

function exceedsBound(
  what: string,
  observed: number,
  limit: number,
  path: string,
): WorkspaceSnapshotProblem {
  return {
    code: 'exceeds-bound',
    path,
    message: `${what} is ${observed}, exceeding the bound of ${limit} at ${path}`,
  };
}

/**
 * Strictly validate an untrusted value as a v1 canonical workspace snapshot —
 * the shape carried by `mobile.workspace.snapshot.result` and applied by the
 * Swift `WorkspaceStore`. Returns the (possibly empty) list of problems; an
 * empty list means the value is structurally valid and within every bound.
 *
 * Enforced: exact key sets at every level (unknown fields rejected even when
 * their value is `undefined`), required-field presence and types, canonical
 * enums (`kind`, `recoverability`), canonical Z-form ISO-8601 timestamps for
 * `lastActivity`, non-negative safe-integer revisions/counts, and bounded
 * array/string sizes. The validator checks shape, types, and bounds only —
 * not identity semantics (it does not reject, for example, duplicate pane
 * ids), because the canonical snapshot builder owns what identities are
 * legal; ranking is insensitive to duplicates.
 */
export function validateWorkspaceSnapshot(input: unknown): WorkspaceSnapshotValidation {
  const problems: WorkspaceSnapshotProblem[] = [];
  if (!isRecordLike(input)) {
    return [
      {
        code: 'invalid-snapshot',
        path: '',
        message: `workspace snapshot must be an object, got ${describeType(input)}`,
      },
    ];
  }
  checkUnknownFields(input, SNAPSHOT_KEY_SET, '', problems);

  if (!isSafeNonNegativeInteger(input.revision)) {
    problems.push({
      code: isAbsent(input.revision) ? 'missing-field' : 'invalid-field',
      path: 'revision',
      message: 'snapshot revision must be a non-negative safe integer',
    });
  }

  if (!Array.isArray(input.projects)) {
    problems.push({
      code: 'invalid-field',
      path: 'projects',
      message: `snapshot projects must be an array, got ${describeType(input.projects)}`,
    });
    return problems;
  }
  if (input.projects.length > MAX_WORKSPACE_PROJECTS) {
    problems.push(
      exceedsBound('project count', input.projects.length, MAX_WORKSPACE_PROJECTS, 'projects'),
    );
    return problems;
  }

  let totalPanes = 0;
  for (let projectIndex = 0; projectIndex < input.projects.length; projectIndex += 1) {
    const projectPath = `projects[${projectIndex}]`;
    const project: unknown = input.projects[projectIndex];
    if (!isRecordLike(project)) {
      problems.push({
        code: 'invalid-field',
        path: projectPath,
        message: `project at ${projectPath} must be an object, got ${describeType(project)}`,
      });
      continue;
    }
    checkUnknownFields(project, PROJECT_KEY_SET, projectPath, problems);
    requireString(project, 'id', WORKSPACE_STRING_LIMITS.id, projectPath, problems);
    requireString(project, 'root', WORKSPACE_STRING_LIMITS.path, projectPath, problems);
    requireString(project, 'title', WORKSPACE_STRING_LIMITS.title, projectPath, problems);
    requireCount(project, 'runningCount', projectPath, problems);
    requireCount(project, 'attentionCount', projectPath, problems);

    totalPanes += validateWorktrees(project, projectPath, problems);
    totalPanes += validatePaneList(project, 'projectPanes', projectPath, problems);
    if (totalPanes > MAX_WORKSPACE_PANES_TOTAL) {
      problems.push(
        exceedsBound('total pane count', totalPanes, MAX_WORKSPACE_PANES_TOTAL, projectPath),
      );
      return problems;
    }
  }
  return problems;
}

/**
 * Validate the `worktrees` array of one project, including every pane inside
 * it. Returns the number of panes counted under this project.
 */
function validateWorktrees(
  project: Record<string, unknown>,
  projectPath: string,
  problems: WorkspaceSnapshotProblem[],
): number {
  const fieldPath = joinField(projectPath, 'worktrees');
  const worktrees: unknown = project.worktrees;
  if (!Array.isArray(worktrees)) {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field worktrees at ${fieldPath} must be an array, got ${describeType(worktrees)}`,
    });
    return 0;
  }
  if (worktrees.length > MAX_WORKTREES_PER_PROJECT) {
    problems.push(
      exceedsBound('worktree count', worktrees.length, MAX_WORKTREES_PER_PROJECT, fieldPath),
    );
    return 0;
  }
  let totalPanes = 0;
  for (let worktreeIndex = 0; worktreeIndex < worktrees.length; worktreeIndex += 1) {
    const worktreePath = `${fieldPath}[${worktreeIndex}]`;
    const worktree: unknown = worktrees[worktreeIndex];
    if (!isRecordLike(worktree)) {
      problems.push({
        code: 'invalid-field',
        path: worktreePath,
        message: `worktree at ${worktreePath} must be an object, got ${describeType(worktree)}`,
      });
      continue;
    }
    checkUnknownFields(worktree, WORKTREE_KEY_SET, worktreePath, problems);
    requireString(worktree, 'path', WORKSPACE_STRING_LIMITS.path, worktreePath, problems);
    requireString(worktree, 'head', WORKSPACE_STRING_LIMITS.head, worktreePath, problems);
    requireOptionalString(worktree, 'branch', WORKSPACE_STRING_LIMITS.branch, worktreePath, problems);
    requireOptionalString(worktree, 'lockReason', WORKSPACE_STRING_LIMITS.detail, worktreePath, problems);
    requireOptionalString(worktree, 'pruneReason', WORKSPACE_STRING_LIMITS.detail, worktreePath, problems);
    requireBoolean(worktree, 'isMain', worktreePath, problems);
    requireBoolean(worktree, 'detached', worktreePath, problems);
    requireBoolean(worktree, 'bare', worktreePath, problems);
    requireBoolean(worktree, 'locked', worktreePath, problems);
    requireBoolean(worktree, 'prunable', worktreePath, problems);
    requireBoolean(worktree, 'dirty', worktreePath, problems);
    requireBoolean(worktree, 'missing', worktreePath, problems);
    requireCount(worktree, 'runningCount', worktreePath, problems);
    requireCount(worktree, 'attentionCount', worktreePath, problems);
    totalPanes += validatePaneList(worktree, 'panes', worktreePath, problems);
  }
  return totalPanes;
}

/**
 * Validate one pane container (`worktrees[].panes` or a project's
 * `projectPanes`) and return the number of panes it holds. The container
 * bound is enforced before enumeration, so an oversized container costs one
 * bounds problem and no per-element work.
 */
function validatePaneList(
  container: Record<string, unknown>,
  field: string,
  containerPath: string,
  problems: WorkspaceSnapshotProblem[],
): number {
  const fieldPath = joinField(containerPath, field);
  const panes: unknown = container[field];
  if (!Array.isArray(panes)) {
    problems.push({
      code: 'invalid-field',
      path: fieldPath,
      message: `field ${field} at ${fieldPath} must be an array, got ${describeType(panes)}`,
    });
    return 0;
  }
  if (panes.length > MAX_PANES_PER_CONTAINER) {
    problems.push(exceedsBound(`${field} count`, panes.length, MAX_PANES_PER_CONTAINER, fieldPath));
    return 0;
  }
  for (let paneIndex = 0; paneIndex < panes.length; paneIndex += 1) {
    const panePath = `${fieldPath}[${paneIndex}]`;
    const pane: unknown = panes[paneIndex];
    if (!isRecordLike(pane)) {
      problems.push({
        code: 'invalid-field',
        path: panePath,
        message: `pane at ${panePath} must be an object, got ${describeType(pane)}`,
      });
      continue;
    }
    validatePane(pane, panePath, problems);
  }
  return panes.length;
}

function validatePane(
  pane: Record<string, unknown>,
  panePath: string,
  problems: WorkspaceSnapshotProblem[],
): void {
  checkUnknownFields(pane, PANE_KEY_SET, panePath, problems);
  requireString(pane, 'id', WORKSPACE_STRING_LIMITS.id, panePath, problems);
  requireString(pane, 'cwd', WORKSPACE_STRING_LIMITS.path, panePath, problems);
  requireOptionalString(pane, 'title', WORKSPACE_STRING_LIMITS.title, panePath, problems);
  requireOptionalString(pane, 'agent', WORKSPACE_STRING_LIMITS.agent, panePath, problems);
  requireString(pane, 'status', WORKSPACE_STRING_LIMITS.status, panePath, problems);
  requireEnum(pane, 'kind', WORKSPACE_PANE_KINDS, panePath, problems);
  requireEnum(pane, 'recoverability', WORKSPACE_RECOVERABILITY_VALUES, panePath, problems);

  const needsAttention = pane.needsAttention;
  if (!isAbsent(needsAttention) && typeof needsAttention !== 'boolean') {
    problems.push({
      code: 'invalid-field',
      path: joinField(panePath, 'needsAttention'),
      message: `field needsAttention at ${joinField(panePath, 'needsAttention')} must be a boolean when present, got ${describeType(needsAttention)}`,
    });
  }

  const lastActivity = pane.lastActivity;
  if (!isAbsent(lastActivity)) {
    const fieldPath = joinField(panePath, 'lastActivity');
    if (
      typeof lastActivity !== 'string'
      || !CANONICAL_ISO_Z_TIMESTAMP.test(lastActivity)
      || lastActivity.length > WORKSPACE_STRING_LIMITS.isoTimestamp
    ) {
      problems.push({
        code: 'invalid-field',
        path: fieldPath,
        message: `field lastActivity at ${fieldPath} must be a canonical Z-form ISO-8601 timestamp of at most ${WORKSPACE_STRING_LIMITS.isoTimestamp} code units`,
      });
    }
  }
}
