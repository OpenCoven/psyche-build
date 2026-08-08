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
type PlainRecord = Record<string, unknown>;

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
const MISSING_PROPERTY = Symbol('missingProperty');
const RFC_3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseGitHubAccount(value: unknown, host: string): GitHubAccountRef {
  try {
    const normalizedHost = requireNonEmptyString(host, invalidGitHubAccount).trim().toLowerCase();
    const record = requireRecord(value, invalidGitHubAccount);
    const login = requireNonEmptyString(
      getOwnDataProperty(record, 'login', invalidGitHubAccount),
      invalidGitHubAccount,
    );
    const publicUrl = getOptionalOwnDataProperty(record, 'html_url', invalidGitHubAccount);
    const apiUrl = getOptionalOwnDataProperty(record, 'url', invalidGitHubAccount);
    validateGitHubAccountUrls(normalizedHost, publicUrl, apiUrl);

    const idValue = getOptionalOwnDataProperty(record, 'id', invalidGitHubAccount);
    const parsed: GitHubAccountRef = {
      host: normalizedHost,
      login,
      source: 'gh',
    };

    if (idValue !== MISSING_PROPERTY && idValue !== null) {
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

  try {
    const record = requireRecord(value, invalidRepositoryPermissions);
    return {
      admin: requireBoolean(getOwnDataProperty(record, 'admin', invalidRepositoryPermissions), invalidRepositoryPermissions),
      maintain: requireBoolean(
        getOwnDataProperty(record, 'maintain', invalidRepositoryPermissions),
        invalidRepositoryPermissions,
      ),
      push: requireBoolean(getOwnDataProperty(record, 'push', invalidRepositoryPermissions), invalidRepositoryPermissions),
      triage: requireBoolean(
        getOwnDataProperty(record, 'triage', invalidRepositoryPermissions),
        invalidRepositoryPermissions,
      ),
      pull: requireBoolean(getOwnDataProperty(record, 'pull', invalidRepositoryPermissions), invalidRepositoryPermissions),
    };
  } catch {
    return invalidRepositoryPermissions();
  }
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

    const author = requireRecord(
      getOwnDataProperty(record, 'author', invalidPullRequestOverview),
      invalidPullRequestOverview,
    );
    const commitCount = parseCommitCount(
      getOwnDataProperty(record, 'commits', invalidPullRequestOverview),
    );

    return {
      repository: parsedRepository,
      number: requireNonNegativeInteger(
        getOwnDataProperty(record, 'number', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      url: requireHttpsUrl(getOwnDataProperty(record, 'url', invalidPullRequestOverview), invalidPullRequestOverview),
      title: requireNonEmptyString(
        getOwnDataProperty(record, 'title', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      bodyPreview: requireString(
        getOwnDataProperty(record, 'body', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ).slice(0, MAX_PR_BODY_PREVIEW),
      state: requireEnumValue(
        getOwnDataProperty(record, 'state', invalidPullRequestOverview),
        PULL_REQUEST_STATES,
        invalidPullRequestOverview,
      ),
      isDraft: requireBoolean(
        getOwnDataProperty(record, 'isDraft', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      authorLogin: requireNonEmptyString(
        getOwnDataProperty(author, 'login', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      baseRefName: requireNonEmptyString(
        getOwnDataProperty(record, 'baseRefName', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      headRefName: requireNonEmptyString(
        getOwnDataProperty(record, 'headRefName', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      labels: parseLabels(getOwnDataProperty(record, 'labels', invalidPullRequestOverview)),
      assignees: parseLoginList(getOwnDataProperty(record, 'assignees', invalidPullRequestOverview)),
      requestedReviewers: parseReviewRequests(
        getOwnDataProperty(record, 'reviewRequests', invalidPullRequestOverview),
      ),
      viewerPermissions: parsedPermissions,
      reviewDecision: parseNullableEnumValueOrEmptyString(
        getOwnDataProperty(record, 'reviewDecision', invalidPullRequestOverview),
        REVIEW_DECISIONS,
        invalidPullRequestOverview,
      ),
      mergeable: parseNullableEnumValue(
        getOwnDataProperty(record, 'mergeable', invalidPullRequestOverview),
        MERGEABLE_STATES,
        invalidPullRequestOverview,
      ),
      mergeStateStatus: parseNullableNonEmptyString(
        getOwnDataProperty(record, 'mergeStateStatus', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      checks,
      additions: requireNonNegativeInteger(
        getOwnDataProperty(record, 'additions', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      deletions: requireNonNegativeInteger(
        getOwnDataProperty(record, 'deletions', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      changedFiles: requireNonNegativeInteger(
        getOwnDataProperty(record, 'changedFiles', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      commitCount,
      updatedAt: requireDateString(
        getOwnDataProperty(record, 'updatedAt', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
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

function requireRecord(value: unknown, onError: ErrorFactory): PlainRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return onError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return onError();
    }
    return value as PlainRecord;
  } catch {
    return onError();
  }
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
  const match = RFC_3339_TIMESTAMP.exec(parsed);
  if (!match) {
    return onError();
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  const second = Number.parseInt(match[6]!, 10);

  if (month < 1 || month > 12) {
    return onError();
  }
  if (day < 1 || day > getDaysInMonth(year, month)) {
    return onError();
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return onError();
  }

  if (match[8] !== 'Z') {
    const offsetHour = Number.parseInt(match[10]!, 10);
    const offsetMinute = Number.parseInt(match[11]!, 10);
    if (offsetHour > 23 || offsetMinute > 59) {
      return onError();
    }
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

function parseNullableEnumValueOrEmptyString<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  onError: ErrorFactory,
): T[number] | null {
  if (value === '') {
    return null;
  }
  return parseNullableEnumValue(value, allowed, onError);
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
    host: requireNonEmptyString(getOwnDataProperty(record, 'host', onError), onError).trim().toLowerCase(),
    owner: requireNonEmptyString(getOwnDataProperty(record, 'owner', onError), onError),
    name: requireNonEmptyString(getOwnDataProperty(record, 'name', onError), onError),
    url: requireHttpsUrl(getOwnDataProperty(record, 'url', onError), onError),
  };

  const visibility = getOptionalOwnDataProperty(record, 'visibility', onError);
  if (visibility !== MISSING_PROPERTY) {
    repository.visibility = requireEnumValue(visibility, REPOSITORY_VISIBILITIES, onError);
  }
  const archived = getOptionalOwnDataProperty(record, 'archived', onError);
  if (archived !== MISSING_PROPERTY) {
    repository.archived = requireBoolean(archived, onError);
  }
  const fork = getOptionalOwnDataProperty(record, 'fork', onError);
  if (fork !== MISSING_PROPERTY) {
    repository.fork = requireBoolean(fork, onError);
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
      name: requireNonEmptyString(
        getOwnDataProperty(record, 'name', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
      color: requireNonEmptyString(
        getOwnDataProperty(record, 'color', invalidPullRequestOverview),
        invalidPullRequestOverview,
      ),
    };
  });
}

function parseLoginList(value: unknown): readonly string[] {
  return requireArray(value, invalidPullRequestOverview).map((entry) => {
    const record = requireRecord(entry, invalidPullRequestOverview);
    return requireNonEmptyString(
      getOwnDataProperty(record, 'login', invalidPullRequestOverview),
      invalidPullRequestOverview,
    );
  });
}

function parseReviewRequests(value: unknown): readonly string[] {
  return requireArray(value, invalidPullRequestOverview).map((entry) => {
    const record = requireRecord(entry, invalidPullRequestOverview);
    const login = getOptionalOwnDataProperty(record, 'login', invalidPullRequestOverview);
    if (login !== MISSING_PROPERTY) {
      return requireNonEmptyString(login, invalidPullRequestOverview);
    }

    const slug = getOptionalOwnDataProperty(record, 'slug', invalidPullRequestOverview);
    if (slug !== MISSING_PROPERTY) {
      const parsedSlug = requireString(slug, invalidPullRequestOverview);
      if (parsedSlug.length > 0) {
        return parsedSlug;
      }
    }

    const name = getOptionalOwnDataProperty(record, 'name', invalidPullRequestOverview);
    if (name !== MISSING_PROPERTY) {
      return requireNonEmptyString(name, invalidPullRequestOverview);
    }

    return invalidPullRequestOverview();
  });
}

function parseChecks(allChecks: unknown, requiredChecks: unknown): PullRequestCheckSummary {
  const parsedAllChecks = requireArray(allChecks, invalidPullRequestOverview).map((entry) =>
    parseCheck(entry, invalidPullRequestOverview),
  );
  const requiredCounts = new Map<string, number>();
  for (const check of requireArray(requiredChecks, invalidPullRequestOverview).map((entry) =>
    parseCheck(entry, invalidPullRequestOverview),
  )) {
    requiredCounts.set(check.key, (requiredCounts.get(check.key) ?? 0) + 1);
  }

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

    const remainingRequired = requiredCounts.get(check.key) ?? 0;
    const target = remainingRequired > 0 ? summary.required : summary.optional;
    if (remainingRequired > 0) {
      requiredCounts.set(check.key, remainingRequired - 1);
    }
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
    getOwnDataProperty(record, 'bucket', onError),
    ['pending', 'pass', 'fail', 'skipping', 'cancel'] as const,
    onError,
  );
  const workflow = requireString(getOwnDataProperty(record, 'workflow', onError), onError);
  const name = requireNonEmptyString(getOwnDataProperty(record, 'name', onError), onError);
  const link = requireString(getOwnDataProperty(record, 'link', onError), onError);
  requireNonEmptyString(getOwnDataProperty(record, 'state', onError), onError);

  return {
    key: buildRequiredCheckKey(workflow, name, link),
    outcome: mapCheckOutcome(bucket),
  };
}

function parseCommitCount(value: unknown): number {
  const commits = requireArray(value, invalidPullRequestOverview);
  for (const entry of commits) {
    const record = requireRecord(entry, invalidPullRequestOverview);
    requireNonEmptyString(
      getOwnDataProperty(record, 'oid', invalidPullRequestOverview),
      invalidPullRequestOverview,
    );
  }
  return commits.length;
}

function buildRequiredCheckKey(workflow: string, name: string, link: string): string {
  return `${workflow}\0${name}\0${link}`;
}

function validateGitHubAccountUrls(
  host: string,
  publicUrl: unknown | typeof MISSING_PROPERTY,
  apiUrl: unknown | typeof MISSING_PROPERTY,
): void {
  if (publicUrl !== MISSING_PROPERTY) {
    validateGitHubAccountUrlHost(host, requireHttpsUrl(publicUrl, invalidGitHubAccount));
  }
  if (apiUrl !== MISSING_PROPERTY) {
    validateGitHubAccountUrlHost(host, requireHttpsUrl(apiUrl, invalidGitHubAccount));
  }
  if (publicUrl === MISSING_PROPERTY && apiUrl === MISSING_PROPERTY) {
    invalidGitHubAccount();
  }
}

function validateGitHubAccountUrlHost(host: string, url: string): void {
  const parsedUrl = new URL(url);
  const urlHost = parsedUrl.hostname.toLowerCase();
  if (host === 'github.com') {
    if (urlHost !== 'github.com' && urlHost !== 'api.github.com') {
      invalidGitHubAccount();
    }
    return;
  }
  if (urlHost !== host) {
    invalidGitHubAccount();
  }
}

function getOwnDataProperty(record: PlainRecord, key: string, onError: ErrorFactory): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return onError();
    }
    return descriptor.value;
  } catch {
    return onError();
  }
}

function getOptionalOwnDataProperty(
  record: PlainRecord,
  key: string,
  onError: ErrorFactory,
): unknown | typeof MISSING_PROPERTY {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) {
      return MISSING_PROPERTY;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return onError();
    }
    return descriptor.value;
  } catch {
    return onError();
  }
}

function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
