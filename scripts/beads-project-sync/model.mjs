// @ts-check

/**
 * @typedef {0 | 1 | 2 | 3 | 4} BeadPriority
 */

/**
 * @typedef {{
 *   issue_id?: unknown,
 *   type?: unknown,
 *   depends_on_id?: unknown,
 * }} RawDependencyRecord
 */

/**
 * @typedef {{
 *   _type?: unknown,
 *   id?: unknown,
 *   issue_type?: unknown,
 *   title?: unknown,
 *   description?: unknown,
 *   design?: unknown,
 *   spec_id?: unknown,
 *   acceptance_criteria?: unknown,
 *   notes?: unknown,
 *   status?: unknown,
 *   priority?: unknown,
 *   labels?: unknown,
 *   dependencies?: unknown,
 *   assignee?: unknown,
 *   created_at?: unknown,
 *   updated_at?: unknown,
 *   closed_at?: unknown,
 * }} RawBeadRecord
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string | null,
 *   design: string | null,
 *   specId: string | null,
 *   acceptanceCriteria: string | null,
 *   notes: string | null,
 *   status: string,
 *   priority: BeadPriority,
 *   type: string,
 *   blocked: boolean,
 *   labels: string[],
 *   parentId: string | null,
 *   blockedByIds: string[],
 *   githubAssignee: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   closedAt: string | null,
 * }} ParsedBead
 */

/**
 * @typedef {{
 *   assigneeMap?: ReadonlyMap<string, string> | Record<string, string>,
 * }} ParseBeadExportConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   parentId?: string | null,
 *   blockedByIds?: readonly string[] | null,
 * }} IndexableBead
 */

const unsupportedRecordTypes = new Set(['infrastructure', 'memory', 'template', 'gate', 'wisp']);
export const PUBLIC_BEAD_TYPES = Object.freeze([
  'epic',
  'feature',
  'task',
  'bug',
  'chore',
  'decision',
]);
const supportedPublicBeadTypes = new Set(PUBLIC_BEAD_TYPES);
const BEAD_ID_SOURCE = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?';
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

export const BEAD_ID_PATTERN = new RegExp(`^${BEAD_ID_SOURCE}$`, 'u');

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
function normalizeRequiredString(value, fieldName, context) {
  if (typeof value !== 'string') {
    fail(`${context} must include string field "${fieldName}"`);
  }

  const normalized = value.trim();
  if (!normalized) {
    if (fieldName === 'id') {
      fail(`${context} has an empty id`);
    }
    fail(`${context} has an empty "${fieldName}"`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string}
 */
export function normalizeBeadId(value, fieldName, context) {
  const normalized = normalizeRequiredString(value, fieldName, context);
  if (!BEAD_ID_PATTERN.test(normalized)) {
    fail(`${context} field "${fieldName}" must be a valid Bead id using only letters, digits, dots, or hyphens`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {string}
 */
export function normalizePublicBeadType(value, context) {
  const normalized = normalizeRequiredString(value, 'issue_type', context);
  if (!supportedPublicBeadTypes.has(normalized)) {
    fail(`${context} has unsupported public Bead type "${normalized}"`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} context
 * @returns {string | null}
 */
function normalizeOptionalString(value, fieldName, context) {
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
 * @param {boolean} optional
 * @returns {string | null}
 */
function normalizeDateTime(value, fieldName, context, optional) {
  if (value == null && optional) {
    return null;
  }
  const normalized = normalizeRequiredString(value, fieldName, context);
  const match = normalized.match(DATE_TIME_PATTERN);
  if (!match) {
    fail(`${context} field "${fieldName}" must be a valid date-time`);
  }

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , rawOffset] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const offsetHour = rawOffset === 'Z' ? 0 : Number(rawOffset.slice(1, 3));
  const offsetMinute = rawOffset === 'Z' ? 0 : Number(rawOffset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0;
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    fail(`${context} field "${fieldName}" must be a valid date-time`);
  }

  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    fail(`${context} field "${fieldName}" must be a valid date-time`);
  }
  try {
    return new Date(milliseconds).toISOString().replace(/\.000Z$/u, 'Z');
  } catch {
    fail(`${context} field "${fieldName}" must be a valid date-time`);
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {BeadPriority}
 */
export function normalizeBeadPriority(value, context) {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > 4
  ) {
    fail(`${context} must be an integer from 0 to 4`);
  }
  return /** @type {BeadPriority} */ (value);
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function hasCurrentField(key) {
  return /^current(?:_|[A-Z]|$)/.test(key);
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} context
 */
function assertNoCurrentFields(record, context) {
  const currentField = Object.keys(record).find(hasCurrentField);
  if (currentField) {
    fail(`${context} uses unsupported current field "${currentField}"`);
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {string[]}
 */
function normalizeLabels(value, context) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${context} field "labels" must be an array`);
  }

  const labels = /** @type {string[]} */ ([]);
  const seen = new Set();
  for (const entry of value) {
    const label = normalizeRequiredString(entry, 'label', context);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * @param {ParseBeadExportConfig['assigneeMap'] | null | undefined} assigneeMap
 * @returns {Map<string, string>}
 */
function normalizeAssigneeMap(assigneeMap) {
  if (assigneeMap == null) {
    return new Map();
  }

  /** @type {Iterable<readonly [string, string]>} */
  const entries = assigneeMap instanceof Map
    ? assigneeMap.entries()
    : typeof assigneeMap === 'object'
      ? Object.entries(assigneeMap)
      : fail('parseBeadExport config.assigneeMap must be an object or Map');

  const normalized = new Map();
  for (const [rawAssignee, rawGithubAssignee] of entries) {
    const assignee = normalizeRequiredString(rawAssignee, 'assigneeMap key', 'parseBeadExport config');
    const githubAssignee = normalizeRequiredString(
      rawGithubAssignee,
      'assigneeMap value',
      'parseBeadExport config',
    );
    normalized.set(assignee, githubAssignee);
  }
  return normalized;
}

/**
 * @template TValue
 * @param {Map<string, TValue[]>} map
 * @param {string} key
 * @param {TValue} value
 */
function pushGrouped(map, key, value) {
  const current = map.get(key);
  if (current) {
    current.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * @param {unknown} value
 * @param {string} recordId
 * @param {number} lineNumber
 * @returns {{ parentId: string | null, blockedByIds: string[] }}
 */
function normalizeDependencies(value, recordId, lineNumber) {
  if (value == null) {
    return { parentId: null, blockedByIds: [] };
  }
  if (!Array.isArray(value)) {
    fail(`Beads record "${recordId}" on line ${lineNumber} field "dependencies" must be an array`);
  }

  let parentId = null;
  const blockedByIds = /** @type {string[]} */ ([]);
  const seenBlockers = new Set();
  for (const dependency of value) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      fail(`Beads record "${recordId}" on line ${lineNumber} has an invalid dependency entry`);
    }
    const dependencyRecord = /** @type {RawDependencyRecord & Record<string, unknown>} */ (dependency);
    assertNoCurrentFields(dependencyRecord, `Beads dependency for "${recordId}" on line ${lineNumber}`);

    if (
      dependencyRecord.issue_id != null
      && normalizeBeadId(
        dependencyRecord.issue_id,
        'issue_id',
        `Beads dependency for "${recordId}" on line ${lineNumber}`,
      ) !== recordId
    ) {
      fail(
        `Beads dependency for "${recordId}" on line ${lineNumber} targets issue_id "${dependencyRecord.issue_id}"`,
      );
    }

    const dependencyType = normalizeRequiredString(
      dependencyRecord.type,
      'type',
      `Beads dependency for "${recordId}" on line ${lineNumber}`,
    );
    const dependsOnId = normalizeBeadId(
      dependencyRecord.depends_on_id,
      'depends_on_id',
      `Beads dependency for "${recordId}" on line ${lineNumber}`,
    );

    if (dependencyType === 'parent-child') {
      if (parentId !== null) {
        fail(`Beads record "${recordId}" on line ${lineNumber} has multiple parents`);
      }
      parentId = dependsOnId;
      continue;
    }

    if (dependencyType === 'blocks') {
      if (!seenBlockers.has(dependsOnId)) {
        seenBlockers.add(dependsOnId);
        blockedByIds.push(dependsOnId);
      }
      continue;
    }

    fail(
      `Beads record "${recordId}" on line ${lineNumber} has unsupported dependency type "${dependencyType}"`,
    );
  }

  return {
    parentId,
    blockedByIds: blockedByIds.sort(compareStrings),
  };
}

/**
 * @param {unknown} record
 * @param {number} lineNumber
 * @param {Map<string, string>} assigneeMap
 * @returns {ParsedBead}
 */
function normalizeRecord(record, lineNumber, assigneeMap) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`Malformed Beads record on line ${lineNumber}`);
  }

  const beadRecord = /** @type {RawBeadRecord & Record<string, unknown>} */ (record);
  assertNoCurrentFields(beadRecord, `Beads record on line ${lineNumber}`);

  const recordType = normalizeRequiredString(
    beadRecord._type,
    '_type',
    `Beads record on line ${lineNumber}`,
  );
  if (unsupportedRecordTypes.has(recordType)) {
    fail(`Unsupported Beads record type "${recordType}" on line ${lineNumber}`);
  }
  if (recordType !== 'issue') {
    fail(`Unsupported Beads record type "${recordType}" on line ${lineNumber}`);
  }

  const id = normalizeBeadId(beadRecord.id, 'id', `Beads record on line ${lineNumber}`);
  const issueType = normalizePublicBeadType(
    beadRecord.issue_type,
    `Beads record "${id}" on line ${lineNumber}`,
  );

  const { parentId, blockedByIds } = normalizeDependencies(beadRecord.dependencies, id, lineNumber);
  const rawAssignee = normalizeOptionalString(
    beadRecord.assignee,
    'assignee',
    `Beads record "${id}" on line ${lineNumber}`,
  );

  return {
    id,
    title: normalizeRequiredString(
      beadRecord.title,
      'title',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    description: normalizeOptionalString(
      beadRecord.description,
      'description',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    design: normalizeOptionalString(
      beadRecord.design,
      'design',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    specId: normalizeOptionalString(
      beadRecord.spec_id,
      'spec_id',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    acceptanceCriteria: normalizeOptionalString(
      beadRecord.acceptance_criteria,
      'acceptance_criteria',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    notes: normalizeOptionalString(
      beadRecord.notes,
      'notes',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    status: normalizeRequiredString(
      beadRecord.status,
      'status',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    priority: normalizeBeadPriority(
      beadRecord.priority,
      `Beads record "${id}" on line ${lineNumber} field "priority"`,
    ),
    type: issueType,
    blocked: false,
    labels: normalizeLabels(beadRecord.labels, `Beads record "${id}" on line ${lineNumber}`),
    parentId,
    blockedByIds,
    githubAssignee: rawAssignee == null ? null : assigneeMap.get(rawAssignee) ?? null,
    createdAt: /** @type {string} */ (normalizeDateTime(
      beadRecord.created_at,
      'created_at',
      `Beads record "${id}" on line ${lineNumber}`,
      false,
    )),
    updatedAt: /** @type {string} */ (normalizeDateTime(
      beadRecord.updated_at,
      'updated_at',
      `Beads record "${id}" on line ${lineNumber}`,
      false,
    )),
    closedAt: normalizeDateTime(
      beadRecord.closed_at,
      'closed_at',
      `Beads record "${id}" on line ${lineNumber}`,
      true,
    ),
  };
}

/**
 * @param {string} jsonl
 * @param {ParseBeadExportConfig} [config={}]
 * @returns {ParsedBead[]}
 */
export function parseBeadExport(jsonl, config = {}) {
  if (typeof jsonl !== 'string') {
    fail('Bead export JSONL must be a string');
  }

  const assigneeMap = normalizeAssigneeMap(config.assigneeMap);
  const beads = /** @type {ParsedBead[]} */ ([]);
  const seenIds = new Set();
  for (const [index, rawLine] of jsonl.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    /** @type {unknown} */
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Malformed JSON on line ${lineNumber}: ${detail}`);
    }

    const bead = normalizeRecord(record, lineNumber, assigneeMap);
    if (seenIds.has(bead.id)) {
      fail(`Duplicate Beads id "${bead.id}" on line ${lineNumber}`);
    }
    seenIds.add(bead.id);
    beads.push(bead);
  }

  const index = new Map(beads.map((bead) => [bead.id, bead]));
  for (const bead of beads) {
    bead.blocked = bead.status !== 'closed'
      && bead.blockedByIds.some((blockedById) => index.get(blockedById)?.status !== 'closed');
  }

  return beads;
}

/**
 * @template {IndexableBead} TBead
 * @param {readonly TBead[]} beads
 * @returns {{
 *   byId: Map<string, TBead>,
 *   childrenByParentId: Map<string, TBead[]>,
 *   dependentsByBlockerId: Map<string, TBead[]>,
 * }}
 */
export function buildBeadIndex(beads) {
  const byId = /** @type {Map<string, TBead>} */ (new Map());
  const childrenByParentId = /** @type {Map<string, TBead[]>} */ (new Map());
  const dependentsByBlockerId = /** @type {Map<string, TBead[]>} */ (new Map());

  for (const bead of beads) {
    const beadId = normalizeBeadId(bead?.id, 'id', 'buildBeadIndex bead');
    if (byId.has(beadId)) {
      fail(`buildBeadIndex received duplicate id "${beadId}"`);
    }
    byId.set(beadId, bead);

    if (bead.parentId) {
      pushGrouped(
        childrenByParentId,
        normalizeBeadId(bead.parentId, 'parentId', `buildBeadIndex bead "${beadId}"`),
        bead,
      );
    }
    for (const blockedById of bead.blockedByIds ?? []) {
      pushGrouped(
        dependentsByBlockerId,
        normalizeBeadId(blockedById, 'blockedByIds entry', `buildBeadIndex bead "${beadId}"`),
        bead,
      );
    }
  }

  return { byId, childrenByParentId, dependentsByBlockerId };
}

/**
 * @template {{ status: string }} TBead
 * @param {readonly TBead[]} beads
 * @returns {TBead[]}
 */
export function activeBeads(beads) {
  return beads.filter((bead) => bead.status !== 'closed');
}

/**
 * @template {{ status: string, type: string, blocked: boolean }} TBead
 * @param {readonly TBead[]} beads
 * @returns {{
 *   total: number,
 *   active: number,
 *   closed: number,
 *   blocked: number,
 *   inProgress: number,
 *   statusCounts: Record<string, number>,
 *   typeCounts: Record<string, number>,
 * }}
 */
export function summarizeInventory(beads) {
  const active = activeBeads(beads);
  const statusCounts = /** @type {Record<string, number>} */ ({});
  const typeCounts = /** @type {Record<string, number>} */ ({});

  for (const bead of beads) {
    statusCounts[bead.status] = (statusCounts[bead.status] ?? 0) + 1;
    typeCounts[bead.type] = (typeCounts[bead.type] ?? 0) + 1;
  }

  return {
    total: beads.length,
    active: active.length,
    closed: beads.length - active.length,
    blocked: active.filter((bead) => bead.blocked).length,
    inProgress: beads.filter((bead) => bead.status === 'in_progress').length,
    statusCounts,
    typeCounts,
  };
}
