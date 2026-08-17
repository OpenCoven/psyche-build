const SAFE_WORKSPACE_SESSION_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const SAFE_COVEN_ATTACHMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CANONICAL_COVEN_KIND = 'coven-code';
const LEGACY_COVEN_KIND = 'coven-chat';
const ALLOWED_KINDS = new Set(['shell', 'psyche', CANONICAL_COVEN_KIND, 'coven-attach']);
const COLUMN = 'column';
const ROW = 'row';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, maximum = 4096) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function safeId(value) {
  return typeof value === 'string' && SAFE_WORKSPACE_SESSION_ID.test(value) ? value : null;
}

export function isSafeCovenAttachmentId(value) {
  return typeof value === 'string' && SAFE_COVEN_ATTACHMENT_ID.test(value);
}

function safeCovenAttachmentId(value) {
  return isSafeCovenAttachmentId(value) ? value : null;
}

function normalizeKind(value) {
  const kind = safeString(value);
  if (kind === LEGACY_COVEN_KIND) return CANONICAL_COVEN_KIND;
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

function sanitizePaneTreeDetails(
  root,
  knownThreadIds,
  seenThreadIds = new Set(),
  seenNodeIds = new Set()
) {
  const known =
    knownThreadIds instanceof Set
      ? knownThreadIds
      : new Set(Array.isArray(knownThreadIds) ? knownThreadIds : []);
  const threadSeed =
    seenThreadIds instanceof Set
      ? new Set(seenThreadIds)
      : new Set(Array.isArray(seenThreadIds) ? seenThreadIds : []);
  const nodeSeed =
    seenNodeIds instanceof Set
      ? new Set(seenNodeIds)
      : new Set(Array.isArray(seenNodeIds) ? seenNodeIds : []);

  function visit(node, usedNodeIds, usedThreadIds) {
    if (!isObject(node) || typeof node.type !== 'string') return null;

    if (node.type === 'leaf') {
      const id = safeId(node.id);
      const threadId = safeId(node.threadId);
      if (
        !id ||
        !threadId ||
        !known.has(threadId) ||
        usedNodeIds.has(id) ||
        usedThreadIds.has(threadId)
      ) {
        return null;
      }

      return {
        node: { type: 'leaf', id, threadId },
        nodeIds: new Set([id]),
        threadIds: new Set([threadId]),
      };
    }

    if (node.type !== 'split') return null;

    const id = safeId(node.id);

    if (!id || usedNodeIds.has(id)) {
      const first = visit(node.first, usedNodeIds, usedThreadIds);
      const second = visit(node.second, usedNodeIds, usedThreadIds);
      return first || second;
    }

    const first = visit(node.first, usedNodeIds, usedThreadIds);
    if (!first) {
      return visit(node.second, usedNodeIds, usedThreadIds);
    }

    const nodeIdsForSecond = new Set(usedNodeIds);
    for (const nodeId of first.nodeIds) {
      nodeIdsForSecond.add(nodeId);
    }

    const threadIdsForSecond = new Set(usedThreadIds);
    for (const threadId of first.threadIds) {
      threadIdsForSecond.add(threadId);
    }

    const second = visit(node.second, nodeIdsForSecond, threadIdsForSecond);

    if (!first) return second;
    if (!second) return first;
    if (first.nodeIds.has(id) || second.nodeIds.has(id)) return first;

    const nodeIds = new Set(first.nodeIds);
    nodeIds.add(id);
    const threadIds = new Set(first.threadIds);
    for (const threadId of second.threadIds) {
      threadIds.add(threadId);
    }
    for (const nodeId of second.nodeIds) {
      nodeIds.add(nodeId);
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
      nodeIds,
      threadIds,
    };
  }

  return visit(root, nodeSeed, threadSeed);
}

export function importWorkspaceV2(saved) {
  return {
    version: 3,
    activeProjectId: safeString(saved?.activeProjectId),
    activeThreadId: null,
    projects: Array.isArray(saved?.projects) ? saved.projects.slice() : [],
    sessions: [],
    filesPanes: [],
    paneLayouts: [],
  };
}

export function sanitizeSessionDescriptor(saved) {
  if (!isObject(saved)) return null;

  const id = safeId(saved.id);
  const projectId = safeId(saved.projectId);
  const worktreePath = safeString(saved.worktreePath);
  const launchKind = normalizeKind(saved.launchKind);

  if (!id || !projectId || !worktreePath || !launchKind) return null;

  const descriptor = {
    id,
    projectId,
    worktreePath,
    hidden: saved.hidden === true,
    launchKind,
    kind: normalizeKind(saved.kind) || launchKind,
  };

  const name = safeString(saved.name, 256);
  if (name) descriptor.name = name;

  if (launchKind === 'coven-attach' || launchKind === CANONICAL_COVEN_KIND) {
    const covenSessionId = safeCovenAttachmentId(saved.covenSessionId);
    if (!covenSessionId) return null;
    descriptor.covenSessionId = covenSessionId;
  }

  return descriptor;
}

export function sanitizePaneTree(
  root,
  knownThreadIds,
  seenLeaves = new Set(),
  seenNodeIds = new Set()
) {
  const sanitized = sanitizePaneTreeDetails(
    root,
    knownThreadIds,
    seenLeaves,
    seenNodeIds
  );
  if (!sanitized) return null;
  if (seenLeaves instanceof Set) {
    for (const threadId of sanitized.threadIds) {
      seenLeaves.add(threadId);
    }
  }
  if (seenNodeIds instanceof Set) {
    for (const nodeId of sanitized.nodeIds) {
      seenNodeIds.add(nodeId);
    }
  }
  return sanitized.node;
}

export function reconcileSessions(descriptors, liveIds) {
  const live = new Set(
    Array.isArray(liveIds)
      ? liveIds.map(safeId).filter(Boolean)
      : []
  );
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

function sanitizePaneLayout(
  saved,
  knownThreadIds,
  seenThreadIds,
  seenNodeIds,
  projectIds
) {
  if (!isObject(saved)) return null;

  const projectId = safeId(saved.projectId);
  const worktreePath = safeString(saved.worktreePath);
  if (!projectId || !worktreePath || !projectIds.has(projectId)) return null;

  const sanitizedRoot = sanitizePaneTreeDetails(
    saved.root,
    knownThreadIds,
    seenThreadIds,
    seenNodeIds
  );
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
    nodeIds: sanitizedRoot.nodeIds,
    threadIds: sanitizedRoot.threadIds,
  };
}

function sanitizeFilesPaneDescriptor(saved, projectIds) {
  if (!isObject(saved)) return null;

  const id = safeId(saved.id);
  const projectId = safeId(saved.projectId);
  const workspaceRoot = safeString(saved.workspaceRoot);
  if (!id || !projectId || !workspaceRoot || !projectIds.has(projectId)) return null;

  return {
    id,
    projectId,
    workspaceRoot,
    hidden: saved.hidden === true,
  };
}

export function sanitizeWorkspaceV3(saved) {
  if (!isObject(saved) || saved.version !== 3) return null;

  const projects = Array.isArray(saved.projects) ? saved.projects.slice() : [];
  const sessions = [];
  const filesPanes = [];
  const knownThreadIds = new Set();
  const knownFilesPaneIds = new Set();
  const projectIds = new Set();
  const sessionScopes = new Map();
  const filesPaneScopes = new Map();

  for (const project of projects) {
    const projectId = safeId(project && project.id);
    if (projectId) {
      projectIds.add(projectId);
    }
  }

  for (const descriptor of Array.isArray(saved.sessions) ? saved.sessions : []) {
    const session = sanitizeSessionDescriptor(descriptor);
    if (
      !session ||
      !projectIds.has(session.projectId) ||
      knownThreadIds.has(session.id)
    ) {
      continue;
    }
    knownThreadIds.add(session.id);
    sessions.push(session);

    const scopeKey = `${session.projectId}\u0000${session.worktreePath}`;
    const scopedThreadIds = sessionScopes.get(scopeKey) || new Set();
    scopedThreadIds.add(session.id);
    sessionScopes.set(scopeKey, scopedThreadIds);
  }

  for (const descriptor of Array.isArray(saved.filesPanes) ? saved.filesPanes : []) {
    const filesPane = sanitizeFilesPaneDescriptor(descriptor, projectIds);
    if (
      !filesPane ||
      knownThreadIds.has(filesPane.id) ||
      knownFilesPaneIds.has(filesPane.id)
    ) {
      continue;
    }

    const scopeKey = `${filesPane.projectId}\u0000${filesPane.workspaceRoot}`;
    if (filesPaneScopes.has(scopeKey)) continue;

    knownFilesPaneIds.add(filesPane.id);
    filesPaneScopes.set(scopeKey, filesPane);
    filesPanes.push(filesPane);
  }

  const activeProjectId = safeId(saved.activeProjectId) && projectIds.has(safeId(saved.activeProjectId))
    ? safeId(saved.activeProjectId)
    : null;
  const activeThreadId = safeId(saved.activeThreadId) && knownThreadIds.has(safeId(saved.activeThreadId))
    ? safeId(saved.activeThreadId)
    : null;

  const seenLayouts = new Set();
  const seenThreadIds = new Set();
  const seenNodeIds = new Set();
  const paneLayouts = [];
  const layouts = Array.isArray(saved.paneLayouts)
    ? saved.paneLayouts
    : isObject(saved.paneLayouts)
      ? Object.values(saved.paneLayouts)
      : [];

  for (const layout of layouts) {
    const layoutProjectId = safeId(layout && layout.projectId);
    const layoutWorktreePath = safeString(layout && layout.worktreePath);
    const scopeKey = layoutProjectId && layoutWorktreePath
      ? `${layoutProjectId}\u0000${layoutWorktreePath}`
      : null;
    const scopedThreadIds = scopeKey
      ? new Set(sessionScopes.get(scopeKey) || [])
      : new Set();
    const filesPane = scopeKey ? filesPaneScopes.get(scopeKey) : null;
    if (filesPane && !filesPane.hidden) scopedThreadIds.add(filesPane.id);
    const sanitized = sanitizePaneLayout(
      layout,
      scopedThreadIds,
      seenThreadIds,
      seenNodeIds,
      projectIds
    );
    if (!sanitized) continue;

    const key = `${sanitized.projectId}\u0000${sanitized.worktreePath}`;
    if (seenLayouts.has(key)) continue;
    seenLayouts.add(key);
    for (const nodeId of sanitized.nodeIds) {
      seenNodeIds.add(nodeId);
    }
    for (const threadId of sanitized.threadIds) {
      seenThreadIds.add(threadId);
    }
    const { nodeIds, threadIds, ...layoutEntry } = sanitized;
    paneLayouts.push(layoutEntry);
  }

  return {
    version: 3,
    activeProjectId,
    activeThreadId,
    projects,
    sessions,
    filesPanes,
    paneLayouts,
  };
}
