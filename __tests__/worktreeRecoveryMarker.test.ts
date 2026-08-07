import { afterEach, describe, expect, it } from 'vitest';
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
});
