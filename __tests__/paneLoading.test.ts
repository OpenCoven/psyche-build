import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsycheConfig, PsychePane } from '../src/types.js';

const readFileMock = vi.hoisted(() => vi.fn());
const atomicWriteJsonMock = vi.hoisted(() => vi.fn());
const tmuxServiceMock = vi.hoisted(() => ({
  getAllPaneInfo: vi.fn(),
  getAllPaneIds: vi.fn(),
  getTerminalDimensions: vi.fn(async () => ({ width: 201, height: 60 })),
  resizePane: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: readFileMock,
    open: vi.fn(async () => ({ close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) })),
    unlink: vi.fn(async () => {}),
  },
  readFile: readFileMock,
  open: vi.fn(async () => ({ close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) })),
  unlink: vi.fn(async () => {}),
}));

vi.mock('../src/utils/atomicWrite.js', () => ({
  atomicWriteJson: atomicWriteJsonMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

function pane(
  id: string,
  paneId: string,
  hidden = false
): PsychePane {
  return {
    id,
    slug: id,
    prompt: id,
    paneId,
    hidden,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('loadAndProcessPanes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves an interactive pane addition while applying loader metadata updates', async () => {
    const panesFile = '/project/.psyche/psyche.config.json';
    let config: PsycheConfig = {
      projectName: 'project',
      projectRoot: '/project',
      controlPaneId: '%0',
      panes: [pane('psyche-1', '%1', true)],
      settings: {},
      lastUpdated: 'before',
    };
    let sidebarWidth = 40;
    let releaseTmuxFetch: (() => void) | undefined;
    const tmuxFetchPending = new Promise<void>((resolve) => {
      releaseTmuxFetch = resolve;
    });

    readFileMock.mockImplementation(async () => JSON.stringify(config));
    atomicWriteJsonMock.mockImplementation(async (_file: string, next: PsycheConfig) => {
      config = clone(next);
    });
    tmuxServiceMock.getAllPaneInfo
      .mockImplementationOnce(async () => {
        await tmuxFetchPending;
        return [
          { paneId: '%0', title: 'psyche' },
          { paneId: '%1', title: 'worker' },
        ];
      })
      .mockResolvedValue([
        { paneId: '%0', title: 'psyche' },
        { paneId: '%1', title: 'worker' },
        { paneId: '%2', title: 'new-worker' },
      ]);
    tmuxServiceMock.getAllPaneIds.mockResolvedValue(['%1']);

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const { savePanesToFile } = await import('../src/hooks/usePaneSync.js');
    const { withPanesConfigWriteLock } = await import('../src/utils/panesConfigQueue.js');

    const load = loadAndProcessPanes(panesFile, true, () => sidebarWidth);
    await vi.waitFor(() => {
      expect(tmuxServiceMock.getAllPaneInfo).toHaveBeenCalledTimes(1);
    });
    await savePanesToFile(
      panesFile,
      [...config.panes, pane('psyche-2', '%2')],
      withPanesConfigWriteLock
    );
    sidebarWidth = 4;
    releaseTmuxFetch?.();

    const result = await load;

    expect(config.panes.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(config.panes.find((entry) => entry.id === 'psyche-1')?.hidden).toBe(false);
    expect(result.panes.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(tmuxServiceMock.resizePane).toHaveBeenCalledWith('%0', { width: 4 });
  });

  it('appends created panes without overwriting loader-reconciled metadata', async () => {
    const panesFile = '/project/.psyche/psyche.config.json';
    let config: PsycheConfig = {
      projectName: 'project',
      projectRoot: '/project',
      controlPaneId: '%0',
      panes: [pane('psyche-1', '%1')],
      settings: {},
      lastUpdated: 'after-loader-reconciliation',
    };
    readFileMock.mockImplementation(async () => JSON.stringify(config));
    atomicWriteJsonMock.mockImplementation(async (_file: string, next: PsycheConfig) => {
      config = clone(next);
    });

    const { appendPanesToFile } = await import('../src/hooks/usePaneSync.js');
    const { withPanesConfigWriteLock } = await import('../src/utils/panesConfigQueue.js');
    const appended = await appendPanesToFile(
      panesFile,
      [pane('psyche-2', '%2')],
      withPanesConfigWriteLock
    );

    expect(appended.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(config.panes.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(config.lastUpdated).not.toBe('after-loader-reconciliation');
  });

  it('rebases a stale loader metadata write without losing additions or reviving removals', async () => {
    const panesFile = '/project/.psyche/psyche.config.json';
    const observedPane = pane('psyche-1', '%1', true);
    const remappedPane = pane('psyche-1', '%1');
    let config: PsycheConfig = {
      projectName: 'project',
      projectRoot: '/project',
      controlPaneId: '%0',
      panes: [observedPane, pane('psyche-2', '%2')],
      settings: {},
      lastUpdated: 'before',
    };
    readFileMock.mockImplementation(async () => JSON.stringify(config));
    atomicWriteJsonMock.mockImplementation(async (_file: string, next: PsycheConfig) => {
      config = clone(next);
    });

    const { saveUpdatedPaneConfig } = await import('../src/hooks/usePaneSync.js');
    const { withPanesConfigWriteLock } = await import('../src/utils/panesConfigQueue.js');

    await saveUpdatedPaneConfig(
      panesFile,
      [remappedPane],
      withPanesConfigWriteLock,
      [observedPane]
    );
    expect(config.panes.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(config.panes.find((entry) => entry.id === 'psyche-1')?.hidden).toBe(false);

    config = {
      ...config,
      panes: [pane('psyche-2', '%2')],
    };
    await saveUpdatedPaneConfig(
      panesFile,
      [remappedPane],
      withPanesConfigWriteLock,
      [observedPane]
    );
    expect(config.panes.map((entry) => entry.id)).toEqual(['psyche-2']);
  });

  it('removes a conflict pane from the observed pane snapshot', async () => {
    const panesFile = '/project/.psyche/psyche.config.json';
    const contentPane = pane('psyche-1', '%1');
    const conflictPane = pane('psyche-conflict', '%2');
    let config: PsycheConfig = {
      projectName: 'project',
      projectRoot: '/project',
      controlPaneId: '%0',
      panes: [contentPane, conflictPane],
      settings: {},
      lastUpdated: 'before',
    };
    readFileMock.mockImplementation(async () => JSON.stringify(config));
    atomicWriteJsonMock.mockImplementation(async (_file: string, next: PsycheConfig) => {
      config = clone(next);
    });

    const { savePanesToFile } = await import('../src/hooks/usePaneSync.js');
    const { withPanesConfigWriteLock } = await import('../src/utils/panesConfigQueue.js');
    await savePanesToFile(
      panesFile,
      [contentPane],
      withPanesConfigWriteLock,
      {
        observedPanes: [contentPane, conflictPane],
        appendUnobservedPanes: false,
      }
    );

    expect(config.panes.map((entry) => entry.id)).toEqual(['psyche-1']);
  });
});
