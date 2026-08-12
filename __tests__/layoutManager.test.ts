import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsycheConfig, PsychePane } from '../src/types.js';

const transactionConfig = vi.hoisted(() => ({
  value: undefined as PsycheConfig | undefined,
}));
const persistMock = vi.hoisted(() => vi.fn(async () => {}));
const tmuxServiceMock = vi.hoisted(() => ({
  getTerminalDimensions: vi.fn(async () => ({ width: 201, height: 60 })),
  resizePane: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  projectRootFromPaneConfigPath: () => '/project',
  readProjectPaneConfig: vi.fn(async () => transactionConfig.value),
  transactProjectPaneConfig: async (
    _projectRoot: string,
    operation: (transaction: {
      config: PsycheConfig;
      persist: () => Promise<void>;
    }) => Promise<unknown>,
  ) => ({
    result: await operation({
      config: transactionConfig.value!,
      persist: persistMock,
    }),
  }),
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: () => tmuxServiceMock,
  },
}));

function pane(id: string, paneId: string): PsychePane {
  return { id, slug: id, prompt: id, paneId };
}

describe('applyStoredPaneLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionConfig.value = {
      projectName: 'project',
      projectRoot: '/project',
      panes: [pane('psyche-1', '%1')],
      settings: {},
      lastUpdated: '2026-08-12T00:00:00.000Z',
    };
  });

  it('persists ownership and the accepted inserted topology in one transaction', async () => {
    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');
    const inserted = pane('psyche-2', '%2');

    const layout = await applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1'), inserted],
      persistPanes: [inserted],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: {
        kind: 'insert',
        paneId: inserted.id,
        targetPaneId: 'psyche-1',
        direction: 'vertical',
      },
    });

    expect(transactionConfig.value?.panes).toEqual([
      pane('psyche-1', '%1'),
      inserted,
    ]);
    expect(transactionConfig.value?.paneLayout).toEqual(layout);
    expect(tmuxServiceMock.selectLayout).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(tmuxServiceMock.selectLayout.mock.invocationCallOrder[0])
      .toBeLessThan(persistMock.mock.invocationCallOrder[0]);
  });

  it('does not persist ownership or topology when tmux rejects the layout', async () => {
    tmuxServiceMock.selectLayout.mockRejectedValueOnce(new Error('tmux unavailable'));
    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');

    await expect(applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1')],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
    })).rejects.toThrow('tmux unavailable');

    expect(transactionConfig.value?.paneLayout).toBeUndefined();
    expect(persistMock).not.toHaveBeenCalled();
  });
});
