import { ControlJournal } from './journal.js';
import { acquireOwnerLock } from './ownerLock.js';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { ControlRuntime, type ControlHandlers } from './runtime.js';
import { bootstrapSession } from './resources/sessionBootstrap.js';
import { ApprovalStore } from './approvals.js';
import { CapabilityLeaseStore } from './capabilityLeases.js';
import { SurfaceRegistry } from './surfaces.js';
import type { BrowserSemanticSnapshotRegistry } from './browserSemanticSnapshots.js';

export interface HostControlPlane {
  epoch: number;
  runtime: ControlRuntime;
  close(): Promise<void>;
}

export interface HostControlPlaneOptions {
  handlers: ControlHandlers;
  surfaces?: SurfaceRegistry;
  ownerLock?: typeof acquireOwnerLock;
  journalOpen?: typeof ControlJournal.open;
  bootstrap?: (projectRoot: string) => Promise<void>;
  browserSemanticSnapshots?: BrowserSemanticSnapshotRegistry;
}

export async function createHostControlPlane(
  projectRoot: string,
  options: HostControlPlaneOptions,
): Promise<HostControlPlane> {
  const root = await canonicalizeProjectRoot(projectRoot);
  const lock = await (options.ownerLock ?? acquireOwnerLock)(root);

  try {
    const journal = await (options.journalOpen ?? ControlJournal.open)(root, lock.epoch);
    await journal.append('runtime.bootstrap.started', {});
    await (options.bootstrap ?? bootstrapSession)(root);
    await journal.append('runtime.bootstrap.succeeded', {});
    const runtime = await ControlRuntime.create({
      ownerEpoch: lock.epoch,
      handlers: options.handlers,
      journal,
      surfaces: options.surfaces ?? new SurfaceRegistry(),
      capabilityLeases: new CapabilityLeaseStore(undefined, lock.epoch),
      approvals: new ApprovalStore(),
      resolveBrowserElementSemantics: options.browserSemanticSnapshots
        ? (input) => options.browserSemanticSnapshots!.resolve(input)
        : undefined,
    });

    return {
      epoch: lock.epoch,
      runtime,
      close: async () => {
        await lock.release();
      },
    };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}
