import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  acknowledgeWorktreeRecoveryMarker,
  findBlockingWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
  writeWorktreeRecoveryMarker,
} from '../src/services/WorktreeRecoveryMarker.js';
import { retainPaneRecovery } from '../src/utils/paneLifecycleRecovery.js';
import type { PsychePane } from '../src/types.js';

describe('worktree recovery markers', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks destructive cleanup until an operator explicitly acknowledges recovery', async () => {
    const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-recovery-marker-'));
    directories.push(projectRoot);
    const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', 'uncertain');
    mkdirSync(path.join(worktreePath, 'src'), { recursive: true });

    const written = await writeWorktreeRecoveryMarker({
      projectRoot,
      worktreePath,
      pane: { id: 'pane-1', paneId: '%9' },
      operation: 'attach-agent',
      reason: 'tmux teardown could not be verified',
    });

    expect(findBlockingWorktreeRecoveryMarker(
      projectRoot,
      projectRoot,
      path.join(worktreePath, 'src'),
    )).toMatchObject({
      blocked: true,
      marker: { id: written.marker.id },
    });
    expect(await listWorktreeRecoveryMarkers(projectRoot)).toHaveLength(1);

    await expect(acknowledgeWorktreeRecoveryMarker(projectRoot, written.marker.id))
      .resolves.toBe(true);
    expect(findBlockingWorktreeRecoveryMarker(projectRoot, projectRoot, worktreePath))
      .toEqual({ blocked: false });
  });

  it('acknowledges only the exact incident generation when a newer marker exists', async () => {
    const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-recovery-marker-'));
    directories.push(projectRoot);
    const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', 'uncertain');
    mkdirSync(worktreePath, { recursive: true });
    const request = {
      projectRoot,
      worktreePath,
      pane: { id: 'pane-1', paneId: '%9' },
      operation: 'attach-agent',
      reason: 'tmux teardown could not be verified',
    };

    const older = await writeWorktreeRecoveryMarker(request);
    const newer = await writeWorktreeRecoveryMarker({
      ...request,
      reason: 'a newer recovery incident',
    });

    expect(newer.marker.id).not.toBe(older.marker.id);
    expect(await listWorktreeRecoveryMarkers(projectRoot)).toHaveLength(2);
    await acknowledgeWorktreeRecoveryMarker(projectRoot, older.marker.id);
    expect(await listWorktreeRecoveryMarkers(projectRoot)).toEqual([
      expect.objectContaining({
        id: newer.marker.id,
        reason: 'a newer recovery incident',
      }),
    ]);
    expect(findBlockingWorktreeRecoveryMarker(projectRoot, projectRoot, worktreePath))
      .toMatchObject({ blocked: true, marker: { id: newer.marker.id } });
  });

  it('persists cross-project slug quarantine in the session namespace across reload', async () => {
    const sessionProjectRoot = mkdtempSync(
      path.join(process.cwd(), '.psyche-recovery-session-'),
    );
    const targetProjectRoot = mkdtempSync(
      path.join(process.cwd(), '.psyche-recovery-target-'),
    );
    directories.push(sessionProjectRoot, targetProjectRoot);
    const worktreePath = path.join(
      targetProjectRoot,
      '.psyche',
      'worktrees',
      'feature',
    );
    mkdirSync(worktreePath, { recursive: true });

    const associateRecoveryMarker = vi.fn();
    const recovery = await retainPaneRecovery({
      sessionProjectRoot,
      projectRoot: targetProjectRoot,
      pane: {
        id: 'pane-2',
        paneId: '%10',
        slug: 'feature-a2',
        prompt: 'review',
        projectRoot: targetProjectRoot,
        worktreePath,
      } as PsychePane,
      operation: 'bridge-pane-persistence',
      reason: 'pane config persistence and teardown could not be confirmed',
      reservation: {
        retain: () => ({ associateRecoveryMarker }),
      },
      persistConfigRecovery: async () => ({
        durable: false,
        message: 'session pane registry unavailable',
      }),
    });
    expect(recovery).toMatchObject({ durable: true, retained: false });
    const [written] = await listWorktreeRecoveryMarkers(targetProjectRoot);
    expect(associateRecoveryMarker).not.toHaveBeenCalled();

    vi.resetModules();
    const restartedRecovery = await import('../src/services/WorktreeRecoveryMarker.js');
    expect(written).toMatchObject({
      sessionProjectRoot,
      projectRoot: targetProjectRoot,
      worktreePath,
    });
    expect(await restartedRecovery.listQuarantinedPaneSlugs(sessionProjectRoot))
      .toEqual(['feature-a2']);
    expect(await restartedRecovery.listQuarantinedPaneSlugs(targetProjectRoot))
      .toEqual([]);
    expect(restartedRecovery.findBlockingWorktreeRecoveryMarker(
      sessionProjectRoot,
      targetProjectRoot,
      worktreePath,
    ).blocked).toBe(true);
    expect(restartedRecovery.findBlockingWorktreeRecoveryMarker(
      targetProjectRoot,
      targetProjectRoot,
      worktreePath,
    ).blocked).toBe(true);
    expect(restartedRecovery.findBlockingWorktreeReuseRecoveryMarker(
      sessionProjectRoot,
      targetProjectRoot,
      worktreePath,
    ))
      .toEqual({ blocked: false });

    await expect(restartedRecovery.acknowledgeWorktreeRecoveryMarker(
      sessionProjectRoot,
      written.id,
    ))
      .resolves.toBe(true);
    expect(await restartedRecovery.listQuarantinedPaneSlugs(sessionProjectRoot))
      .toEqual([]);
    expect(restartedRecovery.findBlockingWorktreeRecoveryMarker(
      sessionProjectRoot,
      targetProjectRoot,
      worktreePath,
    )).toEqual({ blocked: false });
  });

  it('keeps target cleanup fail-closed when session quarantine persistence fails', async () => {
    const sessionProjectRoot = mkdtempSync(
      path.join(process.cwd(), '.psyche-recovery-session-failure-'),
    );
    const otherSessionRoot = mkdtempSync(
      path.join(process.cwd(), '.psyche-recovery-other-session-'),
    );
    const targetProjectRoot = mkdtempSync(
      path.join(process.cwd(), '.psyche-recovery-target-failure-'),
    );
    directories.push(sessionProjectRoot, otherSessionRoot, targetProjectRoot);
    const worktreePath = path.join(
      targetProjectRoot,
      '.psyche',
      'worktrees',
      'feature',
    );
    mkdirSync(worktreePath, { recursive: true });
    const recoveryId = '11111111-2222-4333-8444-555555555555';
    const request = {
      recoveryId,
      sessionProjectRoot,
      projectRoot: targetProjectRoot,
      worktreePath,
      pane: { id: 'pane-3', paneId: '%11', slug: 'feature-a3' },
      allowWorktreeReuse: true,
      operation: 'bridge-pane-persistence',
      reason: 'pane config persistence and teardown could not be confirmed',
    };

    const partial = await writeWorktreeRecoveryMarker(request, {
      persistPaneQuarantine: async () => {
        throw new Error('injected session registry write failure');
      },
    });

    expect(partial).toMatchObject({
      state: 'target-marker-only',
      marker: { paneOwnershipState: 'provisional' },
      warning: expect.stringContaining('injected session registry write failure'),
    });
    expect(findBlockingWorktreeRecoveryMarker(
      otherSessionRoot,
      targetProjectRoot,
      worktreePath,
    )).toMatchObject({
      blocked: true,
      marker: { id: partial.marker.id, paneOwnershipState: 'provisional' },
    });

    const reconciled = await writeWorktreeRecoveryMarker(request);
    expect(reconciled).toMatchObject({
      state: 'complete',
      marker: {
        id: partial.marker.id,
        paneOwnershipState: 'quarantined',
      },
    });
    expect(await listWorktreeRecoveryMarkers(targetProjectRoot)).toHaveLength(1);

    await expect(acknowledgeWorktreeRecoveryMarker(
      sessionProjectRoot,
      reconciled.marker.id,
    )).resolves.toBe(true);
    expect(findBlockingWorktreeRecoveryMarker(
      otherSessionRoot,
      targetProjectRoot,
      worktreePath,
    )).toEqual({ blocked: false });
  });
});
