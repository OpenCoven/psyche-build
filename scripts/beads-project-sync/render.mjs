// @ts-check

import { summarizeInventory } from './model.mjs';
import { assertNoPublishableSecrets, sanitizePublicText } from './sanitize.mjs';

/** @typedef {import('./sanitize.mjs').PublicBead} PublicBead */

/**
 * @typedef {{
 *   inventoryById?: ReadonlyMap<string, PublicBead> | Record<string, PublicBead>,
 *   mirroredIssueUrlsByBeadId?: ReadonlyMap<string, string> | Record<string, string>,
 *   sourceRepositoryUrl?: string | null,
 *   sourceRef?: string | null,
 *   inventoryTimestamp?: string | null,
 *   projectName?: string | null,
 * }} RenderContext
 */

const ISSUE_MARKER_PREFIX = '<!-- psyche-bead-sync:v1 bead-id=';
const PROJECT_README_MARKER = '<!-- psyche-bead-sync:v1 project-readme -->';
const GENERATED_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1/giu;
const TYPE_SORT_ORDER = ['epic', 'feature', 'task'];
const ABSOLUTE_URL_PATTERN = /^(?:git\+)?[A-Za-z][A-Za-z0-9+.-]*:\/\//iu;

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
 * @returns {string}
 */
function escapeGeneratedMarkers(value) {
  return value.replace(GENERATED_MARKER_PATTERN, '&lt;!-- psyche-bead-sync:v1');
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

  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      const [, marker, suffix] = fenceMatch;
      if (activeFence == null) {
        activeFence = marker;
      } else if (
        marker[0] === activeFence[0]
        && marker.length >= activeFence.length
        && /^[ \t]*$/u.test(suffix)
      ) {
        activeFence = null;
      }
      return line;
    }

    return activeFence == null ? normalizeHeadingLine(line) : line;
  }).join('\n');
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
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeSourceUrl(value) {
  return normalizeHttpUrl(value, 'sourcePath');
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
  const normalizedPath = normalizeOptionalInlineText(path, 'sourcePath');
  if (normalizedPath == null) {
    return null;
  }

  const normalizedSourceUrl = normalizeSourceUrl(normalizedPath);
  if (normalizedSourceUrl) {
    return normalizedSourceUrl;
  }
  if (looksLikeAbsoluteUrl(normalizedPath)) {
    return null;
  }

  const repositoryUrl = normalizeRepositoryUrl(context.sourceRepositoryUrl);
  if (!repositoryUrl || normalizedPath.startsWith('/')) {
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
  const designLink = renderSourceLink(bead.design, context);
  const planLink = renderSourceLink(bead.specId, context);

  if (designLink) {
    lines.push(`- Design doc: ${designLink}`);
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
 * @returns {string}
 */
function renderClosedHistory(inventory) {
  const closed = inventory
    .filter((bead) => bead.status === 'closed')
    .sort((left, right) => {
      const leftTimestamp = left.closedAt ?? left.updatedAt;
      const rightTimestamp = right.closedAt ?? right.updatedAt;
      return compareStrings(rightTimestamp, leftTimestamp) || compareStrings(left.id, right.id);
    });

  return closed.length > 0
    ? closed.map((bead) => {
      const closedAt = normalizeInlineText(bead.closedAt ?? bead.updatedAt, 'closedAt');
      return `- \`${normalizeInlineText(bead.id, 'id')}\` — ${normalizeInlineText(bead.title, 'title')} (closed ${closedAt})`;
    }).join('\n')
    : '- No closed beads in this snapshot.';
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
  return `[${normalizeInlineText(bead.id, 'id')}] ${normalizeInlineText(bead.title, 'title')}`;
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

  const sections = [
    `${ISSUE_MARKER_PREFIX}${normalizeInlineText(bead.id, 'id')} -->`,
    renderSection('Bead', [
      `- ID: \`${normalizeInlineText(bead.id, 'id')}\``,
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
      'This issue body is a generated public mirror of a private Beads record. The Beads source remains authoritative, and manual edits here will be overwritten by the next sync.',
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
  const sections = [
    PROJECT_README_MARKER,
    `# ${title}`,
    'This README is a generated public tracking snapshot for mirrored Beads work. The private Beads project remains authoritative, so update the source Bead instead of editing this README.',
    renderSection('Inventory snapshot', [
      `- Inventory timestamp: ${resolveInventoryTimestamp(inventory, context)}`,
      `- Total beads: ${summary.total}`,
      `- Active beads: ${summary.active}`,
      `- Closed beads: ${summary.closed}`,
      `- Blocked active beads: ${summary.blocked}`,
    ].join('\n')),
    renderSection('Type counts', renderTypeCountLines(summary.typeCounts)),
    renderSection('Priority counts', renderPriorityCountLines(inventory)),
    renderSection('Closed history summary', renderClosedHistory(inventory)),
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
      'The private Beads project remains authoritative. Public GitHub issues and this README are generated mirrors managed by Psyche Build.',
    ),
  ];

  return sections.filter(Boolean).join('\n\n');
}
