export interface LaneLease {
  paneId: string;
  actorId: string;
  actorKind: 'human' | 'psyche';
  taskId?: string;
  revision: number;
  expiresAt: string;
}

export class LaneLeaseStore {
  private readonly leases = new Map<string, LaneLease>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  delegate(paneId: string, actorId: string, taskId: string, ttlMs: number): LaneLease {
    return this.replace(paneId, actorId, 'psyche', ttlMs, taskId);
  }

  takeover(paneId: string, actorId: string): LaneLease {
    return this.replace(paneId, actorId, 'human', 24 * 60 * 60 * 1000);
  }

  assertAutomation(paneId: string, actorId: string, revision: number): LaneLease {
    return this.assert(paneId, actorId, 'psyche', revision);
  }

  assertHuman(paneId: string, actorId: string, revision: number): LaneLease {
    return this.assert(paneId, actorId, 'human', revision);
  }

  snapshot(): Record<string, LaneLease> {
    return Object.fromEntries(this.leases);
  }

  private replace(
    paneId: string,
    actorId: string,
    actorKind: LaneLease['actorKind'],
    ttlMs: number,
    taskId?: string,
  ): LaneLease {
    const revision = (this.revisions.get(paneId) ?? 0) + 1;
    this.revisions.set(paneId, revision);
    const lease: LaneLease = {
      paneId,
      actorId,
      actorKind,
      revision,
      expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString(),
      ...(taskId ? { taskId } : {}),
    };
    Object.freeze(lease);
    this.leases.set(paneId, lease);
    return lease;
  }

  private assert(
    paneId: string,
    actorId: string,
    actorKind: LaneLease['actorKind'],
    revision: number,
  ): LaneLease {
    const lease = this.leases.get(paneId);
    if (!lease || lease.revision !== revision) throw new Error('lease revision mismatch');
    if (lease.actorId !== actorId || lease.actorKind !== actorKind) {
      throw new Error('lane is controlled by another actor');
    }
    if (Date.parse(lease.expiresAt) <= this.clock().getTime()) throw new Error('lease expired');
    return lease;
  }
}
