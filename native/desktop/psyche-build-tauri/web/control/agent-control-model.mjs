function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function copyTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const result = { kind: String(target.kind || ''), id: String(target.id || '') };
  if (Number.isSafeInteger(target.generation)) result.generation = target.generation;
  return result;
}

function leaseCard(lease, now, operator) {
  const resources = asArray(lease.grants).flatMap((grant) => {
    const target = copyTarget(grant && grant.target);
    if (!target) return [];
    return [{ ...target, capabilities: asArray(grant.capabilities).map(String) }];
  });
  const expired = Date.parse(String(lease.expiresAt || '')) <= now;
  return {
    leaseId: String(lease.id || ''),
    requestId: String(lease.requestId || ''),
    revision: Number(lease.revision || 0),
    agentId: String(lease.actorId || ''),
    taskId: String(lease.taskId || ''),
    expiresAt: String(lease.expiresAt || ''),
    resources,
    canRevoke: operator && !expired,
    expired,
  };
}

function requestCard(request, operator) {
  const resources = asArray(request.grants).flatMap((grant) => {
    const target = copyTarget(grant && grant.target);
    return target ? [{ ...target, capabilities: asArray(grant.capabilities).map(String) }] : [];
  });
  const createdAt = String(request.createdAt || '');
  const ttlMs = Number(request.ttlMs || 0);
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = createdAtMs + ttlMs;
  const expiresAt = Number.isFinite(createdAtMs)
    && Number.isFinite(ttlMs)
    && Number.isFinite(expiresAtMs)
    && Math.abs(expiresAtMs) <= 8.64e15
    ? new Date(expiresAtMs).toISOString()
    : '';
  return {
    requestId: String(request.id || ''),
    agentId: String(request.actorId || ''),
    taskId: String(request.taskId || ''),
    createdAt,
    ttlMs,
    expiresAt,
    resources,
    canGrant: operator && request.status === 'pending',
  };
}

export function createAgentControlModel(snapshot, options = {}) {
  const ownerEpoch = Number(snapshot && snapshot.ownerEpoch || 0);
  const operator = options.operator === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const epochChanged = Number.isSafeInteger(options.previousOwnerEpoch)
    && options.previousOwnerEpoch !== ownerEpoch;
  const leases = asArray(snapshot && snapshot.capabilityLeases).map((lease) =>
    leaseCard(lease, now, operator));
  const active = leases.filter((lease) => !lease.expired);
  const approvals = asArray(snapshot && snapshot.approvals).map((approval) => ({
    approvalId: String(approval.id || ''),
    status: String(approval.status || ''),
    leaseId: String(approval.leaseId || ''),
    leaseRevision: Number(approval.leaseRevision || 0),
    payloadDigest: String(approval.payloadDigest || ''),
    resource: copyTarget(approval.resource),
    capability: String(approval.capability || ''),
    effect: {
      kind: String(approval.effect && approval.effect.kind || ''),
      target: String(approval.effect && approval.effect.target || ''),
    },
    expiresAt: String(approval.expiresAt || ''),
    canApprove: operator && approval.status === 'pending',
    canDeny: operator && approval.status === 'pending',
  }));
  const requests = asArray(snapshot && snapshot.leaseRequests);
  const resources = asArray(snapshot && snapshot.resources).flatMap((resource) => {
    const target = copyTarget(resource);
    return target && Number.isSafeInteger(target.generation) ? [target] : [];
  });
  const badges = epochChanged ? [] : active.flatMap((lease) =>
    lease.resources.map((resource) => ({
      ...resource,
      leaseId: lease.leaseId,
      revision: lease.revision,
      agentId: lease.agentId,
      taskId: lease.taskId,
      expiresAt: lease.expiresAt,
    })));
  return {
    ownerEpoch,
    pendingCount: requests.filter((request) => request.status === 'pending').length
      + approvals.filter((approval) => approval.status === 'pending').length,
    groups: {
      requested: requests.filter((request) => request.status === 'pending')
        .map((request) => requestCard(request, operator)),
      active,
      expired: leases.filter((lease) => lease.expired),
      revoked: requests.filter((request) => request.status === 'revoked')
        .map((request) => requestCard(request, operator)),
    },
    approvals,
    badges,
    resources,
  };
}

export function resourceLeaseBadge(model, resource) {
  if (!resource) return null;
  return model.badges.find((badge) => (
    badge.kind === resource.kind
    && badge.id === resource.id
    && (badge.kind === 'project' || badge.generation === resource.generation)
  )) || null;
}

export function surfaceResourceIdentity(model, kind, id) {
  return model.resources.find((resource) => resource.kind === kind && resource.id === id) || null;
}
