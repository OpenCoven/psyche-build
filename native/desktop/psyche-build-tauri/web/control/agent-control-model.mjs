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

function leaseCard(lease, now, operator, historical = false) {
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
  const status = historical && (lease.status === 'expired' || lease.status === 'revoked')
    ? lease.status
    : (Date.parse(String(lease.expiresAt || '')) <= now ? 'expired' : 'active');
  return {
    leaseId: String(lease.id || ''),
    requestId: String(lease.requestId || ''),
    revision: Number(lease.revision || 0),
    ownerEpoch: Number(lease.ownerEpoch || 0),
    agentId: boundedAgentControlText(lease.actorId),
    taskId: boundedAgentControlText(lease.taskId),
    expiresAt: boundedAgentControlText(lease.expiresAt),
    resources,
    resourceOverflow: boundedGrants.overflow,
    endedAt: historical ? boundedAgentControlText(lease.endedAt) : '',
    status,
    canRevoke: operator && status === 'active',
    expired: status === 'expired',
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
  const requiresNarrowerRequest = boundedGrants.overflow > 0
    || resources.some((resource) => resource.capabilityOverflow > 0);
  return {
    requestId: String(request.id || ''),
    agentId: boundedAgentControlText(request.actorId),
    taskId: boundedAgentControlText(request.taskId),
    createdAt: boundedAgentControlText(createdAt),
    ttlMs,
    resources,
    resourceOverflow: boundedGrants.overflow,
    requiresNarrowerRequest,
    canGrant: operator && request.status === 'pending' && !requiresNarrowerRequest,
  };
}

export function createAgentControlModel(snapshot, options = {}) {
  const ownerEpoch = Number(snapshot && snapshot.ownerEpoch || 0);
  const operator = options.operator === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const epochChanged = Number.isSafeInteger(options.previousOwnerEpoch)
    && options.previousOwnerEpoch !== ownerEpoch;
  const indexedLeases = boundedAgentControlList(
    snapshot && snapshot.capabilityLeases,
    AGENT_CONTROL_UI_LIMITS.leaseContextIndex,
  );
  const leaseIndex = indexedLeases.items.map((lease) =>
    leaseCard(lease, now, operator));
  const boundedLeases = boundedAgentControlList(leaseIndex, AGENT_CONTROL_UI_LIMITS.cardsPerGroup);
  const leases = boundedLeases.items;
  const active = leases.filter((lease) => lease.status === 'active');
  const historicalLeases = boundedAgentControlList(
    asArray(snapshot && snapshot.leaseHistory)
      .filter((lease) => lease?.ownerEpoch === ownerEpoch
        && (lease.status === 'expired' || lease.status === 'revoked'))
      .map((lease) => leaseCard(lease, now, operator, true)),
    AGENT_CONTROL_UI_LIMITS.cardsPerGroup,
  );
  const leaseById = new Map(leaseIndex.map((lease) => [lease.leaseId, lease]));
  const allApprovals = asArray(snapshot && snapshot.approvals);
  const pendingApprovals = allApprovals.filter((approval) => approval?.status === 'pending');
  const boundedApprovals = boundedAgentControlList(
    pendingApprovals,
    AGENT_CONTROL_UI_LIMITS.cardsPerGroup,
  );
  const approvals = boundedApprovals.items.map((approval) => {
    const lease = leaseById.get(String(approval.leaseId || ''));
    const leaseCurrent = Boolean(
      lease
      && !lease.expired
      && lease.ownerEpoch === ownerEpoch
      && Number(approval.ownerEpoch || 0) === ownerEpoch
      && lease.revision === Number(approval.leaseRevision || 0),
    );
    return {
      approvalId: String(approval.id || ''),
      status: String(approval.status || ''),
      leaseId: String(approval.leaseId || ''),
      leaseRevision: Number(approval.leaseRevision || 0),
      payloadDigest: String(approval.payloadDigest || ''),
      resource: copyTarget(approval.resource),
      capability: boundedAgentControlText(
        approval.capability,
        AGENT_CONTROL_UI_LIMITS.capabilityBytes,
      ),
      effect: {
        kind: boundedAgentControlText(approval.effect && approval.effect.kind),
        target: boundedAgentControlText(approval.effect && approval.effect.target),
      },
      expiresAt: boundedAgentControlText(approval.expiresAt),
      agentId: lease?.agentId || '',
      taskId: lease?.taskId || '',
      leaseCurrent,
      canRevokeLease: operator && leaseCurrent,
      canApprove: operator && approval.status === 'pending' && leaseCurrent,
      canDeny: operator && approval.status === 'pending' && leaseCurrent,
    };
  });
  const allRequests = asArray(snapshot && snapshot.leaseRequests);
  const pendingRequests = allRequests.filter((request) => request?.status === 'pending');
  const revokedRequests = allRequests.filter((request) => request?.status === 'revoked');
  const boundedRequests = boundedAgentControlList(pendingRequests, AGENT_CONTROL_UI_LIMITS.cardsPerGroup);
  const boundedRevokedRequests = boundedAgentControlList(
    revokedRequests,
    AGENT_CONTROL_UI_LIMITS.cardsPerGroup,
  );
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
    pendingCount: pendingRequests.length + pendingApprovals.length,
    groups: {
      requested: boundedRequests.items.map((request) => requestCard(request, operator)),
      active,
      expired: [
        ...leases.filter((lease) => lease.status === 'expired'),
        ...historicalLeases.items.filter((lease) => lease.status === 'expired'),
      ],
      revoked: [
        ...historicalLeases.items.filter((lease) => lease.status === 'revoked'),
        ...boundedRevokedRequests.items.map((request) => requestCard(request, operator)),
      ],
    },
    approvals,
    badges,
    resources,
    overflow: {
      leaseRequests: boundedRequests.overflow,
      leases: Math.max(0, asArray(snapshot && snapshot.capabilityLeases).length
        - AGENT_CONTROL_UI_LIMITS.cardsPerGroup),
      approvals: boundedApprovals.overflow,
      resources: boundedResources.overflow,
      leaseHistory: historicalLeases.overflow,
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
