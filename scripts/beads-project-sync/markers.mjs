// @ts-check

export const DEFAULT_PROJECT_MARKER = 'psyche-beads-project-sync:v1';
export const DEFAULT_ISSUE_MARKER = 'psyche-bead-sync:v1';
export const LEGACY_PROJECT_MARKERS = Object.freeze(['psyche-bead-sync:v1']);
export const LEGACY_ISSUE_MARKERS = Object.freeze(['psyche-bead-sync:v1']);

const MARKER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,199})$/u;
const REPOSITORY_SEGMENT_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})';
const REPOSITORY_IDENTITY_PATTERN = new RegExp(
  `^${REPOSITORY_SEGMENT_PATTERN}\\/${REPOSITORY_SEGMENT_PATTERN}$`,
  'u',
);

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {string}
 */
export function normalizeMarker(value, context) {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  const marker = value.trim();
  if (!MARKER_PATTERN.test(marker) || marker.includes('--')) {
    throw new Error(`${context} must be a safe machine marker`);
  }
  return marker;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @returns {string}
 */
export function normalizeRepositoryIdentity(value, context) {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  const identity = value.trim();
  if (!REPOSITORY_IDENTITY_PATTERN.test(identity)) {
    throw new Error(`${context} must be an owner/repository identity`);
  }
  return identity;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * @param {unknown} current
 * @param {unknown} legacy
 * @param {string} context
 * @returns {string[]}
 */
export function recognizedMarkers(current, legacy, context) {
  const markers = [normalizeMarker(current, context)];
  if (legacy != null) {
    if (!Array.isArray(legacy)) {
      throw new Error(`${context} legacy markers must be an array`);
    }
    for (const value of legacy) {
      markers.push(normalizeMarker(value, `${context} legacy marker`));
    }
  }
  return [...new Set(markers)];
}

/**
 * @param {unknown} current
 * @param {unknown} legacy
 * @param {string} context
 * @returns {string[]}
 */
export function recognizedProjectMarkers(current, legacy, context) {
  if (legacy != null && !Array.isArray(legacy)) {
    throw new Error(`${context} legacy markers must be an array`);
  }
  return recognizedMarkers(current, [
    DEFAULT_PROJECT_MARKER,
    ...LEGACY_PROJECT_MARKERS,
    ...(legacy ?? []),
  ], context);
}

/**
 * @param {string} marker
 * @param {string | null | undefined} [repositoryIdentity]
 * @returns {string}
 */
export function projectReadmeMarker(marker, repositoryIdentity) {
  const normalizedMarker = normalizeMarker(marker, 'project marker');
  if (repositoryIdentity == null) {
    return `<!-- ${normalizedMarker} project-readme -->`;
  }
  return `<!-- ${normalizedMarker} project-readme repository=${
    normalizeRepositoryIdentity(repositoryIdentity, 'project repository identity')
  } -->`;
}

/**
 * @param {string} value
 * @param {readonly string[]} markers
 * @returns {{marker: string, repository: string | null}[]}
 */
export function extractProjectReadmeMarkers(value, markers) {
  if (typeof value !== 'string') {
    throw new Error('Project README must be a string');
  }
  if (markers.length === 0) {
    throw new Error('extractProjectReadmeMarkers requires at least one marker');
  }
  const alternatives = markers.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `<!--\\s*(${alternatives})\\s+project-readme(?:\\s+repository=(${REPOSITORY_SEGMENT_PATTERN}\\/${REPOSITORY_SEGMENT_PATTERN}))?\\s*-->`,
    'gu',
  );
  return [...value.matchAll(pattern)].map((match) => ({
    marker: match[1] ?? '',
    repository: match[2] == null
      ? null
      : normalizeRepositoryIdentity(match[2], 'project repository identity'),
  }));
}

/**
 * @param {string} marker
 * @param {string} beadId
 * @returns {string}
 */
export function issueBeadMarker(marker, beadId) {
  return `<!-- ${normalizeMarker(marker, 'issue marker')} bead-id=${beadId} -->`;
}

/**
 * @param {string} marker
 * @param {string} renderHash
 * @returns {string}
 */
export function renderHashMarker(marker, renderHash) {
  return `<!-- ${normalizeMarker(marker, 'render hash marker')} render-hash=${renderHash} -->`;
}

/**
 * @param {readonly string[]} markers
 * @param {string} suffix
 * @param {string} [flags]
 * @returns {RegExp}
 */
export function markerPattern(markers, suffix, flags = 'u') {
  if (markers.length === 0) {
    throw new Error('markerPattern requires at least one marker');
  }
  const alternatives = markers.map(escapeRegExp).join('|');
  return new RegExp(`<!--\\s*(?:${alternatives})\\s+${suffix}\\s*-->`, flags);
}
