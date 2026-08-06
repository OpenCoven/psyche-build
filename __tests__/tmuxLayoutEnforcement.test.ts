import { expect, it, vi } from 'vitest';

const tmuxServiceMock = vi.hoisted(() => ({
  resizePane: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  getPaneTitleSync: vi.fn(() => 'psyche'),
  splitPaneSync: vi.fn(() => '%1'),
  resizePaneSync: vi.fn(),
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

it('uses the explicit compact width when setting up the initial sidebar layout', async () => {
  const { setupSidebarLayout } = await import('../src/utils/tmux.js');

  setupSidebarLayout('%0', '/project', 4);

  expect(tmuxServiceMock.resizePaneSync).toHaveBeenCalledWith('%0', { width: 4 });
});
