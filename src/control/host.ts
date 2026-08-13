import { ControlJournal } from './journal.js';
import { acquireOwnerLock } from './ownerLock.js';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { ControlRuntime, type ControlHandlers, type RuntimeJournal } from './runtime.js';
import type { CanonicalBrowserSnapshotResolver } from './runtime.js';
import { SurfaceRegistry } from './surfaces.js';
import { CapabilityLeaseStore } from './capabilityLeases.js';
import { ApprovalStore } from './approvals.js';
import { bootstrapSession } from './resources/sessionBootstrap.js';
import type { BrowserProviderBroker } from './browserProviderBroker.js';

export interface HostControlPlane {
  epoch: number;
  runtime: ControlRuntime;
  browserProviders?: BrowserProviderBroker;
  close(): Promise<void>;
}

export interface HostControlPlaneOptions {
  handlers: ControlHandlers;
  ownerLock?: typeof acquireOwnerLock;
  journalOpen?: (projectRoot: string, ownerEpoch: number) => Promise<RuntimeJournal>;
  bootstrap?: (projectRoot: string) => Promise<void>;
  surfaces?: SurfaceRegistry;
  capabilityLeases?: CapabilityLeaseStore;
  approvals?: ApprovalStore;
  resolveBrowserSnapshot?: CanonicalBrowserSnapshotResolver;
  browserProviders?: BrowserProviderBroker;
  canonicalizePath?: (candidate: string, mode?: 'existing' | 'prospective') => string | Promise<string>;
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
      capabilityLeases: options.capabilityLeases ?? new CapabilityLeaseStore(undefined, lock.epoch),
      approvals: options.approvals ?? new ApprovalStore(),
      resolveBrowserSnapshot: options.resolveBrowserSnapshot,
      canonicalizePath: options.canonicalizePath,
    });

    return {
      epoch: lock.epoch,
      runtime,
      browserProviders: options.browserProviders,
      close: async () => {
        await lock.release();
      },
    };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}
