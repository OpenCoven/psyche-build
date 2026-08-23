// @ts-check

import { readFile as nodeReadFile } from 'node:fs/promises';

export const SUPPORTED_PROJECT_MARKER = 'psyche-beads-project-sync:v1';
export const SUPPORTED_ISSUE_MARKER = 'psyche-bead-sync:v1';

/**
 * @typedef {{
 *   owner: string,
 *   repository: string,
 *   projectTitle: string,
 *   projectMarker: string,
 *   issueMarker: string,
 *   assigneeMap: Record<string, string>,
 *   massClose: {
 *     minimum: number,
 *     fraction: number,
 *   },
 * }} BeadsProjectSyncConfig
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`Invalid Beads Project sync configuration: ${message}`);
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
 * @param {readonly string[]} allowedKeys
 * @param {string} context
 */
function assertExactKeys(value, allowedKeys, context) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${context} contains unknown field "${unknown[0]}"`);
  }
  const missing = allowedKeys.filter((key) => !(key in value));
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

  const minimum = Number(input.minimum);
  if (!Number.isInteger(minimum) || minimum < 0) {
    fail('"massClose.minimum" must be a non-negative integer');
  }
  const fraction = Number(input.fraction);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    fail('"massClose.fraction" must be greater than 0 and at most 1');
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
    'projectTitle',
    'projectMarker',
    'issueMarker',
    'assigneeMap',
    'massClose',
  ], 'root');

  const projectMarker = requiredString(input.projectMarker, 'projectMarker');
  if (projectMarker !== SUPPORTED_PROJECT_MARKER) {
    fail(`"projectMarker" must be "${SUPPORTED_PROJECT_MARKER}"`);
  }
  const issueMarker = requiredString(input.issueMarker, 'issueMarker');
  if (issueMarker !== SUPPORTED_ISSUE_MARKER) {
    fail(`"issueMarker" must be "${SUPPORTED_ISSUE_MARKER}"`);
  }

  return Object.freeze({
    owner: requiredString(input.owner, 'owner'),
    repository: requiredString(input.repository, 'repository'),
    projectTitle: requiredString(input.projectTitle, 'projectTitle'),
    projectMarker,
    issueMarker,
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
