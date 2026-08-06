import { describe, expect, it, vi } from 'vitest';
import { rollbackLocalPaneCreation } from '../src/utils/localPaneCreationRollback.js';

describe('rollbackLocalPaneCreation', () => {
  it.each([
    ['standard pane creation', true],
    ['reopen', false],
    ['attach', false],
    ['conflict', false],
    ['terminal shell', false],
    ['ritual pane creation', true],
    ['file browser shell', false],
    ['desktop shell', true],
  ])('rolls back only the resources created by %s', async (_flow, ownsResource) => {
    const tmuxService = { killPane: vi.fn(async () => {}) };
    const cleanup = vi.fn(async () => {});

    await rollbackLocalPaneCreation({
      tmuxService,
      paneId: '%new',
      cleanup: ownsResource ? cleanup : undefined,
    });

    expect(tmuxService.killPane).toHaveBeenCalledWith('%new');
    expect(cleanup).toHaveBeenCalledTimes(ownsResource ? 1 : 0);
  });

  it('preserves the layout failure when best-effort rollback also fails', async () => {
    const tmuxService = { killPane: vi.fn(async () => { throw new Error('pane already gone'); }) };
    const cleanup = vi.fn(async () => { throw new Error('resource cleanup failed'); });

    await expect(rollbackLocalPaneCreation({
      tmuxService,
      paneId: '%new',
      cleanup,
    })).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
