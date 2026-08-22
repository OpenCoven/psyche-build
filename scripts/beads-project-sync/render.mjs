import { summarizeInventory } from './model.mjs';

const ISSUE_MARKER_PREFIX = '<!-- psyche-bead-sync:v1 bead-id=';
const PROJECT_README_MARKER = '<!-- psyche-bead-sync:v1 project-readme -->';
const GENERATED_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1/giu;
const TYPE_SORT_ORDER = ['epic', 'feature', 'task'];

function fail(message) {
  throw new Error(message);
}

function escapeGeneratedMarkers(value) {
  return value.replace(GENERATED_MARKER_PATTERN, '&lt;!-- psyche-bead-sync:v1');
}

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

function normalizeHeadingLine(line) {
  return line.replace(/^(#{1,6})(?=\s)/u, (heading) => '#'.repeat(Math.min(heading.length + 1, 6)));
}

function promoteHeadingsOutsideCodeFences(value) {
  const lines = value.split('\n');
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

function normalizeRecordMap(value, fieldName) {
  if (value == null) {
    return new Map();
  }
  if (value instanceof Map) {
    return new Map(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return new Map(Object.entries(value));
  }
  fail(`${fieldName} must be an object or Map when present`);
}

function normalizeRepositoryUrl(value) {
  const normalized = normalizeOptionalInlineText(value, 'sourceRepositoryUrl');
  return normalized == null ? null : normalized.replace(/^git\+/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '');
}

function encodePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function renderSection(title, content) {
  if (!content) {
    return null;
  }

  return `## ${title}\n${content}`;
}

function renderSourceLink(path, context) {
  const normalizedPath = normalizeOptionalInlineText(path, 'sourcePath');
  if (normalizedPath == null) {
    return null;
  }

  const repositoryUrl = normalizeRepositoryUrl(context.sourceRepositoryUrl);
  if (!repositoryUrl || normalizedPath.startsWith('/') || normalizedPath.includes('://')) {
    return normalizedPath;
  }

  const sourceRef = normalizeOptionalInlineText(context.sourceRef, 'sourceRef') ?? 'main';
  return `[${normalizedPath}](${repositoryUrl}/blob/${encodePath(sourceRef)}/${encodePath(normalizedPath)})`;
}

function renderMirroredDependencyLink(id, url) {
  const dependencyId = normalizeInlineText(id, 'dependency id');
  const dependencyUrl = normalizeOptionalInlineText(url, 'mirroredIssueUrl');
  if (!dependencyUrl) {
    return `\`${dependencyId}\``;
  }

  const issueNumber = dependencyUrl.match(/\/issues\/(\d+)(?:[/?#]|$)/u)?.[1];
  if (issueNumber) {
    return `[#${issueNumber}](${dependencyUrl}) \`${dependencyId}\``;
  }

  return `[\`${dependencyId}\`](${dependencyUrl})`;
}

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

function renderDependenciesSection(bead, inventoryById, mirroredIssueUrlsByBeadId) {
  const lines = [];

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

  for (const blockedById of bead.blockedByIds ?? []) {
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

function renderLabelsSection(bead) {
  const labels = Array.isArray(bead.labels)
    ? [...bead.labels]
      .map((label) => normalizeInlineText(label, 'label'))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    : [];
  return labels.length > 0 ? labels.map((label) => `- \`${label}\``).join('\n') : null;
}

function renderDesignSection(bead, context) {
  const lines = [];
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

function renderSourceMetadata(bead) {
  const lines = [
    `- Source status: \`${normalizeInlineText(bead.status, 'status')}\``,
    `- Source type: \`${normalizeInlineText(bead.type, 'type')}\``,
    `- Source priority: P${Number(bead.priority)}`,
    `- Source blocked: ${bead.blocked ? 'yes' : 'no'}`,
    `- Created at: ${normalizeInlineText(bead.createdAt, 'createdAt')}`,
    `- Updated at: ${normalizeInlineText(bead.updatedAt, 'updatedAt')}`,
  ];

  if (bead.closedAt) {
    lines.push(`- Closed at: ${normalizeInlineText(bead.closedAt, 'closedAt')}`);
  }

  return lines.join('\n');
}

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
    return left.localeCompare(right);
  });

  return keys.length > 0
    ? keys.map((type) => `- ${type}: ${typeCounts[type]}`).join('\n')
    : '- none';
}

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

function renderClosedHistory(inventory) {
  const closed = inventory
    .filter((bead) => bead.status === 'closed')
    .sort((left, right) => {
      const leftTimestamp = left.closedAt ?? left.updatedAt;
      const rightTimestamp = right.closedAt ?? right.updatedAt;
      return rightTimestamp.localeCompare(leftTimestamp) || left.id.localeCompare(right.id);
    });

  return closed.length > 0
    ? closed.map((bead) => {
      const closedAt = normalizeInlineText(bead.closedAt ?? bead.updatedAt, 'closedAt');
      return `- \`${normalizeInlineText(bead.id, 'id')}\` — ${normalizeInlineText(bead.title, 'title')} (closed ${closedAt})`;
    }).join('\n')
    : '- No closed beads in this snapshot.';
}

function resolveInventoryTimestamp(inventory, context) {
  const contextTimestamp = normalizeOptionalInlineText(context.inventoryTimestamp, 'inventoryTimestamp');
  if (contextTimestamp) {
    return contextTimestamp;
  }

  const timestamps = inventory
    .flatMap((bead) => [bead.updatedAt, bead.closedAt].filter(Boolean))
    .map((timestamp) => normalizeInlineText(timestamp, 'inventory timestamp'));
  return timestamps.sort((left, right) => right.localeCompare(left))[0] ?? 'unknown';
}

export function renderIssueTitle(bead) {
  return `[${normalizeInlineText(bead.id, 'id')}] ${normalizeInlineText(bead.title, 'title')}`;
}

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
