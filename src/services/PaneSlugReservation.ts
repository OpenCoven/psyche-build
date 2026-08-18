import {
  acquireProjectPaneSlugAllocationLock,
  acquireProjectWorktreeRecoveryLock,
  readProjectPaneConfigUnderLock,
  type ProjectPaneConfigLockOptions,
} from './ProjectPaneConfig.js';
import {
  isPaneSlugOwnerStale,
  listPaneSlugOwnershipRecords,
  readPaneSlugOwnershipRecord,
  removePaneSlugOwnershipRecord,
  reservePaneSlug,
  type PaneSlugAllocationState,
  type PaneSlugCandidate,
  type PaneSlugRegistryOwnerProbe,
  type PaneSlugReservation,
} from './PaneSlugRegistry.js';
import { TmuxService } from './TmuxService.js';
import {
  ensurePaneSlugCleanupBlocker,
  removePaneSlugCleanupBlocker,
  writeProvisionalPaneSlugCleanupBlockerUnderLock,
  writeWorktreeRecoveryMarker,
} from './WorktreeRecoveryMarker.js';
import type {
  TmuxPanePresence,
  VerifiedPaneTeardownResult,
} from '../utils/paneTeardown.js';

export interface CrashSafePaneSlugReservationOptions {
  sessionProjectRoot: string;
  projectRoot: string;
  paneId: string;
  operation: string;
  allocate: (
    state: PaneSlugAllocationState,
  ) => PaneSlugCandidate | Promise<PaneSlugCandidate>;
  probePane?: (paneId: string) => Promise<TmuxPanePresence>;
  ownerProbe?: PaneSlugRegistryOwnerProbe;
  lockOptions?: ProjectPaneConfigLockOptions;
  writeOwnershipRecord?: Parameters<typeof reservePaneSlug>[0]['writeOwnershipRecord'];
}

export async function reserveCrashSafePaneSlug(
  options: CrashSafePaneSlugReservationOptions,
): Promise<PaneSlugReservation> {
  await reconcileStalePaneSlugReservations({
    sessionProjectRoot: options.sessionProjectRoot,
    probePane: options.probePane,
    ownerProbe: options.ownerProbe,
    lockOptions: options.lockOptions,
  });
  const targetLock = await acquireProjectWorktreeRecoveryLock(
    options.projectRoot,
    options.lockOptions,
  );
  let cleanupRecord: Parameters<typeof ensurePaneSlugCleanupBlocker>[0]
    | undefined;
  try {
    const reservation = await reservePaneSlug({
      ...options,
      publishCleanupBlocker: async (record) => {
        const written = await writeProvisionalPaneSlugCleanupBlockerUnderLock(
          record,
        );
        cleanupRecord = {
          ...record,
          targetMarkerId: written.marker.id,
        };
        return written.marker.id;
      },
    });
    if (!cleanupRecord) {
      throw new Error('Pane slug cleanup blocker was not published');
    }
    return wrapCrashSafeReservation(reservation, cleanupRecord);
  } finally {
    await targetLock.release();
  }
}

/**
 * Restart reconciliation never guesses that a stale process created no pane.
 * Exact durable config wins, confirmed tmux absence releases the slug, and
 * every other outcome becomes a target cleanup marker plus session quarantine.
 */
export async function reconcileStalePaneSlugReservations(
  options: {
    sessionProjectRoot: string;
    probePane?: (paneId: string) => Promise<TmuxPanePresence>;
    ownerProbe?: PaneSlugRegistryOwnerProbe;
    lockOptions?: ProjectPaneConfigLockOptions;
  },
): Promise<void> {
  const records = await listPaneSlugOwnershipRecords(options.sessionProjectRoot);
  for (const snapshot of records) {
    await ensurePaneSlugCleanupBlocker(snapshot);
    if (
      snapshot.state !== 'provisional'
      || !isPaneSlugOwnerStale(snapshot, options.ownerProbe)
    ) {
      continue;
    }

    const config = await readProjectPaneConfigUnderLock(snapshot.sessionProjectRoot);
    if (hasExactPersistedPane(config, snapshot)) {
      await clearExactOwnershipRecord(snapshot, options.lockOptions);
      continue;
    }

    const paneId = snapshot.pane.paneId;
    const presence = paneId
      ? await probePanePresence(paneId, options.probePane)
      : 'unknown';
    if (presence === 'absent') {
      await clearExactOwnershipRecord(snapshot, options.lockOptions);
      continue;
    }

    await writeWorktreeRecoveryMarker({
      recoveryId: snapshot.recoveryId,
      sessionProjectRoot: snapshot.sessionProjectRoot,
      projectRoot: snapshot.projectRoot,
      worktreePath: snapshot.worktreePath,
      pane: {
        id: snapshot.pane.id,
        paneId: paneId || 'unresolved',
        slug: snapshot.slug,
      },
      allowWorktreeReuse: true,
      operation: `${snapshot.operation}-restart-reconciliation`,
      reason: paneId
        ? `owner process ended before pane persistence; tmux pane ${paneId} is ${presence}`
        : 'owner process ended in the crash window after durable slug reservation; pane effect identity is unavailable',
    });
  }
}

export async function settlePaneSlugReservationAfterFailure(
  reservation: PaneSlugReservation,
  options: {
    operation: string;
    reason: string;
    teardown?: (
      effect: NonNullable<PaneSlugReservation['effect']>,
    ) => Promise<VerifiedPaneTeardownResult>;
  },
): Promise<{
  released: boolean;
  quarantined: boolean;
  message?: string;
  marker?: { path: string; generation?: string };
}> {
  const record = await readPaneSlugOwnershipRecord(
    reservation.sessionProjectRoot,
    reservation.recoveryId,
  );
  if (!record) {
    return { released: true, quarantined: false };
  }
  if (record.state === 'quarantined') {
    return {
      released: false,
      quarantined: true,
      message: record.reason,
    };
  }

  let configReadFailure: string | undefined;
  try {
    const config = await readProjectPaneConfigUnderLock(
      reservation.sessionProjectRoot,
    );
    if (hasExactPersistedPane(config, record)) {
      await reservation.completeAfterPanePersisted({
        id: record.pane.id,
        paneId: record.pane.paneId!,
        slug: record.slug,
      });
      return { released: true, quarantined: false };
    }
  } catch (error) {
    configReadFailure = error instanceof Error ? error.message : String(error);
  }

  if (!reservation.effect && !record.pane.paneId) {
    await reservation.clearBeforeEffect();
    return { released: true, quarantined: false };
  }

  const effect = reservation.effect || (
    record.pane.paneId
      ? {
        paneId: record.pane.paneId,
        ...(record.pane.tmuxServerIdentity
          ? { tmuxServerIdentity: record.pane.tmuxServerIdentity }
          : {}),
      }
      : undefined
  );
  const teardown = effect && options.teardown
    ? await options.teardown(effect)
    : { presence: 'unknown' as const };
  if (teardown.presence === 'absent') {
    await reservation.clearAfterConfirmedTeardown('absent');
    return { released: true, quarantined: false };
  }

  const marker = await writeWorktreeRecoveryMarker({
    recoveryId: reservation.recoveryId,
    sessionProjectRoot: reservation.sessionProjectRoot,
    projectRoot: reservation.projectRoot,
    worktreePath: reservation.worktreePath,
    pane: {
      id: reservation.paneId,
      paneId: effect?.paneId || 'unresolved',
      slug: reservation.slug,
    },
    allowWorktreeReuse: true,
    operation: options.operation,
    reason: `${options.reason}; pane teardown is ${teardown.presence}${
      configReadFailure
        ? `; pane registry could not be checked during settlement: ${configReadFailure}`
        : ''
    }`,
  });
  return {
    released: false,
    quarantined: true,
    message: marker.state === 'complete'
      ? `quarantined pane slug ${reservation.slug} in ${marker.path}`
      : `retained target cleanup blocker ${marker.path}; ${marker.warning}`,
    marker: {
      path: marker.path,
      generation: marker.marker.generation,
    },
  };
}

async function clearExactOwnershipRecord(
  snapshot: Parameters<typeof ensurePaneSlugCleanupBlocker>[0],
  lockOptions?: ProjectPaneConfigLockOptions,
): Promise<void> {
  const lock = await acquireProjectPaneSlugAllocationLock(
    snapshot.sessionProjectRoot,
    lockOptions,
  );
  try {
    const current = await readPaneSlugOwnershipRecord(
      snapshot.sessionProjectRoot,
      snapshot.recoveryId,
    );
    if (!current || current.owner.nonce !== snapshot.owner.nonce) {
      return;
    }
    await removePaneSlugOwnershipRecord(
      snapshot.sessionProjectRoot,
      snapshot.recoveryId,
    );
  } finally {
    await lock.release();
  }
  await removePaneSlugCleanupBlocker(snapshot);
}

function wrapCrashSafeReservation(
  reservation: PaneSlugReservation,
  cleanupRecord: Parameters<typeof ensurePaneSlugCleanupBlocker>[0],
): PaneSlugReservation {
  const clearCleanupBlocker = async (
    settle: () => Promise<void>,
  ): Promise<void> => {
    await settle();
    await removePaneSlugCleanupBlocker(cleanupRecord);
  };
  return {
    get recoveryId() {
      return reservation.recoveryId;
    },
    get sessionProjectRoot() {
      return reservation.sessionProjectRoot;
    },
    get projectRoot() {
      return reservation.projectRoot;
    },
    get slug() {
      return reservation.slug;
    },
    get paneId() {
      return reservation.paneId;
    },
    get worktreePath() {
      return reservation.worktreePath;
    },
    get effect() {
      return reservation.effect;
    },
    recordPaneEffect: (paneId, identity) => (
      reservation.recordPaneEffect(paneId, identity)
    ),
    completeAfterPanePersisted: (pane) => clearCleanupBlocker(
      () => reservation.completeAfterPanePersisted(pane),
    ),
    clearBeforeEffect: () => clearCleanupBlocker(
      () => reservation.clearBeforeEffect(),
    ),
    clearAfterConfirmedTeardown: (presence) => clearCleanupBlocker(
      () => reservation.clearAfterConfirmedTeardown(presence),
    ),
  };
}

function hasExactPersistedPane(
  config: { panes?: readonly unknown[] },
  record: {
    pane: { id: string; paneId?: string };
    slug: string;
  },
): boolean {
  return (Array.isArray(config.panes) ? config.panes : []).some((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return false;
    }
    const value = candidate as Record<string, unknown>;
    return (
      value.id === record.pane.id
      && value.slug === record.slug
      && (
        record.pane.paneId === undefined
        || value.paneId === record.pane.paneId
      )
    );
  });
}

async function probePanePresence(
  paneId: string,
  probe?: (paneId: string) => Promise<TmuxPanePresence>,
): Promise<TmuxPanePresence> {
  try {
    return probe
      ? await probe(paneId)
      : await TmuxService.getInstance().probePanePresence(paneId);
  } catch {
    return 'unknown';
  }
}
