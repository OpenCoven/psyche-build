// @ts-check

import {
  DEFAULT_ISSUE_MARKER,
  DEFAULT_PROJECT_MARKER,
  extractProjectReadmeMarkers,
  LEGACY_ISSUE_MARKERS,
  LEGACY_PROJECT_MARKERS,
  markerPattern,
  normalizeMarker,
  normalizeRepositoryIdentity,
  projectReadmeMarker,
  recognizedMarkers,
  recognizedProjectMarkers,
} from './markers.mjs';

export const PROJECT_README_MARKER = projectReadmeMarker(DEFAULT_PROJECT_MARKER);
export const LEGACY_PROJECT_README_MARKER = projectReadmeMarker(LEGACY_PROJECT_MARKERS[0]);

export const PROJECT_VIEWS = Object.freeze([
  Object.freeze({ name: 'Overview', layout: 'TABLE_LAYOUT', filter: '' }),
  Object.freeze({ name: 'Backlog', layout: 'BOARD_LAYOUT', filter: 'status:Backlog' }),
  Object.freeze({ name: 'Ready', layout: 'BOARD_LAYOUT', filter: 'status:Ready' }),
  Object.freeze({ name: 'In Progress', layout: 'BOARD_LAYOUT', filter: 'status:"In Progress"' }),
  Object.freeze({ name: 'Blocked', layout: 'TABLE_LAYOUT', filter: 'status:Blocked' }),
  Object.freeze({ name: 'Done', layout: 'TABLE_LAYOUT', filter: 'status:Done' }),
]);

const API_HEADERS = Object.freeze([
  '-H',
  'Accept: application/vnd.github+json',
  '-H',
  'X-GitHub-Api-Version: 2026-03-10',
  '--include',
]);
const SAFE_OWNER_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const PROJECT_NODE_ID_PATTERN = /^PVT_[A-Za-z0-9_-]{8,255}$/u;
const SAFE_BEAD_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,199})$/u;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/giu;
const MAX_ERROR_DETAIL = 512;
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 60_000;
const APPLY_LOCK_REF = 'refs/tags/psyche-beads-project-sync-lock';
const APPLY_LOCK_REF_ENDPOINT = 'tags/psyche-beads-project-sync-lock';
const APPLY_LOCK_MESSAGE_PREFIX = 'psyche-beads-project-lock:v1 ';
const DEFAULT_APPLY_LOCK_TTL_MS = 30 * 60 * 1_000;
const MAX_APPLY_LOCK_TTL_MS = 24 * 60 * 60 * 1_000;
const SAFE_LOCK_IDENTITY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const STATUS_OPTIONS = Object.freeze([
  Object.freeze({ name: 'Backlog', color: 'GRAY', description: '' }),
  Object.freeze({ name: 'Ready', color: 'BLUE', description: '' }),
  Object.freeze({ name: 'In Progress', color: 'YELLOW', description: '' }),
  Object.freeze({ name: 'Blocked', color: 'RED', description: '' }),
  Object.freeze({ name: 'Done', color: 'GREEN', description: '' }),
]);
const PRIORITY_OPTIONS = Object.freeze([
  Object.freeze({ name: 'P0', color: 'RED', description: '' }),
  Object.freeze({ name: 'P1', color: 'ORANGE', description: '' }),
  Object.freeze({ name: 'P2', color: 'YELLOW', description: '' }),
  Object.freeze({ name: 'P3', color: 'BLUE', description: '' }),
  Object.freeze({ name: 'P4', color: 'GRAY', description: '' }),
]);
const BEAD_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ name: 'Epic', color: 'PURPLE', description: '' }),
  Object.freeze({ name: 'Feature', color: 'BLUE', description: '' }),
  Object.freeze({ name: 'Task', color: 'GREEN', description: '' }),
  Object.freeze({ name: 'Bug', color: 'RED', description: '' }),
  Object.freeze({ name: 'Chore', color: 'GRAY', description: '' }),
  Object.freeze({ name: 'Decision', color: 'PINK', description: '' }),
]);

const REQUIRED_LABELS = Object.freeze([
  Object.freeze({ name: 'bead', color: '5319e7', description: 'Managed mirror of a Beads record' }),
  Object.freeze({ name: 'bead:epic', color: '8250df', description: 'Mirrored Beads epic' }),
  Object.freeze({ name: 'bead:feature', color: '1d76db', description: 'Mirrored Beads feature' }),
  Object.freeze({ name: 'bead:task', color: '0e8a16', description: 'Mirrored Beads task' }),
  Object.freeze({ name: 'priority:P0', color: 'b60205', description: 'Beads priority P0' }),
  Object.freeze({ name: 'priority:P1', color: 'd93f0b', description: 'Beads priority P1' }),
  Object.freeze({ name: 'priority:P2', color: 'fbca04', description: 'Beads priority P2' }),
  Object.freeze({ name: 'priority:P3', color: '0e8a16', description: 'Beads priority P3' }),
  Object.freeze({ name: 'priority:P4', color: 'c5def5', description: 'Beads priority P4' }),
  Object.freeze({ name: 'status:blocked', color: 'd73a4a', description: 'Blocked by another active Bead' }),
]);

const FIELD_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'Status', dataType: 'SINGLE_SELECT', options: STATUS_OPTIONS }),
  Object.freeze({ name: 'Priority', dataType: 'SINGLE_SELECT', options: PRIORITY_OPTIONS }),
  Object.freeze({ name: 'Bead Type', dataType: 'SINGLE_SELECT', options: BEAD_TYPE_OPTIONS }),
  Object.freeze({ name: 'Bead ID', dataType: 'TEXT', options: Object.freeze([]) }),
  Object.freeze({ name: 'Parent Goal', dataType: 'TEXT', options: Object.freeze([]) }),
  Object.freeze({ name: 'Source Updated', dataType: 'DATE', options: Object.freeze([]) }),
]);

const DISCOVER_PROJECTS_QUERY = `
query DiscoverManagedProject($owner: String!, $repo: String!, $cursor: String) {
  organization(login: $owner) {
    id
    projectsV2(first: 100, after: $cursor) {
      nodes {
        id
        number
        title
        readme
        public
        closed
        url
        repositories(first: 100) {
          nodes {
            id
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        items(first: 1, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
          totalCount
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  repository(owner: $owner, name: $repo) {
    id
  }
}
`.trim();

const CREATE_PROJECT_MUTATION = `
mutation CreateManagedProject($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 {
      id
      number
      title
      readme
      public
      url
    }
  }
}
`.trim();

const UPDATE_PROJECT_MUTATION = `
mutation UpdateManagedProject($projectId: ID!, $title: String!, $readme: String!) {
  updateProjectV2(input: {projectId: $projectId, title: $title, readme: $readme}) {
    projectV2 {
      id
      number
      title
      readme
      public
      url
    }
  }
}
`.trim();

const INITIALIZE_FRESH_PROJECT_MUTATION = `
mutation UpdateManagedProject($projectId: ID!, $title: String!, $readme: String!) {
  updateProjectV2(input: {projectId: $projectId, title: $title, public: true, readme: $readme}) {
    projectV2 {
      id
      number
      title
      readme
      public
      url
    }
  }
}
`.trim();

const UPDATE_PROJECT_README_MUTATION = `
mutation UpdateManagedProjectReadme($projectId: ID!, $readme: String!) {
  updateProjectV2(input: {projectId: $projectId, readme: $readme}) {
    projectV2 {
      id
      readme
    }
  }
}
`.trim();

const LINK_PROJECT_MUTATION = `
mutation LinkManagedProject($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: {projectId: $projectId, repositoryId: $repositoryId}) {
    repository {
      id
    }
  }
}
`.trim();

const DISCOVER_LINKED_REPOSITORIES_QUERY = `
query DiscoverLinkedProjectRepositories($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      repositories(first: 100, after: $cursor) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`.trim();

const DISCOVER_FIELDS_QUERY = `
query DiscoverManagedProjectFields($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 100, after: $cursor) {
        nodes {
          __typename
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            dataType
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`.trim();

const CREATE_FIELD_MUTATION = `
mutation CreateManagedProjectField($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) {
    projectV2Field {
      ... on ProjectV2Field {
        id
        name
        dataType
      }
      ... on ProjectV2SingleSelectField {
        id
        name
        dataType
        options {
          id
          name
        }
      }
    }
  }
}
`.trim();

const UPDATE_FIELD_MUTATION = `
mutation UpdateManagedProjectField($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: {fieldId: $fieldId, singleSelectOptions: $options}) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options {
          id
          name
        }
      }
    }
  }
}
`.trim();

const DISCOVER_VIEWS_QUERY = `
query DiscoverManagedProjectViews($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      views(first: 100, after: $cursor) {
        nodes {
          id
          name
          layout
          filter
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`.trim();

const CREATE_VIEW_MUTATION = `
mutation CreateManagedProjectView($input: CreateProjectV2ViewInput!) {
  createProjectV2View(input: $input) {
    projectV2View {
      id
      name
      layout
      filter
    }
  }
}
`.trim();

const UPDATE_VIEW_MUTATION = `
mutation UpdateManagedProjectView($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) {
    projectV2View {
      id
      name
      layout
      filter
    }
  }
}
`.trim();

const DISCOVER_ITEMS_QUERY = `
query DiscoverManagedProjectItems($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        nodes {
          id
          isArchived
          content {
            ... on Issue {
              id
              url
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldDateValue {
                date
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`.trim();

/**
 * @typedef {{
 *   env?: Readonly<Record<string, string>>,
 *   stdin?: string,
 * }} GhRunOptions
 */

/**
 * @typedef {{
 *   stdout: string,
 *   stderr?: string,
 *   exitCode?: number,
 *   headers?: Readonly<Record<string, string | readonly string[] | undefined>>,
 *   retryAfter?: string | number,
 *   rateLimitReset?: string | number,
 *   status?: number,
 * }} GhRunResult
 */

/**
 * @typedef {(command: string, args: readonly string[], options: GhRunOptions) => Promise<GhRunResult> | GhRunResult} GhRun
 */

/**
 * @typedef {{
 *   id: string,
 *   number: number,
 *   title: string,
 *   readme: string,
 *   public: boolean,
 *   closed?: boolean,
 *   url?: string,
 *   linkedRepositoryIds?: readonly string[],
 *   linkedRepositoriesKnown?: boolean,
 *   linkedRepositoriesHasNextPage?: boolean,
 *   linkedRepositoriesEndCursor?: string | null,
 *   itemCount?: number | null,
 * }} ProjectContext
 */

/**
 * @typedef {{
 *   id: number,
 *   nodeId: string,
 *   number: number,
 *   repository: string,
 * }} IssueIdentity
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   dataType: string,
 *   options: Map<string, string>,
 * }} ProjectFieldContext
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   layout: string,
 *   filter: string,
 * }} ProjectViewContext
 */

/**
 * @typedef {{
 *   command?: unknown,
 *   code?: unknown,
 *   kind?: unknown,
 *   name?: unknown,
 *   status?: unknown,
 *   statusCode?: unknown,
 *   exitCode?: unknown,
 *   stderr?: unknown,
 *   stderrSummary?: unknown,
 *   message?: unknown,
 *   response?: { status?: unknown },
 *   headers?: unknown,
 *   retryAfter?: unknown,
 *   rateLimitReset?: unknown,
 *   graphqlErrors?: unknown,
 * }} ErrorLike
 */

/**
 * @typedef {{
 *   version: 1,
 *   state: 'acquired' | 'released',
 *   owner: string,
 *   runId: string,
 *   leaseId: string,
 *   acquiredAt: number,
 *   expiresAt: number,
 * }} ApplyLockState
 */

/**
 * @typedef {ApplyLockState & {
 *   ref: string,
 *   sha: string,
 *   treeSha: string,
 * }} ApplyLockHandle
 */

export class GhClientError extends Error {
  /**
   * @param {string} kind
   * @param {string} message
   * @param {number | undefined} [status]
   */
  constructor(kind, message, status) {
    super(message);
    this.name = 'GhClientError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new GhClientError('validation', message);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function requiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function positiveInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${fieldName} must be a positive integer`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function array(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function errorStatus(value) {
  const error = /** @type {ErrorLike} */ (value ?? {});
  for (const candidate of [error.status, error.statusCode, error.response?.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }

  const detail = [
    error.message,
    error.stderr,
    error.stderrSummary,
  ].filter((entry) => typeof entry === 'string').join(' ');
  const match = detail.match(/\b(?:HTTP\s*)?(4\d\d|5\d\d)\b/iu);
  return match ? Number(match[1]) : undefined;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorDetail(error) {
  const candidate = /** @type {ErrorLike} */ (error ?? {});
  const raw = [
    candidate.message,
    candidate.stderrSummary,
    candidate.stderr,
  ].find((value) => typeof value === 'string' && value.trim());
  if (typeof raw !== 'string') {
    return 'GitHub command failed';
  }

  return raw
    .replace(GITHUB_TOKEN_PATTERN, '<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_ERROR_DETAIL);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isDefiniteRateLimit(error) {
  const status = errorStatus(error);
  const detail = errorDetail(error);
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    return /(?:rate[\s-]*limit|secondary rate|abuse detection)/iu.test(detail);
  }

  const graphqlErrors = array(/** @type {ErrorLike} */ (error ?? {}).graphqlErrors);
  return graphqlErrors.length > 0 && graphqlErrors.every((entry) => {
    const item = record(entry);
    return item.type === 'RATE_LIMITED'
      || /rate[\s-]*limit/iu.test(stringOrEmpty(item.message));
  });
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryable(error) {
  const status = errorStatus(error);
  if (isDefiniteRateLimit(error)) {
    return true;
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return false;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransportFailure(error) {
  if (errorStatus(error) != null) {
    return false;
  }

  const candidate = /** @type {ErrorLike} */ (error ?? {});
  if (candidate.kind === 'transport' || candidate.name === 'AbortError') {
    return true;
  }

  const code = stringOrEmpty(candidate.code).toUpperCase();
  if ([
    'ABORT_ERR',
    'ECONNABORTED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETRESET',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_ABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(code)) {
    return true;
  }

  return /(?:\b(?:ECONNRESET|ETIMEDOUT|aborted|EOF)\b|socket hang up|connection (?:was )?(?:closed|refused|reset)|error connecting|dial tcp|i\/o timeout|no such host|TLS handshake timeout|timed? out|timeout|network error|fetch failed|broken pipe)/iu
    .test(errorDetail(error));
}

/**
 * @param {unknown} rawHeaders
 * @param {string} name
 * @returns {string | null}
 */
function headerValue(rawHeaders, name) {
  if (rawHeaders == null) {
    return null;
  }
  if (typeof /** @type {{get?: unknown}} */ (rawHeaders).get === 'function') {
    const value = /** @type {{get(name: string): unknown}} */ (rawHeaders).get(name);
    return value == null ? null : String(value);
  }
  const headers = record(rawHeaders);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (Array.isArray(value)) {
    return value[0] == null ? null : String(value[0]);
  }
  return value == null ? null : String(value);
}

/**
 * @param {unknown} error
 * @param {number} attempt
 * @param {number} now
 * @param {number} maxWaitMs
 * @returns {number}
 */
function retryWaitMilliseconds(error, attempt, now, maxWaitMs) {
  const candidate = /** @type {ErrorLike} */ (error ?? {});
  const retryAfter = candidate.retryAfter
    ?? headerValue(candidate.headers, 'Retry-After');
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(String(retryAfter)) - now;
    if (Number.isFinite(milliseconds)) {
      return Math.max(0, Math.min(maxWaitMs, milliseconds));
    }
  }

  const reset = candidate.rateLimitReset
    ?? headerValue(candidate.headers, 'X-RateLimit-Reset');
  if (reset != null) {
    const resetSeconds = Number(reset);
    if (Number.isFinite(resetSeconds)) {
      return Math.max(0, Math.min(maxWaitMs, (resetSeconds * 1_000) - now));
    }
  }

  return Math.min(maxWaitMs, BASE_RETRY_DELAY_MS * (2 ** attempt));
}

/**
 * @param {unknown} error
 * @returns {GhClientError}
 */
function toClientError(error) {
  if (error instanceof GhClientError) {
    return error;
  }
  const clientError = new GhClientError(
    isTransportFailure(error) ? 'transport' : 'github',
    errorDetail(error),
    errorStatus(error),
  );
  const source = record(error);
  for (const key of ['headers', 'retryAfter', 'rateLimitReset', 'graphqlErrors']) {
    if (source[key] == null) {
      continue;
    }
    Object.defineProperty(clientError, key, {
      configurable: false,
      enumerable: false,
      value: source[key],
      writable: false,
    });
  }
  return clientError;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {Record<string, unknown>}
 */
function parseJsonObject(value, context) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return {};
  }
  try {
    return record(JSON.parse(text));
  } catch {
    throw new GhClientError('response', `${context} returned invalid JSON`);
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {unknown}
 */
function parseJson(value, context) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GhClientError('response', `${context} returned invalid JSON`);
  }
}

/**
 * @param {unknown} result
 * @returns {GhRunResult}
 */
function normalizeRunResult(result) {
  if (typeof result === 'string') {
    return { stdout: result, stderr: '', exitCode: 0 };
  }
  const value = record(result);
  const exitCode = value.exitCode == null ? 0 : Number(value.exitCode);
  if (!Number.isInteger(exitCode)) {
    throw new GhClientError('runner', 'GitHub runner returned an invalid exit code');
  }
  return {
    stdout: stringOrEmpty(value.stdout),
    stderr: stringOrEmpty(value.stderr),
    exitCode,
    ...(value.headers == null
      ? {}
      : {
          headers: /** @type {Readonly<Record<string, string | readonly string[] | undefined>>} */ (
            value.headers
          ),
        }),
    ...(typeof value.retryAfter === 'string' || typeof value.retryAfter === 'number'
      ? { retryAfter: value.retryAfter }
      : {}),
    ...(typeof value.rateLimitReset === 'string' || typeof value.rateLimitReset === 'number'
      ? { rateLimitReset: value.rateLimitReset }
      : {}),
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  };
}

/**
 * @param {GhRunResult} result
 * @returns {GhRunResult}
 */
function parseIncludedApiResult(result) {
  let stdout = result.stdout;
  /** @type {Record<string, string>} */
  const parsedHeaders = {};
  let status = typeof result.status === 'number' ? result.status : undefined;

  while (/^HTTP\/\S+\s+\d{3}(?:\s|$)/u.test(stdout)) {
    const separator = stdout.search(/\r?\n\r?\n/u);
    if (separator === -1) {
      break;
    }
    const headerBlock = stdout.slice(0, separator);
    const separatorMatch = stdout.slice(separator).match(/^\r?\n\r?\n/u)?.[0] ?? '';
    stdout = stdout.slice(separator + separatorMatch.length);
    const lines = headerBlock.split(/\r?\n/u);
    const statusMatch = lines[0]?.match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/u);
    if (statusMatch) {
      status = Number(statusMatch[1]);
    }
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) {
        continue;
      }
      parsedHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }

  const headers = /** @type {Record<string, string | readonly string[] | undefined>} */ ({
    ...parsedHeaders,
    ...record(result.headers),
  });
  return {
    ...result,
    stdout,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(status == null ? {} : { status }),
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {GhRunResult} [result]
 * @returns {void}
 */
function assertNoGraphqlErrors(payload, result) {
  const errors = array(payload.errors);
  if (errors.length === 0) {
    return;
  }
  const first = record(errors[0]);
  const message = errorDetail({ message: first.message });
  const graphqlError = new GhClientError('graphql', message || 'GitHub GraphQL request failed');
  Object.defineProperty(graphqlError, 'graphqlErrors', {
    configurable: false,
    enumerable: false,
    value: errors,
    writable: false,
  });
  if (result?.headers != null) {
    Object.defineProperty(graphqlError, 'headers', {
      configurable: false,
      enumerable: false,
      value: result.headers,
      writable: false,
    });
  }
  if (result?.status != null) {
    Object.defineProperty(graphqlError, 'status', {
      configurable: false,
      enumerable: false,
      value: result.status,
      writable: false,
    });
  }
  throw graphqlError;
}

/**
 * @param {unknown} raw
 * @returns {ProjectContext}
 */
function normalizeProject(raw) {
  const project = record(raw);
  const repositories = record(project.repositories);
  const repositoryPageInfo = record(repositories.pageInfo);
  const items = record(project.items);
  const rawItemCount = project.itemCount ?? items.totalCount;
  const itemCount = typeof rawItemCount === 'number'
    && Number.isSafeInteger(rawItemCount)
    && rawItemCount >= 0
    ? rawItemCount
    : null;
  return {
    id: requiredString(project.id, 'project id'),
    number: positiveInteger(project.number, 'project number'),
    title: requiredString(project.title, 'project title'),
    readme: stringOrEmpty(project.readme),
    public: project.public === true,
    ...(typeof project.closed === 'boolean' ? { closed: project.closed } : {}),
    ...(typeof project.url === 'string' ? { url: project.url } : {}),
    linkedRepositoriesKnown:
      project.linkedRepositoriesKnown === true || project.repositories != null,
    linkedRepositoryIds: Array.isArray(project.linkedRepositoryIds)
      ? project.linkedRepositoryIds.filter((id) => typeof id === 'string')
      : array(repositories.nodes)
        .map((rawRepository) => stringOrEmpty(record(rawRepository).id))
        .filter(Boolean),
    linkedRepositoriesHasNextPage: project.linkedRepositoriesHasNextPage === true
      || repositoryPageInfo.hasNextPage === true,
    linkedRepositoriesEndCursor: typeof project.linkedRepositoriesEndCursor === 'string'
      ? project.linkedRepositoriesEndCursor
      : typeof repositoryPageInfo.endCursor === 'string'
        ? repositoryPageInfo.endCursor
        : null,
    itemCount,
  };
}

/**
 * @param {ProjectContext} project
 * @param {string} title
 * @returns {boolean}
 */
function isStrictProjectCreateCandidate(project, title) {
  return project.title === title
    && !project.readme.trim()
    && project.public === false
    && project.closed === false
    && project.linkedRepositoriesKnown === true
    && (project.linkedRepositoryIds?.length ?? 0) === 0
    && project.linkedRepositoriesHasNextPage !== true
    && project.itemCount === 0;
}

/**
 * @param {unknown} raw
 * @returns {ProjectFieldContext | null}
 */
function normalizeField(raw) {
  const field = record(raw);
  if (typeof field.id !== 'string' || typeof field.name !== 'string') {
    return null;
  }
  const dataType = typeof field.dataType === 'string' ? field.dataType : '';
  const options = new Map();
  for (const rawOption of array(field.options)) {
    const option = record(rawOption);
    if (typeof option.id === 'string' && typeof option.name === 'string') {
      options.set(option.name, option.id);
    }
  }
  return {
    id: field.id,
    name: field.name,
    dataType,
    options,
  };
}

/**
 * @param {unknown} raw
 * @returns {ProjectViewContext | null}
 */
function normalizeView(raw) {
  const view = record(raw);
  if (typeof view.id !== 'string' || typeof view.name !== 'string') {
    return null;
  }
  return {
    id: view.id,
    name: view.name,
    layout: stringOrEmpty(view.layout),
    filter: stringOrEmpty(view.filter),
  };
}

/**
 * @param {string} body
 * @returns {string}
 */
function statusFromBody(body) {
  return body.match(/^- Status:\s*`([^`\r\n]+)`\s*$/imu)?.[1]?.trim().toLowerCase() || 'open';
}

/**
 * @param {unknown} rawValues
 * @param {string} issueBody
 * @returns {Record<string, string | number | boolean | null>}
 */
function normalizeProjectItemFields(rawValues, issueBody) {
  /** @type {Record<string, string | number | boolean | null>} */
  const fields = {};

  for (const rawValue of array(record(rawValues).nodes)) {
    const value = record(rawValue);
    const fieldName = stringOrEmpty(record(value.field).name);
    if (fieldName === 'Bead ID' && typeof value.text === 'string') {
      fields.beadId = value.text;
    } else if (fieldName === 'Parent Goal' && typeof value.text === 'string') {
      fields.parentGoal = value.text;
    } else if (fieldName === 'Source Updated' && typeof value.date === 'string') {
      fields.sourceUpdated = value.date;
    } else if (fieldName === 'Priority' && typeof value.name === 'string') {
      const match = value.name.match(/^P([0-4])$/u);
      if (match) {
        fields.priority = Number(match[1]);
      }
    } else if (fieldName === 'Bead Type' && typeof value.name === 'string') {
      fields.type = value.name.toLowerCase();
    } else if (fieldName === 'Status' && typeof value.name === 'string') {
      fields.blocked = value.name === 'Blocked';
      fields.done = value.name === 'Done';
      fields.status = {
        Backlog: 'open',
        Ready: 'ready',
        'In Progress': 'in_progress',
        Blocked: statusFromBody(issueBody),
        Done: 'closed',
      }[value.name] ?? value.name.toLowerCase();
    }
  }

  return fields;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeUrl(value) {
  return typeof value === 'string' ? value.replace(/\/+$/u, '') : '';
}

/**
 * @param {Record<string, unknown>} issue
 * @param {string} context
 * @returns {string}
 */
function issueRepositoryIdentity(issue, context) {
  const fullName = stringOrEmpty(record(issue.repository).full_name);
  if (fullName) {
    return normalizeRepositoryIdentity(fullName, `${context} repository`);
  }
  const repositoryUrl = stringOrEmpty(issue.repository_url);
  if (repositoryUrl) {
    try {
      const segments = new URL(repositoryUrl).pathname.split('/').filter(Boolean);
      const reposIndex = segments.findIndex((segment) => segment.toLowerCase() === 'repos');
      if (reposIndex >= 0 && segments.length === reposIndex + 3) {
        return normalizeRepositoryIdentity(
          `${decodeURIComponent(segments[reposIndex + 1] ?? '')}/${
            decodeURIComponent(segments[reposIndex + 2] ?? '')
          }`,
          `${context} repository`,
        );
      }
    } catch {
      // Fall through to the fail-closed error below.
    }
  }
  fail(`${context} is missing repository identity`);
}

/**
 * @param {unknown} rawIssue
 * @param {string} context
 * @returns {IssueIdentity}
 */
function normalizeIssueIdentity(rawIssue, context) {
  const issue = record(rawIssue);
  return {
    id: positiveInteger(issue.id, `${context} database id`),
    nodeId: requiredString(issue.node_id, `${context} node id`),
    number: positiveInteger(issue.number, `${context} number`),
    repository: issueRepositoryIdentity(issue, context),
  };
}

/**
 * @param {string} body
 * @param {number} issueNumber
 * @param {readonly string[]} issueMarkers
 * @returns {string | null}
 */
function extractBeadId(body, issueNumber, issueMarkers) {
  const markers = [...body.matchAll(markerPattern(
    issueMarkers,
    'bead-id=([^\\r\\n]*?)',
    'gu',
  ))];
  if (markers.length > 1) {
    throw new GhClientError('marker', `Issue #${issueNumber} contains duplicate managed markers`);
  }
  if (markers.length === 0) {
    return null;
  }
  const id = stringOrEmpty(markers[0]?.[1]).trim();
  if (!SAFE_BEAD_ID_PATTERN.test(id)) {
    throw new GhClientError('marker', `Issue #${issueNumber} contains an invalid managed Bead id`);
  }
  return id;
}

/**
 * @param {string} body
 * @param {readonly string[]} markers
 * @returns {string | null}
 */
function extractRenderHash(body, markers) {
  return body.match(markerPattern(markers, 'render-hash=([a-f0-9]{64})'))?.[1] ?? null;
}

/**
 * @param {string} body
 * @returns {string[]}
 */
function labelsFromBody(body) {
  const labels = ['bead'];
  const type = body.match(/^- Type:\s*`(epic|feature|task)`\s*$/imu)?.[1]?.toLowerCase();
  if (type) {
    labels.push(`bead:${type}`);
  }
  const priority = body.match(/^- Priority:\s*P([0-4])\s*$/imu)?.[1];
  if (priority) {
    labels.push(`priority:P${priority}`);
  }
  if (/^- Blocked:\s*yes\s*$/imu.test(body)) {
    labels.push('status:blocked');
  }
  return labels;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function issueLabelNames(value) {
  const labels = [];
  const seen = new Set();
  for (const rawLabel of array(value)) {
    const name = typeof rawLabel === 'string'
      ? rawLabel
      : stringOrEmpty(record(rawLabel).name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    labels.push(name);
  }
  return labels;
}

/**
 * @param {unknown} input
 * @returns {number}
 */
function issueNumberFrom(input) {
  if (typeof input === 'number') {
    return positiveInteger(input, 'issue number');
  }
  const value = record(input);
  return positiveInteger(value.issueNumber ?? value.number, 'issue number');
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalAssignee(value) {
  if (value == null) {
    return null;
  }
  return requiredString(value, 'assignee');
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string[]}
 */
function assigneeLogins(value, fieldName) {
  if (!Array.isArray(value)) {
    fail(`${fieldName} must be an array`);
  }
  const logins = new Set();
  for (const rawAssignee of value) {
    const assignee = record(rawAssignee);
    const login = typeof rawAssignee === 'string'
      ? requiredString(rawAssignee, 'assignee')
      : requiredString(assignee.login, 'assignee login');
    logins.add(login);
  }
  return [...logins].sort();
}

/**
 * @param {Record<string, unknown>} operation
 * @returns {string[] | undefined}
 */
function operationAssignees(operation) {
  if (operation.assignees !== undefined) {
    return assigneeLogins(operation.assignees, 'assignees');
  }
  if (operation.assignee !== undefined) {
    const assignee = optionalAssignee(operation.assignee);
    return assignee == null ? [] : [assignee];
  }
  return undefined;
}

/**
 * @param {readonly {name: string}[]} expected
 * @param {ReadonlyMap<string, string>} actual
 * @returns {boolean}
 */
function optionNamesMatch(expected, actual) {
  return expected.length === actual.size
    && expected.every((option) => actual.has(option.name));
}

/**
 * @param {unknown} rawFields
 * @returns {Map<string, ProjectFieldContext>}
 */
function normalizeFieldMap(rawFields) {
  if (!(rawFields instanceof Map)) {
    fail('field context must be a Map');
  }
  const result = new Map();
  for (const [name, rawField] of rawFields.entries()) {
    const value = record(rawField);
    const options = value.options instanceof Map
      ? new Map(value.options)
      : new Map(Object.entries(record(value.options)).map(([optionName, optionId]) => [
        optionName,
        requiredString(optionId, `${name} option id`),
      ]));
    result.set(name, {
      id: requiredString(value.id, `${name} field id`),
      name: requiredString(value.name ?? name, `${name} field name`),
      dataType: requiredString(value.dataType, `${name} field data type`),
      options,
    });
  }
  return result;
}

/**
 * @param {{
 *   run: GhRun,
 *   owner: string,
 *   repo: string,
 *   token: string,
 *   projectNodeId?: string,
 *   bootstrap?: boolean,
 *   projectMarker?: string,
 *   issueMarker?: string,
 *   legacyProjectMarkers?: readonly string[],
 *   legacyIssueMarkers?: readonly string[],
 *   sleep?: (milliseconds: number) => void | Promise<void>,
 *   now?: () => number,
 *   maxRetryWaitMs?: number,
 * }} options
 */
export function createGhClient(options) {
  if (typeof options !== 'object' || options == null) {
    fail('createGhClient requires options');
  }
  if (typeof options.run !== 'function') {
    fail('createGhClient requires an execFile-style run function');
  }
  const run = options.run;
  const owner = requiredString(options.owner, 'owner');
  const repo = requiredString(options.repo, 'repo');
  const repositoryIdentity = normalizeRepositoryIdentity(
    `${owner}/${repo}`,
    'repository identity',
  );
  const token = requiredString(options.token, 'token');
  const projectNodeId = options.projectNodeId == null
    ? null
    : requiredString(options.projectNodeId, 'projectNodeId');
  if (projectNodeId != null && !PROJECT_NODE_ID_PATTERN.test(projectNodeId)) {
    fail('projectNodeId must be a GitHub ProjectV2 node ID beginning with "PVT_"');
  }
  const bootstrap = options.bootstrap === true;
  if (options.bootstrap != null && options.bootstrap !== true && options.bootstrap !== false) {
    fail('bootstrap must be a boolean when present');
  }
  if (projectNodeId != null && bootstrap) {
    fail('projectNodeId and bootstrap mode cannot be combined');
  }
  /** @type {(milliseconds: number) => void | Promise<void>} */
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxRetryWaitMs = options.maxRetryWaitMs == null
    ? MAX_RETRY_DELAY_MS
    : (
      typeof options.maxRetryWaitMs === 'number'
      && Number.isFinite(options.maxRetryWaitMs)
      && options.maxRetryWaitMs >= 0
        ? options.maxRetryWaitMs
        : fail('maxRetryWaitMs must be a non-negative finite number')
    );
  const projectMarker = normalizeMarker(
    options.projectMarker ?? DEFAULT_PROJECT_MARKER,
    'projectMarker',
  );
  const issueMarker = normalizeMarker(
    options.issueMarker ?? DEFAULT_ISSUE_MARKER,
    'issueMarker',
  );
  const recognizedProjectMarkerValues = recognizedProjectMarkers(
    projectMarker,
    options.legacyProjectMarkers,
    'projectMarker',
  );
  const recognizedIssueMarkerValues = recognizedMarkers(
    issueMarker,
    options.legacyIssueMarkers ?? LEGACY_ISSUE_MARKERS,
    'issueMarker',
  );
  const currentProjectReadmeMarker = projectReadmeMarker(projectMarker, repositoryIdentity);
  if (!SAFE_OWNER_REPO_PATTERN.test(owner) || !SAFE_OWNER_REPO_PATTERN.test(repo)) {
    fail('owner and repo must be safe GitHub path segments');
  }

  /** @type {ProjectContext | null} */
  let projectContext = null;
  /** @type {Map<string, ProjectFieldContext>} */
  let fieldContext = new Map();
  /** @type {string | null} */
  let organizationId = null;
  /** @type {string | null} */
  let repositoryId = null;
  let repositoryDefaultBranch = 'main';
  /** @type {Map<number, number>} */
  const issueDatabaseIds = new Map();
  /** @type {ProjectContext[]} */
  let lastDiscoveredProjects = [];
  let projectDiscoveryComplete = false;
  /** @type {Record<string, unknown>[] | null} */
  let projectItemsCache = null;

  /**
   * @param {ProjectContext | null} project
   * @returns {void}
   */
  function rememberProject(project) {
    if (projectContext?.id !== project?.id) {
      projectItemsCache = null;
    }
    projectContext = project;
    if (!project) {
      return;
    }
    const index = lastDiscoveredProjects.findIndex((candidate) => candidate.id === project.id);
    if (index === -1) {
      lastDiscoveredProjects.push(project);
    } else {
      lastDiscoveredProjects[index] = project;
    }
  }

  /**
   * @param {Record<string, unknown>} issue
   * @returns {boolean}
   */
  function isTrustedManagedIssue(issue) {
    const association = stringOrEmpty(issue.author_association).toUpperCase();
    return TRUSTED_AUTHOR_ASSOCIATIONS.has(association);
  }

  /**
   * @template TValue
   * @param {() => Promise<TValue>} action
   * @returns {Promise<TValue>}
   */
  async function withRetry(action) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (
          (!isRetryable(error) && !isTransportFailure(error))
          || attempt === MAX_ATTEMPTS - 1
        ) {
          throw toClientError(error);
        }
        await sleep(retryWaitMilliseconds(error, attempt, now(), maxRetryWaitMs));
      }
    }
    throw new GhClientError('github', 'GitHub request exhausted retries');
  }

  /**
   * @param {readonly string[]} args
   * @param {string | undefined} stdin
   * @returns {Promise<GhRunResult>}
   */
  async function runGhOnce(args, stdin) {
    const runOptions = {
      env: { GH_TOKEN: token },
      ...(stdin === undefined ? {} : { stdin }),
    };
    const result = args[0] === 'api'
      ? parseIncludedApiResult(normalizeRunResult(await run('gh', args, runOptions)))
      : normalizeRunResult(await run('gh', args, runOptions));
    if ((result.exitCode ?? 0) !== 0) {
      throw Object.assign(
        new Error(result.stderr || `GitHub command exited with code ${result.exitCode}`),
        {
          exitCode: result.exitCode,
          status: result.status,
          stderr: result.stderr,
          ...('headers' in result ? { headers: result.headers } : {}),
          ...('retryAfter' in result ? { retryAfter: result.retryAfter } : {}),
          ...('rateLimitReset' in result ? { rateLimitReset: result.rateLimitReset } : {}),
        },
      );
    }
    return result;
  }

  /**
   * Safe reads and exact-value updates may retry because repeating them cannot
   * create a second GitHub resource or relationship.
   *
   * @param {readonly string[]} args
   * @param {string | undefined} [stdin]
   * @returns {Promise<GhRunResult>}
   */
  async function runGh(args, stdin) {
    return withRetry(() => runGhOnce(args, stdin));
  }

  /**
   * @param {'GET' | 'POST' | 'PATCH' | 'DELETE'} method
   * @param {string} endpoint
   * @param {Record<string, unknown> | undefined} [body]
   * @returns {Promise<unknown>}
   */
  async function rest(method, endpoint, body) {
    const args = [
      'api',
      endpoint,
      '--method',
      method,
      ...API_HEADERS,
      ...(body === undefined ? [] : ['--input', '-']),
    ];
    const execute = method === 'POST' || method === 'DELETE' ? runGhOnce : runGh;
    try {
      const result = await execute(
        args,
        body === undefined ? undefined : `${JSON.stringify(body)}\n`,
      );
      return parseJson(result.stdout, `${method} ${endpoint}`);
    } catch (error) {
      throw toClientError(error);
    }
  }

  /**
   * @template TValue
   * @param {string} description
   * @param {() => Promise<TValue>} mutate
   * @param {() => Promise<TValue | null>} reread
   * @returns {Promise<TValue>}
   */
  async function ambiguousMutation(description, mutate, reread) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await mutate();
      } catch (error) {
        if (isDefiniteRateLimit(error)) {
          if (attempt === MAX_ATTEMPTS - 1) {
            throw toClientError(error);
          }
          await sleep(retryWaitMilliseconds(error, attempt, now(), maxRetryWaitMs));
          continue;
        }

        if (!isRetryable(error) && !isTransportFailure(error)) {
          throw toClientError(error);
        }

        try {
          const applied = await reread();
          if (applied != null) {
            return applied;
          }
        } catch {
          throw new GhClientError(
            'ambiguous',
            `${description} may have succeeded, but its identity could not be verified`,
            errorStatus(error),
          );
        }

        throw new GhClientError(
          'ambiguous',
          `${description} may have succeeded, but no matching identity was found`,
          errorStatus(error),
        );
      }
    }
    throw new GhClientError('github', `${description} exhausted retries`);
  }

  /**
   * @template TValue
   * @param {string} description
   * @param {() => Promise<TValue>} mutate
   * @param {() => Promise<unknown | null>} reread
   * @returns {Promise<TValue | null>}
   */
  async function idempotentRelationshipDelete(description, mutate, reread) {
    try {
      return await mutate();
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        return null;
      }

      const kind = /** @type {ErrorLike} */ (error ?? {}).kind;
      if (!isRetryable(error) && !isTransportFailure(error) && kind !== 'ambiguous') {
        throw toClientError(error);
      }

      try {
        if (await reread() == null) {
          return null;
        }
      } catch {
        throw new GhClientError(
          'ambiguous',
          `${description} may have succeeded, but the relationship could not be verified`,
          status,
        );
      }

      throw new GhClientError(
        'ambiguous',
        `${description} failed ambiguously and the relationship is still present`,
        status,
      );
    }
  }

  /**
   * @param {string} endpoint
   * @returns {Promise<unknown | null>}
   */
  async function getOrNull(endpoint) {
    try {
      return await rest('GET', endpoint);
    } catch (error) {
      if (errorStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @returns {Promise<Record<string, unknown>>}
   */
  async function graphqlOnce(query, variables) {
    const result = parseIncludedApiResult(normalizeRunResult(
      await run('gh', ['api', 'graphql', '--include', '--input', '-'], {
        env: { GH_TOKEN: token },
        stdin: `${JSON.stringify({ query, variables })}\n`,
      }),
    ));
    if ((result.exitCode ?? 0) !== 0) {
      throw Object.assign(
        new Error(result.stderr || `GitHub GraphQL command exited with code ${result.exitCode}`),
        {
          exitCode: result.exitCode,
          status: result.status,
          stderr: result.stderr,
          ...('headers' in result ? { headers: result.headers } : {}),
          ...('retryAfter' in result ? { retryAfter: result.retryAfter } : {}),
          ...('rateLimitReset' in result ? { rateLimitReset: result.rateLimitReset } : {}),
        },
      );
    }
    const payload = parseJsonObject(result.stdout, 'GitHub GraphQL');
    assertNoGraphqlErrors(payload, result);
    return payload;
  }

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @returns {Promise<Record<string, unknown>>}
   */
  async function graphql(query, variables) {
    return withRetry(() => graphqlOnce(query, variables));
  }

  /**
   * @returns {ProjectContext}
   */
  function requireProject() {
    if (!projectContext) {
      fail('A managed GitHub Project must be discovered or ensured first');
    }
    return projectContext;
  }

  /**
   * @returns {Promise<{organization: Record<string, unknown>, repository: Record<string, unknown>}>}
   */
  async function verifyAccess() {
    await runGh(['auth', 'status', '--hostname', 'github.com', '--active']);
    const repository = record(await rest('GET', `repos/${owner}/${repo}`));
    const organization = record(await rest('GET', `orgs/${owner}`));
    if (
      typeof repository.default_branch === 'string'
      && SAFE_BEAD_ID_PATTERN.test(repository.default_branch)
    ) {
      repositoryDefaultBranch = repository.default_branch;
    }
    return { organization, repository };
  }

  /**
   * @param {unknown} value
   * @param {string} fieldName
   * @returns {string}
   */
  function lockIdentity(value, fieldName) {
    const identity = requiredString(value, fieldName);
    if (!SAFE_LOCK_IDENTITY_PATTERN.test(identity)) {
      fail(`${fieldName} contains unsupported characters`);
    }
    return identity;
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  function lockTtl(value) {
    if (value == null) {
      return DEFAULT_APPLY_LOCK_TTL_MS;
    }
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value <= 0
      || value > MAX_APPLY_LOCK_TTL_MS
    ) {
      fail(`apply lock ttlMs must be an integer from 1 to ${MAX_APPLY_LOCK_TTL_MS}`);
    }
    return value;
  }

  /**
   * @param {ApplyLockState} state
   * @returns {string}
   */
  function renderApplyLockMessage(state) {
    return `${APPLY_LOCK_MESSAGE_PREFIX}${JSON.stringify(state)}`;
  }

  /**
   * @param {unknown} value
   * @param {string} fieldName
   * @returns {number}
   */
  function lockTimestamp(value, fieldName) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new GhClientError('lock', `GitHub apply lock has an invalid ${fieldName}`);
    }
    return value;
  }

  /**
   * @param {unknown} message
   * @returns {ApplyLockState}
   */
  function parseApplyLockMessage(message) {
    const text = requiredString(message, 'apply lock commit message');
    if (!text.startsWith(APPLY_LOCK_MESSAGE_PREFIX)) {
      throw new GhClientError('lock', 'GitHub apply lock contains an unrecognized state');
    }
    /** @type {Record<string, unknown>} */
    let parsed;
    try {
      parsed = record(JSON.parse(text.slice(APPLY_LOCK_MESSAGE_PREFIX.length)));
    } catch {
      throw new GhClientError('lock', 'GitHub apply lock contains invalid JSON');
    }
    if (
      parsed.version !== 1
      || (parsed.state !== 'acquired' && parsed.state !== 'released')
    ) {
      throw new GhClientError('lock', 'GitHub apply lock contains an unsupported state');
    }
    return {
      version: 1,
      state: parsed.state,
      owner: lockIdentity(parsed.owner, 'apply lock owner'),
      runId: lockIdentity(parsed.runId, 'apply lock runId'),
      leaseId: lockIdentity(parsed.leaseId, 'apply lock leaseId'),
      acquiredAt: lockTimestamp(parsed.acquiredAt, 'acquiredAt'),
      expiresAt: lockTimestamp(parsed.expiresAt, 'expiresAt'),
    };
  }

  /**
   * @returns {Promise<ApplyLockHandle | null>}
   */
  async function readApplyLock() {
    const rawRef = await getOrNull(
      `repos/${owner}/${repo}/git/ref/${APPLY_LOCK_REF_ENDPOINT}`,
    );
    if (rawRef == null) {
      return null;
    }
    const ref = record(rawRef);
    const sha = requiredString(record(ref.object).sha, 'apply lock ref sha');
    const commit = record(await rest(
      'GET',
      `repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`,
    ));
    const state = parseApplyLockMessage(commit.message);
    return {
      ...state,
      ref: APPLY_LOCK_REF,
      sha,
      treeSha: requiredString(record(commit.tree).sha, 'apply lock tree sha'),
    };
  }

  /**
   * @param {ApplyLockState} state
   * @param {string} parentSha
   * @param {string} treeSha
   * @returns {Promise<string>}
   */
  async function createApplyLockCommit(state, parentSha, treeSha) {
    const created = record(await ambiguousMutation(
      `GitHub apply lock state commit for "${state.leaseId}"`,
      () => rest('POST', `repos/${owner}/${repo}/git/commits`, {
        message: renderApplyLockMessage(state),
        tree: treeSha,
        parents: [parentSha],
      }),
      async () => null,
    ));
    return requiredString(created.sha, 'apply lock commit sha');
  }

  /**
   * @param {string} sha
   * @param {string} leaseId
   * @returns {Promise<void>}
   */
  async function createApplyLockRef(sha, leaseId) {
    try {
      await ambiguousMutation(
        `GitHub apply lock acquisition for "${leaseId}"`,
        () => rest('POST', `repos/${owner}/${repo}/git/refs`, {
          ref: APPLY_LOCK_REF,
          sha,
        }),
        async () => {
          const current = await readApplyLock();
          return current?.sha === sha ? {} : null;
        },
      );
    } catch (error) {
      if (errorStatus(error) !== 422) {
        throw error;
      }
      const current = await readApplyLock();
      if (current?.sha === sha) {
        return;
      }
      throw new GhClientError(
        'lock',
        `GitHub apply lock contention: lock is held by ${current?.owner ?? 'another contender'}`
          + `${current?.runId ? ` (${current.runId})` : ''}`,
        409,
      );
    }
  }

  /**
   * @param {string} sha
   * @param {string} leaseId
   * @returns {Promise<void>}
   */
  async function updateApplyLockRef(sha, leaseId) {
    try {
      await ambiguousMutation(
        `GitHub apply lock update for "${leaseId}"`,
        () => rest(
          'PATCH',
          `repos/${owner}/${repo}/git/refs/${APPLY_LOCK_REF_ENDPOINT}`,
          { sha, force: false },
        ),
        async () => {
          const current = await readApplyLock();
          return current?.sha === sha ? {} : null;
        },
      );
    } catch (error) {
      if (errorStatus(error) !== 422) {
        throw error;
      }
      const current = await readApplyLock();
      if (current?.sha === sha) {
        return;
      }
      throw new GhClientError(
        'lock',
        `GitHub apply lock contention: lock is held by ${current?.owner ?? 'another contender'}`
          + `${current?.runId ? ` (${current.runId})` : ''}`,
        409,
      );
    }
  }

  /**
   * @param {{
   *   owner: string,
   *   runId: string,
   *   leaseId: string,
   *   ttlMs?: number,
   * }} input
   * @returns {Promise<ApplyLockHandle>}
   */
  async function acquireApplyLock(input) {
    const lockOwner = lockIdentity(input?.owner, 'apply lock owner');
    const runId = lockIdentity(input?.runId, 'apply lock runId');
    const leaseId = lockIdentity(input?.leaseId, 'apply lock leaseId');
    const ttlMs = lockTtl(input?.ttlMs);
    const acquiredAt = now();
    const state = /** @type {ApplyLockState} */ ({
      version: 1,
      state: 'acquired',
      owner: lockOwner,
      runId,
      leaseId,
      acquiredAt,
      expiresAt: acquiredAt + ttlMs,
    });
    const current = await readApplyLock();
    if (current?.state === 'acquired' && current.expiresAt > acquiredAt) {
      throw new GhClientError(
        'lock',
        `GitHub apply lock is held by ${current.owner} (${current.runId}) until `
          + new Date(current.expiresAt).toISOString(),
        409,
      );
    }

    let parentSha;
    let treeSha;
    if (current) {
      parentSha = current.sha;
      treeSha = current.treeSha;
    } else {
      const base = record(await rest(
        'GET',
        `repos/${owner}/${repo}/git/commits/${encodeURIComponent(repositoryDefaultBranch)}`,
      ));
      parentSha = requiredString(base.sha, 'apply lock base commit sha');
      treeSha = requiredString(record(base.tree).sha, 'apply lock base tree sha');
    }

    const sha = await createApplyLockCommit(state, parentSha, treeSha);
    if (current) {
      await updateApplyLockRef(sha, leaseId);
    } else {
      await createApplyLockRef(sha, leaseId);
    }
    return {
      ...state,
      ref: APPLY_LOCK_REF,
      sha,
      treeSha,
    };
  }

  /**
   * @param {ApplyLockHandle} handle
   * @returns {Promise<void>}
   */
  async function releaseApplyLock(handle) {
    const lockOwner = lockIdentity(handle?.owner, 'apply lock owner');
    const runId = lockIdentity(handle?.runId, 'apply lock runId');
    const leaseId = lockIdentity(handle?.leaseId, 'apply lock leaseId');
    const current = await readApplyLock();
    if (
      current?.state === 'released'
      && current.owner === lockOwner
      && current.runId === runId
      && current.leaseId === leaseId
    ) {
      return;
    }
    if (
      current == null
      || current.state !== 'acquired'
      || current.sha !== handle.sha
      || current.owner !== lockOwner
      || current.runId !== runId
      || current.leaseId !== leaseId
    ) {
      throw new GhClientError(
        'lock',
        'GitHub apply lock release refused because ownership could not be proven',
        409,
      );
    }

    const released = /** @type {ApplyLockState} */ ({
      ...current,
      state: 'released',
      expiresAt: now(),
    });
    const sha = await createApplyLockCommit(released, current.sha, current.treeSha);
    await updateApplyLockRef(sha, leaseId);
  }

  /**
   * @returns {Promise<unknown[]>}
   */
  async function listRepositoryIssues() {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const pageItems = array(await rest(
        'GET',
        `repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
      ));
      issues.push(...pageItems);
      if (pageItems.length < 100) {
        return issues;
      }
    }
  }

  /**
   * @param {string} beadId
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function findIssueByBeadId(beadId) {
    const matches = [];
    for (const rawIssue of await listRepositoryIssues()) {
      const issue = record(rawIssue);
      if (issue.pull_request != null) {
        continue;
      }
      if (!isTrustedManagedIssue(issue)) {
        continue;
      }
      const number = positiveInteger(issue.number, 'issue number');
      if (extractBeadId(stringOrEmpty(issue.body), number, recognizedIssueMarkerValues) === beadId) {
        matches.push(issue);
      }
    }
    if (matches.length > 1) {
      throw new GhClientError('marker', `Duplicate managed Bead id "${beadId}"`);
    }
    return matches[0] ?? null;
  }

  /**
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async function listProjectItems(forceRefresh = false) {
    if (!forceRefresh && projectItemsCache) {
      return [...projectItemsCache];
    }
    const project = requireProject();
    const items = [];
    let cursor = null;

    for (;;) {
      const payload = await graphql(DISCOVER_ITEMS_QUERY, {
        projectId: project.id,
        cursor,
      });
      const data = record(payload.data);
      const node = record(data.node);
      const connection = record(node.items);
      for (const rawItem of array(connection.nodes)) {
        items.push(record(rawItem));
      }
      const pageInfo = record(connection.pageInfo);
      if (pageInfo.hasNextPage !== true) {
        projectItemsCache = items;
        return [...items];
      }
      cursor = requiredString(pageInfo.endCursor, 'project item page cursor');
    }
  }

  /**
   * @param {string} issueUrl
   * @param {boolean} [forceRefresh]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function findProjectItemByIssueUrl(issueUrl, forceRefresh = false) {
    const normalizedIssueUrl = normalizeUrl(issueUrl);
    const matches = (await listProjectItems(forceRefresh)).filter((rawItem) =>
      normalizeUrl(record(record(rawItem).content).url) === normalizedIssueUrl);
    if (matches.length > 1) {
      throw new GhClientError('project', `Issue "${normalizedIssueUrl}" has multiple Project items`);
    }
    return matches[0] ?? null;
  }

  /**
   * @param {number} issueNumber
   * @returns {Promise<IssueIdentity[]>}
   */
  async function listBlockerIssues(issueNumber) {
    const blockers = [];
    for (let page = 1; ; page += 1) {
      const pageItems = array(await rest(
        'GET',
        `repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by?per_page=100&page=${page}`,
      ));
      for (const rawBlocker of pageItems) {
        blockers.push(normalizeIssueIdentity(rawBlocker, 'blocker issue'));
      }
      if (pageItems.length < 100) {
        const byNodeId = new Map(blockers.map((blocker) => [blocker.nodeId, blocker]));
        return [...byNodeId.values()].sort((left, right) =>
          left.repository.localeCompare(right.repository) || left.number - right.number
        );
      }
    }
  }

  /**
   * @param {string} endpoint
   * @param {number} databaseId
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function findIssueInConnection(endpoint, databaseId) {
    const matches = [];
    for (let page = 1; ; page += 1) {
      const pageItems = array(await rest(
        'GET',
        `${endpoint}?per_page=100&page=${page}`,
      ));
      for (const rawIssue of pageItems) {
        const issue = record(rawIssue);
        if (issue.id === databaseId) {
          matches.push(issue);
        }
      }
      if (pageItems.length < 100) {
        break;
      }
    }
    if (matches.length > 1) {
      throw new GhClientError('relationship', `GitHub returned duplicate issue id ${databaseId}`);
    }
    return matches[0] ?? null;
  }

  /**
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async function listManagedIssues() {
    const rawIssues = await listRepositoryIssues();
    /** @type {Array<{
     *   beadId: string,
     *   number: number,
     *   issueNodeId?: string,
     *   title: string | null,
     *   body: string | null,
     *   state: string,
     *   assignees: string[],
     *   labels: string[],
     *   renderHash: string | null,
     *   projectItem: {
     *     id: string,
     *     archived: boolean,
     *     fields: Record<string, string | number | boolean | null>,
     *   } | null,
     *   parentIssueNumber: number | null,
     *   blockerIssueNumbers: number[],
     *   parentIssue: IssueIdentity | null,
     *   blockerIssues: IssueIdentity[],
     *   repository: string,
     *   url?: string,
     * }>} */
    const managed = [];
    const seen = new Map();

    for (const rawIssue of rawIssues) {
      const issue = record(rawIssue);
      if (issue.pull_request != null) {
        continue;
      }
      if (!isTrustedManagedIssue(issue)) {
        continue;
      }
      const number = positiveInteger(issue.number, 'issue number');
      const body = stringOrEmpty(issue.body);
      const beadId = extractBeadId(body, number, recognizedIssueMarkerValues);
      if (beadId == null) {
        continue;
      }
      const priorIssueNumber = seen.get(beadId);
      if (priorIssueNumber != null) {
        throw new GhClientError(
          'marker',
          `Duplicate managed Bead id "${beadId}" on issues #${priorIssueNumber} and #${number}`,
        );
      }
      seen.set(beadId, number);

      const assignees = assigneeLogins(array(issue.assignees), 'issue assignees');
      const renderHash = extractRenderHash(body, recognizedIssueMarkerValues);
      managed.push({
        beadId,
        number,
        ...(typeof issue.id === 'number' ? { issueDatabaseId: positiveInteger(issue.id, 'issue database id') } : {}),
        ...(typeof issue.node_id === 'string' ? { issueNodeId: issue.node_id } : {}),
        title: typeof issue.title === 'string' ? issue.title : null,
        body: typeof issue.body === 'string' ? issue.body : null,
        state: typeof issue.state === 'string' ? issue.state : 'open',
        assignees,
        labels: issueLabelNames(issue.labels),
        renderHash,
        projectItem: null,
        parentIssueNumber: null,
        blockerIssueNumbers: [],
        parentIssue: null,
        blockerIssues: [],
        repository: repositoryIdentity,
        ...(typeof issue.html_url === 'string' ? { url: issue.html_url } : {}),
      });
    }

    if (!projectContext) {
      if (projectNodeId != null || bootstrap) {
        await discoverProject();
      } else {
        await discoverProjects();
      }
    }

    if (projectContext) {
      const byNodeId = new Map();
      const byUrl = new Map();
      for (const rawItem of await listProjectItems()) {
        const item = record(rawItem);
        const content = record(item.content);
        const nodeId = stringOrEmpty(content.id);
        const url = normalizeUrl(content.url);
        if (!nodeId && !url) {
          continue;
        }
        if ((nodeId && byNodeId.has(nodeId)) || (url && byUrl.has(url))) {
          throw new GhClientError('project', 'A managed issue has multiple GitHub Project items');
        }
        if (nodeId) {
          byNodeId.set(nodeId, item);
        }
        if (url) {
          byUrl.set(url, item);
        }
      }

      for (const issue of managed) {
        const item = (issue.issueNodeId ? byNodeId.get(issue.issueNodeId) : null)
          ?? (issue.url ? byUrl.get(normalizeUrl(issue.url)) : null);
        if (item) {
          issue.projectItem = {
            id: requiredString(item.id, 'project item id'),
            archived: item.isArchived === true,
            fields: normalizeProjectItemFields(record(item.fieldValues), issue.body ?? ''),
          };
        }
      }
    }

    for (const issue of managed) {
      const rawParent = await getOrNull(
        `repos/${owner}/${repo}/issues/${issue.number}/parent`,
      );
      issue.parentIssue = rawParent == null
        ? null
        : normalizeIssueIdentity(rawParent, 'parent issue');
      issue.parentIssueNumber = issue.parentIssue?.number ?? null;
      issue.blockerIssues = await listBlockerIssues(issue.number);
      issue.blockerIssueNumbers = issue.blockerIssues.map((blocker) => blocker.number);
    }

    return managed;
  }

  /**
   * @returns {Promise<readonly {name: string, color: string, description: string}[]>}
   */
  async function ensureLabels() {
    const existing = new Set();
    for (let page = 1; ; page += 1) {
      const labels = array(await rest(
        'GET',
        `repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
      ));
      for (const rawLabel of labels) {
        const label = record(rawLabel);
        if (typeof label.name === 'string') {
          existing.add(label.name);
        }
      }
      if (labels.length < 100) {
        break;
      }
    }

    for (const label of REQUIRED_LABELS) {
      if (!existing.has(label.name)) {
        const labelEndpoint = `repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`;
        await ambiguousMutation(
          `Label create for "${label.name}"`,
          () => rest('POST', `repos/${owner}/${repo}/labels`, { ...label }),
          () => getOrNull(labelEndpoint),
        );
      }
    }
    return REQUIRED_LABELS;
  }

  /**
   * @returns {Promise<ProjectContext[]>}
   */
  async function discoverProjects(forceRefresh = false) {
    if (!forceRefresh && projectDiscoveryComplete) {
      return [...lastDiscoveredProjects];
    }
    const projectsFound = [];
    let cursor = null;

    for (;;) {
      const payload = await graphql(DISCOVER_PROJECTS_QUERY, { owner, repo, cursor });
      const data = record(payload.data);
      const organization = record(data.organization);
      const repository = record(data.repository);
      const projects = record(organization.projectsV2);
      const pageInfo = record(projects.pageInfo);

      if (typeof organization.id === 'string') {
        organizationId = organization.id;
      }
      if (typeof repository.id === 'string') {
        repositoryId = repository.id;
      }

      for (const rawProject of array(projects.nodes)) {
        projectsFound.push(normalizeProject(rawProject));
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }
      cursor = requiredString(pageInfo.endCursor, 'project page cursor');
    }

    lastDiscoveredProjects = projectsFound;
    projectDiscoveryComplete = true;
    return [...projectsFound];
  }

  /**
   * @returns {Promise<ProjectContext | null>}
   */
  async function discoverProject() {
    const projects = await discoverProjects();
    if (projectNodeId != null) {
      const project = projects.find((candidate) => candidate.id === projectNodeId) ?? null;
      if (!project) {
        rememberProject(null);
        return null;
      }
      const markers = extractProjectReadmeMarkers(
        project.readme,
        recognizedProjectMarkerValues,
      );
      if (markers.length > 1) {
        throw new GhClientError(
          'ownership',
          `Pinned GitHub Project ${projectNodeId} (#${project.number}) contains duplicate `
            + 'managed README markers; refusing to adopt or repair it.',
        );
      }
      const marker = markers[0];
      if (
        marker?.repository != null
        && marker.repository.toLowerCase() !== repositoryIdentity.toLowerCase()
      ) {
        throw new GhClientError(
          'ownership',
          `Pinned GitHub Project ${projectNodeId} (#${project.number}) is marked for `
            + `${marker.repository}, not ${repositoryIdentity}; refusing to adopt or repair it.`,
        );
      }
      const hasRepositoryMarker =
        marker?.repository?.toLowerCase() === repositoryIdentity.toLowerCase();
      if (!hasRepositoryMarker && !await isProjectLinkedToRepository(project)) {
        throw new GhClientError(
          'ownership',
          `Pinned GitHub Project ${projectNodeId} (#${project.number}) has neither the `
            + `repository-bound managed README marker nor a link to ${repositoryIdentity}; `
            + 'refusing to adopt or repair it.',
        );
      }
      if (!project.public) {
        throw new GhClientError(
          'visibility',
          `Pinned GitHub Project ${projectNodeId} (#${project.number}) is private; `
            + 'manual maintainer review and a manual Project visibility change to public are '
            + 'required before rerunning. Automatic visibility changes are disabled.',
        );
      }
      rememberProject(project);
      return projectContext;
    }

    if (!bootstrap) {
      throw new GhClientError(
        'validation',
        'Project discovery requires an immutable projectNodeId or explicit bootstrap mode',
      );
    }

    for (const project of projects) {
      const markers = extractProjectReadmeMarkers(
        project.readme,
        recognizedProjectMarkerValues,
      );
      if (markers.length > 1) {
        throw new GhClientError(
          'marker',
          `GitHub Project #${project.number} contains duplicate managed README markers`,
        );
      }
      const marker = markers[0];
      if (
        marker?.repository?.toLowerCase() === repositoryIdentity.toLowerCase()
        || (marker?.repository == null && marker != null && await isProjectLinkedToRepository(project))
      ) {
        throw new GhClientError(
          'ownership',
          `Existing marked Project #${project.number} (${project.id}) cannot be adopted in `
            + 'bootstrap mode. A maintainer must review it and pin its immutable node ID.',
        );
      }
    }
    rememberProject(null);
    return null;
  }

  /**
   * @param {string | ProjectContext} projectInput
   * @returns {Promise<boolean>}
   */
  async function isProjectLinkedToRepository(projectInput) {
    if (!repositoryId) {
      throw new GhClientError('permission', 'Unable to resolve repository access');
    }
    const project = typeof projectInput === 'string' ? null : projectInput;
    const projectId = typeof projectInput === 'string' ? projectInput : projectInput.id;
    if (project?.linkedRepositoryIds?.includes(repositoryId)) {
      return true;
    }
    if (project?.linkedRepositoriesKnown && !project.linkedRepositoriesHasNextPage) {
      return false;
    }
    let cursor = project?.linkedRepositoriesKnown
      ? project.linkedRepositoriesEndCursor ?? null
      : null;
    for (;;) {
      const payload = await graphql(DISCOVER_LINKED_REPOSITORIES_QUERY, {
        projectId,
        cursor,
      });
      const connection = record(record(record(payload.data).node).repositories);
      if (array(connection.nodes).some((rawRepository) => record(rawRepository).id === repositoryId)) {
        return true;
      }
      const pageInfo = record(connection.pageInfo);
      if (pageInfo.hasNextPage !== true) {
        return false;
      }
      cursor = requiredString(pageInfo.endCursor, 'linked repository page cursor');
    }
  }

  /**
   * @param {ProjectContext} project
   * @returns {Promise<void>}
   */
  async function ensureProjectLinked(project) {
    if (!repositoryId) {
      throw new GhClientError('permission', 'Unable to resolve repository access');
    }
    if (await isProjectLinkedToRepository(project)) {
      return;
    }
    await ambiguousMutation(
      `Repository link for Project "${project.id}"`,
      () => graphqlOnce(LINK_PROJECT_MUTATION, {
        projectId: project.id,
        repositoryId,
      }),
      async () => await isProjectLinkedToRepository(project.id) ? {} : null,
    );
  }

  /**
   * @param {{title: string, readme: string}} input
   * @returns {Promise<ProjectContext>}
   */
  async function ensureProject(input) {
    const title = requiredString(input?.title, 'project title');
    const readme = requiredString(input?.readme, 'project README');
    if (!readme.includes(currentProjectReadmeMarker)) {
      fail('project README must contain the managed marker');
    }

    const existing = await discoverProject();
    if (existing) {
      if (existing.title !== title || existing.readme !== readme) {
        const updatedPayload = await graphql(UPDATE_PROJECT_MUTATION, {
          projectId: existing.id,
          title,
          readme,
        });
        const updatedData = record(record(updatedPayload.data).updateProjectV2);
        rememberProject({
          ...existing,
          ...normalizeProject(updatedData.projectV2),
          linkedRepositoriesKnown: existing.linkedRepositoriesKnown,
          linkedRepositoryIds: existing.linkedRepositoryIds,
          linkedRepositoriesHasNextPage: existing.linkedRepositoriesHasNextPage,
          linkedRepositoriesEndCursor: existing.linkedRepositoriesEndCursor,
          itemCount: existing.itemCount,
        });
      }
      await ensureProjectLinked(requireProject());
      return requireProject();
    }

    if (projectNodeId != null) {
      throw new GhClientError(
        'ownership',
        `Pinned GitHub Project ${projectNodeId} was not found in ${owner}; `
          + 'review .github/beads-project-sync.json and the Project ownership before rerunning.',
      );
    }
    if (!bootstrap) {
      throw new GhClientError(
        'validation',
        'Fresh Project provisioning requires explicit bootstrap mode',
      );
    }

    if (!organizationId || !repositoryId) {
      throw new GhClientError('permission', 'Unable to resolve organization or repository access');
    }
    const preCreateProjectIds = new Set(lastDiscoveredProjects.map((project) => project.id));
    const preexistingCandidates = lastDiscoveredProjects.filter((project) =>
      isStrictProjectCreateCandidate(project, title)
    );
    if (preexistingCandidates.length > 0) {
      const projects = preexistingCandidates
        .map((project) => `#${project.number} (${project.id})`)
        .join(', ');
      throw new GhClientError(
        'ambiguous',
        `Unmarked Project ${projects} matches the expected create placeholder for "${title}", `
          + 'but ownership cannot be proven across process restarts. Manual recovery is required: '
          + `add the managed README marker and link it to ${repositoryIdentity}, `
          + 'or delete it and rerun.',
      );
    }

    const createdPayload = await ambiguousMutation(
      `Project create for "${title}"`,
      () => graphqlOnce(CREATE_PROJECT_MUTATION, {
        ownerId: organizationId,
        title,
      }),
      async () => {
        const candidates = (await discoverProjects(true)).filter((project) =>
          !preCreateProjectIds.has(project.id)
          && isStrictProjectCreateCandidate(project, title)
        );
        if (candidates.length > 1) {
          throw new GhClientError('ambiguous', `Multiple newly created Projects are named "${title}"`);
        }
        return candidates[0] == null
          ? null
          : { data: { createProjectV2: { projectV2: candidates[0] } } };
      },
    );
    const createdData = record(record(createdPayload.data).createProjectV2);
    const created = normalizeProject(createdData.projectV2);

    if (created.title !== title || !created.public || created.readme !== readme) {
      const updatedPayload = await graphql(INITIALIZE_FRESH_PROJECT_MUTATION, {
        projectId: created.id,
        title,
        readme,
      });
      const updatedData = record(record(updatedPayload.data).updateProjectV2);
      const updatedRaw = record(updatedData.projectV2);
      rememberProject({
        ...created,
        ...updatedRaw,
        id: created.id,
        number: created.number,
        title,
        readme,
        public: true,
        linkedRepositoriesKnown: created.linkedRepositoriesKnown,
        linkedRepositoryIds: created.linkedRepositoryIds,
        linkedRepositoriesHasNextPage: created.linkedRepositoriesHasNextPage,
        linkedRepositoriesEndCursor: created.linkedRepositoriesEndCursor,
        itemCount: created.itemCount,
      });
    } else {
      rememberProject(created);
    }

    await ensureProjectLinked(requireProject());
    return requireProject();
  }

  /**
   * @returns {Promise<Map<string, ProjectFieldContext>>}
   */
  async function discoverFields() {
    const project = requireProject();
    const fields = new Map();
    let cursor = null;

    for (;;) {
      const payload = await graphql(DISCOVER_FIELDS_QUERY, {
        projectId: project.id,
        cursor,
      });
      const data = record(payload.data);
      const node = record(data.node);
      const connection = record(node.fields);
      for (const rawField of array(connection.nodes)) {
        const field = normalizeField(rawField);
        if (field) {
          fields.set(field.name, field);
        }
      }
      const pageInfo = record(connection.pageInfo);
      if (pageInfo.hasNextPage !== true) {
        break;
      }
      cursor = requiredString(pageInfo.endCursor, 'field page cursor');
    }

    fieldContext = fields;
    return new Map(fields);
  }

  /**
   * @returns {Promise<Map<string, ProjectFieldContext>>}
   */
  async function ensureFields() {
    const project = requireProject();
    const current = await discoverFields();
    let changed = false;

    for (const definition of FIELD_DEFINITIONS) {
      const field = current.get(definition.name);
      if (!field) {
        await ambiguousMutation(
          `Project field create for "${definition.name}"`,
          () => graphqlOnce(CREATE_FIELD_MUTATION, {
            input: {
              projectId: project.id,
              name: definition.name,
              dataType: definition.dataType,
              ...(definition.options.length > 0
                ? { singleSelectOptions: definition.options.map((option) => ({ ...option })) }
                : {}),
            },
          }),
          async () => {
            const discovered = (await discoverFields()).get(definition.name);
            if (!discovered) {
              return null;
            }
            if (discovered.dataType && discovered.dataType !== definition.dataType) {
              throw new GhClientError(
                'validation',
                `Project field "${definition.name}" has type ${discovered.dataType}; expected ${definition.dataType}`,
              );
            }
            return {};
          },
        );
        changed = true;
        continue;
      }

      if (field.dataType && field.dataType !== definition.dataType) {
        throw new GhClientError(
          'validation',
          `Project field "${definition.name}" has type ${field.dataType}; expected ${definition.dataType}`,
        );
      }
      if (definition.options.length > 0 && !optionNamesMatch(definition.options, field.options)) {
        await graphql(UPDATE_FIELD_MUTATION, {
          fieldId: field.id,
          options: definition.options.map((option) => {
            const id = field.options.get(option.name);
            return {
              ...(id == null ? {} : { id }),
              ...option,
            };
          }),
        });
        changed = true;
      }
    }

    return changed ? discoverFields() : current;
  }

  /**
   * @param {Map<string, ProjectFieldContext>} fields
   * @returns {void}
   */
  function setFieldContext(fields) {
    fieldContext = normalizeFieldMap(fields);
  }

  /**
   * @returns {Promise<ProjectViewContext[]>}
   */
  async function discoverViews() {
    const project = requireProject();
    const views = [];
    let cursor = null;

    for (;;) {
      const payload = await graphql(DISCOVER_VIEWS_QUERY, {
        projectId: project.id,
        cursor,
      });
      const data = record(payload.data);
      const node = record(data.node);
      const connection = record(node.views);
      for (const rawView of array(connection.nodes)) {
        const view = normalizeView(rawView);
        if (view) {
          views.push(view);
        }
      }
      const pageInfo = record(connection.pageInfo);
      if (pageInfo.hasNextPage !== true) {
        break;
      }
      cursor = requiredString(pageInfo.endCursor, 'view page cursor');
    }
    return views;
  }

  /**
   * @returns {Promise<ProjectViewContext[]>}
   */
  async function ensureViews() {
    const project = requireProject();
    const current = await discoverViews();
    const byName = new Map(current.map((view) => [view.name, view]));
    let changed = false;

    for (const desired of PROJECT_VIEWS) {
      const existing = byName.get(desired.name);
      if (!existing) {
        const createdPayload = await ambiguousMutation(
          `Project view create for "${desired.name}"`,
          () => graphqlOnce(CREATE_VIEW_MUTATION, {
            input: {
              projectId: project.id,
              name: desired.name,
              layout: desired.layout,
            },
          }),
          async () => {
            const matches = (await discoverViews())
              .filter((view) => view.name === desired.name);
            if (matches.length > 1) {
              throw new GhClientError(
                'ambiguous',
                `Multiple Project views are named "${desired.name}"`,
              );
            }
            return matches[0] == null
              ? null
              : { data: { createProjectV2View: { projectV2View: matches[0] } } };
          },
        );
        const createdData = record(record(createdPayload.data).createProjectV2View);
        const created = normalizeView(createdData.projectV2View);
        if (!created) {
          throw new GhClientError('response', `GitHub did not return created view "${desired.name}"`);
        }
        await graphql(UPDATE_VIEW_MUTATION, {
          input: {
            viewId: created.id,
            filter: desired.filter,
          },
        });
        changed = true;
        continue;
      }
      if (existing.layout !== desired.layout || existing.filter !== desired.filter) {
        await graphql(UPDATE_VIEW_MUTATION, {
          input: {
            viewId: existing.id,
            ...desired,
          },
        });
        changed = true;
      }
    }

    return changed ? discoverViews() : current;
  }

  /**
   * @param {Record<string, unknown>} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function createIssue(operation) {
    const title = requiredString(operation?.title, 'issue title');
    const body = requiredString(operation?.body, 'issue body');
    const assignees = operationAssignees(operation);
    const payload = {
      title,
      body,
      labels: labelsFromBody(body),
      ...(assignees === undefined ? {} : { assignees }),
    };
    const bodyBeadId = extractBeadId(body, 1, [issueMarker]);
    const beadId = requiredString(operation?.beadId ?? bodyBeadId, 'managed Bead id');
    if (!SAFE_BEAD_ID_PATTERN.test(beadId) || bodyBeadId !== beadId) {
      fail('createIssue requires one matching managed Bead id marker');
    }
    const created = record(await ambiguousMutation(
      `Issue create for Bead "${beadId}"`,
      () => rest('POST', `repos/${owner}/${repo}/issues`, payload),
      () => findIssueByBeadId(beadId),
    ));
    return {
      ...created,
      number: positiveInteger(created.number, 'created issue number'),
    };
  }

  /**
   * @param {Record<string, unknown>} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function updateIssue(operation) {
    const issueNumber = issueNumberFrom(operation);
    const body = requiredString(operation?.body, 'issue body');
    const assignees = operationAssignees(operation);
    const labels = Array.isArray(operation?.labels)
      && operation.labels.every((label) => typeof label === 'string')
      ? [...operation.labels]
      : labelsFromBody(body);
    const payload = {
      title: requiredString(operation?.title, 'issue title'),
      body,
      ...(typeof operation?.state === 'string' ? { state: operation.state } : {}),
      labels,
      ...(assignees === undefined ? {} : { assignees }),
    };
    return record(await rest('PATCH', `repos/${owner}/${repo}/issues/${issueNumber}`, payload));
  }

  /**
   * @param {unknown} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function closeIssue(operation) {
    const issueNumber = issueNumberFrom(operation);
    return record(await rest('PATCH', `repos/${owner}/${repo}/issues/${issueNumber}`, {
      state: 'closed',
    }));
  }

  /**
   * @param {unknown} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function reopenIssue(operation) {
    const issueNumber = issueNumberFrom(operation);
    return record(await rest('PATCH', `repos/${owner}/${repo}/issues/${issueNumber}`, {
      state: 'open',
    }));
  }

  /**
   * @param {{issueNumber: number, labels: readonly string[]}} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function labelIssue(operation) {
    const issueNumber = issueNumberFrom(operation);
    if (!Array.isArray(operation?.labels) || operation.labels.some((label) => typeof label !== 'string')) {
      fail('labels must be an array of strings');
    }
    return record(await rest('PATCH', `repos/${owner}/${repo}/issues/${issueNumber}`, {
      labels: [...operation.labels],
    }));
  }

  /**
   * @param {{issueNumber: number, assignee?: string | null, assignees?: readonly string[]}} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function assignIssue(operation) {
    const issueNumber = issueNumberFrom(operation);
    let assignees;
    if (Array.isArray(operation?.assignees)) {
      assignees = operation.assignees.map((assignee) => requiredString(assignee, 'assignee'));
    } else {
      const assignee = optionalAssignee(operation?.assignee);
      assignees = assignee ? [assignee] : [];
    }
    return record(await rest('PATCH', `repos/${owner}/${repo}/issues/${issueNumber}`, {
      assignees,
    }));
  }

  /**
   * @param {{issueNumber: number}} operation
   * @returns {Promise<{id: string}>}
   */
  async function ensureProjectItem(operation) {
    const project = requireProject();
    const issueNumber = issueNumberFrom(operation);
    const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
    const existing = await findProjectItemByIssueUrl(issueUrl);
    if (existing) {
      return { id: requiredString(existing.id, 'project item id') };
    }
    const item = await ambiguousMutation(
      `Project item add for issue #${issueNumber}`,
      async () => {
        const result = await runGhOnce([
          'project',
          'item-add',
          String(project.number),
          '--owner',
          owner,
          '--url',
          issueUrl,
          '--format',
          'json',
        ], undefined);
        return parseJsonObject(result.stdout, 'gh project item-add');
      },
      () => findProjectItemByIssueUrl(issueUrl, true),
    );
    const id = requiredString(item.id ?? record(item.item).id, 'project item id');
    if (projectItemsCache) {
      const returnedItem = record(item.item);
      projectItemsCache.push({
        ...returnedItem,
        id,
        isArchived: false,
        content: {
          ...record(returnedItem.content),
          url: issueUrl,
        },
        fieldValues: returnedItem.fieldValues ?? { nodes: [] },
      });
    }
    return { id };
  }

  /**
   * @param {string} itemId
   * @param {readonly {field: ProjectFieldContext, valueArgs: string[]}[]} updates
   * @returns {Promise<void>}
   */
  async function editProjectFields(itemId, updates) {
    const project = requireProject();
    const declarations = ['$projectId: ID!', '$itemId: ID!'];
    /** @type {Record<string, string>} */
    const variables = {
      projectId: project.id,
      itemId,
    };
    const selections = [];

    for (const [index, update] of updates.entries()) {
      const fieldId = `fieldId${index}`;
      declarations.push(`$${fieldId}: ID!`);
      variables[fieldId] = update.field.id;

      if (update.valueArgs.length === 1 && update.valueArgs[0] === '--clear') {
        selections.push(`
  clear${index}: clearProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $${fieldId}
  }) {
    projectV2Item { id }
  }`);
        continue;
      }

      const [flag, rawValue] = update.valueArgs;
      const value = requiredString(rawValue, `${update.field.name} value`);
      const valueId = `value${index}`;
      const definition = {
        '--text': { type: 'String!', field: 'text' },
        '--single-select-option-id': { type: 'String!', field: 'singleSelectOptionId' },
        '--date': { type: 'Date!', field: 'date' },
      }[flag];
      if (!definition || update.valueArgs.length !== 2) {
        fail(`Unsupported Project field update for "${update.field.name}"`);
      }
      declarations.push(`$${valueId}: ${definition.type}`);
      variables[valueId] = value;
      selections.push(`
  update${index}: updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $${fieldId}
    value: {${definition.field}: $${valueId}}
  }) {
    projectV2Item { id }
  }`);
    }

    await graphql(`
mutation UpdateManagedProjectItemFields(
  ${declarations.join('\n  ')}
) {
${selections.join('\n')}
}
`.trim(), variables);
    projectItemsCache = null;
  }

  /**
   * @param {string} name
   * @returns {ProjectFieldContext}
   */
  function requireField(name) {
    const field = fieldContext.get(name);
    if (!field) {
      fail(`Required Project field "${name}" has not been discovered`);
    }
    return field;
  }

  /**
   * @param {string} fieldName
   * @param {unknown} value
   * @returns {string}
   */
  function requireOption(fieldName, value) {
    const name = requiredString(value, `${fieldName} option`);
    const id = requireField(fieldName).options.get(name);
    if (!id) {
      fail(`Project field "${fieldName}" is missing option "${name}"`);
    }
    return id;
  }

  /**
   * @param {Record<string, unknown>} values
   * @returns {string}
   */
  function desiredStatus(values) {
    if (values.done === true || String(values.status ?? '').toLowerCase() === 'closed') {
      return 'Done';
    }
    if (values.blocked === true) {
      return 'Blocked';
    }
    const status = String(values.status ?? '').trim().toLowerCase().replace(/[_-]+/gu, ' ');
    if (status === 'ready') {
      return 'Ready';
    }
    if (status === 'in progress' || status === 'inprogress') {
      return 'In Progress';
    }
    return 'Backlog';
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function desiredPriority(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4) {
      return `P${value}`;
    }
    const normalized = requiredString(value, 'priority').toUpperCase();
    if (!/^P[0-4]$/u.test(normalized)) {
      fail('priority must be P0-P4 or an integer from 0 through 4');
    }
    return normalized;
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function desiredType(value) {
    const normalized = requiredString(value, 'Bead type').toLowerCase();
    const type = {
      epic: 'Epic',
      feature: 'Feature',
      task: 'Task',
      bug: 'Bug',
      chore: 'Chore',
      decision: 'Decision',
    }[normalized];
    if (!type) {
      fail(`Unsupported Bead type "${normalized}"`);
    }
    return type;
  }

  /**
   * @param {Record<string, unknown>} operation
   * @returns {Promise<void>}
   */
  async function setFields(operation) {
    const itemId = requiredString(operation?.itemId, 'project item id');
    const values = record(operation?.fields);
    /** @type {{field: ProjectFieldContext, valueArgs: string[]}[]} */
    const updates = [];

    if (Object.hasOwn(values, 'beadId')) {
      const field = requireField('Bead ID');
      const value = values.beadId;
      updates.push({
        field,
        valueArgs: value == null ? ['--clear'] : ['--text', requiredString(value, 'Bead ID')],
      });
    }
    if (
      Object.hasOwn(values, 'status')
      || Object.hasOwn(values, 'blocked')
      || Object.hasOwn(values, 'done')
    ) {
      const field = requireField('Status');
      updates.push({
        field,
        valueArgs: [
          '--single-select-option-id',
          requireOption('Status', desiredStatus(values)),
        ],
      });
    }
    if (Object.hasOwn(values, 'priority')) {
      const field = requireField('Priority');
      updates.push({
        field,
        valueArgs: [
          '--single-select-option-id',
          requireOption('Priority', desiredPriority(values.priority)),
        ],
      });
    }
    if (Object.hasOwn(values, 'type')) {
      const field = requireField('Bead Type');
      updates.push({
        field,
        valueArgs: [
          '--single-select-option-id',
          requireOption('Bead Type', desiredType(values.type)),
        ],
      });
    }
    if (Object.hasOwn(values, 'parentGoal')) {
      const field = requireField('Parent Goal');
      updates.push({
        field,
        valueArgs: values.parentGoal == null
          ? ['--clear']
          : ['--text', requiredString(values.parentGoal, 'Parent Goal')],
      });
    }
    if (Object.hasOwn(values, 'sourceUpdated')) {
      const field = requireField('Source Updated');
      if (values.sourceUpdated == null) {
        updates.push({ field, valueArgs: ['--clear'] });
      } else {
        const timestamp = requiredString(values.sourceUpdated, 'Source Updated');
        const date = timestamp.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
          fail('Source Updated must start with an ISO date');
        }
        updates.push({ field, valueArgs: ['--date', date] });
      }
    }

    if (updates.length > 0) {
      await editProjectFields(itemId, updates);
    }
  }

  /**
   * @param {number} issueNumber
   * @returns {Promise<number>}
   */
  async function resolveIssueDatabaseId(issueNumber) {
    const normalizedIssueNumber = positiveInteger(issueNumber, 'issue number');
    const cached = issueDatabaseIds.get(normalizedIssueNumber);
    if (cached != null) {
      return cached;
    }
    const issue = record(await rest(
      'GET',
      `repos/${owner}/${repo}/issues/${normalizedIssueNumber}`,
    ));
    const id = positiveInteger(issue.id, 'issue database id');
    issueDatabaseIds.set(normalizedIssueNumber, id);
    return id;
  }

  /**
   * @param {{parentIssueNumber: number, subIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function addSubIssue(operation) {
    const parentIssueNumber = positiveInteger(operation?.parentIssueNumber, 'parent issue number');
    const subIssueId = positiveInteger(operation?.subIssueId, 'sub-issue database id');
    const endpoint = `repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues`;
    return ambiguousMutation(
      `Sub-issue relationship add for parent #${parentIssueNumber}`,
      () => rest('POST', endpoint, { sub_issue_id: subIssueId }),
      () => findIssueInConnection(endpoint, subIssueId),
    );
  }

  /**
   * @param {{parentIssueNumber: number, subIssueId: number, parentRepository?: string}} operation
   * @returns {Promise<unknown>}
   */
  async function removeSubIssue(operation) {
    const parentIssueNumber = positiveInteger(operation?.parentIssueNumber, 'parent issue number');
    const subIssueId = positiveInteger(operation?.subIssueId, 'sub-issue database id');
    const parentRepository = normalizeRepositoryIdentity(
      operation?.parentRepository ?? repositoryIdentity,
      'parent repository identity',
    );
    const connectionEndpoint =
      `repos/${parentRepository}/issues/${parentIssueNumber}/sub_issues`;
    return idempotentRelationshipDelete(
      `Sub-issue relationship removal for parent ${parentRepository}#${parentIssueNumber}`,
      () => rest(
        'DELETE',
        `repos/${parentRepository}/issues/${parentIssueNumber}/sub_issue`,
        { sub_issue_id: subIssueId },
      ),
      () => findIssueInConnection(connectionEndpoint, subIssueId),
    );
  }

  /**
   * @param {{issueNumber: number, blockerIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function addBlockedBy(operation) {
    const issueNumber = positiveInteger(operation?.issueNumber, 'issue number');
    const blockerIssueId = positiveInteger(operation?.blockerIssueId, 'blocker issue database id');
    const endpoint = `repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`;
    return ambiguousMutation(
      `Blocked-by relationship add for issue #${issueNumber}`,
      () => rest('POST', endpoint, { issue_id: blockerIssueId }),
      () => findIssueInConnection(endpoint, blockerIssueId),
    );
  }

  /**
   * @param {{issueNumber: number, blockerIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function removeBlockedBy(operation) {
    const issueNumber = positiveInteger(operation?.issueNumber, 'issue number');
    const blockerIssueId = positiveInteger(operation?.blockerIssueId, 'blocker issue database id');
    const connectionEndpoint =
      `repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`;
    return idempotentRelationshipDelete(
      `Blocked-by relationship removal for issue #${issueNumber}`,
      () => rest(
        'DELETE',
        `${connectionEndpoint}/${blockerIssueId}`,
      ),
      () => findIssueInConnection(connectionEndpoint, blockerIssueId),
    );
  }

  /**
   * Reconciliation adapter mapping:
   * syncParent -> removeSubIssue(current parent) + addSubIssue(desired parent).
   *
   * @param {{
   *   issueNumber: number,
   *   parentIssueNumber: number | null,
   *   currentParentIssueNumber: number | null,
   *   currentParentIssue?: IssueIdentity | null,
   * }} operation
   * @returns {Promise<void>}
   */
  async function syncParent(operation) {
    const childIssueNumber = positiveInteger(operation?.issueNumber, 'child issue number');
    const childIssueId = await resolveIssueDatabaseId(childIssueNumber);
    const currentParentIssue = operation?.currentParentIssue == null
      ? null
      : {
          id: positiveInteger(operation.currentParentIssue.id, 'current parent database id'),
          nodeId: requiredString(operation.currentParentIssue.nodeId, 'current parent node id'),
          number: positiveInteger(operation.currentParentIssue.number, 'current parent issue number'),
          repository: normalizeRepositoryIdentity(
            operation.currentParentIssue.repository,
            'current parent repository identity',
          ),
        };
    const currentParent = currentParentIssue?.number ?? (
      operation?.currentParentIssueNumber == null
        ? null
        : positiveInteger(operation.currentParentIssueNumber, 'current parent issue number')
    );
    const desiredParent = operation?.parentIssueNumber == null
      ? null
      : positiveInteger(operation.parentIssueNumber, 'parent issue number');
    const currentMatchesDesired = desiredParent != null && (
      currentParentIssue == null
        ? currentParent === desiredParent
        : (
            currentParentIssue.repository.toLowerCase() === repositoryIdentity.toLowerCase()
            && currentParentIssue.number === desiredParent
          )
    );

    if (currentParent != null && !currentMatchesDesired) {
      await removeSubIssue({
        parentIssueNumber: currentParentIssue?.number ?? currentParent,
        subIssueId: childIssueId,
        parentRepository: currentParentIssue?.repository ?? repositoryIdentity,
      });
    }
    if (desiredParent != null && !currentMatchesDesired) {
      await addSubIssue({ parentIssueNumber: desiredParent, subIssueId: childIssueId });
    }
  }

  /**
   * Reconciliation adapter mapping:
   * syncBlocker -> removeBlockedBy(stale blockers) + addBlockedBy(new blockers).
   *
   * @param {{
   *   issueNumber: number,
   *   blockerIssueNumbers: readonly number[],
   *   currentBlockerIssueNumbers: readonly number[],
   *   currentBlockerIssues?: readonly IssueIdentity[],
   * }} operation
   * @returns {Promise<void>}
   */
  async function syncBlocker(operation) {
    const issueNumber = positiveInteger(operation?.issueNumber, 'issue number');
    const desired = new Set(
      array(operation?.blockerIssueNumbers).map((value) => positiveInteger(value, 'blocker issue number')),
    );
    const current = new Set(
      array(operation?.currentBlockerIssueNumbers).map((value) => positiveInteger(value, 'blocker issue number')),
    );
    const currentBlockerIssues = array(operation?.currentBlockerIssues).map((value) => {
      const blocker = record(value);
      return {
        id: positiveInteger(blocker.id, 'current blocker database id'),
        nodeId: requiredString(blocker.nodeId, 'current blocker node id'),
        number: positiveInteger(blocker.number, 'current blocker issue number'),
        repository: normalizeRepositoryIdentity(
          blocker.repository,
          'current blocker repository identity',
        ),
      };
    });
    const currentLocalNumbers = new Set(
      currentBlockerIssues
        .filter((blocker) => blocker.repository.toLowerCase() === repositoryIdentity.toLowerCase())
        .map((blocker) => blocker.number),
    );

    if (currentBlockerIssues.length > 0) {
      for (const blocker of currentBlockerIssues) {
        const matchesDesired = blocker.repository.toLowerCase() === repositoryIdentity.toLowerCase()
          && desired.has(blocker.number);
        if (!matchesDesired) {
          await removeBlockedBy({
            issueNumber,
            blockerIssueId: blocker.id,
          });
        }
      }
    } else {
      for (const blockerNumber of current) {
        if (!desired.has(blockerNumber)) {
          await removeBlockedBy({
            issueNumber,
            blockerIssueId: await resolveIssueDatabaseId(blockerNumber),
          });
        }
      }
    }
    for (const blockerNumber of desired) {
      const alreadyPresent = currentBlockerIssues.length > 0
        ? currentLocalNumbers.has(blockerNumber)
        : current.has(blockerNumber);
      if (!alreadyPresent) {
        await addBlockedBy({
          issueNumber,
          blockerIssueId: await resolveIssueDatabaseId(blockerNumber),
        });
      }
    }
  }

  /**
   * @param {{itemId: string}} operation
   * @returns {Promise<void>}
   */
  async function archiveItem(operation) {
    const project = requireProject();
    await runGh([
      'project',
      'item-archive',
      String(project.number),
      '--owner',
      owner,
      '--id',
      requiredString(operation?.itemId, 'project item id'),
    ]);
    projectItemsCache = null;
  }

  /**
   * Reconciliation adapter mapping: restoreItem is the GitHub unarchive action.
   *
   * @param {{itemId: string}} operation
   * @returns {Promise<void>}
   */
  async function restoreItem(operation) {
    const project = requireProject();
    await runGh([
      'project',
      'item-archive',
      String(project.number),
      '--owner',
      owner,
      '--id',
      requiredString(operation?.itemId, 'project item id'),
      '--undo',
    ]);
    projectItemsCache = null;
  }

  /**
   * @param {{body: string}} operation
   * @returns {Promise<void>}
   */
  async function updateReadme(operation) {
    const project = requireProject();
    const readme = requiredString(operation?.body, 'project README');
    if (!readme.includes(currentProjectReadmeMarker)) {
      fail('project README must contain the managed marker');
    }
    await graphql(UPDATE_PROJECT_README_MUTATION, {
      projectId: project.id,
      readme,
    });
    rememberProject({ ...project, readme });
  }

  /**
   * @param {{title: string, readme: string}} input
   */
  async function provisionProject(input) {
    await verifyAccess();
    const project = await ensureProject(input);
    await ensureLabels();
    const fields = await ensureFields();
    const views = await ensureViews();
    return { project, fields, views };
  }

  return Object.freeze({
    verifyAccess,
    acquireApplyLock,
    releaseApplyLock,
    listRepositoryIssues,
    listManagedIssues,
    ensureLabels,
    discoverProject,
    ensureProject,
    provisionProject,
    discoverFields,
    ensureFields,
    setFieldContext,
    discoverViews,
    ensureViews,
    createIssue,
    updateIssue,
    closeIssue,
    reopenIssue,
    labelIssue,
    assignIssue,
    ensureProjectItem,
    setFields,
    addSubIssue,
    removeSubIssue,
    addBlockedBy,
    removeBlockedBy,
    syncParent,
    syncBlocker,
    archiveItem,
    restoreItem,
    unarchiveItem: restoreItem,
    updateReadme,
  });
}
