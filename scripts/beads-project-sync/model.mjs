const unsupportedRecordTypes = new Set(['infrastructure', 'memory', 'template', 'gate', 'wisp']);

function fail(message) {
  throw new Error(message);
}

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

function normalizePriority(value, context) {
  if (value == null || value === '') {
    return 0;
  }
  const priority = Number(value);
  if (!Number.isFinite(priority)) {
    fail(`${context} has an invalid priority`);
  }
  return priority;
}

function hasCurrentField(key) {
  return /^current(?:_|[A-Z]|$)/.test(key);
}

function assertNoCurrentFields(record, context) {
  const currentField = Object.keys(record).find(hasCurrentField);
  if (currentField) {
    fail(`${context} uses unsupported current field "${currentField}"`);
  }
}

function normalizeLabels(value, context) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${context} field "labels" must be an array`);
  }

  const labels = [];
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

function normalizeAssigneeMap(assigneeMap) {
  if (assigneeMap == null) {
    return new Map();
  }

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

function pushGrouped(map, key, value) {
  const current = map.get(key);
  if (current) {
    current.push(value);
  } else {
    map.set(key, [value]);
  }
}

function normalizeDependencies(value, recordId, lineNumber) {
  if (value == null) {
    return { parentId: null, blockedByIds: [] };
  }
  if (!Array.isArray(value)) {
    fail(`Beads record "${recordId}" on line ${lineNumber} field "dependencies" must be an array`);
  }

  let parentId = null;
  const blockedByIds = [];
  const seenBlockers = new Set();
  for (const dependency of value) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      fail(`Beads record "${recordId}" on line ${lineNumber} has an invalid dependency entry`);
    }
    assertNoCurrentFields(dependency, `Beads dependency for "${recordId}" on line ${lineNumber}`);

    if (dependency.issue_id != null && dependency.issue_id !== recordId) {
      fail(
        `Beads dependency for "${recordId}" on line ${lineNumber} targets issue_id "${dependency.issue_id}"`,
      );
    }

    const dependencyType = normalizeRequiredString(
      dependency.type,
      'type',
      `Beads dependency for "${recordId}" on line ${lineNumber}`,
    );
    const dependsOnId = normalizeRequiredString(
      dependency.depends_on_id,
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

  return { parentId, blockedByIds };
}

function normalizeRecord(record, lineNumber, assigneeMap) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`Malformed Beads record on line ${lineNumber}`);
  }

  assertNoCurrentFields(record, `Beads record on line ${lineNumber}`);

  const recordType = normalizeRequiredString(record._type, '_type', `Beads record on line ${lineNumber}`);
  if (unsupportedRecordTypes.has(recordType)) {
    fail(`Unsupported Beads record type "${recordType}" on line ${lineNumber}`);
  }
  if (recordType !== 'issue') {
    fail(`Unsupported Beads record type "${recordType}" on line ${lineNumber}`);
  }

  const id = normalizeRequiredString(record.id, 'id', `Beads record on line ${lineNumber}`);
  const issueType = normalizeRequiredString(
    record.issue_type,
    'issue_type',
    `Beads record "${id}" on line ${lineNumber}`,
  );
  if (unsupportedRecordTypes.has(issueType)) {
    fail(`Unsupported Beads record "${id}" on line ${lineNumber} with type "${issueType}"`);
  }

  const { parentId, blockedByIds } = normalizeDependencies(record.dependencies, id, lineNumber);
  const rawAssignee = normalizeOptionalString(
    record.assignee,
    'assignee',
    `Beads record "${id}" on line ${lineNumber}`,
  );

  return {
    id,
    title: normalizeRequiredString(record.title, 'title', `Beads record "${id}" on line ${lineNumber}`),
    description: normalizeOptionalString(
      record.description,
      'description',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    design: normalizeOptionalString(
      record.design,
      'design',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    specId: normalizeOptionalString(
      record.spec_id,
      'spec_id',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    acceptanceCriteria: normalizeOptionalString(
      record.acceptance_criteria,
      'acceptance_criteria',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    notes: normalizeOptionalString(record.notes, 'notes', `Beads record "${id}" on line ${lineNumber}`),
    status: normalizeRequiredString(
      record.status,
      'status',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    priority: normalizePriority(record.priority, `Beads record "${id}" on line ${lineNumber}`),
    type: issueType,
    blocked: false,
    labels: normalizeLabels(record.labels, `Beads record "${id}" on line ${lineNumber}`),
    parentId,
    blockedByIds,
    githubAssignee: rawAssignee == null ? null : assigneeMap.get(rawAssignee) ?? null,
    createdAt: normalizeRequiredString(
      record.created_at,
      'created_at',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    updatedAt: normalizeRequiredString(
      record.updated_at,
      'updated_at',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
    closedAt: normalizeOptionalString(
      record.closed_at,
      'closed_at',
      `Beads record "${id}" on line ${lineNumber}`,
    ),
  };
}

export function parseBeadExport(jsonl, config = {}) {
  if (typeof jsonl !== 'string') {
    fail('Bead export JSONL must be a string');
  }

  const assigneeMap = normalizeAssigneeMap(config.assigneeMap);
  const beads = [];
  const seenIds = new Set();
  for (const [index, rawLine] of jsonl.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

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

export function buildBeadIndex(beads) {
  const byId = new Map();
  const childrenByParentId = new Map();
  const dependentsByBlockerId = new Map();

  for (const bead of beads) {
    if (!bead?.id) {
      fail('buildBeadIndex expected beads with ids');
    }
    if (byId.has(bead.id)) {
      fail(`buildBeadIndex received duplicate id "${bead.id}"`);
    }
    byId.set(bead.id, bead);

    if (bead.parentId) {
      pushGrouped(childrenByParentId, bead.parentId, bead);
    }
    for (const blockedById of bead.blockedByIds ?? []) {
      pushGrouped(dependentsByBlockerId, blockedById, bead);
    }
  }

  return { byId, childrenByParentId, dependentsByBlockerId };
}

export function activeBeads(beads) {
  return beads.filter((bead) => bead.status !== 'closed');
}

export function summarizeInventory(beads) {
  const active = activeBeads(beads);
  const statusCounts = {};
  const typeCounts = {};

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
