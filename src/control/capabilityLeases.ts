import { randomUUID } from 'node:crypto';
import { AGENT_CONTROL_LIMITS } from './limits.js';

export const SURFACE_CAPABILITIES = Object.freeze([
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus',
  'pane.resize', 'pane.create', 'pane.close',
  'browser.inspect', 'browser.screenshot', 'browser.navigate',
  'browser.interact', 'browser.history', 'browser.close', 'browser.script',
] as const);

export type SurfaceCapability = typeof SURFACE_CAPABILITIES[number];

export type LeaseTarget =
  | { readonly kind: 'project'; readonly id: string }
  | {
      readonly kind: 'pane' | 'browser_tab';
      readonly id: string;
      readonly generation: number;
    };

export type CapabilityLeaseErrorCode =
  | 'lease_missing'
  | 'lease_expired'
  | 'lease_revision_mismatch'
  | 'owner_restarted'
  | 'capability_denied';

export interface CapabilityLeaseGrantItem {
  readonly target: LeaseTarget;
  readonly capabilities: readonly SurfaceCapability[];
}

export interface CapabilityLease {
  readonly id: string;
  readonly requestId: string;
  readonly revision: number;
  readonly ownerEpoch: number;
  readonly actorId: string;
  readonly taskId: string;
  readonly grantedBy: string;
  readonly grants: readonly CapabilityLeaseGrantItem[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CapabilityLeaseHistoryEntry extends CapabilityLease {
  readonly status: 'expired' | 'revoked';
  readonly endedAt: string;
}

export const CAPABILITY_LEASE_HISTORY_LIMIT = 100;
export const CAPABILITY_LEASE_HISTORY_TTL_MS = 24 * 60 * 60_000;

export interface CapabilityLeaseGrant {
  readonly requestId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly grantedBy: string;
  readonly grants: readonly CapabilityLeaseGrantItem[];
  readonly ttlMs: number;
}

export interface CapabilityLeaseAssertion {
  readonly leaseId: string;
  readonly revision: number;
  readonly ownerEpoch: number;
  readonly actorId: string;
  readonly taskId: string;
  readonly target: LeaseTarget;
  readonly capability: SurfaceCapability;
}

export class CapabilityLeaseStore {
  private readonly leases = new Map<string, CapabilityLease>();
  private readonly leaseIdsByRequest = new Map<string, string>();
  private readonly lifecycleHistory: CapabilityLeaseHistoryEntry[] = [];
  private readonly historyLimit: number;
  private readonly historyTtlMs: number;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly ownerEpoch: number,
    options: { historyLimit?: number; historyTtlMs?: number } = {},
  ) {
    this.historyLimit = options.historyLimit ?? CAPABILITY_LEASE_HISTORY_LIMIT;
    this.historyTtlMs = options.historyTtlMs ?? CAPABILITY_LEASE_HISTORY_TTL_MS;
  }

  grant(input: CapabilityLeaseGrant): CapabilityLease {
    const previousId = this.leaseIdsByRequest.get(input.requestId);
    const now = this.clock();
    let previous = previousId ? this.leases.get(previousId) : undefined;
    if (previous && Date.parse(previous.expiresAt) <= now.getTime()) {
      this.invalidate(previous.id, 'expired');
      previous = undefined;
    }
    if (previous) this.assertRenewalIdentity(previous, input);
    const ttlMs = Math.max(0, Math.min(input.ttlMs, AGENT_CONTROL_LIMITS.leaseTtlMs));
    const lease = freezeLease({
      id: previous?.id ?? randomUUID(),
      requestId: input.requestId,
      revision: (previous?.revision ?? 0) + 1,
      ownerEpoch: this.ownerEpoch,
      actorId: input.actorId,
      taskId: input.taskId,
      grantedBy: input.grantedBy,
      grants: previous?.grants ?? input.grants,
      createdAt: previous?.createdAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    this.leases.set(lease.id, lease);
    this.leaseIdsByRequest.set(lease.requestId, lease.id);
    return lease;
  }

  assert(input: CapabilityLeaseAssertion): CapabilityLease {
    const lease = this.leases.get(input.leaseId);
    if (!lease) throw codedError('lease_missing', 'capability lease is missing');
    if (lease.ownerEpoch !== this.ownerEpoch || input.ownerEpoch !== this.ownerEpoch) {
      throw codedError('owner_restarted', 'capability lease belongs to another owner epoch');
    }
    if (lease.revision !== input.revision) {
      throw codedError('lease_revision_mismatch', 'capability lease revision mismatch');
    }
    if (Date.parse(lease.expiresAt) <= this.clock().getTime()) {
      this.invalidate(lease.id, 'expired');
      throw codedError('lease_expired', 'capability lease expired');
    }
    const authorized = lease.actorId === input.actorId
      && lease.taskId === input.taskId
      && lease.grants.some((grant) => (
        targetsEqual(grant.target, input.target)
        && grant.capabilities.includes(input.capability)
      ));
    if (!authorized) throw codedError('capability_denied', 'capability lease does not authorize this action');
    return lease;
  }

  snapshot(): CapabilityLease[] {
    const now = this.clock().getTime();
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= now) this.invalidate(lease.id, 'expired');
    }
    return [...this.leases.values()];
  }

  release(leaseId: string): CapabilityLease | undefined {
    return this.invalidate(leaseId, 'revoked');
  }

  revoke(leaseId: string): CapabilityLease | undefined {
    return this.invalidate(leaseId, 'revoked');
  }

  revokeTarget(target: LeaseTarget): CapabilityLease[] {
    const revoked: CapabilityLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.grants.some((grant) => targetsEqual(grant.target, target))) {
        revoked.push(lease);
        this.invalidate(lease.id, 'revoked');
      }
    }
    return revoked;
  }

  revokeAll(): CapabilityLease[] {
    const revoked = this.snapshot();
    for (const lease of revoked) this.invalidate(lease.id, 'revoked');
    return revoked;
  }

  history(): readonly CapabilityLeaseHistoryEntry[] {
    this.pruneHistory();
    return Object.freeze([...this.lifecycleHistory]);
  }

  private invalidate(
    leaseId: string,
    status: CapabilityLeaseHistoryEntry['status'],
  ): CapabilityLease | undefined {
    const lease = this.leases.get(leaseId);
    if (!lease) return undefined;
    this.leases.delete(leaseId);
    this.leaseIdsByRequest.delete(lease.requestId);
    this.lifecycleHistory.push(Object.freeze({
      ...lease,
      status,
      endedAt: this.clock().toISOString(),
    }));
    this.pruneHistory();
    return lease;
  }

  private pruneHistory(): void {
    const cutoff = this.clock().getTime() - this.historyTtlMs;
    while (this.lifecycleHistory.length > 0 && (
      this.lifecycleHistory.length > this.historyLimit
      || Date.parse(this.lifecycleHistory[0].endedAt) < cutoff
    )) this.lifecycleHistory.shift();
  }

  private assertRenewalIdentity(previous: CapabilityLease, input: CapabilityLeaseGrant): void {
    if (previous.ownerEpoch !== this.ownerEpoch) {
      throw codedError('owner_restarted', 'capability lease belongs to another owner epoch');
    }
    if (
      previous.actorId !== input.actorId
      || previous.taskId !== input.taskId
      || previous.grantedBy !== input.grantedBy
      || !grantsEqual(previous.grants, input.grants)
    ) {
      throw codedError('capability_denied', 'capability lease renewal cannot change identity or authority');
    }
  }
}

function targetsEqual(left: LeaseTarget, right: LeaseTarget): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === 'project' || right.kind === 'project') return true;
  return left.generation === right.generation;
}

function freezeLease(lease: CapabilityLease): CapabilityLease {
  const grants = lease.grants.map((grant) => Object.freeze({
    target: Object.freeze({ ...grant.target }),
    capabilities: Object.freeze([...grant.capabilities]),
  }));
  return Object.freeze({ ...lease, grants: Object.freeze(grants) });
}

function grantsEqual(
  left: CapabilityLease['grants'],
  right: CapabilityLeaseGrant['grants'],
): boolean {
  const leftAuthority = authorityKeys(left);
  const rightAuthority = authorityKeys(right);
  return leftAuthority.size === rightAuthority.size
    && [...leftAuthority].every((key) => rightAuthority.has(key));
}

function authorityKeys(grants: readonly CapabilityLeaseGrantItem[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const grant of grants) {
    const target = grant.target.kind === 'project'
      ? [grant.target.kind, grant.target.id]
      : [grant.target.kind, grant.target.id, grant.target.generation];
    for (const capability of grant.capabilities) {
      keys.add(JSON.stringify([...target, capability]));
    }
  }
  return keys;
}

function codedError(
  code: CapabilityLeaseErrorCode,
  message: string,
): Error & { code: CapabilityLeaseErrorCode } {
  return Object.assign(new Error(message), { code });
}
