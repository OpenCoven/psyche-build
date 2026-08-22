import os from 'node:os';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;
const API_KEY_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|apikey|client[_-]?secret|access[_-]?token|auth[_-]?token)\b(?:\s*["'`])?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;]+)/iu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:github[_-]?token|token|secret|password|passwd)\b(?:\s*["'`])?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;]+)/iu;
const GENERATED_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1/giu;
const HOME_PATH_PREFIX_PATTERN = /(^|[\s"'`(<=>:,])/u;

function fail(message) {
  throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeHomeDirectories(config) {
  if (config == null) {
    return [os.homedir()].filter(Boolean);
  }

  const { homeDirectories } = config;
  if (homeDirectories == null) {
    return [os.homedir()].filter(Boolean);
  }

  const entries = homeDirectories instanceof Set
    ? [...homeDirectories]
    : Array.isArray(homeDirectories)
      ? homeDirectories
      : fail('sanitizePublicText config.homeDirectories must be an array or Set');

  const normalized = new Set([os.homedir()]);
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      fail('sanitizePublicText config.homeDirectories entries must be strings');
    }

    const homeDirectory = entry.trim().replace(/[\\/]+$/gu, '');
    if (homeDirectory) {
      normalized.add(homeDirectory);
    }
  }

  return [...normalized].filter(Boolean).sort((left, right) => right.length - left.length);
}

function replaceConfiguredHomeDirectory(value, homeDirectory) {
  if (!homeDirectory) {
    return value;
  }

  let sanitized = value;
  const fileUriHomeDirectory = toFileUriHomeDirectory(homeDirectory);
  if (fileUriHomeDirectory) {
    const fileUriPattern = new RegExp(
      `${HOME_PATH_PREFIX_PATTERN.source}${escapeRegExp(fileUriHomeDirectory)}(?=/|$)`,
      'gu',
    );
    sanitized = sanitized.replace(fileUriPattern, (_, prefix) => `${prefix}file:///~`);
  }

  const pathPattern = new RegExp(
    `${HOME_PATH_PREFIX_PATTERN.source}${escapeRegExp(homeDirectory)}(?=[/\\\\]|$)`,
    'gu',
  );
  return sanitized.replace(pathPattern, (_, prefix) => `${prefix}~`);
}

function toFileUriHomeDirectory(homeDirectory) {
  if (/^[A-Za-z]:[\\/]/u.test(homeDirectory)) {
    return `file:///${homeDirectory.replace(/\\/gu, '/')}`;
  }
  if (homeDirectory.startsWith('/')) {
    return `file://${homeDirectory}`;
  }
  return null;
}

function redactHomeDirectories(value, config) {
  let sanitized = value;

  for (const homeDirectory of normalizeHomeDirectories(config)) {
    sanitized = replaceConfiguredHomeDirectory(sanitized, homeDirectory);
  }

  sanitized = sanitized.replace(
    /(^|[\s"'`(<=>:,])file:\/\/\/(?:Users|home)\/[^/\s]+(?=\/|$)/gu,
    (_, prefix) => `${prefix}file:///~`,
  );
  sanitized = sanitized.replace(
    /(^|[\s"'`(<=>:,])file:\/\/\/[A-Za-z]:\/Users\/[^/\s]+(?=\/|$)/gu,
    (_, prefix) => `${prefix}file:///~`,
  );
  sanitized = sanitized.replace(
    /(^|[\s"'`(<=>:,])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(?=[/\\]|$)/gu,
    (_, prefix) => `${prefix}~`,
  );
  sanitized = sanitized.replace(
    /(^|[\s"'`(<=>:,])(?:[A-Za-z]:(?:\/|\\)Users(?:\/|\\)[^\\/\s]+)(?=(?:\/|\\)|$)/gu,
    (_, prefix) => `${prefix}~`,
  );

  return sanitized;
}

function escapeGeneratedMarkers(value) {
  return value.replace(GENERATED_MARKER_PATTERN, '&lt;!-- psyche-bead-sync:v1');
}

function normalizeMultilineText(value) {
  const normalized = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return normalized || null;
}

function sanitizeInlineText(value, fieldName, config, required = true) {
  const sanitized = sanitizePublicText(value, config);
  const inline = sanitized == null ? null : sanitized.replace(/\s+/gu, ' ').trim();
  if (required && !inline) {
    fail(`Public bead field "${fieldName}" must not be empty`);
  }
  return inline;
}

function sanitizeStringList(value, fieldName, config) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`Public bead field "${fieldName}" must be an array`);
  }

  const sanitized = [];
  const seen = new Set();
  for (const entry of value) {
    const item = sanitizeInlineText(entry, fieldName, config);
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    sanitized.push(item);
  }
  return sanitized;
}

function normalizePriority(value) {
  const priority = Number(value);
  if (!Number.isFinite(priority)) {
    fail('Public bead field "priority" must be a finite number');
  }
  return priority;
}

export function assertNoPublishableSecrets(value) {
  if (typeof value !== 'string') {
    fail('assertNoPublishableSecrets expected a string');
  }

  if (!value) {
    return;
  }

  if (GITHUB_TOKEN_PATTERN.test(value)) {
    fail('Publishable GitHub token detected');
  }
  if (PRIVATE_KEY_PATTERN.test(value)) {
    fail('Publishable private key detected');
  }
  if (API_KEY_ASSIGNMENT_PATTERN.test(value)) {
    fail('Publishable API key assignment detected');
  }
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) {
    fail('Publishable credential assignment detected');
  }
}

export function sanitizePublicText(value, config = {}) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('sanitizePublicText expected a string when present');
  }

  let sanitized = value.replace(/\r\n?/gu, '\n');
  sanitized = sanitized.replace(EMAIL_PATTERN, '<redacted-email>');
  sanitized = redactHomeDirectories(sanitized, config);
  assertNoPublishableSecrets(sanitized);
  sanitized = escapeGeneratedMarkers(sanitized);
  return normalizeMultilineText(sanitized);
}

export function toPublicBead(bead, config = {}) {
  if (!bead || typeof bead !== 'object' || Array.isArray(bead)) {
    fail('toPublicBead expected a Beads record object');
  }

  return {
    id: sanitizeInlineText(bead.id, 'id', config),
    title: sanitizeInlineText(bead.title, 'title', config),
    description: sanitizePublicText(bead.description, config),
    design: sanitizePublicText(bead.design, config),
    specId: sanitizePublicText(bead.specId, config),
    acceptanceCriteria: sanitizePublicText(bead.acceptanceCriteria, config),
    notes: sanitizePublicText(bead.notes, config),
    status: sanitizeInlineText(bead.status, 'status', config),
    priority: normalizePriority(bead.priority),
    type: sanitizeInlineText(bead.type, 'type', config),
    blocked: bead.blocked === true,
    labels: sanitizeStringList(bead.labels, 'labels', config),
    parentId: sanitizeInlineText(bead.parentId, 'parentId', config, false),
    blockedByIds: sanitizeStringList(bead.blockedByIds, 'blockedByIds', config),
    githubAssignee: sanitizeInlineText(bead.githubAssignee, 'githubAssignee', config, false),
    createdAt: sanitizeInlineText(bead.createdAt, 'createdAt', config),
    updatedAt: sanitizeInlineText(bead.updatedAt, 'updatedAt', config),
    closedAt: sanitizeInlineText(bead.closedAt, 'closedAt', config, false),
  };
}
