import { beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxServiceMock = vi.hoisted(() => ({
  getAllPaneIdsSync: vi.fn(() => ['%0', '%1', '%2', '%3']),
  getPaneTitleSync: vi.fn(() => 'content'),
  listPanesSync: vi.fn(() => '%0=0\n%1=1\n%2=2\n%3=3'),
  paneExists: vi.fn(async () => true),
  getStatusBarHeightSync: vi.fn(() => 0),
  getWindowDimensionsSync: vi.fn(() => ({ width: 201, height: 60 })),
  setWindowOptionSync: vi.fn(),
  resizeWindowSync: vi.fn(() => true),
  resizePaneSync: vi.fn(),
  selectLayoutSync: vi.fn(() => true),
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

describe('recalculateAndApplyLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects a calculated multi-column layout instead of main-vertical for multi-pane content', async () => {
    const { recalculateAndApplyLayout } = await import('../src/utils/layoutManager.js');

    await recalculateAndApplyLayout('%0', ['%1', '%2', '%3'], 201, 60, undefined, {
      disableSpacer: true,
      sidebarWidth: 40,
    });

    expect(tmuxServiceMock.selectLayoutSync).toHaveBeenCalledTimes(1);
    const [layoutString] = tmuxServiceMock.selectLayoutSync.mock.calls[0] as unknown as [string];

    expect(layoutString).not.toBe('main-vertical');
    expect(layoutString).toMatch(/^[0-9a-f]{4},201x60,0,0\{/);
    expect(layoutString).toContain('40x60,0,0,0');
    expect(layoutString).toContain(',41,0,1');
    expect(layoutString).toContain(',96,0,2');
    expect(layoutString).toContain(',149,0,3');
  });
});
