// @ts-check

import { createHash } from 'node:crypto';

import { activeBeads, buildBeadIndex, normalizeBeadId } from './model.mjs';
import {
  DEFAULT_ISSUE_MARKER,
  DEFAULT_PROJECT_MARKER,
  LEGACY_ISSUE_MARKERS,
  markerPattern,
  normalizeMarker,
  recognizedMarkers,
  recognizedProjectMarkers as resolveRecognizedProjectMarkers,
  renderHashMarker,
} from './markers.mjs';
import { renderIssueBody, renderIssueTitle, renderProjectReadme } from './render.mjs';

/** @typedef {import('./render.mjs').RenderContext} RenderContext */
/** @typedef {import('./sanitize.mjs').PublicBead} PublicBead */

/**
 * @typedef {string | number | boolean | null} ReconciliationFieldValue
 */

/**
 * @typedef {Record<string, ReconciliationFieldValue>} ProjectFieldValues
 */

/**
 * @typedef {{
 *   id?: unknown,
 *   archived?: unknown,
 *   fields?: unknown,
 * }} RawProjectItemSnapshot
 */

/**
 * @typedef {{
 *   number?: unknown,
 *   title?: unknown,
 *   body?: unknown,
 *   state?: unknown,
 *   assignee?: unknown,
 *   labels?: unknown,
 *   renderHash?: unknown,
 *   projectItem?: unknown,
 *   parentIssueNumber?: unknown,
 *   blockerIssueNumbers?: unknown,
 * }} RawIssueSnapshot
 */

/**
 * @typedef {{
 *   body?: unknown,
 *   renderHash?: unknown,
 *   path?: unknown,
 * }} RawReadmeSnapshot
 */

/**
 * @typedef {{
 *   inventory?: unknown,
 *   existingIssues?: unknown,
 *   readme?: unknown,
 *   renderContext?: unknown,
 * }} RawPlanReconciliationInput
 */

/**
 * @typedef {{
 *   id: string,
 *   archived: boolean,
 *   fields: ProjectFieldValues,
 * }} ProjectItemSnapshot
 */

/**
 * @typedef {{
 *   number: number,
 *   title: string | null,
 *   body: string | null,
 *   state: string,
 *   assignee: string | null,
 *   labels: string[] | null,
 *   renderHash: string | null,
 *   projectItem: ProjectItemSnapshot | null,
 *   parentIssueNumber: number | null,
 *   blockerIssueNumbers: number[],
 * }} IssueSnapshot
 */

/**
 * @typedef {IssueSnapshot & { beadId: string }} ManagedIssueSnapshot
 */

/**
 * @typedef {{
 *   body: string | null,
 *   renderHash: string | null,
 *   path: string,
 * }} ReadmeSnapshot
 */

/**
 * @typedef {{
 *   inventory: readonly PublicBead[],
 *   existingIssues?: readonly IssueSnapshot[] | readonly ManagedIssueSnapshot[] | undefined,
 *   readme?: ReadmeSnapshot | null | undefined,
 *   renderContext?: Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'> | undefined,
 * }} PlanReconciliationInput
 */

/**
 * @typedef {'createIssues' | 'updateIssues' | 'closeIssues' | 'ensureProjectItems' | 'restoreItems' | 'setFields' | 'syncParents' | 'syncBlockers' | 'archiveItems' | 'updateReadme'} ReconciliationPhase
 */

/**
 * @typedef {{
 *   type: 'createIssue',
 *   phase: 'createIssues',
 *   beadId: string,
 *   title: string,
 *   body: string,
 *   renderHash: string,
 *   assignee: string | null,
 *   state: 'open',
 * }} CreateIssueOperation
 */

/**
 * @typedef {{
 *   type: 'updateIssue',
 *   phase: 'updateIssues',
 *   beadId: string,
 *   issueNumber: number,
 *   title: string,
 *   body: string,
 *   renderHash: string,
 *   assignee: string | null,
 *   state: string,
 * }} UpdateIssueOperation
 */

/**
 * @typedef {{
 *   type: 'closeIssue',
 *   phase: 'closeIssues',
 *   beadId: string,
 *   issueNumber: number,
 * }} CloseIssueOperation
 */

/**
 * @typedef {{
 *   type: 'ensureProjectItem',
 *   phase: 'ensureProjectItems',
 *   beadId: string,
 *   issueNumber?: number,
 * }} EnsureProjectItemOperation
 */

/**
 * @typedef {{
 *   type: 'restoreItem',
 *   phase: 'restoreItems',
 *   beadId: string,
 *   itemId?: string,
 * }} RestoreItemOperation
 */

/**
 * @typedef {{
 *   type: 'setFields',
 *   phase: 'setFields',
 *   beadId: string,
 *   itemId?: string,
 *   fields: ProjectFieldValues,
 * }} SetFieldsOperation
 */

/**
 * @typedef {{
 *   type: 'syncParent',
 *   phase: 'syncParents',
 *   beadId: string,
 *   parentBeadId: string | null,
 *   parentIssueNumber?: number | null,
 *   currentParentIssueNumber: number | null,
 * }} SyncParentOperation
 */

/**
 * @typedef {{
 *   type: 'syncBlocker',
 *   phase: 'syncBlockers',
 *   beadId: string,
 *   blockerBeadIds: string[],
 *   blockerIssueNumbers?: number[],
 *   currentBlockerIssueNumbers: number[],
 * }} SyncBlockerOperation
 */

/**
 * @typedef {{
 *   type: 'archiveItem',
 *   phase: 'archiveItems',
 *   beadId: string,
 *   itemId?: string,
 * }} ArchiveItemOperation
 */

/**
 * @typedef {{
 *   type: 'updateReadme',
 *   phase: 'updateReadme',
 *   path: string,
 *   body: string,
 *   renderHash: string,
 * }} UpdateReadmeOperation
 */

/**
 * @typedef {CreateIssueOperation | UpdateIssueOperation | CloseIssueOperation | EnsureProjectItemOperation | RestoreItemOperation | SetFieldsOperation | SyncParentOperation | SyncBlockerOperation | ArchiveItemOperation | UpdateReadmeOperation} ReconciliationOperation
 */

/**
 * @typedef {{
 *   createIssue: number,
 *   updateIssue: number,
 *   closeIssue: number,
 *   ensureProjectItem: number,
 *   restoreItem: number,
 *   setFields: number,
 *   syncParent: number,
 *   syncBlocker: number,
 *   archiveItem: number,
 *   updateReadme: number,
 * }} ReconciliationOperationCounts
 */

/**
 * @typedef {{
 *   beadId: string,
 *   issueNumber: number,
 *   issueTitle: string | null,
 * }} ReconciliationClosureCandidate
 */

/**
 * @typedef {{
 *   sourceTotal: number,
 *   sourceActive: number,
 *   sourceClosed: number,
 *   managedTotal: number,
 *   managedOpenCount: number,
 *   defaultMaxCloseCount: number,
 *   createIssueCount: number,
 *   updateIssueCount: number,
 *   closeIssueCount: number,
 *   ensureProjectItemCount: number,
 *   restoreItemCount: number,
 *   setFieldsCount: number,
 *   syncParentCount: number,
 *   syncBlockerCount: number,
 *   archiveItemCount: number,
 *   updateReadmeCount: number,
 *   operationCounts: ReconciliationOperationCounts,
 *   closureCandidates: ReconciliationClosureCandidate[],
 * }} ReconciliationSummary
 */

/**
 * @typedef {{
 *   inventory: readonly PublicBead[],
 *   operations: readonly ReconciliationOperation[],
 *   managedIssuesByBeadId: ReadonlyMap<string, ManagedIssueSnapshot>,
 *   summary: ReconciliationSummary,
 * }} ReconciliationPlan
 */

/**
 * @typedef {{
 *   maxCloseCount?: number,
 * }} ReconciliationSafetyLimits
 */

/**
 * @template TValue
 * @typedef {TValue | PromiseLike<TValue>} Awaitable
 */

/**
 * @typedef {{
 *   number: number,
 * }} CreateIssueResult
 */

/**
 * @typedef {{
 *   id: string,
 * }} EnsureProjectItemResult
 */

/**
 * @typedef {{
 *   createIssue: (operation: CreateIssueOperation) => Awaitable<CreateIssueResult>,
 *   updateIssue: (operation: UpdateIssueOperation) => Awaitable<unknown>,
 *   closeIssue: (operation: CloseIssueOperation) => Awaitable<unknown>,
 *   ensureProjectItem: (operation: EnsureProjectItemOperation & { issueNumber: number }) => Awaitable<EnsureProjectItemResult>,
 *   restoreItem: (operation: RestoreItemOperation & { itemId: string }) => Awaitable<unknown>,
 *   setFields: (operation: SetFieldsOperation & { itemId: string }) => Awaitable<unknown>,
 *   syncParent: (operation: SyncParentOperation & { issueNumber: number, parentIssueNumber: number | null }) => Awaitable<unknown>,
 *   syncBlocker: (operation: SyncBlockerOperation & { issueNumber: number, blockerIssueNumbers: number[] }) => Awaitable<unknown>,
 *   archiveItem: (operation: ArchiveItemOperation & { itemId: string }) => Awaitable<unknown>,
 *   updateReadme: (operation: UpdateReadmeOperation) => Awaitable<unknown>,
 * }} ReconciliationAdapters
 */

/**
 * @typedef {{
 *   operation: ReconciliationOperation,
 *   result: unknown,
 * }} AppliedReconciliationOperation
 */

/**
 * @typedef {{
 *   applied: AppliedReconciliationOperation[],
 *   issueNumbersByBeadId: Map<string, number>,
 *   projectItemIdsByBeadId: Map<string, string>,
 * }} AppliedReconciliationResult
 */

/**
 * @typedef {{
 *   failingOperation: ReconciliationOperation,
 *   applied: readonly AppliedReconciliationOperation[],
 *   issueNumbersByBeadId: ReadonlyMap<string, number>,
 *   projectItemIdsByBeadId: ReadonlyMap<string, string>,
 *   cause?: unknown,
 * }} ReconciliationApplyErrorDetails
 */

export class ReconciliationApplyError extends Error {
  /** @type {ReconciliationOperation} */
  failingOperation;

  /** @type {AppliedReconciliationOperation[]} */
  applied;

  /** @type {Map<string, number>} */
  issueNumbersByBeadId;

  /** @type {Map<string, string>} */
  projectItemIdsByBeadId;

  /** @type {unknown} */
  cause;

  /**
   * @param {string} message
   * @param {ReconciliationApplyErrorDetails} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'ReconciliationApplyError';
    this.failingOperation = details.failingOperation;
    this.applied = [...details.applied];
    this.issueNumbersByBeadId = new Map(details.issueNumbersByBeadId);
    this.projectItemIdsByBeadId = new Map(details.projectItemIdsByBeadId);
    this.cause = details.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const README_PATH = 'README.md';
const ISSUE_TITLE_PREFIX_PATTERN = /^\[([^\r\n]+?)\]/u;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string}
 */
function normalizeRequiredTrimmedString(value, fieldName, context) {
  if (typeof value !== 'string') {
    fail(`${context} field "${fieldName}" must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    fail(`${context} field "${fieldName}" must not be empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string | null}
 */
function normalizeOptionalTrimmedString(value, fieldName, context) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`${context} field "${fieldName}" must be a string when present`);
  }
  const normalized = value.trim();
  return normalized || null;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string | null}
 */
function normalizeOptionalMultilineString(value, fieldName, context) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`${context} field "${fieldName}" must be a string when present`);
  }
  return value.replace(/\r\n?/gu, '\n');
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {number}
 */
function normalizePositiveInteger(value, fieldName, context) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${context} field "${fieldName}" must be a positive integer`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {number | null}
 */
function normalizeNullablePositiveInteger(value, fieldName, context) {
  if (value == null) {
    return null;
  }
  return normalizePositiveInteger(value, fieldName, context);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {boolean}
 */
function normalizeBoolean(value, fieldName, context) {
  if (typeof value !== 'boolean') {
    fail(`${context} field "${fieldName}" must be a boolean`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {ProjectFieldValues}
 */
function normalizeFieldMap(value, context) {
  if (value == null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} fields must be an object when present`);
  }

  /** @type {ProjectFieldValues} */
  const fields = {};
  for (const [key, rawFieldValue] of Object.entries(value)) {
    if (
      rawFieldValue !== null
      && typeof rawFieldValue !== 'string'
      && typeof rawFieldValue !== 'number'
      && typeof rawFieldValue !== 'boolean'
    ) {
      fail(`${context} field "${key}" has unsupported value type`);
    }
    fields[key] = rawFieldValue;
  }
  return fields;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {number[]}
 */
function normalizeIssueNumberList(value, context) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${context} must be an array when present`);
  }

  const seen = new Set();
  const issueNumbers = /** @type {number[]} */ ([]);
  for (const entry of value) {
    const issueNumber = normalizePositiveInteger(entry, 'issueNumber', context);
    if (seen.has(issueNumber)) {
      continue;
    }
    seen.add(issueNumber);
    issueNumbers.push(issueNumber);
  }
  return issueNumbers.sort((left, right) => left - right);
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {string[] | null}
 */
function normalizeIssueLabels(value, context) {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(`${context} must be an array when present`);
  }

  const seen = new Set();
  const labels = [];
  for (const entry of value) {
    const label = normalizeRequiredTrimmedString(entry, 'label', context);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }
  return labels.sort(compareStrings);
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {ProjectItemSnapshot | null}
 */
function normalizeProjectItem(value, context) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} projectItem must be an object when present`);
  }

  const projectItem = /** @type {RawProjectItemSnapshot & Record<string, unknown>} */ (value);
  return {
    id: normalizeRequiredTrimmedString(projectItem.id, 'id', `${context} projectItem`),
    archived: projectItem.archived == null
      ? false
      : normalizeBoolean(projectItem.archived, 'archived', `${context} projectItem`),
    fields: normalizeFieldMap(projectItem.fields, `${context} projectItem`),
  };
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {IssueSnapshot}
 */
function normalizeIssueSnapshot(value, context) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }

  const issue = /** @type {RawIssueSnapshot & Record<string, unknown>} */ (value);
  return {
    number: normalizePositiveInteger(issue.number, 'number', context),
    title: normalizeOptionalTrimmedString(issue.title, 'title', context),
    body: normalizeOptionalMultilineString(issue.body, 'body', context),
    state: normalizeOptionalTrimmedString(issue.state, 'state', context)?.toLowerCase() ?? 'open',
    assignee: normalizeOptionalTrimmedString(issue.assignee, 'assignee', context),
    labels: normalizeIssueLabels(issue.labels, `${context} labels`),
    renderHash: normalizeRenderHash(issue.renderHash, 'renderHash', context),
    projectItem: normalizeProjectItem(issue.projectItem, context),
    parentIssueNumber: normalizeNullablePositiveInteger(issue.parentIssueNumber, 'parentIssueNumber', context),
    blockerIssueNumbers: normalizeIssueNumberList(issue.blockerIssueNumbers, `${context} blockerIssueNumbers`),
  };
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {ReadmeSnapshot}
 */
function normalizeReadmeSnapshot(value, context) {
  if (value == null) {
    return {
      body: null,
      renderHash: null,
      path: README_PATH,
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object when present`);
  }

  const readme = /** @type {RawReadmeSnapshot & Record<string, unknown>} */ (value);
  const path = normalizeOptionalTrimmedString(readme.path, 'path', context) ?? README_PATH;
  return {
    body: normalizeOptionalMultilineString(readme.body, 'body', context),
    renderHash: normalizeRenderHash(readme.renderHash, 'renderHash', context),
    path,
  };
}

/**
 * @param {unknown} value
 * @returns {Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'>}
 */
function normalizeRenderContext(value) {
  if (value == null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('planReconciliation input.renderContext must be an object when present');
  }
  return /** @type {Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'>} */ ({ ...value });
}

/**
 * @param {Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'>} context
 */
function resolveMarkerContext(context) {
  const projectMarker = normalizeMarker(
    context.projectMarker ?? DEFAULT_PROJECT_MARKER,
    'planReconciliation projectMarker',
  );
  const issueMarker = normalizeMarker(
    context.issueMarker ?? DEFAULT_ISSUE_MARKER,
    'planReconciliation issueMarker',
  );
  return {
    projectMarker,
    issueMarker,
    recognizedProjectMarkers: resolveRecognizedProjectMarkers(
      projectMarker,
      context.legacyProjectMarkers,
      'planReconciliation projectMarker',
    ),
    recognizedIssueMarkers: recognizedMarkers(
      issueMarker,
      context.legacyIssueMarkers ?? LEGACY_ISSUE_MARKERS,
      'planReconciliation issueMarker',
    ),
  };
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string | null}
 */
function normalizeRenderHash(value, fieldName, context) {
  const hash = normalizeOptionalTrimmedString(value, fieldName, context);
  if (hash == null) {
    return null;
  }
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    fail(`${context} field "${fieldName}" must be a lowercase SHA-256 hex digest`);
  }
  return hash;
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function describeManagedIssueContext(issueNumber) {
  return `Issue #${issueNumber}`;
}

/**
 * @param {string | null} body
 * @param {string} context
 * @param {readonly string[]} issueMarkers
 * @returns {string[]}
 */
function extractIssueMarkers(body, context, issueMarkers) {
  if (body == null) {
    return [];
  }

  return [...body.matchAll(markerPattern(
    issueMarkers,
    'bead-id=([^\\r\\n]*?)',
    'gu',
  ))]
    .map((match) => normalizeBeadId(match[1] ?? '', 'bead-id', context));
}

/**
 * @param {string | null} body
 * @param {readonly string[]} markers
 * @returns {string | null}
 */
function extractRenderHash(body, markers) {
  if (body == null) {
    return null;
  }
  const match = body.match(markerPattern(markers, 'render-hash=([a-f0-9]{64})'));
  return match?.[1] ?? null;
}

/**
 * @param {string | null} title
 * @param {string} context
 * @returns {string | null}
 */
function extractBeadIdFromTitle(title, context) {
  if (title == null) {
    fail(`${context} title has an invalid managed Bead id prefix`);
  }
  const match = title.match(ISSUE_TITLE_PREFIX_PATTERN);
  if (!match) {
    fail(`${context} title has an invalid managed Bead id prefix`);
  }
  const beadId = normalizeBeadId(match[1] ?? '', 'title Bead id', context);
  if (!title.startsWith(`[${beadId}] `)) {
    fail(`${context} title has an invalid managed Bead id prefix`);
  }
  return beadId;
}

/**
 * @param {string} body
 * @param {readonly string[]} markers
 * @returns {string}
 */
function stripRenderHashComment(body, markers) {
  return body.replace(
    new RegExp(`\\n*${markerPattern(
      markers,
      'render-hash=([a-f0-9]{64})',
    ).source}\\s*$`, 'u'),
    '',
  );
}

/**
 * @param {string} body
 * @param {readonly string[]} markers
 * @returns {string}
 */
function normalizeCanonicalBody(body, markers) {
  return stripRenderHashComment(body, markers).replace(/\s+$/u, '');
}

/**
 * @param {string} body
 * @returns {string}
 */
function hashRenderedBody(body) {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * @param {string} body
 * @param {string} renderHash
 * @param {string} marker
 * @returns {string}
 */
function attachRenderHash(body, renderHash, marker) {
  return `${body}\n\n${renderHashMarker(marker, renderHash)}`;
}

/**
 * @param {ProjectFieldValues} currentFields
 * @param {ProjectFieldValues} desiredFields
 * @returns {boolean}
 */
function hasDesiredFieldValues(currentFields, desiredFields) {
  for (const [key, desiredValue] of Object.entries(desiredFields)) {
    if ((currentFields[key] ?? null) !== desiredValue) {
      return false;
    }
  }
  return true;
}

/**
 * @param {IssueSnapshot} issue
 * @param {string} desiredBody
 * @param {string} desiredRenderHash
 * @param {readonly string[]} issueMarkers
 * @returns {boolean}
 */
function hasCurrentRenderedBody(issue, desiredBody, desiredRenderHash, issueMarkers) {
  if (issue.body != null) {
    return normalizeCanonicalBody(issue.body, issueMarkers) === desiredBody;
  }

  return (issue.renderHash ?? extractRenderHash(issue.body, issueMarkers)) === desiredRenderHash;
}

/**
 * @param {ReadmeSnapshot} readme
 * @param {string} desiredBody
 * @param {string} desiredRenderHash
 * @param {readonly string[]} projectMarkers
 * @returns {boolean}
 */
function hasCurrentReadme(readme, desiredBody, desiredRenderHash, projectMarkers) {
  if (readme.body != null) {
    return markerPattern(projectMarkers, 'project-readme').test(readme.body)
      && normalizeCanonicalBody(readme.body, projectMarkers) === desiredBody;
  }

  return (readme.renderHash ?? extractRenderHash(readme.body, projectMarkers)) === desiredRenderHash;
}

/**
 * @param {PublicBead | null | undefined} bead
 * @returns {boolean}
 */
function shouldMirrorRelationshipTarget(bead) {
  return bead != null && bead.status !== 'closed';
}

/**
 * @param {string} beadId
 * @param {PublicBead | null | undefined} bead
 * @returns {ProjectFieldValues}
 */
function buildDesiredFields(beadId, bead) {
  if (bead == null) {
    return {
      beadId,
      status: 'closed',
      done: true,
    };
  }

  return {
    beadId: bead.id,
    status: bead.status,
    type: bead.type,
    priority: Number(bead.priority),
    blocked: Boolean(bead.blocked),
    done: bead.status === 'closed',
    parentGoal: bead.parentId ?? null,
    sourceUpdated: bead.updatedAt.slice(0, 10),
  };
}

/**
 * @param {ReadonlyMap<string, ManagedIssueSnapshot>} managedIssuesByBeadId
 * @param {string | null} beadId
 * @returns {number | null}
 */
function resolveKnownIssueNumber(managedIssuesByBeadId, beadId) {
  if (beadId == null) {
    return null;
  }
  return managedIssuesByBeadId.get(beadId)?.number ?? null;
}

/**
 * @param {readonly number[]} left
 * @param {readonly number[]} right
 * @returns {boolean}
 */
function numberListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

/**
 * @param {unknown} input
 * @returns {PlanReconciliationInput}
 */
function normalizePlanInput(input) {
  if (typeof input !== 'object' || input == null || Array.isArray(input)) {
    fail('planReconciliation expected an input object');
  }

  const normalizedInput = /** @type {RawPlanReconciliationInput & Record<string, unknown>} */ (input);
  if (!Array.isArray(normalizedInput.inventory)) {
    fail('planReconciliation input.inventory must be an array');
  }

  const inventory = /** @type {readonly PublicBead[]} */ (normalizedInput.inventory);
  const existingIssues = normalizedInput.existingIssues == null
    ? []
    : Array.isArray(normalizedInput.existingIssues)
      ? normalizedInput.existingIssues.map((issue, index) => normalizeIssueSnapshot(
        issue,
        `planReconciliation input.existingIssues[${index}]`,
      ))
      : fail('planReconciliation input.existingIssues must be an array when present');

  return {
    inventory,
    existingIssues,
    readme: normalizeReadmeSnapshot(normalizedInput.readme, 'planReconciliation input.readme'),
    renderContext: normalizeRenderContext(normalizedInput.renderContext),
  };
}

/**
 * @param {readonly IssueSnapshot[]} existingIssues
 * @param {readonly string[]} issueMarkers
 * @returns {Map<string, ManagedIssueSnapshot>}
 */
function indexManagedIssues(existingIssues, issueMarkers) {
  const managedIssuesByBeadId = /** @type {Map<string, ManagedIssueSnapshot>} */ (new Map());

  for (const issue of existingIssues) {
    const issueContext = describeManagedIssueContext(issue.number);
    const markers = extractIssueMarkers(issue.body, issueContext, issueMarkers);
    if (markers.length > 1) {
      fail(`Issue #${issue.number} contains duplicate managed markers`);
    }

    const beadId = markers[0]
      ?? (
        issue.renderHash != null
          ? extractBeadIdFromTitle(issue.title, issueContext)
          : null
      );
    if (beadId == null) {
      continue;
    }
    if (managedIssuesByBeadId.has(beadId)) {
      fail(`Duplicate managed marker for bead "${beadId}"`);
    }

    managedIssuesByBeadId.set(beadId, {
      ...issue,
      beadId,
    });
  }

  return managedIssuesByBeadId;
}

/**
 * @param {readonly PublicBead[]} inventory
 * @param {Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'>} renderContext
 * @returns {RenderContext}
 */
function buildIssueRenderContext(inventory, renderContext) {
  return {
    ...renderContext,
    inventoryById: buildBeadIndex(inventory).byId,
  };
}

/**
 * @param {PublicBead} bead
 * @returns {string[]}
 */
function desiredIssueLabels(bead) {
  const labels = ['bead', `priority:P${bead.priority}`];
  if (bead.type === 'epic' || bead.type === 'feature' || bead.type === 'task') {
    labels.push(`bead:${bead.type}`);
  }
  if (bead.blocked) {
    labels.push('status:blocked');
  }
  return labels.sort(compareStrings);
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
function stringListsEqual(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * @param {readonly PublicBead[]} inventory
 * @param {ReadonlyMap<string, ManagedIssueSnapshot>} managedIssuesByBeadId
 * @param {CreateIssueOperation[]} createIssues
 * @param {UpdateIssueOperation[]} updateIssues
 * @param {CloseIssueOperation[]} closeIssues
 * @param {EnsureProjectItemOperation[]} ensureProjectItems
 * @param {RestoreItemOperation[]} restoreItems
 * @param {SetFieldsOperation[]} setFields
 * @param {SyncParentOperation[]} syncParents
 * @param {SyncBlockerOperation[]} syncBlockers
 * @param {ArchiveItemOperation[]} archiveItems
 * @param {UpdateReadmeOperation[]} updateReadmeOperations
 * @returns {ReconciliationSummary}
 */
function buildSummary(
  inventory,
  managedIssuesByBeadId,
  createIssues,
  updateIssues,
  closeIssues,
  ensureProjectItems,
  restoreItems,
  setFields,
  syncParents,
  syncBlockers,
  archiveItems,
  updateReadmeOperations,
) {
  const sourceActive = activeBeads(inventory);
  const managedOpenCount = [...managedIssuesByBeadId.values()]
    .filter((issue) => issue.state !== 'closed')
    .length;
  const operationCounts = {
    createIssue: createIssues.length,
    updateIssue: updateIssues.length,
    closeIssue: closeIssues.length,
    ensureProjectItem: ensureProjectItems.length,
    restoreItem: restoreItems.length,
    setFields: setFields.length,
    syncParent: syncParents.length,
    syncBlocker: syncBlockers.length,
    archiveItem: archiveItems.length,
    updateReadme: updateReadmeOperations.length,
  };
  const closureCandidates = closeIssues.map((operation) => ({
    beadId: operation.beadId,
    issueNumber: operation.issueNumber,
    issueTitle: managedIssuesByBeadId.get(operation.beadId)?.title ?? null,
  }));

  return {
    sourceTotal: inventory.length,
    sourceActive: sourceActive.length,
    sourceClosed: inventory.length - sourceActive.length,
    managedTotal: managedIssuesByBeadId.size,
    managedOpenCount,
    defaultMaxCloseCount: Math.max(5, Math.ceil(managedOpenCount * 0.25)),
    createIssueCount: createIssues.length,
    updateIssueCount: updateIssues.length,
    closeIssueCount: closeIssues.length,
    ensureProjectItemCount: ensureProjectItems.length,
    restoreItemCount: restoreItems.length,
    setFieldsCount: setFields.length,
    syncParentCount: syncParents.length,
    syncBlockerCount: syncBlockers.length,
    archiveItemCount: archiveItems.length,
    updateReadmeCount: updateReadmeOperations.length,
    operationCounts,
    closureCandidates,
  };
}

/**
 * @param {PlanReconciliationInput} input
 * @returns {ReconciliationPlan}
 */
export function planReconciliation(input) {
  const normalizedInput = normalizePlanInput(input);
  const markerContext = resolveMarkerContext(normalizedInput.renderContext ?? {});
  const inventory = [...normalizedInput.inventory];
  if (inventory.length === 0) {
    fail('planReconciliation cannot reconcile an empty source inventory');
  }

  const inventoryIndex = buildBeadIndex(inventory);
  const managedIssuesByBeadId = indexManagedIssues(
    normalizedInput.existingIssues ?? [],
    markerContext.recognizedIssueMarkers,
  );
  const issueRenderContext = buildIssueRenderContext(inventory, normalizedInput.renderContext ?? {});
  const sortedActiveBeads = activeBeads(inventory).slice().sort((left, right) => compareStrings(left.id, right.id));
  const activeBeadIds = new Set(sortedActiveBeads.map((bead) => bead.id));

  /** @type {CreateIssueOperation[]} */
  const createIssues = [];
  /** @type {UpdateIssueOperation[]} */
  const updateIssues = [];
  /** @type {CloseIssueOperation[]} */
  const closeIssues = [];
  /** @type {EnsureProjectItemOperation[]} */
  const ensureProjectItems = [];
  /** @type {RestoreItemOperation[]} */
  const restoreItems = [];
  /** @type {SetFieldsOperation[]} */
  const setFields = [];
  /** @type {SyncParentOperation[]} */
  const syncParents = [];
  /** @type {SyncBlockerOperation[]} */
  const syncBlockers = [];
  /** @type {ArchiveItemOperation[]} */
  const archiveItems = [];
  /** @type {UpdateReadmeOperation[]} */
  const updateReadmeOperations = [];

  for (const bead of sortedActiveBeads) {
    const existingIssue = managedIssuesByBeadId.get(bead.id);
    const renderedBody = renderIssueBody(bead, issueRenderContext);
    const renderHash = hashRenderedBody(renderedBody);
    const managedBody = attachRenderHash(renderedBody, renderHash, markerContext.issueMarker);
    const title = renderIssueTitle(bead);
    const assignee = bead.githubAssignee ?? null;

    if (!existingIssue) {
      createIssues.push({
        type: 'createIssue',
        phase: 'createIssues',
        beadId: bead.id,
        title,
        body: managedBody,
        renderHash,
        assignee,
        state: 'open',
      });
    } else {
      const issueNeedsUpdate = (
        existingIssue.title !== title
        || existingIssue.assignee !== assignee
        || existingIssue.state === 'closed'
        || (
          existingIssue.labels != null
          && !stringListsEqual(existingIssue.labels, desiredIssueLabels(bead))
        )
        || !hasCurrentRenderedBody(
          existingIssue,
          renderedBody,
          renderHash,
          markerContext.recognizedIssueMarkers,
        )
      );

      if (issueNeedsUpdate) {
        updateIssues.push({
          type: 'updateIssue',
          phase: 'updateIssues',
          beadId: bead.id,
          issueNumber: existingIssue.number,
          title,
          body: managedBody,
          renderHash,
          assignee,
          state: 'open',
        });
      }
    }

    if (existingIssue?.projectItem == null) {
      ensureProjectItems.push({
        type: 'ensureProjectItem',
        phase: 'ensureProjectItems',
        beadId: bead.id,
        issueNumber: existingIssue?.number,
      });
    }

    if (existingIssue?.projectItem?.archived) {
      restoreItems.push({
        type: 'restoreItem',
        phase: 'restoreItems',
        beadId: bead.id,
        itemId: existingIssue.projectItem.id,
      });
    }

    const desiredFields = buildDesiredFields(bead.id, bead);
    if (!hasDesiredFieldValues(existingIssue?.projectItem?.fields ?? {}, desiredFields)) {
      setFields.push({
        type: 'setFields',
        phase: 'setFields',
        beadId: bead.id,
        itemId: existingIssue?.projectItem?.id,
        fields: desiredFields,
      });
    }

    const desiredParentBeadId = shouldMirrorRelationshipTarget(
      bead.parentId == null ? null : inventoryIndex.byId.get(bead.parentId),
    )
      ? bead.parentId
      : null;
    const knownParentIssueNumber = resolveKnownIssueNumber(managedIssuesByBeadId, desiredParentBeadId);
    if (
      desiredParentBeadId == null
        ? existingIssue?.parentIssueNumber != null
        : knownParentIssueNumber == null || existingIssue?.parentIssueNumber !== knownParentIssueNumber
    ) {
      syncParents.push({
        type: 'syncParent',
        phase: 'syncParents',
        beadId: bead.id,
        parentBeadId: desiredParentBeadId,
        parentIssueNumber: knownParentIssueNumber,
        currentParentIssueNumber: existingIssue?.parentIssueNumber ?? null,
      });
    }

    const desiredBlockerBeadIds = [...bead.blockedByIds]
      .filter((blockedById) => shouldMirrorRelationshipTarget(inventoryIndex.byId.get(blockedById)))
      .sort(compareStrings);
    const desiredKnownBlockerIssueNumbers = desiredBlockerBeadIds
      .map((blockedById) => resolveKnownIssueNumber(managedIssuesByBeadId, blockedById))
      .filter((issueNumber) => issueNumber != null)
      .sort((left, right) => left - right);

    if (
      desiredBlockerBeadIds.some((blockedById) => !managedIssuesByBeadId.has(blockedById))
      || !numberListsEqual(existingIssue?.blockerIssueNumbers ?? [], desiredKnownBlockerIssueNumbers)
    ) {
      syncBlockers.push({
        type: 'syncBlocker',
        phase: 'syncBlockers',
        beadId: bead.id,
        blockerBeadIds: desiredBlockerBeadIds,
        blockerIssueNumbers: desiredKnownBlockerIssueNumbers,
        currentBlockerIssueNumbers: [...(existingIssue?.blockerIssueNumbers ?? [])],
      });
    }
  }

  const closableBeadIds = [...managedIssuesByBeadId.keys()]
    .filter((beadId) => !activeBeadIds.has(beadId))
    .sort(compareStrings);

  for (const beadId of closableBeadIds) {
    const existingIssue = managedIssuesByBeadId.get(beadId);
    if (!existingIssue) {
      continue;
    }

    const sourceBead = inventoryIndex.byId.get(beadId) ?? null;
    if (existingIssue.state !== 'closed') {
      closeIssues.push({
        type: 'closeIssue',
        phase: 'closeIssues',
        beadId,
        issueNumber: existingIssue.number,
      });
    }

    const desiredFields = buildDesiredFields(beadId, sourceBead);
    if (existingIssue.projectItem == null && existingIssue.state !== 'closed') {
      ensureProjectItems.push({
        type: 'ensureProjectItem',
        phase: 'ensureProjectItems',
        beadId,
        issueNumber: existingIssue.number,
      });
    }

    if (
      existingIssue.projectItem != null
      || existingIssue.state !== 'closed'
    ) {
      if (!hasDesiredFieldValues(existingIssue.projectItem?.fields ?? {}, desiredFields)) {
        setFields.push({
          type: 'setFields',
          phase: 'setFields',
          beadId,
          itemId: existingIssue.projectItem?.id,
          fields: desiredFields,
        });
      }

      if (!existingIssue.projectItem?.archived) {
        archiveItems.push({
          type: 'archiveItem',
          phase: 'archiveItems',
          beadId,
          itemId: existingIssue.projectItem?.id,
        });
      }
    }
  }

  const renderedReadmeBody = renderProjectReadme(inventory, normalizedInput.renderContext ?? {});
  const readmeRenderHash = hashRenderedBody(renderedReadmeBody);
  if (!hasCurrentReadme(
    normalizedInput.readme ?? normalizeReadmeSnapshot(null, 'plan'),
    renderedReadmeBody,
    readmeRenderHash,
    markerContext.recognizedProjectMarkers,
  )) {
    updateReadmeOperations.push({
      type: 'updateReadme',
      phase: 'updateReadme',
      path: (normalizedInput.readme ?? normalizeReadmeSnapshot(null, 'plan')).path,
      body: attachRenderHash(renderedReadmeBody, readmeRenderHash, markerContext.projectMarker),
      renderHash: readmeRenderHash,
    });
  }

  const operations = /** @type {ReconciliationOperation[]} */ ([
    ...createIssues,
    ...updateIssues,
    ...closeIssues,
    ...ensureProjectItems,
    ...restoreItems,
    ...setFields,
    ...syncParents,
    ...syncBlockers,
    ...archiveItems,
    ...updateReadmeOperations,
  ]);

  return {
    inventory,
    operations,
    managedIssuesByBeadId,
    summary: buildSummary(
      inventory,
      managedIssuesByBeadId,
      createIssues,
      updateIssues,
      closeIssues,
      ensureProjectItems,
      restoreItems,
      setFields,
      syncParents,
      syncBlockers,
      archiveItems,
      updateReadmeOperations,
    ),
  };
}

/**
 * @param {ReconciliationPlan} plan
 * @param {ReconciliationSafetyLimits} [limits={}]
 */
export function assertSafePlan(plan, limits = {}) {
  const maxCloseCount = limits.maxCloseCount == null
    ? plan.summary.defaultMaxCloseCount
    : (
      typeof limits.maxCloseCount === 'number'
      && Number.isInteger(limits.maxCloseCount)
      && limits.maxCloseCount >= 0
        ? limits.maxCloseCount
        : fail('assertSafePlan limits.maxCloseCount must be a non-negative integer when present')
    );

  if (plan.summary.closeIssueCount > maxCloseCount) {
    fail(
      `Refusing to close ${plan.summary.closeIssueCount} managed issues; limit is ${maxCloseCount}`,
    );
  }
}

/**
 * @param {Map<string, number>} issueNumbersByBeadId
 * @param {string} beadId
 * @param {string} context
 * @returns {number}
 */
function requireResolvedIssueNumber(issueNumbersByBeadId, beadId, context) {
  const issueNumber = issueNumbersByBeadId.get(beadId);
  if (issueNumber == null) {
    fail(`${context} missing issue number for bead "${beadId}"`);
  }
  return issueNumber;
}

/**
 * @param {Map<string, string>} projectItemIdsByBeadId
 * @param {string} beadId
 * @param {string} context
 * @returns {string}
 */
function requireResolvedProjectItemId(projectItemIdsByBeadId, beadId, context) {
  const itemId = projectItemIdsByBeadId.get(beadId);
  if (itemId == null) {
    fail(`${context} missing project item id for bead "${beadId}"`);
  }
  return itemId;
}

/**
 * @param {ReconciliationOperation} operation
 * @returns {string}
 */
function describeReconciliationOperationTarget(operation) {
  if ('beadId' in operation) {
    return `bead "${operation.beadId}"`;
  }
  return `README "${operation.path}"`;
}

/**
 * @param {ReconciliationOperation} failingOperation
 * @param {unknown} cause
 * @param {readonly AppliedReconciliationOperation[]} applied
 * @param {ReadonlyMap<string, number>} issueNumbersByBeadId
 * @param {ReadonlyMap<string, string>} projectItemIdsByBeadId
 * @returns {ReconciliationApplyError}
 */
function toReconciliationApplyError(
  failingOperation,
  cause,
  applied,
  issueNumbersByBeadId,
  projectItemIdsByBeadId,
) {
  if (cause instanceof ReconciliationApplyError) {
    return cause;
  }

  return new ReconciliationApplyError(
    `applyReconciliation failed during ${failingOperation.type} for ${describeReconciliationOperationTarget(failingOperation)}`,
    {
      failingOperation,
      applied,
      issueNumbersByBeadId,
      projectItemIdsByBeadId,
      cause,
    },
  );
}

/**
 * @param {ReconciliationPlan} plan
 * @param {ReconciliationAdapters} adapters
 * @returns {Promise<AppliedReconciliationResult>}
 */
export async function applyReconciliation(plan, adapters) {
  if (typeof adapters !== 'object' || adapters == null) {
    fail('applyReconciliation expected an adapters object');
  }

  const issueNumbersByBeadId = /** @type {Map<string, number>} */ (new Map());
  const projectItemIdsByBeadId = /** @type {Map<string, string>} */ (new Map());
  for (const [beadId, issue] of plan.managedIssuesByBeadId.entries()) {
    issueNumbersByBeadId.set(beadId, issue.number);
    if (issue.projectItem?.id) {
      projectItemIdsByBeadId.set(beadId, issue.projectItem.id);
    }
  }

  /** @type {AppliedReconciliationOperation[]} */
  const applied = [];

  for (const operation of plan.operations) {
    /** @type {ReconciliationOperation} */
    let failingOperation = operation;

    try {
      switch (operation.type) {
        case 'createIssue': {
          const createIssue = adapters.createIssue ?? fail('applyReconciliation requires adapters.createIssue');
          const result = await createIssue(operation);
          const issueNumber = normalizePositiveInteger(
            result?.number,
            'number',
            `createIssue result for bead "${operation.beadId}"`,
          );
          issueNumbersByBeadId.set(operation.beadId, issueNumber);
          applied.push({ operation, result });
          break;
        }
        case 'updateIssue': {
          const updateIssue = adapters.updateIssue ?? fail('applyReconciliation requires adapters.updateIssue');
          const result = await updateIssue(operation);
          issueNumbersByBeadId.set(operation.beadId, operation.issueNumber);
          applied.push({ operation, result });
          break;
        }
        case 'closeIssue': {
          const closeIssue = adapters.closeIssue ?? fail('applyReconciliation requires adapters.closeIssue');
          const result = await closeIssue(operation);
          issueNumbersByBeadId.set(operation.beadId, operation.issueNumber);
          applied.push({ operation, result });
          break;
        }
        case 'ensureProjectItem': {
          const ensureProjectItem =
            adapters.ensureProjectItem ?? fail('applyReconciliation requires adapters.ensureProjectItem');
          const issueNumber = operation.issueNumber
            ?? requireResolvedIssueNumber(
              issueNumbersByBeadId,
              operation.beadId,
              'ensureProjectItem operation',
            );
          const resolvedOperation = {
            ...operation,
            issueNumber,
          };
          failingOperation = resolvedOperation;
          const result = await ensureProjectItem(resolvedOperation);
          const itemId = normalizeRequiredTrimmedString(
            result?.id,
            'id',
            `ensureProjectItem result for bead "${operation.beadId}"`,
          );
          projectItemIdsByBeadId.set(operation.beadId, itemId);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'restoreItem': {
          const restoreItem = adapters.restoreItem ?? fail('applyReconciliation requires adapters.restoreItem');
          const itemId = operation.itemId
            ?? requireResolvedProjectItemId(projectItemIdsByBeadId, operation.beadId, 'restoreItem operation');
          const resolvedOperation = {
            ...operation,
            itemId,
          };
          failingOperation = resolvedOperation;
          const result = await restoreItem(resolvedOperation);
          projectItemIdsByBeadId.set(operation.beadId, itemId);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'setFields': {
          const setFieldsAdapter = adapters.setFields ?? fail('applyReconciliation requires adapters.setFields');
          const itemId = operation.itemId
            ?? requireResolvedProjectItemId(projectItemIdsByBeadId, operation.beadId, 'setFields operation');
          const resolvedOperation = {
            ...operation,
            itemId,
          };
          failingOperation = resolvedOperation;
          const result = await setFieldsAdapter(resolvedOperation);
          projectItemIdsByBeadId.set(operation.beadId, itemId);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'syncParent': {
          const syncParent = adapters.syncParent ?? fail('applyReconciliation requires adapters.syncParent');
          const issueNumber = requireResolvedIssueNumber(issueNumbersByBeadId, operation.beadId, 'syncParent operation');
          const parentIssueNumber = operation.parentBeadId == null
            ? null
            : requireResolvedIssueNumber(
              issueNumbersByBeadId,
              operation.parentBeadId,
              'syncParent operation',
            );
          const resolvedOperation = {
            ...operation,
            issueNumber,
            parentIssueNumber,
          };
          failingOperation = resolvedOperation;
          const result = await syncParent(resolvedOperation);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'syncBlocker': {
          const syncBlocker = adapters.syncBlocker ?? fail('applyReconciliation requires adapters.syncBlocker');
          const issueNumber = requireResolvedIssueNumber(issueNumbersByBeadId, operation.beadId, 'syncBlocker operation');
          const blockerIssueNumbers = operation.blockerBeadIds
            .map((blockedById) => requireResolvedIssueNumber(issueNumbersByBeadId, blockedById, 'syncBlocker operation'));
          const resolvedOperation = {
            ...operation,
            issueNumber,
            blockerIssueNumbers,
          };
          failingOperation = resolvedOperation;
          const result = await syncBlocker(resolvedOperation);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'archiveItem': {
          const archiveItem = adapters.archiveItem ?? fail('applyReconciliation requires adapters.archiveItem');
          const itemId = operation.itemId
            ?? requireResolvedProjectItemId(projectItemIdsByBeadId, operation.beadId, 'archiveItem operation');
          const resolvedOperation = {
            ...operation,
            itemId,
          };
          failingOperation = resolvedOperation;
          const result = await archiveItem(resolvedOperation);
          applied.push({ operation: resolvedOperation, result });
          break;
        }
        case 'updateReadme': {
          const updateReadme = adapters.updateReadme ?? fail('applyReconciliation requires adapters.updateReadme');
          const result = await updateReadme(operation);
          applied.push({ operation, result });
          break;
        }
        default:
          fail(`Unsupported reconciliation operation "${/** @type {{ type?: unknown }} */ (operation).type}"`);
      }
    } catch (error) {
      throw toReconciliationApplyError(
        failingOperation,
        error,
        applied,
        issueNumbersByBeadId,
        projectItemIdsByBeadId,
      );
    }
  }

  return {
    applied,
    issueNumbersByBeadId,
    projectItemIdsByBeadId,
  };
}
