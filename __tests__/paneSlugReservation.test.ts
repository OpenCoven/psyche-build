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
  writeWorktreeRecoveryMarker,
} from '../src/services/WorktreeRecoveryMarker.js';
import {
  allocateUniquePaneSlug,
  listPaneSlugOwnershipRecords,
  reservePaneSlug,
} from '../src/services/PaneSlugRegistry.js';
import {
  reconcileStalePaneSlugReservations,
  reserveCrashSafePaneSlug,
  settlePaneSlugReservationAfterFailure,
} from '../src/services/PaneSlugReservation.js';
import { mutateProjectPaneConfig } from '../src/services/ProjectPaneConfig.js';

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

  it('refuses to quarantine a slug owned by a different durable pane', async () => {
    const sessionRoot = project('.psyche-slug-ambiguous-');
    await mutateProjectPaneConfig(sessionRoot, (config) => {
      config.panes = [{ id: 'durable-pane', paneId: '%71', slug: 'shared' }];
    });

    await expect(writeWorktreeRecoveryMarker({
      sessionProjectRoot: sessionRoot,
      projectRoot: sessionRoot,
      worktreePath: sessionRoot,
      pane: { id: 'other-pane', paneId: '%72', slug: 'shared' },
      allowWorktreeReuse: true,
      operation: 'ambiguous-recovery',
      reason: 'pane identity is ambiguous',
    })).rejects.toThrow(/already durably owned/);

    expect(await listWorktreeRecoveryMarkers(sessionRoot)).toEqual([]);
    expect(await listQuarantinedPaneSlugs(sessionRoot)).toEqual([]);
  });
});
