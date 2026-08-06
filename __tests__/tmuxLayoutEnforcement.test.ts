import { expect, it, vi } from 'vitest';

const tmuxServiceMock = vi.hoisted(() => ({
  resizePane: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

it('enforces sidebar size without projecting the legacy content grid', async () => {
  const { enforceControlPaneSize } = await import('../src/utils/tmux.js');

  await enforceControlPaneSize('%0', 40, { forceLayout: true });

  expect(tmuxServiceMock.resizePane).toHaveBeenCalledWith('%0', { width: 40 });
  expect(tmuxServiceMock.refreshClient).toHaveBeenCalledTimes(1);
});
