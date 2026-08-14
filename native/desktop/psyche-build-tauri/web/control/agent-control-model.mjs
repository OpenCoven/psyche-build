const EMPTY_GROUPS = Object.freeze({ requested: [], active: [], expired: [], revoked: [] });
const ID_LIMIT = 512;
const LEASE_TTL_LIMIT = 30 * 60_000;
const CAPABILITIES = new Set([
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus', 'pane.resize', 'pane.create', 'pane.close',
  'browser.inspect', 'browser.screenshot', 'browser.navigate', 'browser.interact', 'browser.history',
  'browser.close', 'browser.script',
]);
const EFFECT_KINDS = new Set(['submit', 'secret_input', 'upload', 'download', 'permission_response', 'close', 'script']);

function text(value) {
  return typeof value === 'string' ? value : '';
}
function safeNotice(value) {
  return typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function canonicalId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT
    && value.trim() === value ? value : '';
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && new Date(parsed).toISOString() === value ? parsed : null;
}

function sha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function target(value) {
  const id = canonicalId(value?.id);
  if (!value || !['project', 'pane', 'browser_tab'].includes(value.kind) || !id) return null;
  if (value.kind === 'project') return Object.freeze({ kind: value.kind, id });
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return null;
  return Object.freeze({ kind: value.kind, id, generation: value.generation });
}

function resources(grants) {
  if (!Array.isArray(grants) || grants.length === 0) return null;
  const normalized = grants.map((grant) => {
    const resource = target(grant?.target);
    if (!resource || !Array.isArray(grant.capabilities) || grant.capabilities.length === 0
        || !grant.capabilities.every((capability) => CAPABILITIES.has(capability))) return null;
    const compatible = resource.kind === 'project'
      ? grant.capabilities.every((capability) => capability === 'pane.create')
      : resource.kind === 'pane'
        ? grant.capabilities.every((capability) => capability.startsWith('pane.') && capability !== 'pane.create')
        : grant.capabilities.every((capability) => capability.startsWith('browser.'));
    if (!compatible) return null;
    return Object.freeze({ ...resource, capabilities: Object.freeze([...grant.capabilities]) });
  });
  return normalized.every(Boolean) ? normalized : null;
}

function requestItem(request, status, operator) {
  const normalizedResources = resources(request.grants);
  const createdAt = timestamp(request.createdAt);
  const requestedExpiry = createdAt === null || !Number.isSafeInteger(request.ttlMs)
    ? null : timestamp(createdAt + request.ttlMs);
  const valid = status === 'requested' && request.status === 'pending' && canonicalId(request.id)
    && canonicalId(request.actorId) && canonicalId(request.taskId) && createdAt !== null
    && Number.isSafeInteger(request.ttlMs) && request.ttlMs > 0 && request.ttlMs <= LEASE_TTL_LIMIT
    && requestedExpiry !== null && normalizedResources;
  if (!valid) return null;
  return Object.freeze({
    id: request.id, requestId: request.id, status,
    agent: request.actorId, task: request.taskId,
    requestedAt: request.createdAt, leaseDurationMs: request.ttlMs,
    resources: Object.freeze(normalizedResources),
    grantCommand: Object.freeze({
      requestId: text(request.id), actorId: text(request.actorId), taskId: text(request.taskId),
      ttlMs: Number.isSafeInteger(request.ttlMs) ? request.ttlMs : 0,
      grants: Object.freeze(normalizedResources.map(({ capabilities, ...leaseTarget }) => Object.freeze({
        target: Object.freeze(leaseTarget), capabilities,
      }))),
    }),
    canGrant: status === 'requested' && operator,
  });
}

function leaseItem(lease, status, operator, historical = false) {
  const normalizedResources = resources(lease?.grants);
  const revision = lease?.revision;
  const createdAt = timestamp(lease?.createdAt);
  const expiresAt = timestamp(lease?.expiresAt);
  if (!canonicalId(lease?.id) || !canonicalId(lease?.requestId) || !canonicalId(lease?.actorId)
      || !canonicalId(lease?.taskId) || !canonicalId(lease?.grantedBy)
      || !Number.isSafeInteger(revision) || revision <= 0 || createdAt === null || expiresAt === null
      || createdAt > expiresAt || !normalizedResources
      || (historical ? lease.status !== status : lease.status !== undefined)) return null;
  return Object.freeze({
    id: lease.id, leaseId: lease.id, requestId: lease.requestId, status,
    revision, ownerEpoch: lease.ownerEpoch, agent: lease.actorId, task: lease.taskId,
    expiresAt: lease.expiresAt, resources: Object.freeze(normalizedResources),
    canRevoke: status === 'active' && operator,
  });
}

function sameTarget(left, right) {
  return left.kind === right.kind && left.id === right.id
    && (left.kind === 'project' || left.generation === right.generation);
}

export function normalizeAgentControlState(response, options = {}) {
  const snapshot = response?.snapshot || response || {};
  const ownerEpoch = Number.isSafeInteger(snapshot.ownerEpoch) && snapshot.ownerEpoch >= 0 ? snapshot.ownerEpoch : null;
  const now = timestamp(options.now === undefined ? new Date().toISOString() : options.now);
  const operator = options.operator === true && ownerEpoch !== null && now !== null;
  if (ownerEpoch === null || now === null) {
    return Object.freeze({ ownerEpoch: null, contextToken: text(options.contextToken), groups: EMPTY_GROUPS,
      approvals: [], badges: [], pendingCount: 0, resourceBadgesFor: () => [], currentResourceFor: () => null,
      recentActivity: [], fetchError: safeNotice(options.fetchError) });
  }

  const groups = { requested: [], active: [], expired: [], revoked: [] };
  const currentRequestIds = new Set();
  const leases = Array.isArray(snapshot.capabilityLeases) ? snapshot.capabilityLeases : [];
  for (const lease of leases) {
    if (lease?.ownerEpoch !== ownerEpoch) continue;
    const expiry = timestamp(lease.expiresAt);
    if (expiry === null) continue;
    const status = expiry <= now ? 'expired' : 'active';
    const item = leaseItem(lease, status, operator);
    if (!item) continue;
    groups[status].push(item);
    currentRequestIds.add(item.requestId);
  }
  const historical = Array.isArray(snapshot.leaseHistory) ? snapshot.leaseHistory : [];
  for (const lease of historical) {
    if (lease?.ownerEpoch !== ownerEpoch || !['expired', 'revoked'].includes(lease.status)) continue;
    if (timestamp(lease.endedAt) === null) continue;
    const item = leaseItem(lease, lease.status, operator, true);
    if (!item) continue;
    groups[lease.status].push(item);
  }
  const requests = Array.isArray(snapshot.leaseRequests) ? snapshot.leaseRequests : [];
  for (const request of requests) {
    const item = requestItem(request || {}, 'requested', operator);
    if (item) groups.requested.push(item);
  }

  const approvals = (Array.isArray(snapshot.approvals) ? snapshot.approvals : []).flatMap((approval) => {
    if (!approval || approval.ownerEpoch !== ownerEpoch) return [];
    const resource = target(approval.resource);
    const expiry = timestamp(approval.expiresAt);
    const created = timestamp(approval.createdAt);
    const lease = groups.active.find((candidate) => candidate.leaseId === approval.leaseId
      && candidate.revision === approval.leaseRevision);
    const authorizedResource = lease?.resources.some((candidate) => resource
      && sameTarget(candidate, resource) && candidate.capabilities.includes(approval.capability));
    const valid = Boolean(resource && lease && authorizedResource && canonicalId(approval.id)
      && canonicalId(approval.actionId) && sha256(approval.payloadDigest) && canonicalId(approval.leaseId)
      && Number.isSafeInteger(approval.leaseRevision) && approval.leaseRevision > 0
      && CAPABILITIES.has(approval.capability) && EFFECT_KINDS.has(approval.effect?.kind)
      && sha256(approval.effect?.targetDigest) && created !== null && expiry !== null
      && created <= now && created < expiry);
    const status = !valid ? 'invalid'
      : (approval.status !== 'pending' ? approval.status : (expiry <= now ? 'expired' : 'pending'));
    return [Object.freeze({
      id: canonicalId(approval.id) || 'invalid-approval', approvalId: canonicalId(approval.id), status,
      leaseId: canonicalId(approval.leaseId), leaseRevision: approval.leaseRevision,
      agent: lease?.agent || '', task: lease?.task || '', resource,
      capability: text(approval.capability),
      effect: Object.freeze({ kind: text(approval.effect?.kind), targetDigest: sha256(approval.effect?.targetDigest) }),
      payloadDigest: sha256(approval.payloadDigest), expiresAt: text(approval.expiresAt),
      canApprove: operator && status === 'pending', canDeny: operator && status === 'pending',
    })];
  });

  const currentResources = (Array.isArray(snapshot.resources) ? snapshot.resources : [])
    .map(target).filter(Boolean);
  const projectRoot = typeof options.projectRoot === 'string' && options.projectRoot.length > 0
    && options.projectRoot.length <= 4096 ? options.projectRoot : '';
  const worktreeRoot = typeof options.worktreeRoot === 'string' && options.worktreeRoot.length > 0
    && options.worktreeRoot.length <= 4096 ? options.worktreeRoot : '';
  const recentActivity = (Array.isArray(snapshot.receipts) ? snapshot.receipts : []).flatMap((receipt) => {
    const resource = target(receipt?.resource);
    const at = timestamp(receipt?.timestamp);
    if (!resource || !currentResources.some((candidate) => sameTarget(candidate, resource))
        || !projectRoot || !worktreeRoot || receipt.projectRoot !== projectRoot || receipt.worktreeRoot !== worktreeRoot
        || at === null || !canonicalId(receipt?.commandId) || !canonicalId(receipt?.actionKind)
        || receipt.redacted !== true || receipt.result !== 'result_unavailable'
        || !['queued', 'running', 'approval_required', 'succeeded', 'failed', 'denied', 'expired', 'unknown'].includes(receipt.outcome)) return [];
    return [Object.freeze({ id: receipt.commandId, action: receipt.actionKind, outcome: receipt.outcome,
      timestamp: new Date(at).toISOString(), agent: canonicalId(receipt.agentId), task: canonicalId(receipt.taskId),
      projectRoot, worktreeRoot, resource, redacted: true, result: 'result_unavailable' })];
  }).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.id.localeCompare(right.id)).slice(-20);
  const badges = groups.active.flatMap((lease) => lease.resources.flatMap((resource) => {
    if (resource.kind === 'project' || !currentResources.some((current) => sameTarget(current, resource))) return [];
    return [Object.freeze({
      ...resource, leaseId: lease.leaseId, revision: lease.revision,
      ownerEpoch, agent: lease.agent, task: lease.task, expiresAt: lease.expiresAt,
      capabilities: resource.capabilities,
    })];
  })).sort((left, right) => right.revision - left.revision
    || Date.parse(right.expiresAt) - Date.parse(left.expiresAt)
    || left.leaseId.localeCompare(right.leaseId));
  const resourceBadgesFor = (resource) => {
    const normalized = target(resource);
    if (!normalized) return [];
    return badges.filter((badge) => sameTarget(badge, normalized));
  };
  const currentResourceFor = (kind, id) => {
    const matches = currentResources.filter((resource) => resource.kind === kind && resource.id === id);
    return matches.length === 1 ? matches[0] : null;
  };
  for (const key of Object.keys(groups)) Object.freeze(groups[key]);
  return Object.freeze({
    ownerEpoch, contextToken: text(options.contextToken), groups: Object.freeze(groups),
    approvals: Object.freeze(approvals), badges: Object.freeze(badges),
    pendingCount: groups.requested.length + approvals.filter((approval) => approval.status === 'pending').length,
    resourceBadgesFor, currentResourceFor, recentActivity: Object.freeze(recentActivity),
    fetchError: safeNotice(options.fetchError),
  });
}

export function resourceBadgeFor(model, resource) {
  const normalized = target(resource);
  if (!normalized || !model || !Array.isArray(model.badges)) return null;
  return model.resourceBadgesFor ? model.resourceBadgesFor(normalized)[0] || null
    : model.badges.find((badge) => sameTarget(badge, normalized)) || null;
}

export function resourceBadgesFor(model, resource) {
  return model?.resourceBadgesFor ? model.resourceBadgesFor(resource) : [];
}

export function badgeAccessibleName(badge) {
  return badge
    ? `Leased to ${badge.agent} for ${badge.task}; lease ${badge.leaseId} revision ${badge.revision}; `
      + `${badge.kind} ${badge.id} generation ${badge.generation}; until ${badge.expiresAt}`
    : '';
}
