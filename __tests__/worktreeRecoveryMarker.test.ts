import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  acknowledgeWorktreeRecoveryMarker,
  findBlockingWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
  writeWorktreeRecoveryMarker,
} from '../src/services/WorktreeRecoveryMarker.js';

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
      path.join(worktreePath, 'src'),
    )).toMatchObject({
      blocked: true,
      marker: { id: written.marker.id },
    });
    expect(await listWorktreeRecoveryMarkers(projectRoot)).toHaveLength(1);

    await expect(acknowledgeWorktreeRecoveryMarker(projectRoot, written.marker.id))
      .resolves.toBe(true);
    expect(findBlockingWorktreeRecoveryMarker(projectRoot, worktreePath))
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
    expect(findBlockingWorktreeRecoveryMarker(projectRoot, worktreePath))
      .toMatchObject({ blocked: true, marker: { id: newer.marker.id } });
  });

  it('persists pane slug quarantine across reload while allowing guarded worktree reuse', async () => {
    const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-recovery-marker-'));
    directories.push(projectRoot);
    const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', 'feature');
    mkdirSync(worktreePath, { recursive: true });

    const written = await writeWorktreeRecoveryMarker({
      projectRoot,
      worktreePath,
      pane: { id: 'pane-2', paneId: '%10', slug: 'feature-a2' },
      operation: 'bridge-pane-persistence',
      reason: 'pane config persistence and teardown could not be confirmed',
      allowWorktreeReuse: true,
    });

    vi.resetModules();
    const restartedRecovery = await import('../src/services/WorktreeRecoveryMarker.js');
    expect(await restartedRecovery.listQuarantinedPaneSlugs(projectRoot))
      .toEqual(['feature-a2']);
    expect(restartedRecovery.findBlockingWorktreeRecoveryMarker(
      projectRoot,
      worktreePath,
    ).blocked).toBe(true);
    expect(restartedRecovery.findBlockingWorktreeReuseRecoveryMarker(
      projectRoot,
      worktreePath,
    ))
      .toEqual({ blocked: false });

    await expect(restartedRecovery.acknowledgeWorktreeRecoveryMarker(
      projectRoot,
      written.marker.id,
    ))
      .resolves.toBe(true);
    expect(await restartedRecovery.listQuarantinedPaneSlugs(projectRoot)).toEqual([]);
  });
});
