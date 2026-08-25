// @ts-check

import { summarizeInventory } from './model.mjs';
import {
  DEFAULT_ISSUE_MARKER,
  DEFAULT_PROJECT_MARKER,
  issueBeadMarker,
  normalizeMarker,
  normalizeRepositoryIdentity,
  projectReadmeMarker,
  renderHashMarker,
} from './markers.mjs';
import {
  assertNoPublishableSecrets,
  containsLocalOperationalPath,
  sanitizePublicText,
} from './sanitize.mjs';

/** @typedef {import('./sanitize.mjs').PublicBead} PublicBead */

/**
 * @typedef {{
 *   inventoryById?: ReadonlyMap<string, PublicBead> | Record<string, PublicBead>,
 *   mirroredIssueUrlsByBeadId?: ReadonlyMap<string, string> | Record<string, string>,
 *   sourceRepositoryUrl?: string | null,
 *   sourceRef?: string | null,
 *   inventoryTimestamp?: string | null,
 *   projectName?: string | null,
 *   repositoryIdentity?: string | null,
 *   projectMarker?: string | null,
 *   issueMarker?: string | null,
 *   legacyProjectMarkers?: readonly string[],
 *   legacyIssueMarkers?: readonly string[],
 * }} RenderContext
 */

const GENERATED_MARKER_PATTERN =
  /<!--\s*[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,199})\s+(?:bead-id=|project-readme|render-hash=)/giu;
const TYPE_SORT_ORDER = ['epic', 'feature', 'task'];
const ABSOLUTE_URL_PATTERN = /^(?:git\+)?[A-Za-z][A-Za-z0-9+.-]*:\/\//iu;
const UNSAFE_REPOSITORY_PATH_SEGMENTS = new Set(['..']);
const ISSUE_TITLE_MAX_CODE_POINTS = 256;
const ISSUE_TITLE_TRUNCATION_SUFFIX = '...';
const MIN_TRUNCATED_TITLE_CODE_POINTS = 1;
export const GITHUB_ISSUE_BODY_MAX_CODE_POINTS = 65_536;
export const GITHUB_PROJECT_README_MAX_CODE_POINTS = 10_000;
const CLOSED_HISTORY_TITLE_MAX_CODE_POINTS = 160;
const PROJECT_README_TRUNCATION_SUFFIX = '...';

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
 * @param {string} value
 * @returns {number}
 */
function codePointLength(value) {
  return [...value].length;
}

/**
 * @param {string} value
 * @param {number} maxCodePoints
 * @param {string} suffix
 * @returns {string}
 */
function truncateCodePoints(value, maxCodePoints, suffix) {
  const codePoints = [...value];
  if (codePoints.length <= maxCodePoints) {
    return value;
  }
  return `${codePoints.slice(0, maxCodePoints - codePointLength(suffix)).join('')}${suffix}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeGeneratedMarkers(value) {
  return value.replace(GENERATED_MARKER_PATTERN, (match) => match.replace('<!--', '&lt;!--'));
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeInlineText(value, fieldName) {
  if (typeof value !== 'string') {
    fail(`${fieldName} must be a string`);
  }

  const normalized = escapeGeneratedMarkers(value.replace(/\s+/gu, ' ').trim());
  if (!normalized) {
    fail(`${fieldName} must not be empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string | null}
 */
function normalizeOptionalInlineText(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`${fieldName} must be a string when present`);
  }

  const normalized = escapeGeneratedMarkers(value.replace(/\s+/gu, ' ').trim());
  return normalized || null;
}
/**
 * @param {string} line
 * @returns {string}
 */
function normalizeHeadingLine(line) {
  return line.replace(/^(#{1,6})(?=\s)/u, (heading) => '#'.repeat(Math.min(heading.length + 1, 6)));
}

/**
 * @param {string} value
 * @returns {string}
 */
function promoteHeadingsOutsideCodeFences(value) {
  const lines = value.split('\n');
  /** @type {string | null} */
  let activeFence = null;

  const normalized = lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      const [, marker, suffix] = fenceMatch;
      if (
        activeFence == null
        && (marker[0] !== '`' || !suffix.includes('`'))
      ) {
        activeFence = marker;
      } else if (
        activeFence != null
        && marker[0] === activeFence[0]
        && marker.length >= activeFence.length
        && /^[ \t]*$/u.test(suffix)
      ) {
        activeFence = null;
      }
      return line;
    }

    return activeFence == null ? normalizeHeadingLine(line) : line;
  });

  if (activeFence != null) {
    normalized.push(activeFence);
  }
  return normalized.join('\n');
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string | null}
 */
function normalizeMarkdownBlock(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`${fieldName} must be a string when present`);
  }

  const normalized = escapeGeneratedMarkers(value)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .trim();
  if (!normalized) {
    return null;
  }

  return promoteHeadingsOutsideCodeFences(normalized);
}

/**
 * @template TValue
 * @param {ReadonlyMap<string, TValue> | Record<string, TValue> | null | undefined} value
 * @param {string} fieldName
 * @returns {Map<string, TValue>}
 */
function normalizeRecordMap(value, fieldName) {
  if (value == null) {
    return new Map();
  }
  if (value instanceof Map) {
    return new Map(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return new Map(/** @type {[string, TValue][]} */ (Object.entries(value)));
  }
  fail(`${fieldName} must be an object or Map when present`);
}

/**
 * @typedef {{
 *   stripDotGit?: boolean,
 *   trimTrailingSlash?: boolean,
 *   clearSearch?: boolean,
 *   clearHash?: boolean,
 * }} NormalizeHttpUrlOptions
 */

/**
 * @param {string} value
 * @returns {string}
 */
function stripGitPrefix(value) {
  return value.replace(/^git\+/iu, '');
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeAbsoluteUrl(value) {
  return ABSOLUTE_URL_PATTERN.test(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeUrlComponent(value) {
  if (!value) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function containsPublishableSecret(value) {
  try {
    assertNoPublishableSecrets(value);
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {string} originalValue
 * @param {URL} url
 * @returns {boolean}
 */
function urlContainsPublishableSecrets(originalValue, url) {
  return [
    originalValue,
    decodeUrlComponent(url.username),
    decodeUrlComponent(url.password),
    decodeUrlComponent(url.pathname),
    decodeUrlComponent(url.search),
    decodeUrlComponent(url.hash),
  ].some((candidate) => candidate ? containsPublishableSecret(candidate) : false);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {NormalizeHttpUrlOptions} [options={}]
 * @returns {string | null}
 */
function normalizeHttpUrl(value, fieldName, options = {}) {
  const normalized = normalizeOptionalInlineText(value, fieldName);
  if (normalized == null || !looksLikeAbsoluteUrl(normalized)) {
    return null;
  }

  const candidate = stripGitPrefix(normalized);

  /** @type {URL} */
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  if (urlContainsPublishableSecrets(normalized, url)) {
    return null;
  }

  url.username = '';
  url.password = '';

  let pathname = url.pathname;
  if (options.trimTrailingSlash) {
    pathname = pathname.replace(/\/+$/u, '');
  }
  if (options.stripDotGit) {
    pathname = pathname.replace(/\.git$/u, '');
  }
  if (!pathname) {
    pathname = '/';
  }
  url.pathname = pathname;

  if (options.clearSearch) {
    url.search = '';
  }
  if (options.clearHash) {
    url.hash = '';
  }

  const href = sanitizePublicText(url.toString());
  if (href == null) {
    return null;
  }
  return options.trimTrailingSlash ? href.replace(/\/$/u, '') : href;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeRepositoryUrl(value) {
  return normalizeHttpUrl(value, 'sourceRepositoryUrl', {
    stripDotGit: true,
    trimTrailingSlash: true,
    clearSearch: true,
    clearHash: true,
  });
}

/**
 * @param {RenderContext} context
 * @returns {string}
 */
function resolveRepositoryIdentity(context) {
  if (context.repositoryIdentity != null) {
    return normalizeRepositoryIdentity(
      context.repositoryIdentity,
      'renderProjectReadme repositoryIdentity',
    );
  }
  const repositoryUrl = normalizeRepositoryUrl(context.sourceRepositoryUrl);
  if (!repositoryUrl) {
    fail('renderProjectReadme requires repositoryIdentity or a canonical sourceRepositoryUrl');
  }
  const pathSegments = new URL(repositoryUrl).pathname.split('/').filter(Boolean);
  if (pathSegments.length !== 2) {
    fail('renderProjectReadme sourceRepositoryUrl must identify one repository');
  }
  return normalizeRepositoryIdentity(
    `${decodeURIComponent(pathSegments[0] ?? '')}/${decodeURIComponent(pathSegments[1] ?? '')}`,
    'renderProjectReadme repository identity',
  );
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeMirroredIssueUrl(value) {
  return normalizeHttpUrl(value, 'mirroredIssueUrl');
}

/**
 * @param {string} path
 * @returns {string}
 */
function encodePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeRepositoryRelativePath(value) {
  const normalized = normalizeOptionalInlineText(value, 'sourcePath');
  if (
    normalized == null
    || looksLikeAbsoluteUrl(normalized)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
    || normalized.startsWith('/')
    || normalized.startsWith('\\')
    || normalized.includes('~')
    || normalized.includes('\\')
    || normalized.includes('?')
    || normalized.includes('#')
    || normalized.includes('[redacted-local-path]')
    || containsLocalOperationalPath(normalized)
  ) {
    return null;
  }

  const segments = normalized.split('/');
  if (
    segments.some((segment) =>
      !segment
      || segment === '.'
      || UNSAFE_REPOSITORY_PATH_SEGMENTS.has(segment.toLowerCase())
    )
  ) {
    return null;
  }

  return normalized;
}

/**
 * @param {string} title
 * @param {string | null | undefined} content
 * @returns {string | null}
 */
function renderSection(title, content) {
  if (!content) {
    return null;
  }

  return `## ${title}\n${content}`;
}

/**
 * @param {unknown} path
 * @param {RenderContext} context
 * @returns {string | null}
 */
function renderSourceLink(path, context) {
  const normalizedPath = normalizeRepositoryRelativePath(path);
  if (normalizedPath == null) {
    return null;
  }

  const repositoryUrl = normalizeRepositoryUrl(context.sourceRepositoryUrl);
  if (!repositoryUrl) {
    return normalizedPath;
  }

  const sourceRef = normalizeOptionalInlineText(context.sourceRef, 'sourceRef') ?? 'main';
  return `[${normalizedPath}](${repositoryUrl}/blob/${encodePath(sourceRef)}/${encodePath(normalizedPath)})`;
}

/**
 * @param {unknown} id
 * @param {unknown} url
 * @returns {string}
 */
function renderMirroredDependencyLink(id, url) {
  const dependencyId = normalizeInlineText(id, 'dependency id');
  const dependencyUrl = normalizeMirroredIssueUrl(url);
  if (!dependencyUrl) {
    return `\`${dependencyId}\``;
  }

  const issueNumber = dependencyUrl.match(/\/issues\/(\d+)(?:[/?#]|$)/u)?.[1];
  if (issueNumber) {
    return `[#${issueNumber}](${dependencyUrl}) \`${dependencyId}\``;
  }

  return `[\`${dependencyId}\`](${dependencyUrl})`;
}

/**
 * @param {unknown} id
 * @param {PublicBead | undefined} bead
 * @param {unknown} url
 * @param {string} prefix
 * @returns {string}
 */
function renderDependencyLine(id, bead, url, prefix) {
  const dependencyId = normalizeInlineText(id, 'dependency id');
  const title = bead?.title ? normalizeInlineText(bead.title, 'dependency title') : null;
  const closed = bead?.status === 'closed';

  if (closed) {
    return `- ${prefix}: closed \`${dependencyId}\`${title ? ` — ${title}` : ''}`;
  }

  const reference = renderMirroredDependencyLink(dependencyId, url);
  return `- ${prefix}: ${reference}${title ? ` — ${title}` : ''}`;
}

/**
 * @param {PublicBead} bead
 * @param {ReadonlyMap<string, PublicBead>} inventoryById
 * @param {ReadonlyMap<string, string>} mirroredIssueUrlsByBeadId
 * @returns {string | null}
 */
function renderDependenciesSection(bead, inventoryById, mirroredIssueUrlsByBeadId) {
  const lines = /** @type {string[]} */ ([]);

  if (bead.parentId) {
    lines.push(
      renderDependencyLine(
        bead.parentId,
        inventoryById.get(bead.parentId),
        mirroredIssueUrlsByBeadId.get(bead.parentId),
        'Parent',
      ),
    );
  }

  for (const blockedById of [...(bead.blockedByIds ?? [])].sort(compareStrings)) {
    lines.push(
      renderDependencyLine(
        blockedById,
        inventoryById.get(blockedById),
        mirroredIssueUrlsByBeadId.get(blockedById),
        inventoryById.get(blockedById)?.status === 'closed' ? 'Closed history' : 'Blocked by',
      ),
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * @param {PublicBead} bead
 * @returns {string | null}
 */
function renderLabelsSection(bead) {
  const labels = Array.isArray(bead.labels)
    ? [...bead.labels]
      .map((label) => normalizeInlineText(label, 'label'))
      .sort(compareStrings)
    : [];
  return labels.length > 0 ? labels.map((label) => `- \`${label}\``).join('\n') : null;
}

/**
 * @param {PublicBead} bead
 * @param {RenderContext} context
 * @returns {string | null}
 */
function renderDesignSection(bead, context) {
  const lines = /** @type {string[]} */ ([]);
  const designIsMarkdownBlock = typeof bead.design === 'string' && /[\r\n]/u.test(bead.design);
  const designLink = typeof bead.design === 'string' && !designIsMarkdownBlock
    ? renderSourceLink(bead.design, context)
    : null;
  const planLink = renderSourceLink(bead.specId, context);

  if (designLink) {
    lines.push(`- Design doc: ${designLink}`);
  } else if (designIsMarkdownBlock) {
    const design = normalizeMarkdownBlock(bead.design, 'design');
    if (design) {
      lines.push(design);
    }
  }
  if (planLink) {
    lines.push(`- Plan: ${planLink}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * @param {PublicBead} bead
 * @returns {string}
 */
function renderSourceMetadata(bead) {
  const lines = /** @type {string[]} */ ([
    `- Source status: \`${normalizeInlineText(bead.status, 'status')}\``,
    `- Source type: \`${normalizeInlineText(bead.type, 'type')}\``,
    `- Source priority: P${Number(bead.priority)}`,
    `- Source blocked: ${bead.blocked ? 'yes' : 'no'}`,
    `- Created at: ${normalizeInlineText(bead.createdAt, 'createdAt')}`,
    `- Updated at: ${normalizeInlineText(bead.updatedAt, 'updatedAt')}`,
  ]);

  if (bead.closedAt) {
    lines.push(`- Closed at: ${normalizeInlineText(bead.closedAt, 'closedAt')}`);
  }

  return lines.join('\n');
}

/**
 * @param {Record<string, number | undefined>} typeCounts
 * @returns {string}
 */
function renderTypeCountLines(typeCounts) {
  const keys = Object.keys(typeCounts).sort((left, right) => {
    const leftIndex = TYPE_SORT_ORDER.indexOf(left);
    const rightIndex = TYPE_SORT_ORDER.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    }
    return compareStrings(left, right);
  });

  return keys.length > 0
    ? keys.map((type) => `- ${type}: ${typeCounts[type] ?? 0}`).join('\n')
    : '- none';
}

/**
 * @param {readonly PublicBead[]} inventory
 * @returns {string}
 */
function renderPriorityCountLines(inventory) {
  const priorityCounts = new Map();
  for (const bead of inventory) {
    const priority = Number(bead.priority);
    priorityCounts.set(priority, (priorityCounts.get(priority) ?? 0) + 1);
  }

  const entries = [...priorityCounts.entries()].sort(([left], [right]) => left - right);
  return entries.length > 0
    ? entries.map(([priority, count]) => `- P${priority}: ${count}`).join('\n')
    : '- none';
}

/**
 * @param {readonly PublicBead[]} inventory
 * @returns {string[]}
 */
function renderClosedHistoryLines(inventory) {
  const closed = inventory
    .filter((bead) => bead.status === 'closed')
    .sort((left, right) => {
      const leftTimestamp = left.closedAt ?? left.updatedAt;
      const rightTimestamp = right.closedAt ?? right.updatedAt;
      return compareStrings(rightTimestamp, leftTimestamp) || compareStrings(left.id, right.id);
    });

  return closed.map((bead) => {
    const closedAt = normalizeInlineText(bead.closedAt ?? bead.updatedAt, 'closedAt');
    const title = truncateCodePoints(
      normalizeInlineText(bead.title, 'title'),
      CLOSED_HISTORY_TITLE_MAX_CODE_POINTS,
      PROJECT_README_TRUNCATION_SUFFIX,
    );
    return `- \`${normalizeInlineText(bead.id, 'id')}\` — ${title} (closed ${closedAt})`;
  });
}

/**
 * @param {number} count
 * @returns {string}
 */
function renderClosedHistoryOmission(count) {
  return `- ${count} additional closed beads omitted.`;
}

/**
 * @param {readonly string[]} beforeHistory
 * @param {string} historyBody
 * @param {readonly string[]} afterHistory
 * @returns {string}
 */
function assembleProjectReadme(beforeHistory, historyBody, afterHistory) {
  return [
    ...beforeHistory,
    `## Closed history summary\n${historyBody}`,
    ...afterHistory,
  ].join('\n\n');
}

/**
 * @param {readonly string[]} beforeHistory
 * @param {readonly string[]} historyLines
 * @param {readonly string[]} afterHistory
 * @param {string} projectMarker
 * @returns {string}
 */
function renderBudgetedProjectReadme(
  beforeHistory,
  historyLines,
  afterHistory,
  projectMarker,
) {
  const managedSuffix = `\n\n${renderHashMarker(projectMarker, '0'.repeat(64))}`;
  const renderedCodePointLimit =
    GITHUB_PROJECT_README_MAX_CODE_POINTS - codePointLength(managedSuffix);

  if (historyLines.length === 0) {
    const rendered = assembleProjectReadme(
      beforeHistory,
      '- No closed beads in this snapshot.',
      afterHistory,
    );
    const managedLength = codePointLength(rendered) + codePointLength(managedSuffix);
    if (managedLength > GITHUB_PROJECT_README_MAX_CODE_POINTS) {
      fail(
        `Project README required sections are ${managedLength} characters; maximum is ${GITHUB_PROJECT_README_MAX_CODE_POINTS}`,
      );
    }
    return rendered;
  }

  const fixedCodePoints = codePointLength(
    assembleProjectReadme(beforeHistory, '', afterHistory),
  );
  const historyPrefixCodePoints = [0];
  for (const line of historyLines) {
    historyPrefixCodePoints.push(
      (historyPrefixCodePoints.at(-1) ?? 0) + codePointLength(line),
    );
  }

  let includedCount = -1;
  for (let candidateCount = 0; candidateCount <= historyLines.length; candidateCount += 1) {
    const omittedCount = historyLines.length - candidateCount;
    let historyBodyCodePoints =
      historyPrefixCodePoints[candidateCount] + Math.max(0, candidateCount - 1);
    if (omittedCount > 0) {
      historyBodyCodePoints +=
        (candidateCount > 0 ? 1 : 0)
        + codePointLength(renderClosedHistoryOmission(omittedCount));
    }
    if (fixedCodePoints + historyBodyCodePoints <= renderedCodePointLimit) {
      includedCount = candidateCount;
    }
  }

  if (includedCount < 1) {
    const firstSample = [
      historyLines[0],
      historyLines.length > 1
        ? renderClosedHistoryOmission(historyLines.length - 1)
        : null,
    ].filter(Boolean).join('\n');
    const requiredLength =
      codePointLength(assembleProjectReadme(beforeHistory, firstSample, afterHistory))
      + codePointLength(managedSuffix);
    fail(
      `Project README required sections and one closed-history sample are ${requiredLength} characters; maximum is ${GITHUB_PROJECT_README_MAX_CODE_POINTS}`,
    );
  }

  const historyBodyLines = historyLines.slice(0, includedCount);
  const omittedCount = historyLines.length - includedCount;
  if (omittedCount > 0) {
    historyBodyLines.push(renderClosedHistoryOmission(omittedCount));
  }
  return assembleProjectReadme(
    beforeHistory,
    historyBodyLines.join('\n'),
    afterHistory,
  );
}

/**
 * @param {readonly PublicBead[]} inventory
 * @param {RenderContext} context
 * @returns {string}
 */
function resolveInventoryTimestamp(inventory, context) {
  const contextTimestamp = normalizeOptionalInlineText(context.inventoryTimestamp, 'inventoryTimestamp');
  if (contextTimestamp) {
    return contextTimestamp;
  }

  const timestamps = /** @type {string[]} */ ([]);
  for (const bead of inventory) {
    timestamps.push(normalizeInlineText(bead.updatedAt, 'inventory timestamp'));
    if (bead.closedAt) {
      timestamps.push(normalizeInlineText(bead.closedAt, 'inventory timestamp'));
    }
  }
  return timestamps.sort((left, right) => compareStrings(right, left))[0] ?? 'unknown';
}

/**
 * @param {PublicBead} bead
 * @returns {string}
 */
export function renderIssueTitle(bead) {
  const prefix = `[${normalizeInlineText(bead.id, 'id')}] `;
  const title = normalizeInlineText(bead.title, 'title');
  const availableTitleCodePoints = ISSUE_TITLE_MAX_CODE_POINTS - [...prefix].length;
  const minimumTitleRoom =
    ISSUE_TITLE_TRUNCATION_SUFFIX.length + MIN_TRUNCATED_TITLE_CODE_POINTS;
  if (availableTitleCodePoints < minimumTitleRoom) {
    fail('Bead id leaves no meaningful issue title room within GitHub\'s 256-code-point limit');
  }

  const titleCodePoints = [...title];
  if (titleCodePoints.length <= availableTitleCodePoints) {
    return `${prefix}${title}`;
  }

  return `${prefix}${titleCodePoints
    .slice(0, availableTitleCodePoints - ISSUE_TITLE_TRUNCATION_SUFFIX.length)
    .join('')}${ISSUE_TITLE_TRUNCATION_SUFFIX}`;
}

/**
 * @param {string} beadId
 * @param {string} body
 */
export function assertIssueBodyWithinLimit(beadId, body) {
  const normalizedBeadId = normalizeInlineText(beadId, 'Bead id');
  if (typeof body !== 'string') {
    fail(`GitHub issue body for Bead "${normalizedBeadId}" must be a string`);
  }

  const actualCodePoints = codePointLength(body);
  if (actualCodePoints > GITHUB_ISSUE_BODY_MAX_CODE_POINTS) {
    fail(
      `GitHub issue body for Bead "${normalizedBeadId}" is ${actualCodePoints} characters; maximum is ${GITHUB_ISSUE_BODY_MAX_CODE_POINTS}`,
    );
  }
}

/**
 * @param {string} body
 */
export function assertProjectReadmeWithinLimit(body) {
  if (typeof body !== 'string') {
    fail('GitHub Project README must be a string');
  }

  const actualCodePoints = codePointLength(body);
  if (actualCodePoints > GITHUB_PROJECT_README_MAX_CODE_POINTS) {
    fail(
      `GitHub Project README is ${actualCodePoints} characters; maximum is ${GITHUB_PROJECT_README_MAX_CODE_POINTS}`,
    );
  }
}

/**
 * @param {PublicBead} bead
 * @param {RenderContext} [context={}]
 * @returns {string}
 */
export function renderIssueBody(bead, context = {}) {
  const inventoryById = normalizeRecordMap(context.inventoryById, 'inventoryById');
  const mirroredIssueUrlsByBeadId = normalizeRecordMap(
    context.mirroredIssueUrlsByBeadId,
    'mirroredIssueUrlsByBeadId',
  );

  const issueMarker = normalizeMarker(
    context.issueMarker ?? DEFAULT_ISSUE_MARKER,
    'renderIssueBody issueMarker',
  );
  const beadId = normalizeInlineText(bead.id, 'id');
  const sections = [
    issueBeadMarker(issueMarker, beadId),
    renderSection('Bead', [
      `- ID: \`${beadId}\``,
      `- Type: \`${normalizeInlineText(bead.type, 'type')}\``,
      `- Status: \`${normalizeInlineText(bead.status, 'status')}\``,
      `- Priority: P${Number(bead.priority)}`,
      `- Blocked: ${bead.blocked ? 'yes' : 'no'}`,
    ].join('\n')),
    renderSection('Goal', normalizeInlineText(bead.title, 'title')),
    renderSection('Description', normalizeMarkdownBlock(bead.description, 'description')),
    renderSection('Design', renderDesignSection(bead, context)),
    renderSection(
      'Acceptance criteria',
      normalizeMarkdownBlock(bead.acceptanceCriteria, 'acceptanceCriteria'),
    ),
    renderSection('Implementation notes', normalizeMarkdownBlock(bead.notes, 'notes')),
    renderSection(
      'Dependencies',
      renderDependenciesSection(bead, inventoryById, mirroredIssueUrlsByBeadId),
    ),
    renderSection('Labels', renderLabelsSection(bead)),
    renderSection('Source metadata', renderSourceMetadata(bead)),
    renderSection(
      'Authority notice',
      'This issue body is a generated public mirror of a Beads record. The Beads source remains authoritative, and manual edits here will be overwritten by the next sync.',
    ),
  ];

  return sections.filter(Boolean).join('\n\n');
}

/**
 * @param {readonly PublicBead[]} inventory
 * @param {RenderContext} [context={}]
 * @returns {string}
 */
export function renderProjectReadme(inventory, context = {}) {
  if (!Array.isArray(inventory)) {
    fail('renderProjectReadme expected an inventory array');
  }

  const summary = summarizeInventory(inventory);
  const title = normalizeOptionalInlineText(context.projectName, 'projectName') ?? 'Public Beads inventory';
  const projectMarker = normalizeMarker(
    context.projectMarker ?? DEFAULT_PROJECT_MARKER,
    'renderProjectReadme projectMarker',
  );
  const beforeHistory = [
    projectReadmeMarker(projectMarker, resolveRepositoryIdentity(context)),
    `# ${title}`,
    'This README is a generated public tracking snapshot for mirrored Beads work. The Beads project remains authoritative, so update the source Bead instead of editing this README.',
    renderSection('Inventory snapshot', [
      `- Inventory timestamp: ${resolveInventoryTimestamp(inventory, context)}`,
      `- Total beads: ${summary.total}`,
      `- Active beads: ${summary.active}`,
      `- Closed beads: ${summary.closed}`,
      `- Blocked active beads: ${summary.blocked}`,
    ].join('\n')),
    renderSection('Type counts', renderTypeCountLines(summary.typeCounts)),
    renderSection('Priority counts', renderPriorityCountLines(inventory)),
  ].filter((section) => section != null);
  const afterHistory = [
    renderSection('Field guide', [
      '- Active beads are any source beads whose status is not `closed`.',
      '- Closed beads remain summarized for dependency and audit context.',
      '- Blocked active beads still depend on at least one non-closed source bead.',
      '- Type counts mirror the public-safe Beads issue types.',
      '- Priority counts reflect Beads numeric priorities; lower numbers are more urgent.',
    ].join('\n')),
    renderSection('Sync behavior', [
      '- Active beads can be mirrored into GitHub issues that carry the machine marker in their body.',
      '- Closed dependency history stays summarized here even when issue bodies show only plain closed indicators.',
      '- Manual edits to generated content are overwritten on the next sync; update the source Bead instead.',
    ].join('\n')),
    renderSection(
      'Authority',
      'The Beads project remains authoritative. Public GitHub issues and this README are generated mirrors managed by Psyche Build.',
    ),
  ].filter((section) => section != null);

  const rendered = renderBudgetedProjectReadme(
    beforeHistory,
    renderClosedHistoryLines(inventory),
    afterHistory,
    projectMarker,
  );
  assertProjectReadmeWithinLimit(rendered);
  return rendered;
}
