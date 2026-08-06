import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const readFileMock = vi.hoisted(() => vi.fn());
const atomicWriteJsonMock = vi.hoisted(() => vi.fn());
const tmuxServiceMock = vi.hoisted(() => ({
  resizePane: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

vi.mock('../src/utils/atomicWrite.js', () => ({
  atomicWriteJson: atomicWriteJsonMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

function pane(id: string, paneId: string, hidden = false): PsychePane {
  return {
    id,
    slug: id,
    prompt: id,
    paneId,
    hidden,
  };
}

describe('applyStoredPaneLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockResolvedValue(JSON.stringify({
      projectName: 'project',
      projectRoot: '/project',
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      settings: {},
      lastUpdated: 'before',
      preservedField: 'preserved',
    }));
  });

  it('applies tmux before atomically persisting the reconciled topology', async () => {
    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');

    const layout = await applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
    });

    expect(tmuxServiceMock.resizePane).toHaveBeenCalledWith('%0', { width: 40 });
    expect(tmuxServiceMock.selectLayout).toHaveBeenCalledTimes(1);
    expect(atomicWriteJsonMock).toHaveBeenCalledWith(
      '/project/.psyche/psyche.config.json',
      expect.objectContaining({
        preservedField: 'preserved',
        paneLayout: layout,
      })
    );
    expect(tmuxServiceMock.selectLayout.mock.invocationCallOrder[0])
      .toBeLessThan(atomicWriteJsonMock.mock.invocationCallOrder[0]);
  });

  it('preserves hidden topology while only resizing and refreshing the sidebar', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      projectName: 'project',
      projectRoot: '/project',
      panes: [pane('psyche-1', '%1', true)],
      settings: {},
      lastUpdated: 'before',
      paneLayout: {
        version: 1,
        root: { kind: 'leaf', paneId: 'psyche-1' },
      },
    }));

    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');

    const layout = await applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1', true)],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
    });

    expect(layout.root).toEqual({ kind: 'leaf', paneId: 'psyche-1' });
    expect(tmuxServiceMock.selectLayout).not.toHaveBeenCalled();
    expect(tmuxServiceMock.resizePane).toHaveBeenCalledWith('%0', { width: 40 });
    expect(tmuxServiceMock.refreshClient).toHaveBeenCalledTimes(1);
  });

  it('does not persist when tmux rejects the layout', async () => {
    tmuxServiceMock.selectLayout.mockRejectedValueOnce(new Error('tmux unavailable'));
    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');

    await expect(applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
    })).rejects.toThrow('tmux unavailable');

    expect(atomicWriteJsonMock).not.toHaveBeenCalled();
  });

  it('merges the accepted layout into config fields saved while tmux was applying it', async () => {
    const initialConfig = {
      projectName: 'project',
      projectRoot: '/project',
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      settings: {},
      lastUpdated: 'before',
      preservedField: 'before-tmux',
    };
    const configSavedDuringTmuxApply = {
      ...initialConfig,
      preservedField: 'saved-during-tmux-apply',
      lastUpdated: 'during-tmux-apply',
    };
    readFileMock
      .mockResolvedValueOnce(JSON.stringify(initialConfig))
      .mockResolvedValueOnce(JSON.stringify(configSavedDuringTmuxApply));
    const { applyStoredPaneLayout } = await import('../src/utils/layoutManager.js');

    await applyStoredPaneLayout({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
    });

    expect(atomicWriteJsonMock).toHaveBeenCalledWith(
      '/project/.psyche/psyche.config.json',
      expect.objectContaining({
        preservedField: 'saved-during-tmux-apply',
        lastUpdated: 'during-tmux-apply',
      })
    );
  });
});
