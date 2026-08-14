import {
  AGENT_CONTROL_UI_LIMITS,
  boundedAgentControlList,
  boundedAgentControlText,
} from './agent-control-limits.mjs';

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
  const boundedGrants = boundedAgentControlList(lease.grants, AGENT_CONTROL_UI_LIMITS.resourcesPerCard);
  const resources = boundedGrants.items.flatMap((grant) => {
    const target = copyTarget(grant && grant.target);
    if (!target) return [];
    const capabilities = boundedAgentControlList(
      grant.capabilities,
      AGENT_CONTROL_UI_LIMITS.capabilitiesPerResource,
    );
    return [{
      ...target,
      capabilities: capabilities.items.map(String),
      capabilityOverflow: capabilities.overflow,
    }];
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
    resourceOverflow: boundedGrants.overflow,
    canRevoke: operator && !expired,
    expired,
  };
}

function requestCard(request, operator) {
  const boundedGrants = boundedAgentControlList(request.grants, AGENT_CONTROL_UI_LIMITS.resourcesPerCard);
  const resources = boundedGrants.items.flatMap((grant) => {
    const target = copyTarget(grant && grant.target);
    const capabilities = boundedAgentControlList(
      grant && grant.capabilities,
      AGENT_CONTROL_UI_LIMITS.capabilitiesPerResource,
    );
    return target ? [{
      ...target,
      capabilities: capabilities.items.map(String),
      capabilityOverflow: capabilities.overflow,
    }] : [];
  });
  const createdAt = String(request.createdAt || '');
  const ttlMs = Number(request.ttlMs || 0);
  return {
    requestId: String(request.id || ''),
    agentId: String(request.actorId || ''),
    taskId: String(request.taskId || ''),
    createdAt,
    ttlMs,
    resources,
    resourceOverflow: boundedGrants.overflow,
    canGrant: operator && request.status === 'pending',
  };
}

export function createAgentControlModel(snapshot, options = {}) {
  const ownerEpoch = Number(snapshot && snapshot.ownerEpoch || 0);
  const operator = options.operator === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const epochChanged = Number.isSafeInteger(options.previousOwnerEpoch)
    && options.previousOwnerEpoch !== ownerEpoch;
  const boundedLeases = boundedAgentControlList(
    snapshot && snapshot.capabilityLeases,
    AGENT_CONTROL_UI_LIMITS.cardsPerGroup,
  );
  const leases = boundedLeases.items.map((lease) =>
    leaseCard(lease, now, operator));
  const active = leases.filter((lease) => !lease.expired);
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const boundedApprovals = boundedAgentControlList(
    snapshot && snapshot.approvals,
    AGENT_CONTROL_UI_LIMITS.cardsPerGroup,
  );
  const approvals = boundedApprovals.items.map((approval) => {
    const lease = leaseById.get(String(approval.leaseId || ''));
    const leaseCurrent = Boolean(
      lease && !lease.expired && lease.revision === Number(approval.leaseRevision || 0),
    );
    return {
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
      agentId: lease?.agentId || '',
      taskId: lease?.taskId || '',
      leaseCurrent,
      canRevokeLease: operator && leaseCurrent,
      canApprove: operator && approval.status === 'pending',
      canDeny: operator && approval.status === 'pending',
    };
  });
  const allRequests = asArray(snapshot && snapshot.leaseRequests);
  const boundedRequests = boundedAgentControlList(allRequests, AGENT_CONTROL_UI_LIMITS.cardsPerGroup);
  const requests = boundedRequests.items;
  const boundedResources = boundedAgentControlList(
    snapshot && snapshot.resources,
    AGENT_CONTROL_UI_LIMITS.registeredResources,
  );
  const resources = boundedResources.items.flatMap((resource) => {
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
      capabilitySummary: boundedAgentControlText(
        resource.capabilities.slice(0, 2).join(', ')
          + (resource.capabilities.length + resource.capabilityOverflow > 2
            ? ` +${resource.capabilities.length + resource.capabilityOverflow - 2}`
            : ''),
        AGENT_CONTROL_UI_LIMITS.capabilityBytes,
      ),
    })));
  return {
    ownerEpoch,
    contextKey: `${String(options.projectRoot || '')}\u0000${ownerEpoch}`,
    pendingCount: allRequests.filter((request) => request.status === 'pending').length
      + asArray(snapshot && snapshot.approvals).filter((approval) => approval.status === 'pending').length,
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
    overflow: {
      leaseRequests: boundedRequests.overflow,
      leases: boundedLeases.overflow,
      approvals: boundedApprovals.overflow,
      resources: boundedResources.overflow,
    },
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
