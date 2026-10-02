import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
} from '../src/services/WorktreeRecoveryMarker.js';
import {
  listPaneSlugOwnershipRecords,
  quarantinePaneSlugOwnershipRecord,
  reservePaneSlug,
} from '../src/services/PaneSlugRegistry.js';
import {
  reconcileStalePaneSlugReservations,
  settlePaneSlugReservationAfterFailure,
} from '../src/services/PaneSlugReservation.js';
import {
  IN_FLIGHT_PANE_CREATION_FUTURE_TOLERANCE_MS,
  IN_FLIGHT_PANE_CREATION_TTL_MS,
  gateUntrackedPaneAdoption,
} from '../src/services/UntrackedPaneAdoptionGate.js';
import type { TmuxServerIdentity } from '../src/services/TmuxServerIdentity.js';

const LIVE_PID = 424_242;
const DEAD_PID = 999_991;
const SERVER: TmuxServerIdentity = { pid: 7, processStartIdentity: 'tmux-a' };
const OTHER_SERVER: TmuxServerIdentity = { pid: 8, processStartIdentity: 'tmux-b' };

describe('untracked pane adoption gate', () => {
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

  async function reserve(
    root: string,
    options: { pid: number; slug: string; now?: Date },
  ) {
    return reservePaneSlug({
      sessionProjectRoot: root,
      projectRoot: root,
      paneId: `record-${options.slug}`,
      operation: 'terminal-pane',
      pid: options.pid,
      getProcessStartIdentity: () => undefined,
      ...(options.now ? { now: () => options.now! } : {}),
      allocate: () => ({ slug: options.slug, worktreePath: root }),
    });
  }

  function gateOptions(overrides: {
    now?: () => number;
    serverIdentityOf?: (paneId: string) => TmuxServerIdentity | undefined;
    reconcile?: typeof reconcileStalePaneSlugReservations;
  } = {}) {
    return {
      ownerProbe: {
        isProcessAlive: (pid: number) => pid === LIVE_PID,
        getProcessStartIdentity: () => undefined,
      },
      probePane: async () => 'present' as const,
      serverIdentityOf: () => SERVER,
      ...overrides,
    };
  }

  const shell = (paneId: string) => ({ paneId, title: 'zsh', command: 'zsh' });

  it('reports an orphan from a crashed creation once, however many cycles poll it (#516)', async () => {
    const root = project('.psyche-adoption-gate-crash-');
    const crashed = await reserve(root, { pid: DEAD_PID, slug: 'shell-1' });
    await crashed.recordPaneEffect('%7', SERVER);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const decision = await gateUntrackedPaneAdoption(
        root,
        [shell('%7')],
        gateOptions(),
      );
      expect(decision.adoptable).toEqual([]);
      expect(decision.excluded).toEqual([
        expect.objectContaining({
          paneId: '%7',
          reason: 'recovery-quarantined',
          recoveryId: crashed.recoveryId,
        }),
      ]);
    }

    const records = await listPaneSlugOwnershipRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      state: 'quarantined',
      recoveryId: crashed.recoveryId,
      pane: { paneId: '%7' },
    });
    const markers = await listWorktreeRecoveryMarkers(root);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      recoveryId: crashed.recoveryId,
      paneOwnershipState: 'quarantined',
      pane: { paneId: '%7' },
    });
  });

  it('lets an acknowledged quarantine be decided afresh', async () => {
    const root = project('.psyche-adoption-gate-ack-');
    const crashed = await reserve(root, { pid: DEAD_PID, slug: 'shell-1' });
    await crashed.recordPaneEffect('%7', SERVER);
    await gateUntrackedPaneAdoption(root, [shell('%7')], gateOptions());
    const [marker] = await listWorktreeRecoveryMarkers(root);

    expect(await acknowledgeWorktreeRecoveryMarker(root, marker!.id)).toBe(true);

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%7')],
      gateOptions(),
    );
    expect(decision.adoptable).toEqual([shell('%7')]);
    expect(decision.excluded).toEqual([]);
    expect(await listWorktreeRecoveryMarkers(root)).toEqual([]);
  });

  it('defers adoption while a live creation has reserved a slug but not bound its pane (#517)', async () => {
    const root = project('.psyche-adoption-gate-inflight-');
    const creation = await reserve(root, { pid: LIVE_PID, slug: 'shell-1' });

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions(),
    );

    expect(decision.adoptable).toEqual([]);
    expect(decision.deferred).toEqual({
      reason: 'creation-in-flight',
      recoveryId: creation.recoveryId,
    });
    // The gate writes nothing for a live creation: no marker, no quarantine.
    expect(await listWorktreeRecoveryMarkers(root)).toEqual([]);
    expect(await listPaneSlugOwnershipRecords(root)).toEqual([
      expect.objectContaining({ state: 'provisional', recoveryId: creation.recoveryId }),
    ]);
  });

  it('excludes only the pane a live creation has bound, and adopts the rest (#517)', async () => {
    const root = project('.psyche-adoption-gate-bound-');
    const creation = await reserve(root, { pid: LIVE_PID, slug: 'shell-1' });
    await creation.recordPaneEffect('%9', SERVER);

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%9'), shell('%10')],
      gateOptions(),
    );

    expect(decision.deferred).toBeUndefined();
    expect(decision.adoptable).toEqual([shell('%10')]);
    expect(decision.excluded).toEqual([
      expect.objectContaining({
        paneId: '%9',
        reason: 'creation-in-flight',
        recoveryId: creation.recoveryId,
      }),
    ]);
    // The gate writes nothing for a live creation: no marker, no quarantine.
    expect(await listWorktreeRecoveryMarkers(root)).toEqual([]);
  });

  it('stops honouring a live reservation once it has outlived the in-flight window', async () => {
    const root = project('.psyche-adoption-gate-expired-');
    const started = new Date('2026-10-01T00:00:00.000Z');
    const creation = await reserve(root, { pid: LIVE_PID, slug: 'shell-1', now: started });
    await creation.recordPaneEffect('%9', SERVER);
    const unbound = await reserve(root, { pid: LIVE_PID, slug: 'shell-2', now: started });

    const withinWindow = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions({ now: () => started.getTime() + IN_FLIGHT_PANE_CREATION_TTL_MS - 1 }),
    );
    expect(withinWindow.adoptable).toEqual([]);
    expect(withinWindow.deferred?.recoveryId).toBe(unbound.recoveryId);

    const expired = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions({ now: () => started.getTime() + IN_FLIGHT_PANE_CREATION_TTL_MS }),
    );
    expect(expired.deferred).toBeUndefined();
    expect(expired.excluded).toEqual([]);
    expect(expired.adoptable).toEqual([shell('%9')]);
  });

  it('reports an abandoned reservation that never bound a pane and leaves the pane adoptable', async () => {
    const root = project('.psyche-adoption-gate-abandoned-');
    const abandoned = await reserve(root, { pid: DEAD_PID, slug: 'shell-1' });

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions(),
    );

    expect(decision.deferred).toBeUndefined();
    expect(decision.adoptable).toEqual([shell('%9')]);
    const markers = await listWorktreeRecoveryMarkers(root);
    expect(markers).toEqual([
      expect.objectContaining({
        recoveryId: abandoned.recoveryId,
        pane: expect.objectContaining({ paneId: 'unresolved' }),
      }),
    ]);
  });

  it('does not let a record bound on another tmux server shadow a reused pane ID', async () => {
    const root = project('.psyche-adoption-gate-server-');
    const creation = await reserve(root, { pid: LIVE_PID, slug: 'shell-1' });
    await creation.recordPaneEffect('%9', OTHER_SERVER);

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions(),
    );

    expect(decision.adoptable).toEqual([shell('%9')]);
    expect(decision.excluded).toEqual([]);
  });

  it('carries the tmux generation into the quarantine so a reused pane ID on a new server is adoptable', async () => {
    const root = project('.psyche-adoption-gate-reused-');
    const crashed = await reserve(root, { pid: DEAD_PID, slug: 'shell-1' });
    await crashed.recordPaneEffect('%7', SERVER);
    await gateUntrackedPaneAdoption(root, [shell('%7')], gateOptions());

    const [record] = await listPaneSlugOwnershipRecords(root);
    expect(record).toMatchObject({
      state: 'quarantined',
      pane: { paneId: '%7', tmuxServerIdentity: SERVER },
    });

    const sameServer = await gateUntrackedPaneAdoption(root, [shell('%7')], gateOptions());
    expect(sameServer.adoptable).toEqual([]);

    const newServer = await gateUntrackedPaneAdoption(
      root,
      [shell('%7')],
      gateOptions({ serverIdentityOf: () => OTHER_SERVER }),
    );
    expect(newServer.adoptable).toEqual([shell('%7')]);
    expect(newServer.excluded).toEqual([]);
    // The quarantine itself stays until acknowledged; only adoption is freed.
    expect(await listWorktreeRecoveryMarkers(root)).toHaveLength(1);
  });

  it('carries the tmux generation into an adoption-failure quarantine', async () => {
    const root = project('.psyche-adoption-gate-failure-identity-');
    const adoption = await reserve(root, { pid: LIVE_PID, slug: 'shell-1' });
    await adoption.recordPaneEffect('%7', SERVER);

    const settlement = await settlePaneSlugReservationAfterFailure(adoption, {
      operation: 'shell-pane-adoption-failure',
      reason: 'Pane layout has no visible insertion target',
    });

    expect(settlement.quarantined).toBe(true);
    expect(await listPaneSlugOwnershipRecords(root)).toEqual([
      expect.objectContaining({
        state: 'quarantined',
        pane: expect.objectContaining({ paneId: '%7', tmuxServerIdentity: SERVER }),
      }),
    ]);
    const [marker] = await listWorktreeRecoveryMarkers(root);
    // The target marker format is unchanged: no generation is written there.
    expect(marker!.pane).toEqual({ id: adoption.paneId, paneId: '%7', slug: 'shell-1' });
  });

  it('honours a legacy quarantine without a generation until it is acknowledged', async () => {
    const root = project('.psyche-adoption-gate-legacy-');
    const legacy = await reserve(root, { pid: LIVE_PID, slug: 'shell-1' });
    await quarantinePaneSlugOwnershipRecord({
      sessionProjectRoot: root,
      recoveryId: legacy.recoveryId,
      projectRoot: root,
      worktreePath: root,
      slug: legacy.slug,
      pane: { id: legacy.paneId, paneId: '%7' },
      operation: 'shell-pane-adoption-failure',
      reason: 'written before the generation was carried',
      targetMarkerId: 'b'.repeat(64),
    });

    const decision = await gateUntrackedPaneAdoption(
      root,
      [shell('%7')],
      gateOptions({ serverIdentityOf: () => OTHER_SERVER }),
    );

    expect(decision.adoptable).toEqual([]);
    expect(decision.excluded).toEqual([
      expect.objectContaining({ paneId: '%7', reason: 'recovery-quarantined' }),
    ]);
  });

  it('does no reconciliation or lock-taking work in the steady state of a reported orphan', async () => {
    const root = project('.psyche-adoption-gate-steady-');
    const crashed = await reserve(root, { pid: DEAD_PID, slug: 'shell-1' });
    await crashed.recordPaneEffect('%7', SERVER);
    await reserve(root, { pid: LIVE_PID, slug: 'shell-2' }).then(
      (live) => live.recordPaneEffect('%8', SERVER),
    );
    const reconcile = vi.fn(reconcileStalePaneSlugReservations);

    const first = await gateUntrackedPaneAdoption(
      root,
      [shell('%7')],
      gateOptions({ reconcile }),
    );
    expect(first.reconciled).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const markersAfterFirst = JSON.stringify(await listWorktreeRecoveryMarkers(root));
    const recordsAfterFirst = JSON.stringify(await listPaneSlugOwnershipRecords(root));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const steady = await gateUntrackedPaneAdoption(
        root,
        [shell('%7')],
        gateOptions({ reconcile }),
      );
      expect(steady.reconciled).toBe(false);
      expect(steady.adoptable).toEqual([]);
    }

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await listWorktreeRecoveryMarkers(root))).toBe(markersAfterFirst);
    expect(JSON.stringify(await listPaneSlugOwnershipRecords(root))).toBe(recordsAfterFirst);
  });

  it('does not let a reservation stamped in the future defer adoption indefinitely', async () => {
    const root = project('.psyche-adoption-gate-future-');
    const stamped = new Date('2026-10-01T00:00:00.000Z');
    const creation = await reserve(root, { pid: LIVE_PID, slug: 'shell-1', now: stamped });

    const nudgedBack = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions({ now: () => stamped.getTime() - 1_000 }),
    );
    expect(nudgedBack.deferred?.recoveryId).toBe(creation.recoveryId);

    const skewed = await gateUntrackedPaneAdoption(
      root,
      [shell('%9')],
      gateOptions({
        now: () => stamped.getTime() - IN_FLIGHT_PANE_CREATION_FUTURE_TOLERANCE_MS - 1,
      }),
    );
    expect(skewed.deferred).toBeUndefined();
    expect(skewed.adoptable).toEqual([shell('%9')]);
  });
});
