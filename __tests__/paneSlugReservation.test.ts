import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeWorktreeRecoveryMarker,
  findBlockingWorktreeRecoveryMarker,
  listQuarantinedPaneSlugs,
  listWorktreeRecoveryMarkers,
  removePaneSlugCleanupBlocker,
  writeWorktreeRecoveryMarker,
} from '../src/services/WorktreeRecoveryMarker.js';
import {
  allocateUniquePaneSlug,
  listPaneSlugOwnershipRecords,
  quarantinePaneSlugOwnershipRecord,
  reservePaneSlug,
} from '../src/services/PaneSlugRegistry.js';
import {
  reconcileStalePaneSlugReservations,
  reserveCrashSafePaneSlug,
  settlePaneSlugReservationAfterFailure,
} from '../src/services/PaneSlugReservation.js';
import {
  acquireProjectWorktreeRecoveryLock,
  mutateProjectPaneConfig,
} from '../src/services/ProjectPaneConfig.js';

describe('crash-safe pane slug ownership', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function project(prefix: string): string {
    const root = mkdtempSync(path.join(process.cwd(), prefix));
    roots.push(root);
    return root;
  }

  it('serializes attachment and new-pane producers in one session namespace', async () => {
    const sessionRoot = project('.psyche-slug-session-');
    const targetRoot = project('.psyche-slug-target-');
    await mutateProjectPaneConfig(sessionRoot, (config) => {
      config.panes = [{ id: 'base', paneId: '%1', slug: 'feature' }];
    });

    const attachment = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'attachment',
      operation: 'attachment',
      allocate: ({ occupiedSlugs }) => ({
        slug: 'feature-a2',
        worktreePath: path.join(targetRoot, '.psyche', 'worktrees', 'feature'),
      }),
    });

    await expect(reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'new-pane',
      operation: 'new-pane',
      allocate: () => ({
        slug: 'feature-a2',
        worktreePath: path.join(targetRoot, '.psyche', 'worktrees', 'feature-a2'),
      }),
    })).rejects.toThrow(/already owned/);

    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([
      expect.objectContaining({
        state: 'provisional',
        slug: 'feature-a2',
        pane: { id: 'attachment' },
      }),
    ]);
    await attachment.clearBeforeEffect();
  });

  it('publishes the target cleanup blocker before the session ownership write', async () => {
    const sessionRoot = project('.psyche-slug-prefix-session-');
    const targetRoot = project('.psyche-slug-prefix-target-');
    const worktreePath = path.join(targetRoot, '.psyche', 'worktrees', 'prefix');
    mkdirSync(worktreePath, { recursive: true });

    await expect(reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'prefix-pane',
      operation: 'prefix-crash',
      allocate: () => ({ slug: 'prefix', worktreePath }),
      writeOwnershipRecord: async () => {
        throw new Error('simulated crash before ownership persistence');
      },
    })).rejects.toThrow(/simulated crash/);

    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    const markers = await listWorktreeRecoveryMarkers(targetRoot);
    expect(markers).toEqual([
      expect.objectContaining({
        paneOwnershipState: 'provisional',
        recoveryId: expect.any(String),
      }),
    ]);
    expect(findBlockingWorktreeRecoveryMarker(
      project('.psyche-slug-prefix-observer-'),
      targetRoot,
      worktreePath,
    )).toMatchObject({
      blocked: true,
      marker: { recoveryId: markers[0].recoveryId },
    });
  });

  it('blocks cleanup directly from a session ownership record without allocation reconciliation', async () => {
    const sessionRoot = project('.psyche-slug-direct-session-');
    const targetRoot = project('.psyche-slug-direct-target-');
    const worktreePath = path.join(targetRoot, '.psyche', 'worktrees', 'direct');
    mkdirSync(worktreePath, { recursive: true });
    const reservation = await reservePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'direct-pane',
      operation: 'direct-ownership',
      allocate: () => ({ slug: 'direct', worktreePath }),
    });

    expect(findBlockingWorktreeRecoveryMarker(
      sessionRoot,
      targetRoot,
      worktreePath,
    )).toMatchObject({
      blocked: true,
      reason: expect.stringContaining(reservation.recoveryId),
    });
    await reservation.clearBeforeEffect();
  });

  it('refuses to acknowledge a cleanup blocker owned by an active provisional producer', async () => {
    const sessionRoot = project('.psyche-slug-active-session-');
    const targetRoot = project('.psyche-slug-active-target-');
    const worktreePath = path.join(targetRoot, '.psyche', 'worktrees', 'active');
    mkdirSync(worktreePath, { recursive: true });
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'active-pane',
      operation: 'active-producer',
      allocate: () => ({ slug: 'active', worktreePath }),
    });
    const [marker] = await listWorktreeRecoveryMarkers(targetRoot);

    await expect(acknowledgeWorktreeRecoveryMarker(
      targetRoot,
      marker.id,
    )).rejects.toThrow(/active producer/);
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toHaveLength(1);
    expect(await listWorktreeRecoveryMarkers(targetRoot)).toHaveLength(1);

    await reservation.clearBeforeEffect();
  });

  it('allocates distinct local and daemon new-pane slugs from fresh state', async () => {
    const sessionRoot = project('.psyche-slug-mixed-');
    const reserveNewPane = (paneId: string, operation: string) => (
      reserveCrashSafePaneSlug({
        sessionProjectRoot: sessionRoot,
        projectRoot: sessionRoot,
        paneId,
        operation,
        allocate: async ({ occupiedSlugs }) => {
          const slug = await allocateUniquePaneSlug('fix-auth', occupiedSlugs);
          return {
            slug,
            worktreePath: path.join(
              sessionRoot,
              '.psyche',
              'worktrees',
              slug,
            ),
          };
        },
      })
    );

    const [local, daemon] = await Promise.all([
      reserveNewPane('local-pane', 'local-new-worktree-pane'),
      reserveNewPane('daemon-pane', 'daemon-new-worktree-pane'),
    ]);
    expect([local.slug, daemon.slug].sort()).toEqual([
      'fix-auth',
      'fix-auth-2',
    ]);
    await Promise.all([
      local.clearBeforeEffect(),
      daemon.clearBeforeEffect(),
    ]);
  });

  it('keeps ownership when a crash occurs after effect but before pane persistence', async () => {
    const sessionRoot = project('.psyche-slug-crash-');
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'pane-crash',
      operation: 'local-new-worktree-pane',
      allocate: () => ({
        slug: 'crash-safe',
        worktreePath: path.join(
          sessionRoot,
          '.psyche',
          'worktrees',
          'crash-safe',
        ),
      }),
    });
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toHaveLength(1);

    await reservation.recordPaneEffect('%42');
    const settlement = await settlePaneSlugReservationAfterFailure(
      reservation,
      {
        operation: 'crash-window',
        reason: 'process ended before pane persistence',
        teardown: async () => ({ presence: 'unknown' }),
      },
    );

    expect(settlement).toMatchObject({
      released: false,
      quarantined: true,
    });
    expect(await listQuarantinedPaneSlugs(sessionRoot)).toEqual(['crash-safe']);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([
      expect.objectContaining({
        recoveryId: reservation.recoveryId,
        pane: expect.objectContaining({ paneId: '%42', slug: 'crash-safe' }),
      }),
    ]);
  });

  it('treats durable pane ownership as settled when cleanup marker removal fails', async () => {
    const sessionRoot = project('.psyche-slug-settle-');
    const cleanupFailure = new Error(`cleanup lock failed ${'x'.repeat(500)}`);
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'pane-settled',
      operation: 'settlement-cleanup-failure',
      allocate: () => ({
        slug: 'settled',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'settled'),
      }),
      removeCleanupBlocker: async () => {
        throw cleanupFailure;
      },
    });
    await reservation.recordPaneEffect('%81');
    await mutateProjectPaneConfig(sessionRoot, (config) => {
      config.panes = [{
        id: reservation.paneId,
        paneId: '%81',
        slug: reservation.slug,
      }];
    });

    const first = await settlePaneSlugReservationAfterFailure(reservation, {
      operation: 'settlement-retry',
      reason: 'caller observed an ambiguous completion',
    });
    const retry = await settlePaneSlugReservationAfterFailure(reservation, {
      operation: 'settlement-retry',
      reason: 'caller retried the same completion',
    });

    expect(first).toMatchObject({
      released: true,
      quarantined: false,
      message: expect.stringContaining('cleanup marker removal requires repair'),
    });
    expect(first.message!.length).toBeLessThan(500);
    expect(retry).toMatchObject({
      released: true,
      quarantined: false,
    });
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toHaveLength(1);
    await expect(reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'duplicate-pane',
      operation: 'settlement-duplicate-retry',
      allocate: () => ({
        slug: 'settled',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'settled'),
      }),
    })).rejects.toThrow(/already owned/);
  });

  it('reconciles stale-process provisional records against tmux state on restart', async () => {
    const sessionRoot = project('.psyche-slug-restart-');
    const absent = await reservePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'absent-pane',
      operation: 'daemon-new-worktree-pane',
      pid: 999_991,
      getProcessStartIdentity: () => 'old-process',
      allocate: () => ({
        slug: 'restart-absent',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'restart-absent'),
      }),
    });

    await absent.recordPaneEffect('%51');
    const uncertain = await reservePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'uncertain-pane',
      operation: 'local-new-worktree-pane',
      pid: 999_992,
      getProcessStartIdentity: () => 'old-process',
      allocate: () => ({
        slug: 'restart-uncertain',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'restart-uncertain'),
      }),
    });
    await uncertain.recordPaneEffect('%52');

    await reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
      ownerProbe: { isProcessAlive: () => false },
      probePane: async (paneId) => paneId === '%51' ? 'absent' : 'unknown',
    });

    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([
      expect.objectContaining({
        state: 'quarantined',
        slug: 'restart-uncertain',
      }),
    ]);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([
      expect.objectContaining({
        recoveryId: uncertain.recoveryId,
        pane: expect.objectContaining({ paneId: '%52' }),
      }),
    ]);
  });

  it('recreates a missing target marker for an existing session quarantine', async () => {
    const sessionRoot = project('.psyche-slug-quarantine-session-');
    const targetRoot = project('.psyche-slug-quarantine-target-');
    const worktreePath = path.join(targetRoot, '.psyche', 'worktrees', 'repair');
    mkdirSync(worktreePath, { recursive: true });
    const reservation = await reservePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'repair-pane',
      operation: 'repair-quarantine',
      allocate: () => ({ slug: 'repair', worktreePath }),
    });
    await quarantinePaneSlugOwnershipRecord({
      sessionProjectRoot: sessionRoot,
      recoveryId: reservation.recoveryId,
      projectRoot: targetRoot,
      worktreePath,
      slug: reservation.slug,
      pane: { id: reservation.paneId, paneId: '%repair' },
      operation: 'repair-quarantine',
      reason: 'target marker was lost',
      targetMarkerId: 'a'.repeat(64),
    });
    expect(await listWorktreeRecoveryMarkers(targetRoot)).toEqual([]);

    await reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
    });

    expect(await listWorktreeRecoveryMarkers(targetRoot)).toEqual([
      expect.objectContaining({
        recoveryId: reservation.recoveryId,
        paneOwnershipState: 'quarantined',
      }),
    ]);
  });

  it('upgrades a provisional target marker from current quarantined ownership after restart', async () => {
    const sessionRoot = project('.psyche-slug-upgrade-session-');
    const targetRoot = project('.psyche-slug-upgrade-target-');
    const worktreePath = path.join(targetRoot, '.psyche', 'worktrees', 'upgrade');
    mkdirSync(worktreePath, { recursive: true });
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: targetRoot,
      paneId: 'upgrade-pane',
      operation: 'upgrade-quarantine',
      allocate: () => ({ slug: 'upgrade', worktreePath }),
    });
    const [provisionalMarker] = await listWorktreeRecoveryMarkers(targetRoot);
    await quarantinePaneSlugOwnershipRecord({
      sessionProjectRoot: sessionRoot,
      recoveryId: reservation.recoveryId,
      projectRoot: targetRoot,
      worktreePath,
      slug: reservation.slug,
      pane: { id: reservation.paneId, paneId: '%upgrade' },
      operation: 'upgrade-quarantine',
      reason: 'quarantine succeeded before target marker rewrite failed',
      targetMarkerId: provisionalMarker.id,
    });

    await reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
    });

    expect(await listWorktreeRecoveryMarkers(targetRoot)).toEqual([
      expect.objectContaining({
        id: provisionalMarker.id,
        recoveryId: reservation.recoveryId,
        pane: expect.objectContaining({ paneId: '%upgrade', slug: 'upgrade' }),
        paneOwnershipState: 'quarantined',
        allowWorktreeReuse: true,
        reason: 'quarantine succeeded before target marker rewrite failed',
      }),
    ]);
    await expect(acknowledgeWorktreeRecoveryMarker(
      sessionRoot,
      provisionalMarker.id,
    )).resolves.toBe(true);
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(targetRoot)).toEqual([]);
  });

  it('does not recreate a cleanup marker after the producer settles ownership', async () => {
    const sessionRoot = project('.psyche-slug-interleave-');
    let ownershipSettled!: () => void;
    const ownershipWasSettled = new Promise<void>((resolve) => {
      ownershipSettled = resolve;
    });
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'interleaved-pane',
      operation: 'interleaved-reconciliation',
      allocate: () => ({
        slug: 'interleaved',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'interleaved'),
      }),
      removeCleanupBlocker: async (record) => {
        ownershipSettled();
        return removePaneSlugCleanupBlocker(record);
      },
    });
    const [snapshot] = await listPaneSlugOwnershipRecords(sessionRoot);
    await removePaneSlugCleanupBlocker(snapshot);

    const targetLock = await acquireProjectWorktreeRecoveryLock(sessionRoot);
    let reconciliationBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      reconciliationBlocked = resolve;
    });
    let retryReconciliation!: () => void;
    const canRetry = new Promise<void>((resolve) => {
      retryReconciliation = resolve;
    });
    const reconciliation = reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
      lockOptions: {
        pollIntervalMs: 1,
        sleep: async () => {
          reconciliationBlocked();
          await canRetry;
        },
      },
    });
    await blocked;

    const settlement = reservation.clearBeforeEffect();
    await ownershipWasSettled;
    await targetLock.release();
    retryReconciliation();

    await Promise.all([reconciliation, settlement]);
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([]);
  });

  it('does not resurrect quarantine after another reconciler confirms pane absence', async () => {
    const sessionRoot = project('.psyche-slug-reconcile-race-');
    const reservation = await reserveCrashSafePaneSlug({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      paneId: 'racing-pane',
      operation: 'racing-reconciliation',
      allocate: () => ({
        slug: 'racing',
        worktreePath: path.join(sessionRoot, '.psyche', 'worktrees', 'racing'),
      }),
    });
    await reservation.recordPaneEffect('%91');

    let firstProbeStarted!: () => void;
    const firstProbeWasStarted = new Promise<void>((resolve) => {
      firstProbeStarted = resolve;
    });
    let releaseFirstProbe!: () => void;
    const firstProbeCanFinish = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const staleReconciliation = reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
      ownerProbe: { isProcessAlive: () => false },
      probePane: async () => {
        firstProbeStarted();
        await firstProbeCanFinish;
        return 'unknown';
      },
    });
    await firstProbeWasStarted;

    await reconcileStalePaneSlugReservations({
      sessionProjectRoot: sessionRoot,
      ownerProbe: { isProcessAlive: () => false },
      probePane: async () => 'absent',
    });
    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([]);

    releaseFirstProbe();
    await staleReconciliation;

    expect(await listPaneSlugOwnershipRecords(sessionRoot)).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([]);
  });

  it('makes target cleanup visible cross-session and acknowledges both records once', async () => {
    const sessionA = project('.psyche-slug-session-a-');
    const sessionB = project('.psyche-slug-session-b-');
    const targetRoot = project('.psyche-slug-target-wide-');
    const worktreePath = path.join(
      targetRoot,
      '.psyche',
      'worktrees',
      'shared',
    );
    mkdirSync(worktreePath, { recursive: true });

    const written = await writeWorktreeRecoveryMarker({
      sessionProjectRoot: sessionA,
      projectRoot: targetRoot,
      worktreePath,
      pane: { id: 'pane-a', paneId: '%61', slug: 'shared-a2' },
      allowWorktreeReuse: true,
      operation: 'cross-session-recovery',
      reason: 'pane state is ambiguous',
    });

    expect(findBlockingWorktreeRecoveryMarker(
      sessionB,
      targetRoot,
      worktreePath,
    )).toMatchObject({
      blocked: true,
      marker: { id: written.marker.id },
    });
    expect(await listWorktreeRecoveryMarkers(targetRoot)).toHaveLength(1);
    expect(await listQuarantinedPaneSlugs(sessionA)).toEqual(['shared-a2']);
    expect(await listQuarantinedPaneSlugs(sessionB)).toEqual([]);

    const acknowledgements = await Promise.all([
      acknowledgeWorktreeRecoveryMarker(sessionA, written.marker.id),
      acknowledgeWorktreeRecoveryMarker(targetRoot, written.marker.id),
    ]);
    expect(acknowledgements.sort()).toEqual([false, true]);
    expect(await listWorktreeRecoveryMarkers(targetRoot)).toEqual([]);
    expect(await listQuarantinedPaneSlugs(sessionA)).toEqual([]);
  });

  it('keeps cleanup blocked when a slug is owned by a different durable pane', async () => {
    const sessionRoot = project('.psyche-slug-ambiguous-');
    await mutateProjectPaneConfig(sessionRoot, (config) => {
      config.panes = [{ id: 'durable-pane', paneId: '%71', slug: 'shared' }];
    });

    const result = await writeWorktreeRecoveryMarker({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      worktreePath: sessionRoot,
      pane: { id: 'other-pane', paneId: '%72', slug: 'shared' },
      allowWorktreeReuse: true,
      operation: 'ambiguous-recovery',
      reason: 'pane identity is ambiguous',
    });

    expect(result).toMatchObject({
      state: 'target-marker-only',
      marker: { paneOwnershipState: 'provisional' },
      warning: expect.stringContaining('already durably owned'),
    });
    expect(findBlockingWorktreeRecoveryMarker(
      sessionRoot,
      sessionRoot,
      sessionRoot,
    )).toMatchObject({ blocked: true, marker: { id: result.marker.id } });
    expect(await listQuarantinedPaneSlugs(sessionRoot)).toEqual([]);
  });
});
