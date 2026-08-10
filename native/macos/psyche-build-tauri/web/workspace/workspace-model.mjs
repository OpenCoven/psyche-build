const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const ALLOWED_KINDS = new Set(['shell', 'psyche', 'coven-chat', 'coven-attach']);
const COLUMN = 'column';
const ROW = 'row';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID.test(value) ? value : null;
}

function normalizeKind(value) {
  const kind = safeString(value);
  return kind && ALLOWED_KINDS.has(kind) ? kind : null;
}

function normalizeRatio(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function findFirstLeafId(root) {
  if (!root || typeof root !== 'object') return null;
  if (root.type === 'leaf') return safeString(root.id);
  return findFirstLeafId(root.first) || findFirstLeafId(root.second);
}

function findLeafById(root, leafId) {
  if (!root || typeof root !== 'object') return false;
  if (root.type === 'leaf') return root.id === leafId;
  return findLeafById(root.first, leafId) || findLeafById(root.second, leafId);
}

function sanitizePaneTreeDetails(root, knownThreadIds, seenLeaves = new Set()) {
  const known =
    knownThreadIds instanceof Set
      ? knownThreadIds
      : new Set(Array.isArray(knownThreadIds) ? knownThreadIds : []);
  const seed =
    seenLeaves instanceof Set
      ? new Set(seenLeaves)
      : new Set(Array.isArray(seenLeaves) ? seenLeaves : []);

  function visit(node, seen) {
    if (!isObject(node) || typeof node.type !== 'string') return null;

    if (node.type === 'leaf') {
      const id = safeId(node.id);
      const threadId = safeId(node.threadId);
      if (!id || !threadId || !known.has(threadId) || seen.has(threadId)) return null;
      const threadIds = new Set([threadId]);
      return { node: { type: 'leaf', id, threadId }, threadIds };
    }

    if (node.type !== 'split') return null;

    const id = safeId(node.id);

    if (!id) {
      const first = visit(node.first, seen);
      const second = visit(node.second, seen);
      return first || second;
    }

    const first = visit(node.first, seen);
    const seenForSecond = first
      ? new Set([...seen, ...first.threadIds])
      : seen;
    const second = visit(node.second, seenForSecond);

    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;

    const threadIds = new Set(first.threadIds);
    for (const threadId of second.threadIds) {
      threadIds.add(threadId);
    }

    return {
      node: {
        type: 'split',
        id,
        orientation: node.orientation === ROW ? ROW : COLUMN,
        ratio: normalizeRatio(node.ratio),
        first: first.node,
        second: second.node,
      },
      threadIds,
    };
  }

  return visit(root, seed);
}

export function importWorkspaceV2(saved) {
  return {
    version: 3,
    activeProjectId: safeString(saved?.activeProjectId),
    activeThreadId: null,
    projects: Array.isArray(saved?.projects) ? saved.projects.slice() : [],
    sessions: [],
    paneLayouts: [],
  };
}

export function sanitizeSessionDescriptor(saved) {
  if (!isObject(saved)) return null;

  const id = safeId(saved.id);
  const projectId = safeString(saved.projectId);
  const worktreePath = safeString(saved.worktreePath);
  const launchKind = normalizeKind(saved.launchKind);

  if (!id || !projectId || !worktreePath || !launchKind) return null;

  const descriptor = {
    id,
    projectId,
    worktreePath,
    hidden: Boolean(saved.hidden),
    launchKind,
    kind: normalizeKind(saved.kind) || launchKind,
  };

  const name = safeString(saved.name);
  if (name) descriptor.name = name;

  if (launchKind === 'coven-attach') {
    const covenSessionId = safeId(saved.covenSessionId);
    if (!covenSessionId) return null;
    descriptor.covenSessionId = covenSessionId;
  }

  return descriptor;
}

export function sanitizePaneTree(root, knownThreadIds, seenLeaves = new Set()) {
  const sanitized = sanitizePaneTreeDetails(root, knownThreadIds, seenLeaves);
  if (!sanitized) return null;
  if (seenLeaves instanceof Set) {
    for (const threadId of sanitized.threadIds) {
      seenLeaves.add(threadId);
    }
  }
  return sanitized.node;
}

export function reconcileSessions(descriptors, liveIds) {
  const live = new Set(Array.isArray(liveIds) ? liveIds.filter((id) => typeof id === 'string') : []);
  const sessions = [];
  const unknownLiveIds = new Set();

  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    const session = sanitizeSessionDescriptor(descriptor);
    if (!session) continue;

    if (live.has(session.id)) {
      sessions.push({ ...session, status: 'running', persistentLive: true });
      live.delete(session.id);
    } else {
      sessions.push({ ...session, status: 'exited', persistentLive: false });
    }
  }

  for (const id of live) {
    unknownLiveIds.add(id);
  }

  return {
    sessions,
    unknownLiveIds: [...unknownLiveIds].sort(),
  };
}

function sanitizePaneLayout(saved, knownThreadIds, seenLeaves) {
  if (!isObject(saved)) return null;

  const projectId = safeString(saved.projectId);
  const worktreePath = safeString(saved.worktreePath);
  if (!projectId || !worktreePath) return null;

  const sanitizedRoot = sanitizePaneTreeDetails(saved.root, knownThreadIds, seenLeaves);
  if (!sanitizedRoot) return null;

  let focusedLeafId = safeString(saved.focusedLeafId);
  if (!focusedLeafId || !findLeafById(sanitizedRoot.node, focusedLeafId)) {
    focusedLeafId = findFirstLeafId(sanitizedRoot.node);
  }

  return {
    projectId,
    worktreePath,
    root: sanitizedRoot.node,
    focusedLeafId,
    threadIds: sanitizedRoot.threadIds,
  };
}

export function sanitizeWorkspaceV3(saved) {
  if (!isObject(saved) || saved.version !== 3) return null;

  const projects = Array.isArray(saved.projects) ? saved.projects.slice() : [];
  const sessions = [];
  const knownThreadIds = new Set();

  for (const descriptor of Array.isArray(saved.sessions) ? saved.sessions : []) {
    const session = sanitizeSessionDescriptor(descriptor);
    if (!session || knownThreadIds.has(session.id)) continue;
    knownThreadIds.add(session.id);
    sessions.push(session);
  }

  const activeProjectId = safeString(saved.activeProjectId) && projects.some((project) => project && project.id === safeString(saved.activeProjectId))
    ? safeString(saved.activeProjectId)
    : null;
  const activeThreadId = safeString(saved.activeThreadId) && knownThreadIds.has(safeString(saved.activeThreadId))
    ? safeString(saved.activeThreadId)
    : null;

  const seenLayouts = new Set();
  const seenLeaves = new Set();
  const paneLayouts = [];
  const layouts = Array.isArray(saved.paneLayouts)
    ? saved.paneLayouts
    : isObject(saved.paneLayouts)
      ? Object.values(saved.paneLayouts)
      : [];

  for (const layout of layouts) {
    const sanitized = sanitizePaneLayout(layout, knownThreadIds, seenLeaves);
    if (!sanitized) continue;

    const key = `${sanitized.projectId}\u0000${sanitized.worktreePath}`;
    if (seenLayouts.has(key)) continue;
    seenLayouts.add(key);
    for (const threadId of sanitized.threadIds) {
      seenLeaves.add(threadId);
    }
    const { threadIds, ...layoutEntry } = sanitized;
    paneLayouts.push(layoutEntry);
  }

  return {
    version: 3,
    activeProjectId,
    activeThreadId,
    projects,
    sessions,
    paneLayouts,
  };
}
