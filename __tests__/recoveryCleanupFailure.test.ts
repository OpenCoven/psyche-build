import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryCleanupRetentionError } from '../src/diagnostics/recoveryCleanup.js';
import { runRecoveryHarness } from '../src/diagnostics/recoveryHarness.js';

const observe = vi.hoisted(() => vi.fn());
vi.mock('../src/diagnostics/recoveryCleanup.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/diagnostics/recoveryCleanup.js')>(),
  observeInterruptedCleanup: observe,
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  observe.mockReset();
});

describe('cleanup harness disposal policy', () => {
  it('retains the fixture when mutation quiescence cannot be confirmed', async () => {
    observe.mockImplementation(async (root: string) => {
      roots.push(root);
      throw new RecoveryCleanupRetentionError();
    });

    await expect(runRecoveryHarness(['interrupted-cleanup-owner']))
      .rejects.toThrow('workspace retained');
    expect(roots).toHaveLength(1);
    expect(await readFile(path.join(roots[0], 'uncommitted-work.txt'), 'utf8'))
      .toBe('the only copy of this work\n');
    await expect(access(path.join(roots[0], '.psyche'))).resolves.toBeUndefined();
  });

  it('still disposes a fixture after an ordinary setup failure', async () => {
    observe.mockImplementation(async (root: string) => {
      roots.push(root);
      throw new Error('setup failed before any child was spawned');
    });

    await expect(runRecoveryHarness(['interrupted-cleanup-owner']))
      .rejects.toThrow('setup failed');
    expect(roots).toHaveLength(1);
    await expect(access(roots[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
