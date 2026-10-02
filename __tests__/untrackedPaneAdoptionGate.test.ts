import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
} from '../src/services/WorktreeRecoveryMarker.js';
import {
  listPaneSlugOwnershipRecords,
  reservePaneSlug,
} from '../src/services/PaneSlugRegistry.js';
import {
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

  /**
   * A live reservation carries one provisional cleanup blocker (the creation
   * publishes it; reconciliation restores it if missing). The gate must add
   * nothing beside it: no adoption-failure marker, no quarantine.
   */
  async function onlyLiveCleanupBlockers(root: string, recoveryId: string) {
    const markers = await listWorktreeRecoveryMarkers(root);
    return markers.length === 1
      && markers[0]!.recoveryId === recoveryId
      && markers[0]!.paneOwnershipState === 'provisional';
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
    expect(await onlyLiveCleanupBlockers(root, creation.recoveryId)).toBe(true);
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
    expect(await onlyLiveCleanupBlockers(root, creation.recoveryId)).toBe(true);
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
});
