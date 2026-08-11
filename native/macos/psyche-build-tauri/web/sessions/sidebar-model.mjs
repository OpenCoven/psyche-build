import { hasWorkingIndicators } from './attention.mjs';
import { buildProjectRailModel, statusPresentation } from './session-model.mjs';

export const SIDEBAR_FILTERS = Object.freeze([
  'all',
  'agents',
  'shells',
  'active',
  'attention',
]);

export const SIDEBAR_ACTIVE_WINDOW_MS = 8_000;

const STATUS_PRESENTATION = Object.freeze({
  exited: Object.freeze({
    key: 'exited',
    label: 'EXITED',
    icon: '×',
    tooltip: 'Exited — process has ended',
  }),
  attention: Object.freeze({
    key: 'attention',
    label: 'REPLY',
    icon: '!',
    tooltip: 'Attention — waiting for your response',
  }),
  busy: Object.freeze({
    key: 'busy',
    label: 'BUSY',
    icon: '↻',
    tooltip: 'Busy — process is starting or actively working',
  }),
  active: Object.freeze({
    key: 'active',
    label: 'ACTIVE',
    icon: '●',
    tooltip: 'Active — process is alive and recently produced output',
  }),
  idle: Object.freeze({
    key: 'idle',
    label: 'IDLE',
    icon: '–',
    tooltip: 'Idle — process is alive and ready for input',
  }),
});

const SORT_ORDER = Object.freeze({
  attention: 0,
  busy: 1,
  active: 2,
  idle: 3,
  exited: 4,
});
const NON_LIVE_LOCAL_STATUSES = new Set(['exited', 'failed']);

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function basename(value) {
  const normalized = text(value).replace(/[\\/]+$/, '');
  if (!normalized) return '';
  return normalized.split(/[\\/]/).pop() || normalized;
}

function commandLabel(thread) {
  const command = basename(thread?.launch?.command);
  const firstArg = Array.isArray(thread?.launch?.args) ? text(thread.launch.args[0]) : '';
  return [command, firstArg].filter(Boolean).join(' ');
}

function numericValue(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function searchValue(parts) {
  return parts
    .map((part) => text(part))
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function statusKeyForSort(status) {
  return SORT_ORDER[status?.key] ?? SORT_ORDER.idle;
}

function projectTitle(project) {
  return text(project?.name) || basename(project?.root);
}

function projectStableIdentity(project) {
  return text(project?.id || project?.root);
}

function branchTitle(worktree) {
  return text(worktree?.branch)
    || (worktree?.is_main ? 'main checkout' : basename(worktree?.path))
    || 'Unresolved sessions';
}

function localRowType(thread) {
  return (thread?.kind || 'shell') === 'shell' ? 'shells' : 'agents';
}

// A tool pane is neither an agent nor a shell: filing Git under Agents would
// claim a model is running in it.
const TOOL_KINDS = ['git', 'web'];

function isToolRow(row) {
  return TOOL_KINDS.indexOf(text(row?.kind)) !== -1;
}

function localRowTitle(thread) {
  return text(thread?.name || thread?.title || thread?.id);
}

function covenHarness(session) {
  return text(session?.harness) || 'Coven';
}

function rowSearchText(project, worktree, row, extras = []) {
  return searchValue([
    project?.name,
    project?.root,
    worktree?.branch,
    worktree?.path,
    row.type,
    row.title,
    row.baseTitle,
    row.id,
    row.kind,
    row.command,
    row.status?.label,
    row.status?.tooltip,
    row.meta,
    ...extras,
  ]);
}

function rowMatchesQuery(row, normalizedQuery) {
  return !normalizedQuery || row.searchText.includes(normalizedQuery);
}

function matchesFilter(row, filter) {
  switch (filter) {
    case 'agents':
      return row.type === 'agents' && !isToolRow(row);
    case 'shells':
      return row.type === 'shells';
    case 'active':
      return row.status.key === 'busy' || row.status.key === 'active';
    case 'attention':
      return row.status.key === 'attention';
    default:
      return true;
  }
}

function normalizeOwnedWorktreePath(ownedRow, worktree) {
  if (ownedRow?.worktreePath === null) return null;
  const ownedPath = text(ownedRow?.worktreePath);
  if (ownedPath) return ownedPath;
  const worktreePath = text(worktree?.path);
  return worktreePath || null;
}

function normalizeLocalRow(project, worktree, ownedRow, thread, now) {
  const kind = text(thread?.kind) || 'shell';
  const title = localRowTitle(thread);
  const command = commandLabel(thread);
  const status = deriveLocalSidebarStatus(thread, now);
  const type = localRowType(thread);
  const discriminator = command || text(thread?.id);
  const row = {
    key: `psyche:${text(thread?.id)}`,
    source: 'psyche',
    id: text(thread?.id),
    projectRoot: text(project?.root),
    worktreePath: normalizeOwnedWorktreePath(ownedRow, worktree),
    kind,
    type,
    title,
    baseTitle: title,
    meta: command || (type === 'agents' ? kind : 'ready'),
    command,
    discriminator,
    status,
    needsAttention: status.key === 'attention',
    lastActiveAt: numericValue(thread?.lastOutputAt),
    value: thread,
  };
  row.selectionKey = localSidebarSelectionKey(project, thread);
  row.searchText = rowSearchText(project, worktree, row, [
    thread?.cwd,
    thread?.launch?.cwd,
  ]);
  row.titleMatches = [];
  row.metaMatches = [];
  row.statusMatches = [];
  return row;
}

function normalizeCovenRow(project, worktree, ownedRow, session) {
  const status = deriveCovenSidebarStatus(session);
  const harness = covenHarness(session);
  const row = {
    key: `coven:${text(session?.id)}`,
    source: 'coven',
    id: text(session?.id),
    projectRoot: text(project?.root),
    worktreePath: normalizeOwnedWorktreePath(ownedRow, worktree),
    kind: 'agent',
    type: 'agents',
    title: text(session?.title || session?.id),
    baseTitle: text(session?.title || session?.id),
    meta: [harness, lower(session?.status) || status.label.toLowerCase()].filter(Boolean).join(' · '),
    command: '',
    discriminator: text(session?.id),
    status,
    needsAttention: status.key === 'attention',
    lastActiveAt: numericValue(Date.parse(text(session?.updatedAt)), 0),
    value: session,
  };
  row.selectionKey = sidebarSelectionKey(row);
  row.searchText = rowSearchText(project, worktree, row, [
    harness,
    session?.status,
    session?.cwd,
    'coven',
  ]);
  row.titleMatches = [];
  row.metaMatches = [];
  row.statusMatches = [];
  return row;
}

function compareRowKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function differentiateDuplicateTitles(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = lower(row.baseTitle);
    const matches = groups.get(key) ?? [];
    matches.push(row);
    groups.set(key, matches);
  }

  for (const matches of groups.values()) {
    if (matches.length < 2) continue;

    const orderedMatches = [...matches].sort((left, right) => (
      compareRowKeys(left.key, right.key)
    ));
    const ordinals = new Map(orderedMatches.map((row, index) => [row.key, String(index + 1)]));
    const detailCollisions = new Map();

    for (const row of orderedMatches) {
      const detail = row.command || ordinals.get(row.key) || row.id || row.meta;
      const collisionGroup = detailCollisions.get(detail) ?? [];
      collisionGroup.push(row);
      detailCollisions.set(detail, collisionGroup);
    }

    for (const row of orderedMatches) {
      const detail = row.command || ordinals.get(row.key) || row.id || row.meta;
      const collisionGroup = detailCollisions.get(detail) ?? [];
      const uniqueDetail = collisionGroup.length > 1
        ? `${detail} · ${collisionGroup.findIndex((match) => match.key === row.key) + 1}`
        : detail;
      row.title = `${row.baseTitle} · ${uniqueDetail}`;
      row.searchText = `${row.searchText}\n${lower(row.title)}`;
    }
  }

  return rows;
}

function sortRows(rows, selectedKey) {
  return [...rows].sort((left, right) => {
    const leftSelected = left.selectionKey === selectedKey;
    const rightSelected = right.selectionKey === selectedKey;
    if (leftSelected !== rightSelected) return Number(rightSelected) - Number(leftSelected);

    const statusDifference = statusKeyForSort(left.status) - statusKeyForSort(right.status);
    if (statusDifference) return statusDifference;

    const activityDifference = numericValue(right.lastActiveAt) - numericValue(left.lastActiveAt);
    if (activityDifference) return activityDifference;

    return compareRowKeys(left.key, right.key);
  });
}

function buildCategory(label, icon, rows, query) {
  return {
    key: lower(label),
    label,
    icon,
    count: rows.length,
    labelMatches: matchTextRanges(label, query),
    rows: rows.map((row) => ({
      ...row,
      titleMatches: matchTextRanges(row.title, query),
      metaMatches: matchTextRanges(row.meta, query),
      statusMatches: matchTextRanges(row.status.label, query),
    })),
  };
}

export function normalizeSidebarFilter(value) {
  const normalized = lower(value);
  return SIDEBAR_FILTERS.includes(normalized) ? normalized : 'all';
}

export function sidebarTailIsWorking(tail) {
  return hasWorkingIndicators(tail);
}

export function deriveLocalSidebarStatus(
  thread,
  now = Date.now(),
  activeWindowMs = SIDEBAR_ACTIVE_WINDOW_MS,
) {
  const status = lower(thread?.status);
  if (NON_LIVE_LOCAL_STATUSES.has(status)) return STATUS_PRESENTATION.exited;
  if (thread?.needsAttention) return STATUS_PRESENTATION.attention;

  const isWorking = Boolean(thread?.isWorking);
  if (thread?.spawning || status === 'starting' || isWorking) {
    return STATUS_PRESENTATION.busy;
  }

  const lastOutputAt = numericValue(thread?.lastOutputAt, Number.NEGATIVE_INFINITY);
  if (status === 'running' && now - lastOutputAt <= activeWindowMs) {
    return STATUS_PRESENTATION.active;
  }

  return STATUS_PRESENTATION.idle;
}

export function deriveCovenSidebarStatus(session) {
  const label = statusPresentation(session?.status).label;
  if (label === 'waiting') return STATUS_PRESENTATION.attention;
  if (label === 'starting' || label === 'running') return STATUS_PRESENTATION.busy;
  return STATUS_PRESENTATION.exited;
}

export function sidebarSelectionKey(row) {
  if (row?.source === 'coven') return `coven:${text(row?.id)}`;

  return [
    'psyche:',
    text(row?.projectRoot),
    '\u0000',
    text(row?.worktreePath),
    '\u0000',
    text(row?.kind) || 'shell',
    '\u0000',
    text(row?.baseTitle || row?.title),
    '\u0000',
    text(row?.discriminator || row?.command || row?.id),
    '\u0000',
    text(row?.id),
  ].join('');
}

export function localSidebarSelectionKey(project, thread) {
  return sidebarSelectionKey({
    source: 'psyche',
    id: thread?.id,
    projectRoot: project?.root,
    worktreePath: thread?.worktreePath,
    kind: thread?.kind || 'shell',
    baseTitle: localRowTitle(thread),
    discriminator: commandLabel(thread) || thread?.id,
  });
}

export function matchTextRanges(value, query) {
  const source = String(value ?? '');
  const needle = lower(query);
  if (!needle) return [];

  const haystack = source.toLowerCase();
  const ranges = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    ranges.push([index, index + needle.length]);
    from = index + needle.length;
  }
  return ranges;
}

export function buildSidebarProjectModel(options) {
  const {
    project,
    localSessions = [],
    covenSessions = [],
    query = '',
    filter = 'all',
    selectedKey = '',
    now = Date.now(),
  } = options ?? {};

  const normalizedQuery = lower(query);
  const normalizedFilter = normalizeSidebarFilter(filter);
  const ownership = buildProjectRailModel(project, localSessions, covenSessions, '');
  const projectSearch = searchValue([project?.name, project?.root]);
  const projectMatches = Boolean(normalizedQuery) && projectSearch.includes(normalizedQuery);
  const branchEntries = [...ownership.worktrees];

  if (ownership.projectRows.length > 0) {
    branchEntries.push({
      worktree: {
        path: '',
        branch: 'Unresolved sessions',
        collapsed: false,
        dirty: false,
        missing: true,
        virtual: true,
      },
      rows: ownership.projectRows,
    });
  }

  const branches = branchEntries
    .map((entry) => {
      const worktree = entry.worktree;
      const branchSearch = searchValue([worktree?.branch, worktree?.path]);
      const branchMatches = Boolean(normalizedQuery) && branchSearch.includes(normalizedQuery);

      const normalizedRows = differentiateDuplicateTitles(entry.rows.map((ownedRow) => (
        ownedRow.source === 'coven'
          ? normalizeCovenRow(project, worktree, ownedRow, ownedRow.value)
          : normalizeLocalRow(project, worktree, ownedRow, ownedRow.value, now)
      )));

      const visibleRows = sortRows(normalizedRows.filter((row) => {
        if (!matchesFilter(row, normalizedFilter)) return false;
        return projectMatches || branchMatches || rowMatchesQuery(row, normalizedQuery);
      }), selectedKey);

      if (visibleRows.length === 0) return null;

      const agentRows = visibleRows.filter((row) => row.type === 'agents' && !isToolRow(row));
      const toolRows = visibleRows.filter((row) => row.type === 'agents' && isToolRow(row));
      const shellRows = visibleRows.filter((row) => row.type === 'shells');
      const categories = [
        agentRows.length ? buildCategory('Agents', '✳', agentRows, normalizedQuery) : null,
        toolRows.length ? buildCategory('Tools', '◍', toolRows, normalizedQuery) : null,
        shellRows.length ? buildCategory('Shells', '❯_', shellRows, normalizedQuery) : null,
      ].filter(Boolean);

      return {
        key: `branch:${projectStableIdentity(project)}\u0000${text(worktree?.path) || '__unresolved__'}`,
        worktree,
        title: branchTitle(worktree),
        titleMatches: matchTextRanges(branchTitle(worktree), normalizedQuery),
        count: visibleRows.length,
        attentionCount: visibleRows.filter((row) => row.needsAttention).length,
        expanded: Boolean(normalizedQuery) || !Boolean(worktree?.collapsed),
        autoExpanded: Boolean(normalizedQuery) && Boolean(worktree?.collapsed),
        categories,
      };
    })
    .filter(Boolean);

  const visibleRows = branches.flatMap((branch) => (
    branch.categories.flatMap((category) => category.rows)
  ));
  const title = projectTitle(project);

  return {
    key: `project:${projectStableIdentity(project)}`,
    project,
    title,
    titleMatches: matchTextRanges(title, normalizedQuery),
    count: visibleRows.length,
    visibleCount: visibleRows.length,
    attentionCount: visibleRows.filter((row) => row.needsAttention).length,
    expanded: Boolean(normalizedQuery) || !Boolean(project?.collapsed),
    autoExpanded: Boolean(normalizedQuery) && Boolean(project?.collapsed),
    branches,
  };
}
