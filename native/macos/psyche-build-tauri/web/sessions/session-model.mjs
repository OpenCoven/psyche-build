const safeCovenSessionId = /^[A-Za-z0-9._:-]{1,128}$/;
const rfc3339Timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeStatus(status) {
  return typeof status === 'string' && status.trim()
    ? status.trim().toLowerCase()
    : 'unknown';
}

function normalizedMessage(message) {
  if (typeof message !== 'string') return null;
  return message.trim() || null;
}

function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function updatedAtValue(session) {
  if (typeof session?.updatedAt !== 'string') {
    return Number.NEGATIVE_INFINITY;
  }

  const match = rfc3339Timestamp.exec(session.updatedAt);
  if (!match) return Number.NEGATIVE_INFINITY;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    return Number.NEGATIVE_INFINITY;
  }

  if (offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return Number.NEGATIVE_INFINITY;
    }
  }

  const value = Date.parse(session.updatedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareSessionIds(left, right) {
  const leftId = isSafeCovenSessionId(left?.id) ? left.id : '';
  const rightId = isSafeCovenSessionId(right?.id) ? right.id : '';
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function contains(value, query) {
  return typeof value === 'string' && value.toLowerCase().includes(query);
}

export function isSafeCovenSessionId(id) {
  return typeof id === 'string' && safeCovenSessionId.test(id);
}

export function statusPresentation(status) {
  const label = normalizeStatus(status);

  switch (label) {
    case 'starting':
      return { tone: 'warn', label, live: true };
    case 'running':
      return { tone: 'ok', label, live: true };
    case 'waiting':
      return { tone: 'warn', label, live: true };
    case 'completed':
    case 'archived':
      return { tone: 'muted', label, live: false };
    case 'failed':
    case 'killed':
    case 'orphaned':
      return { tone: 'danger', label, live: false };
    default:
      return { tone: 'neutral', label, live: false };
  }
}

export function sortCovenSessions(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) => {
    const liveDifference = Number(statusPresentation(right?.status).live)
      - Number(statusPresentation(left?.status).live);
    if (liveDifference) return liveDifference;

    const updatedDifference = updatedAtValue(right) - updatedAtValue(left);
    if (updatedDifference) return updatedDifference;

    return compareSessionIds(left, right);
  });
}

export function groupCovenSessions(sessions) {
  const grouped = new Map();

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || !isSafeCovenSessionId(session.id)
      || typeof session.projectRoot !== 'string' || !session.projectRoot) {
      continue;
    }

    const projectSessions = grouped.get(session.projectRoot) ?? [];
    projectSessions.push(session);
    grouped.set(session.projectRoot, projectSessions);
  }

  for (const [projectRoot, projectSessions] of grouped) {
    grouped.set(projectRoot, sortCovenSessions(projectSessions));
  }

  return grouped;
}

export function filterProjectSessions(project, psycheSessions, covenSessions, query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const projectMatches = Boolean(normalizedQuery) && contains(project?.name, normalizedQuery);
  const local = Array.isArray(psycheSessions) ? psycheSessions : [];
  const remote = Array.isArray(covenSessions) ? covenSessions : [];

  if (!normalizedQuery || projectMatches) {
    return {
      projectMatches,
      psycheSessions: [...local],
      covenSessions: sortCovenSessions(remote),
    };
  }

  return {
    projectMatches: false,
    psycheSessions: local.filter((session) => (
      contains(session?.name, normalizedQuery) || contains(session?.title, normalizedQuery)
    )),
    covenSessions: sortCovenSessions(remote.filter((session) => (
      contains(session?.title, normalizedQuery)
      || contains(session?.harness, normalizedQuery)
      || contains(statusPresentation(session?.status).label, normalizedQuery)
      || contains(session?.id, normalizedQuery)
    ))),
  };
}

function isInsideOrEqual(parent, candidate) {
  if (typeof parent !== 'string' || typeof candidate !== 'string') return false;
  if (candidate === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return candidate.startsWith(prefix);
}

function owningWorktree(worktrees, cwd) {
  return [...worktrees]
    .filter((worktree) => isInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
}

/**
 * Normalize local PTYs and daemon sessions into the same rail-row contract.
 * Rendering code can still offer source-specific actions, but grouping,
 * search, status, identity, and worktree ownership have one implementation.
 */
export function buildProjectRailModel(project, psycheSessions, covenSessions, query) {
  const filtered = filterProjectSessions(project, psycheSessions, covenSessions, query);
  const worktrees = Array.isArray(project?.worktrees) && project.worktrees.length
    ? project.worktrees
    : [{
      path: project?.root ?? '', branch: null, is_main: true,
      dirty: false, missing: false, collapsed: false,
    }];
  const rows = [];

  for (const session of filtered.psycheSessions) {
    const cwd = typeof session?.worktreePath === 'string' && session.worktreePath
      ? session.worktreePath
      : project?.root ?? '';
    rows.push({
      key: `psyche:${session?.id ?? ''}`,
      source: 'psyche',
      id: session?.id ?? '',
      title: session?.name ?? session?.title ?? session?.id ?? '',
      status: session?.status ?? 'unknown',
      needsAttention: Boolean(session?.needsAttention),
      worktreePath: owningWorktree(worktrees, cwd)?.path ?? null,
      value: session,
    });
  }

  for (const session of filtered.covenSessions) {
    const cwd = typeof session?.cwd === 'string' && session.cwd
      ? session.cwd
      : session?.projectRoot ?? '';
    rows.push({
      key: `coven:${session?.id ?? ''}`,
      source: 'coven',
      id: session?.id ?? '',
      title: session?.title?.trim() || session?.id || '',
      status: statusPresentation(session?.status).label,
      needsAttention: statusPresentation(session?.status).label === 'waiting',
      worktreePath: owningWorktree(worktrees, cwd)?.path ?? null,
      value: session,
    });
  }

  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const projectMatches = !normalizedQuery || filtered.projectMatches;
  return {
    projectMatches,
    worktrees: worktrees.map((worktree) => ({
      worktree,
      matches: projectMatches || contains(worktree.branch ?? worktree.path, normalizedQuery),
      rows: rows.filter((row) => row.worktreePath === worktree.path),
    })),
    projectRows: rows.filter((row) => row.worktreePath === null),
  };
}

export function createCovenDiscoveryState() {
  return {
    phase: 'idle',
    sessionsByProject: new Map(),
    message: null,
    requestId: 0,
    refreshedAt: null,
  };
}

export function beginCovenRequest(state) {
  const requestId = state.requestId + 1;
  const initialRequest = state.phase === 'idle';

  return {
    requestId,
    state: {
      ...state,
      phase: initialRequest ? 'loading' : state.phase,
      sessionsByProject: initialRequest ? new Map() : state.sessionsByProject,
      message: initialRequest ? null : state.message,
      requestId,
    },
  };
}

export function applyCovenResponse(state, requestId, response, refreshedAt = Date.now()) {
  if (requestId !== state.requestId) return state;

  const status = normalizeStatus(response?.status);
  const message = normalizedMessage(response?.message);
  const allowedStatuses = new Set(['ready', 'empty', 'unavailable', 'incompatible', 'error']);
  if (!allowedStatuses.has(status)) {
    return {
      ...state,
      phase: 'error',
      sessionsByProject: new Map(),
      message: null,
      refreshedAt,
    };
  }

  if (status === 'ready' || status === 'empty') {
    return {
      ...state,
      phase: 'ready',
      sessionsByProject: groupCovenSessions(response.sessions),
      message,
      refreshedAt,
    };
  }

  return {
    ...state,
    phase: status,
    sessionsByProject: new Map(),
    message,
    refreshedAt,
  };
}

export function invalidateCovenRequests(state) {
  return {
    ...state,
    phase: 'idle',
    sessionsByProject: new Map(),
    message: null,
    requestId: state.requestId + 1,
    refreshedAt: null,
  };
}
