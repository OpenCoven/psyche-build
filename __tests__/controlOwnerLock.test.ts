import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireOwnerLock } from '../src/control/ownerLock.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project owner lock', () => {
  it('rejects a second live owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => true });
    await expect(acquireOwnerLock(root, { pid: 202, isProcessAlive: () => true }))
      .rejects.toThrow('already owned');
    await first.release();
  });

  it('increments the epoch after a dead owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    const firstEpoch = first.epoch;
    await first.release();
    const second = await acquireOwnerLock(root, { pid: 202, isProcessAlive: () => false });
    expect(second.epoch).toBe(firstEpoch + 1);
    await second.release();
  });

  it('allows only one contender to replace a stale owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const stale = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    const liveContender = (pid: number) => pid === 202 || pid === 303;
    const results = await Promise.allSettled([
      acquireOwnerLock(root, { pid: 202, isProcessAlive: liveContender }),
      acquireOwnerLock(root, { pid: 303, isProcessAlive: liveContender }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'fulfilled') await result.value.release();
    }
    await stale.release().catch(() => {});
  });

  it('recovers a provisional lock whose creator died before epoch finalization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const lockDir = path.join(root, '.psyche', 'runtime', 'owner.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 101,
      nonce: 'provisional',
      epoch: 0,
      acquiredAt: '2026-08-03T20:00:00.000Z',
    }));
    const recovered = await acquireOwnerLock(root, {
      pid: 202,
      isProcessAlive: () => false,
    });
    expect(recovered.epoch).toBeGreaterThan(0);
    await recovered.release();
  });
});
