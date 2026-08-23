// @ts-check

export const PROJECT_README_MARKER = '<!-- psyche-bead-sync:v1 project-readme -->';

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
]);
const ISSUE_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1\s+bead-id=([^\r\n]*?)\s*-->/gu;
const RENDER_HASH_PATTERN = /<!--\s*psyche-bead-sync:v1\s+render-hash=([a-f0-9]{64})\s*-->\s*$/u;
const SAFE_OWNER_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const SAFE_BEAD_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,199})$/u;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/giu;
const MAX_ERROR_DETAIL = 512;
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 200;

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
mutation UpdateManagedProject($projectId: ID!, $public: Boolean!, $readme: String!) {
  updateProjectV2(input: {projectId: $projectId, public: $public, readme: $readme}) {
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

const LINK_PROJECT_MUTATION = `
mutation LinkManagedProject($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: {projectId: $projectId, repositoryId: $repositoryId}) {
    repository {
      id
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
 * }} ProjectContext
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
 *   status?: unknown,
 *   statusCode?: unknown,
 *   exitCode?: unknown,
 *   stderr?: unknown,
 *   stderrSummary?: unknown,
 *   message?: unknown,
 *   response?: { status?: unknown },
 *   graphqlErrors?: unknown,
 * }} ErrorLike
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
function isRetryable(error) {
  const status = errorStatus(error);
  const detail = errorDetail(error);
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    return /(?:rate[\s-]*limit|secondary rate|abuse detection)/iu.test(detail);
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const graphqlErrors = array(/** @type {ErrorLike} */ (error ?? {}).graphqlErrors);
  return graphqlErrors.length > 0 && graphqlErrors.every((entry) => {
    const item = record(entry);
    return item.type === 'RATE_LIMITED'
      || /rate[\s-]*limit/iu.test(stringOrEmpty(item.message));
  });
}

/**
 * @param {number} attempt
 * @returns {Promise<void>}
 */
function retryDelay(attempt) {
  const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** attempt));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * @param {unknown} error
 * @returns {GhClientError}
 */
function toClientError(error) {
  if (error instanceof GhClientError) {
    return error;
  }
  return new GhClientError('github', errorDetail(error), errorStatus(error));
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
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function assertNoGraphqlErrors(payload) {
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
  throw graphqlError;
}

/**
 * @param {unknown} raw
 * @returns {ProjectContext}
 */
function normalizeProject(raw) {
  const project = record(raw);
  return {
    id: requiredString(project.id, 'project id'),
    number: positiveInteger(project.number, 'project number'),
    title: requiredString(project.title, 'project title'),
    readme: stringOrEmpty(project.readme),
    public: project.public === true,
    ...(typeof project.closed === 'boolean' ? { closed: project.closed } : {}),
    ...(typeof project.url === 'string' ? { url: project.url } : {}),
  };
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
 * @param {number} issueNumber
 * @returns {string | null}
 */
function extractBeadId(body, issueNumber) {
  const markers = [...body.matchAll(ISSUE_MARKER_PATTERN)];
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
 * @param {{run: GhRun, owner: string, repo: string, token: string}} options
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
  const token = requiredString(options.token, 'token');
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
  /** @type {Map<number, number>} */
  const issueDatabaseIds = new Map();

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
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) {
          throw toClientError(error);
        }
        await retryDelay(attempt);
      }
    }
    throw new GhClientError('github', 'GitHub request exhausted retries');
  }

  /**
   * @param {readonly string[]} args
   * @param {string | undefined} [stdin]
   * @returns {Promise<GhRunResult>}
   */
  async function runGh(args, stdin) {
    return withRetry(async () => {
      const runOptions = {
        env: { GH_TOKEN: token },
        ...(stdin === undefined ? {} : { stdin }),
      };
      const result = normalizeRunResult(await run('gh', args, runOptions));
      if ((result.exitCode ?? 0) !== 0) {
        throw Object.assign(
          new Error(result.stderr || `GitHub command exited with code ${result.exitCode}`),
          { exitCode: result.exitCode, stderr: result.stderr },
        );
      }
      return result;
    });
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
    const result = await runGh(
      args,
      body === undefined ? undefined : `${JSON.stringify(body)}\n`,
    );
    return parseJson(result.stdout, `${method} ${endpoint}`);
  }

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @returns {Promise<Record<string, unknown>>}
   */
  async function graphql(query, variables) {
    return withRetry(async () => {
      const result = normalizeRunResult(await run('gh', ['api', 'graphql', '--input', '-'], {
        env: { GH_TOKEN: token },
        stdin: `${JSON.stringify({ query, variables })}\n`,
      }));
      if ((result.exitCode ?? 0) !== 0) {
        throw Object.assign(
          new Error(result.stderr || `GitHub GraphQL command exited with code ${result.exitCode}`),
          { exitCode: result.exitCode, stderr: result.stderr },
        );
      }
      const payload = parseJsonObject(result.stdout, 'GitHub GraphQL');
      assertNoGraphqlErrors(payload);
      return payload;
    });
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
    return { organization, repository };
  }

  /**
   * @returns {Promise<unknown[]>}
   */
  async function listRepositoryIssues() {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const pageItems = array(await rest(
        'GET',
        `repos/${owner}/${repo}/issues?state=all&labels=bead&per_page=100&page=${page}`,
      ));
      issues.push(...pageItems);
      if (pageItems.length < 100) {
        return issues;
      }
    }
  }

  /**
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async function listManagedIssues() {
    const rawIssues = await listRepositoryIssues();
    const managed = [];
    const seen = new Map();

    for (const rawIssue of rawIssues) {
      const issue = record(rawIssue);
      if (issue.pull_request != null) {
        continue;
      }
      const number = positiveInteger(issue.number, 'issue number');
      const body = stringOrEmpty(issue.body);
      const beadId = extractBeadId(body, number);
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

      const assignees = array(issue.assignees);
      const firstAssignee = record(assignees[0]);
      const renderHash = body.match(RENDER_HASH_PATTERN)?.[1] ?? null;
      managed.push({
        beadId,
        number,
        title: typeof issue.title === 'string' ? issue.title : null,
        body: typeof issue.body === 'string' ? issue.body : null,
        state: typeof issue.state === 'string' ? issue.state : 'open',
        assignee: typeof firstAssignee.login === 'string' ? firstAssignee.login : null,
        renderHash,
        projectItem: null,
        parentIssueNumber: null,
        blockerIssueNumbers: [],
        ...(typeof issue.html_url === 'string' ? { url: issue.html_url } : {}),
      });
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
        await rest('POST', `repos/${owner}/${repo}/labels`, { ...label });
      }
    }
    return REQUIRED_LABELS;
  }

  /**
   * @returns {Promise<ProjectContext | null>}
   */
  async function discoverProject() {
    const matches = [];
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
        const project = normalizeProject(rawProject);
        if (project.readme.includes(PROJECT_README_MARKER)) {
          matches.push(project);
        }
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }
      cursor = requiredString(pageInfo.endCursor, 'project page cursor');
    }

    if (matches.length > 1) {
      throw new GhClientError('marker', 'Multiple GitHub Projects contain the managed README marker');
    }
    projectContext = matches[0] ?? null;
    return projectContext;
  }

  /**
   * @param {{title: string, readme: string}} input
   * @returns {Promise<ProjectContext>}
   */
  async function ensureProject(input) {
    const title = requiredString(input?.title, 'project title');
    const readme = requiredString(input?.readme, 'project README');
    if (!readme.includes(PROJECT_README_MARKER)) {
      fail('project README must contain the managed marker');
    }

    const existing = await discoverProject();
    if (existing) {
      if (!existing.public || existing.readme !== readme) {
        const updatedPayload = await graphql(UPDATE_PROJECT_MUTATION, {
          projectId: existing.id,
          public: true,
          readme,
        });
        const updatedData = record(record(updatedPayload.data).updateProjectV2);
        projectContext = normalizeProject(updatedData.projectV2);
      }
      return requireProject();
    }

    if (!organizationId || !repositoryId) {
      throw new GhClientError('permission', 'Unable to resolve organization or repository access');
    }
    const createdPayload = await graphql(CREATE_PROJECT_MUTATION, {
      ownerId: organizationId,
      title,
    });
    const createdData = record(record(createdPayload.data).createProjectV2);
    const created = normalizeProject(createdData.projectV2);

    const updatedPayload = await graphql(UPDATE_PROJECT_MUTATION, {
      projectId: created.id,
      public: true,
      readme,
    });
    const updatedData = record(record(updatedPayload.data).updateProjectV2);
    const updatedRaw = record(updatedData.projectV2);
    projectContext = {
      ...created,
      ...updatedRaw,
      id: created.id,
      number: created.number,
      title: typeof updatedRaw.title === 'string' ? updatedRaw.title : created.title,
      readme,
      public: true,
    };

    await graphql(LINK_PROJECT_MUTATION, {
      projectId: created.id,
      repositoryId,
    });
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
        await graphql(CREATE_FIELD_MUTATION, {
          input: {
            projectId: project.id,
            name: definition.name,
            dataType: definition.dataType,
            ...(definition.options.length > 0
              ? { singleSelectOptions: definition.options.map((option) => ({ ...option })) }
              : {}),
          },
        });
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
          options: definition.options.map((option) => ({ ...option })),
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
        await graphql(CREATE_VIEW_MUTATION, {
          input: { projectId: project.id, ...desired },
        });
        changed = true;
        continue;
      }
      if (existing.layout !== desired.layout || existing.filter !== desired.filter) {
        await graphql(UPDATE_VIEW_MUTATION, {
          input: {
            projectId: project.id,
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
    const assignee = optionalAssignee(operation?.assignee);
    const payload = {
      title,
      body,
      labels: labelsFromBody(body),
      ...(operation?.assignee === undefined ? {} : { assignees: assignee ? [assignee] : [] }),
    };
    const created = record(await rest('POST', `repos/${owner}/${repo}/issues`, payload));
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
    const assignee = optionalAssignee(operation?.assignee);
    const payload = {
      title: requiredString(operation?.title, 'issue title'),
      body,
      ...(typeof operation?.state === 'string' ? { state: operation.state } : {}),
      labels: labelsFromBody(body),
      ...(operation?.assignee === undefined ? {} : { assignees: assignee ? [assignee] : [] }),
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
    const result = await runGh([
      'project',
      'item-add',
      String(project.number),
      '--owner',
      owner,
      '--url',
      `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
      '--format',
      'json',
    ]);
    const item = parseJsonObject(result.stdout, 'gh project item-add');
    const id = requiredString(item.id ?? record(item.item).id, 'project item id');
    return { id };
  }

  /**
   * @param {string} itemId
   * @param {ProjectFieldContext} field
   * @param {readonly string[]} valueArgs
   * @returns {Promise<void>}
   */
  async function editProjectField(itemId, field, valueArgs) {
    const project = requireProject();
    await runGh([
      'project',
      'item-edit',
      '--id',
      itemId,
      '--project-id',
      project.id,
      '--field-id',
      field.id,
      ...valueArgs,
    ]);
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
    const updates = [];

    if (Object.hasOwn(values, 'beadId')) {
      const field = requireField('Bead ID');
      const value = values.beadId;
      updates.push(editProjectField(
        itemId,
        field,
        value == null ? ['--clear'] : ['--text', requiredString(value, 'Bead ID')],
      ));
    }
    if (
      Object.hasOwn(values, 'status')
      || Object.hasOwn(values, 'blocked')
      || Object.hasOwn(values, 'done')
    ) {
      const field = requireField('Status');
      updates.push(editProjectField(itemId, field, [
        '--single-select-option-id',
        requireOption('Status', desiredStatus(values)),
      ]));
    }
    if (Object.hasOwn(values, 'priority')) {
      const field = requireField('Priority');
      updates.push(editProjectField(itemId, field, [
        '--single-select-option-id',
        requireOption('Priority', desiredPriority(values.priority)),
      ]));
    }
    if (Object.hasOwn(values, 'type')) {
      const field = requireField('Bead Type');
      updates.push(editProjectField(itemId, field, [
        '--single-select-option-id',
        requireOption('Bead Type', desiredType(values.type)),
      ]));
    }
    if (Object.hasOwn(values, 'parentGoal')) {
      const field = requireField('Parent Goal');
      updates.push(editProjectField(
        itemId,
        field,
        values.parentGoal == null
          ? ['--clear']
          : ['--text', requiredString(values.parentGoal, 'Parent Goal')],
      ));
    }
    if (Object.hasOwn(values, 'sourceUpdated')) {
      const field = requireField('Source Updated');
      if (values.sourceUpdated == null) {
        updates.push(editProjectField(itemId, field, ['--clear']));
      } else {
        const timestamp = requiredString(values.sourceUpdated, 'Source Updated');
        const date = timestamp.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
          fail('Source Updated must start with an ISO date');
        }
        updates.push(editProjectField(itemId, field, ['--date', date]));
      }
    }

    for (const update of updates) {
      await update;
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
    return rest(
      'POST',
      `repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues`,
      { sub_issue_id: subIssueId },
    );
  }

  /**
   * @param {{parentIssueNumber: number, subIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function removeSubIssue(operation) {
    const parentIssueNumber = positiveInteger(operation?.parentIssueNumber, 'parent issue number');
    const subIssueId = positiveInteger(operation?.subIssueId, 'sub-issue database id');
    return rest(
      'DELETE',
      `repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issue`,
      { sub_issue_id: subIssueId },
    );
  }

  /**
   * @param {{issueNumber: number, blockerIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function addBlockedBy(operation) {
    const issueNumber = positiveInteger(operation?.issueNumber, 'issue number');
    const blockerIssueId = positiveInteger(operation?.blockerIssueId, 'blocker issue database id');
    return rest(
      'POST',
      `repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
      { issue_id: blockerIssueId },
    );
  }

  /**
   * @param {{issueNumber: number, blockerIssueId: number}} operation
   * @returns {Promise<unknown>}
   */
  async function removeBlockedBy(operation) {
    const issueNumber = positiveInteger(operation?.issueNumber, 'issue number');
    const blockerIssueId = positiveInteger(operation?.blockerIssueId, 'blocker issue database id');
    return rest(
      'DELETE',
      `repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by/${blockerIssueId}`,
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
   * }} operation
   * @returns {Promise<void>}
   */
  async function syncParent(operation) {
    const childIssueNumber = positiveInteger(operation?.issueNumber, 'child issue number');
    const childIssueId = await resolveIssueDatabaseId(childIssueNumber);
    const currentParent = operation?.currentParentIssueNumber == null
      ? null
      : positiveInteger(operation.currentParentIssueNumber, 'current parent issue number');
    const desiredParent = operation?.parentIssueNumber == null
      ? null
      : positiveInteger(operation.parentIssueNumber, 'parent issue number');

    if (currentParent != null && currentParent !== desiredParent) {
      await removeSubIssue({ parentIssueNumber: currentParent, subIssueId: childIssueId });
    }
    if (desiredParent != null && currentParent !== desiredParent) {
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

    for (const blockerNumber of current) {
      if (!desired.has(blockerNumber)) {
        await removeBlockedBy({
          issueNumber,
          blockerIssueId: await resolveIssueDatabaseId(blockerNumber),
        });
      }
    }
    for (const blockerNumber of desired) {
      if (!current.has(blockerNumber)) {
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
  }

  /**
   * @param {{body: string}} operation
   * @returns {Promise<void>}
   */
  async function updateReadme(operation) {
    const project = requireProject();
    const readme = requiredString(operation?.body, 'project README');
    if (!readme.includes(PROJECT_README_MARKER)) {
      fail('project README must contain the managed marker');
    }
    await graphql(UPDATE_PROJECT_MUTATION, {
      projectId: project.id,
      public: true,
      readme,
    });
    projectContext = { ...project, public: true, readme };
  }

  /**
   * @param {{title: string, readme: string}} input
   */
  async function provisionProject(input) {
    await verifyAccess();
    await ensureLabels();
    const project = await ensureProject(input);
    const fields = await ensureFields();
    const views = await ensureViews();
    return { project, fields, views };
  }

  return Object.freeze({
    verifyAccess,
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
