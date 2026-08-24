// @ts-check

import { readFile as nodeReadFile } from 'node:fs/promises';

import {
  DEFAULT_ISSUE_MARKER,
  DEFAULT_PROJECT_MARKER,
  normalizeMarker,
} from './markers.mjs';

export const SUPPORTED_PROJECT_MARKER = DEFAULT_PROJECT_MARKER;
export const SUPPORTED_ISSUE_MARKER = DEFAULT_ISSUE_MARKER;
export const APPLY_LOCK_BRANCH = 'psyche-beads-project-sync-lock';
export const APPLY_LOCK_REF = `refs/heads/${APPLY_LOCK_BRANCH}`;
export const APPLY_LOCK_REF_ENDPOINT = `heads/${APPLY_LOCK_BRANCH}`;

/**
 * @typedef {{
 *   owner: string,
 *   repository: string,
 *   projectNodeId: string,
 *   projectTitle: string,
 *   projectMarker: string,
 *   issueMarker: string,
 *   applyLockRef: typeof APPLY_LOCK_REF,
 *   trustedIssueAuthors: readonly string[],
 *   legacyProjectMarkers?: readonly string[],
 *   assigneeMap: Record<string, string>,
 *   massClose: {
 *     minimum: number,
 *     fraction: number,
 *   },
 * }} BeadsProjectSyncConfig
 */

const PROJECT_NODE_ID_PATTERN = /^PVT_[A-Za-z0-9_-]{8,255}$/u;
const GITHUB_LOGIN_PATTERN =
  /^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`Invalid Beads Project sync configuration: ${message}`);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {readonly string[]}
 */
function machineMarkers(value, fieldName) {
  if (!Array.isArray(value)) {
    fail(`"${fieldName}" must be an array`);
  }
  return Object.freeze([
    ...new Set(value.map((marker) => machineMarker(marker, fieldName))),
  ]);
}

/**
 * @param {unknown} value
 * @returns {readonly string[]}
 */
function trustedIssueAuthors(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('"trustedIssueAuthors" must be a non-empty array');
  }
  const normalized = value.map((login) => {
    const candidate = requiredString(login, 'trustedIssueAuthors entry');
    if (!GITHUB_LOGIN_PATTERN.test(candidate)) {
      fail('"trustedIssueAuthors" entries must be valid GitHub logins');
    }
    return candidate.toLowerCase();
  });
  return Object.freeze([...new Set(normalized)]);
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {Record<string, unknown>}
 */
function record(value, context) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} requiredKeys
 * @param {string} context
 * @param {readonly string[]} [optionalKeys]
 */
function assertExactKeys(value, requiredKeys, context, optionalKeys = []) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${context} contains unknown field "${unknown[0]}"`);
  }
  const missing = requiredKeys.filter((key) => !(key in value));
  if (missing.length > 0) {
    fail(`${context} is missing field "${missing[0]}"`);
  }
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function requiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`"${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function projectNodeId(value) {
  const nodeId = requiredString(value, 'projectNodeId');
  if (!PROJECT_NODE_ID_PATTERN.test(nodeId)) {
    fail('"projectNodeId" must be a GitHub ProjectV2 node ID beginning with "PVT_"');
  }
  return nodeId;
}

/**
 * @param {unknown} value
 * @returns {typeof APPLY_LOCK_REF}
 */
function applyLockRef(value) {
  const ref = value == null ? APPLY_LOCK_REF : requiredString(value, 'applyLockRef');
  if (ref !== APPLY_LOCK_REF) {
    fail(`"applyLockRef" must be the dedicated branch ref "${APPLY_LOCK_REF}"`);
  }
  return APPLY_LOCK_REF;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function machineMarker(value, fieldName) {
  const marker = requiredString(value, fieldName);
  try {
    return normalizeMarker(marker, `"${fieldName}"`);
  } catch (error) {
    fail(error instanceof Error ? error.message : `"${fieldName}" is invalid`);
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function assigneeMap(value) {
  const input = record(value, '"assigneeMap"');
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [sourceAssignee, githubAssignee] of Object.entries(input)) {
    const source = requiredString(sourceAssignee, 'assigneeMap key');
    normalized[source] = requiredString(githubAssignee, `assigneeMap.${source}`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {{minimum: number, fraction: number}}
 */
function massClose(value) {
  const input = record(value, '"massClose"');
  assertExactKeys(input, ['minimum', 'fraction'], '"massClose"');

  const minimum = input.minimum;
  if (typeof minimum !== 'number') {
    fail('"massClose.minimum" must be a non-negative integer');
  }
  if (!Number.isInteger(minimum) || minimum < 0) {
    fail('"massClose.minimum" must be a non-negative integer');
  }
  const fraction = input.fraction;
  if (typeof fraction !== 'number') {
    fail('"massClose.fraction" must be between 0 and 1');
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    fail('"massClose.fraction" must be between 0 and 1');
  }
  return { minimum, fraction };
}

/**
 * @param {unknown} value
 * @returns {BeadsProjectSyncConfig}
 */
export function parseSyncConfig(value) {
  const input = record(value, 'root');
  assertExactKeys(input, [
    'owner',
    'repository',
    'projectNodeId',
    'projectTitle',
    'projectMarker',
    'issueMarker',
    'trustedIssueAuthors',
    'assigneeMap',
    'massClose',
  ], 'root', ['applyLockRef', 'legacyProjectMarkers']);

  const projectMarker = machineMarker(input.projectMarker, 'projectMarker');
  const issueMarker = machineMarker(input.issueMarker, 'issueMarker');
  const legacyProjectMarkers = 'legacyProjectMarkers' in input
    ? machineMarkers(input.legacyProjectMarkers, 'legacyProjectMarkers')
    : null;

  return Object.freeze({
    owner: requiredString(input.owner, 'owner'),
    repository: requiredString(input.repository, 'repository'),
    projectNodeId: projectNodeId(input.projectNodeId),
    projectTitle: requiredString(input.projectTitle, 'projectTitle'),
    projectMarker,
    issueMarker,
    applyLockRef: applyLockRef(input.applyLockRef),
    trustedIssueAuthors: trustedIssueAuthors(input.trustedIssueAuthors),
    ...(legacyProjectMarkers == null ? {} : { legacyProjectMarkers }),
    assigneeMap: Object.freeze(assigneeMap(input.assigneeMap)),
    massClose: Object.freeze(massClose(input.massClose)),
  });
}

/**
 * @param {string} path
 * @param {{readFile?: (path: string, encoding: 'utf8') => Promise<string>}} [options]
 * @returns {Promise<BeadsProjectSyncConfig>}
 */
export async function readSyncConfig(path, options = {}) {
  const readFile = options.readFile ?? nodeReadFile;
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Beads Project sync configuration at ${path}`, { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in Beads Project sync configuration at ${path}`, { cause: error });
  }
  return parseSyncConfig(parsed);
}
