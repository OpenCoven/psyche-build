import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const readFileMock = vi.hoisted(() => vi.fn());
const capturePaneInsertionMock = vi.hoisted(() => vi.fn());
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn());
const getUntrackedPanesMock = vi.hoisted(() => vi.fn());
const createShellPaneMock = vi.hoisted(() => vi.fn());
const tmuxServiceMock = vi.hoisted(() => ({
  getAllPaneIds: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

vi.mock('../src/utils/shellPaneDetection.js', () => ({
  getUntrackedPanes: getUntrackedPanesMock,
  createShellPane: createShellPaneMock,
  getNextPsycheId: vi.fn(() => 2),
}));

vi.mock('../src/utils/paneColors.js', () => ({
  syncPaneColorThemes: vi.fn((panes: PsychePane[]) => panes),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: () => tmuxServiceMock,
  },
}));

vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({ error: vi.fn() }),
  },
}));

function pane(id: string, paneId: string): PsychePane {
  return { id, slug: id, prompt: id, paneId };
}

describe('detectAndAddShellPanes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockResolvedValue(JSON.stringify({
      controlPaneId: '%0',
      paneLayout: {
        version: 1,
        root: { kind: 'leaf', paneId: 'focused' },
      },
    }));
    getUntrackedPanesMock.mockResolvedValue([{ paneId: '%2', title: 'zsh' }]);
    createShellPaneMock.mockResolvedValue(pane('detected', '%2'));
    capturePaneInsertionMock.mockResolvedValue({
      targetPaneId: 'focused',
      targetTmuxPaneId: '%1',
      direction: 'vertical',
    });
    insertPaneIntoStoredLayoutMock.mockResolvedValue({});
  });

  it('inserts externally detected shells beside the focused content pane', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    const focused = pane('focused', '%1');

    const result = await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [focused],
      ['%0', '%1', '%2'],
      {
        focusedTmuxPaneId: '%1',
        selectedPaneId: 'selected',
        sidebarWidth: 4,
      }
    );

    expect(capturePaneInsertionMock).toHaveBeenCalledWith({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [focused],
      focusedTmuxPaneId: '%1',
      selectedPaneId: 'selected',
    });
    expect(insertPaneIntoStoredLayoutMock).toHaveBeenCalledWith({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [focused],
      pane: pane('detected', '%2'),
      controlPaneId: '%0',
      insertion: {
        targetPaneId: 'focused',
        targetTmuxPaneId: '%1',
        direction: 'vertical',
      },
      sidebarWidth: 4,
    });
    expect(result.updatedPanes).toEqual([focused, pane('detected', '%2')]);
  });

  it('uses the selected target when no focused target is available', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    const selected = pane('selected', '%1');

    await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [selected],
      ['%0', '%1', '%2'],
      { selectedPaneId: 'selected' }
    );

    expect(capturePaneInsertionMock).toHaveBeenCalledWith({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [selected],
      focusedTmuxPaneId: undefined,
      selectedPaneId: 'selected',
    });
  });

  it('refreshes stale targets without persisting a shell or layout mutation when none remains', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    const stale = pane('stale', '%1');
    capturePaneInsertionMock
      .mockRejectedValueOnce(new Error('Pane layout insertion target %1 is no longer available'))
      .mockResolvedValueOnce(undefined);
    tmuxServiceMock.getAllPaneIds.mockResolvedValue(['%0', '%2']);

    const result = await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [stale],
      ['%0', '%1', '%2'],
      { focusedTmuxPaneId: '%1' }
    );

    expect(tmuxServiceMock.getAllPaneIds).toHaveBeenCalledWith('window');
    expect(capturePaneInsertionMock).toHaveBeenCalledTimes(2);
    expect(insertPaneIntoStoredLayoutMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      updatedPanes: [stale],
      shellPanesAdded: false,
    });
  });
});
