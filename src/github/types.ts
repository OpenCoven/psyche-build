export const MAX_PR_BODY_PREVIEW = 4_000;

export interface GitHubAccountRef {
  host: string;
  login: string;
  id?: string;
  source: 'gh';
}

export interface GitHubRepositoryRef {
  host: string;
  owner: string;
  name: string;
  url: string;
  visibility?: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  archived?: boolean;
  fork?: boolean;
}

export interface RepositoryPermissions {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  triage: boolean;
  pull: boolean;
}

export interface PullRequestCheckSummary {
  total: number;
  pending: number;
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  required: { total: number; pending: number; passed: number; failed: number };
  optional: { total: number; pending: number; passed: number; failed: number };
}

export interface PullRequestOverview {
  repository: GitHubRepositoryRef;
  number: number;
  url: string;
  title: string;
  bodyPreview: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  authorLogin: string;
  baseRefName: string;
  headRefName: string;
  labels: readonly { name: string; color: string }[];
  assignees: readonly string[];
  requestedReviewers: readonly string[];
  viewerPermissions: RepositoryPermissions | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  mergeStateStatus: string | null;
  checks: PullRequestCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  updatedAt: string;
  fetchedAt: string;
}

export type PullRequestQueryState =
  | { kind: 'ready'; account: GitHubAccountRef; overview: PullRequestOverview; stale: boolean }
  | { kind: 'noPullRequest'; account: GitHubAccountRef; repository: GitHubRepositoryRef; branch: string }
  | { kind: 'detachedHead' }
  | { kind: 'unsupportedRemote'; remotes: readonly string[] }
  | {
      kind: 'ambiguousAssociation';
      candidates: readonly { number: number; url: string; repository: GitHubRepositoryRef }[];
    }
  | { kind: 'unauthenticated'; host: string; loginCommand: string }
  | { kind: 'permissionDenied'; host: string; repository?: GitHubRepositoryRef }
  | { kind: 'rateLimited'; host: string; resetAt?: string }
  | { kind: 'offline'; host?: string }
  | { kind: 'providerUnavailable'; installMessage: string }
  | { kind: 'invalidProviderResponse'; operation: string }
  | { kind: 'failed'; code: string; message: string };

export interface PullRequestOverviewQuery {
  requestId: string;
  projectId: string;
  projectRoot: string;
  worktreePath: string;
  selectionGeneration: number;
  refresh?: boolean;
}

export interface PullRequestOverviewResult {
  requestId: string;
  projectId: string;
  worktreePath: string;
  selectionGeneration: number;
  observedAt: string;
  state: PullRequestQueryState;
}

type ErrorFactory = () => never;

type CheckBucket = 'pending' | 'pass' | 'fail' | 'skipping' | 'cancel';
type CheckOutcome = 'pending' | 'passed' | 'failed' | 'skipped' | 'cancelled';

interface ParsedCheck {
  key: string;
  outcome: CheckOutcome;
}

const PULL_REQUEST_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const;
const MERGEABLE_STATES = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const;
const REPOSITORY_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'INTERNAL'] as const;

export function parseGitHubAccount(value: unknown, host: string): GitHubAccountRef {
  try {
    const normalizedHost = requireNonEmptyString(host, invalidGitHubAccount).trim().toLowerCase();
    const record = requireRecord(value, invalidGitHubAccount);
    const login = requireNonEmptyString(record.login, invalidGitHubAccount);
    const url = requireHttpsUrl(record.url, invalidGitHubAccount);
    if (new URL(url).hostname.toLowerCase() !== normalizedHost) {
      invalidGitHubAccount();
    }

    const idValue = record.id;
    const parsed: GitHubAccountRef = {
      host: normalizedHost,
      login,
      source: 'gh',
    };

    if (idValue !== undefined && idValue !== null) {
      parsed.id = parseAccountId(idValue, invalidGitHubAccount);
    }

    return parsed;
  } catch {
    return invalidGitHubAccount();
  }
}

export function parseRepositoryPermissions(value: unknown): RepositoryPermissions | null {
  if (value === null || value === undefined) {
    return null;
  }

  const record = requireRecord(value, invalidRepositoryPermissions);
  return {
    admin: requireBoolean(record.admin, invalidRepositoryPermissions),
    maintain: requireBoolean(record.maintain, invalidRepositoryPermissions),
    push: requireBoolean(record.push, invalidRepositoryPermissions),
    triage: requireBoolean(record.triage, invalidRepositoryPermissions),
    pull: requireBoolean(record.pull, invalidRepositoryPermissions),
  };
}

export function parsePullRequestOverview(
  value: unknown,
  repository: GitHubRepositoryRef,
  permissions: RepositoryPermissions | null,
  allChecks: unknown,
  requiredChecks: unknown,
  fetchedAt: string,
): PullRequestOverview {
  try {
    const record = requireRecord(value, invalidPullRequestOverview);
    const parsedRepository = parseRepositoryRef(repository, invalidPullRequestOverview);
    const parsedPermissions = parseRepositoryPermissionsForOverview(permissions);
    const checks = parseChecks(allChecks, requiredChecks);

    const author = requireRecord(record.author, invalidPullRequestOverview);
    const commits = requireArray(record.commits, invalidPullRequestOverview);

    return {
      repository: parsedRepository,
      number: requireNonNegativeInteger(record.number, invalidPullRequestOverview),
      url: requireHttpsUrl(record.url, invalidPullRequestOverview),
      title: requireNonEmptyString(record.title, invalidPullRequestOverview),
      bodyPreview: requireString(record.body, invalidPullRequestOverview).slice(0, MAX_PR_BODY_PREVIEW),
      state: requireEnumValue(record.state, PULL_REQUEST_STATES, invalidPullRequestOverview),
      isDraft: requireBoolean(record.isDraft, invalidPullRequestOverview),
      authorLogin: requireNonEmptyString(author.login, invalidPullRequestOverview),
      baseRefName: requireNonEmptyString(record.baseRefName, invalidPullRequestOverview),
      headRefName: requireNonEmptyString(record.headRefName, invalidPullRequestOverview),
      labels: parseLabels(record.labels),
      assignees: parseLoginList(record.assignees),
      requestedReviewers: parseLoginList(record.reviewRequests),
      viewerPermissions: parsedPermissions,
      reviewDecision: parseNullableEnumValue(
        record.reviewDecision,
        REVIEW_DECISIONS,
        invalidPullRequestOverview,
      ),
      mergeable: parseNullableEnumValue(
        record.mergeable,
        MERGEABLE_STATES,
        invalidPullRequestOverview,
      ),
      mergeStateStatus: parseNullableNonEmptyString(record.mergeStateStatus, invalidPullRequestOverview),
      checks,
      additions: requireNonNegativeInteger(record.additions, invalidPullRequestOverview),
      deletions: requireNonNegativeInteger(record.deletions, invalidPullRequestOverview),
      changedFiles: requireNonNegativeInteger(record.changedFiles, invalidPullRequestOverview),
      commitCount: commits.length,
      updatedAt: requireDateString(record.updatedAt, invalidPullRequestOverview),
      fetchedAt: requireDateString(fetchedAt, invalidPullRequestOverview),
    };
  } catch {
    return invalidPullRequestOverview();
  }
}

function invalidGitHubAccount(): never {
  throw new Error('invalid GitHub account response');
}

function invalidRepositoryPermissions(): never {
  throw new Error('invalid repository permissions');
}

function invalidPullRequestOverview(): never {
  throw new Error('invalid pull request overview');
}

function requireRecord(value: unknown, onError: ErrorFactory): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return onError();
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, onError: ErrorFactory): unknown[] {
  if (!Array.isArray(value)) {
    return onError();
  }
  return value;
}

function requireString(value: unknown, onError: ErrorFactory): string {
  if (typeof value !== 'string') {
    return onError();
  }
  return value;
}

function requireNonEmptyString(value: unknown, onError: ErrorFactory): string {
  const parsed = requireString(value, onError);
  if (parsed.trim().length === 0) {
    return onError();
  }
  return parsed;
}

function requireBoolean(value: unknown, onError: ErrorFactory): boolean {
  if (typeof value !== 'boolean') {
    return onError();
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, onError: ErrorFactory): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return onError();
  }
  return value;
}

function requireHttpsUrl(value: unknown, onError: ErrorFactory): string {
  const parsed = requireString(value, onError);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    return onError();
  }
  if (url.protocol !== 'https:' || url.hostname.trim().length === 0) {
    return onError();
  }
  return parsed;
}

function requireDateString(value: unknown, onError: ErrorFactory): string {
  const parsed = requireNonEmptyString(value, onError);
  if (Number.isNaN(Date.parse(parsed))) {
    return onError();
  }
  return parsed;
}

function requireEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  onError: ErrorFactory,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    return onError();
  }
  return value as T[number];
}

function parseNullableEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  onError: ErrorFactory,
): T[number] | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireEnumValue(value, allowed, onError);
}

function parseNullableNonEmptyString(value: unknown, onError: ErrorFactory): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireNonEmptyString(value, onError);
}

function parseAccountId(value: unknown, onError: ErrorFactory): string {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      return onError();
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return onError();
}

function parseRepositoryRef(value: unknown, onError: ErrorFactory): GitHubRepositoryRef {
  const record = requireRecord(value, onError);
  const repository: GitHubRepositoryRef = {
    host: requireNonEmptyString(record.host, onError).trim().toLowerCase(),
    owner: requireNonEmptyString(record.owner, onError),
    name: requireNonEmptyString(record.name, onError),
    url: requireHttpsUrl(record.url, onError),
  };

  if (record.visibility !== undefined) {
    repository.visibility = requireEnumValue(record.visibility, REPOSITORY_VISIBILITIES, onError);
  }
  if (record.archived !== undefined) {
    repository.archived = requireBoolean(record.archived, onError);
  }
  if (record.fork !== undefined) {
    repository.fork = requireBoolean(record.fork, onError);
  }

  return repository;
}

function parseRepositoryPermissionsForOverview(
  value: RepositoryPermissions | null,
): RepositoryPermissions | null {
  try {
    return parseRepositoryPermissions(value);
  } catch {
    return invalidPullRequestOverview();
  }
}

function parseLabels(value: unknown): readonly { name: string; color: string }[] {
  return requireArray(value, invalidPullRequestOverview).map((entry) => {
    const record = requireRecord(entry, invalidPullRequestOverview);
    return {
      name: requireNonEmptyString(record.name, invalidPullRequestOverview),
      color: requireNonEmptyString(record.color, invalidPullRequestOverview),
    };
  });
}

function parseLoginList(value: unknown): readonly string[] {
  return requireArray(value, invalidPullRequestOverview).map((entry) => {
    const record = requireRecord(entry, invalidPullRequestOverview);
    return requireNonEmptyString(record.login, invalidPullRequestOverview);
  });
}

function parseChecks(allChecks: unknown, requiredChecks: unknown): PullRequestCheckSummary {
  const parsedAllChecks = requireArray(allChecks, invalidPullRequestOverview).map((entry) =>
    parseCheck(entry, invalidPullRequestOverview),
  );
  const requiredKeys = new Set(
    requireArray(requiredChecks, invalidPullRequestOverview).map((entry) =>
      parseCheck(entry, invalidPullRequestOverview).key,
    ),
  );

  const summary: PullRequestCheckSummary = {
    total: 0,
    pending: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    required: { total: 0, pending: 0, passed: 0, failed: 0 },
    optional: { total: 0, pending: 0, passed: 0, failed: 0 },
  };

  for (const check of parsedAllChecks) {
    summary.total += 1;
    incrementSummary(summary, check.outcome);

    const target = requiredKeys.has(check.key) ? summary.required : summary.optional;
    target.total += 1;
    if (check.outcome === 'pending') {
      target.pending += 1;
    } else if (check.outcome === 'passed') {
      target.passed += 1;
    } else if (check.outcome === 'failed') {
      target.failed += 1;
    }
  }

  return summary;
}

function parseCheck(value: unknown, onError: ErrorFactory): ParsedCheck {
  const record = requireRecord(value, onError);
  const bucket = requireEnumValue(
    record.bucket,
    ['pending', 'pass', 'fail', 'skipping', 'cancel'] as const,
    onError,
  );
  const workflow = requireNonEmptyString(record.workflow, onError);
  const name = requireNonEmptyString(record.name, onError);
  const link = requireHttpsUrl(record.link, onError);
  requireNonEmptyString(record.state, onError);

  return {
    key: buildRequiredCheckKey(workflow, name, link),
    outcome: mapCheckOutcome(bucket),
  };
}

function buildRequiredCheckKey(workflow: string, name: string, link: string): string {
  return `${workflow}\0${name}\0${link}`;
}

function mapCheckOutcome(bucket: CheckBucket): CheckOutcome {
  switch (bucket) {
    case 'pending':
      return 'pending';
    case 'pass':
      return 'passed';
    case 'fail':
      return 'failed';
    case 'skipping':
      return 'skipped';
    case 'cancel':
      return 'cancelled';
  }
}

function incrementSummary(summary: PullRequestCheckSummary, outcome: CheckOutcome): void {
  switch (outcome) {
    case 'pending':
      summary.pending += 1;
      return;
    case 'passed':
      summary.passed += 1;
      return;
    case 'failed':
      summary.failed += 1;
      return;
    case 'skipped':
      summary.skipped += 1;
      return;
    case 'cancelled':
      summary.cancelled += 1;
      return;
  }
}
