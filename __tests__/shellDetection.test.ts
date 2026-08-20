import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const readFileMock = vi.hoisted(() => vi.fn());
const capturePaneInsertionMock = vi.hoisted(() => vi.fn());
const insertPanesIntoStoredLayoutMock = vi.hoisted(() => vi.fn());
const getUntrackedPanesMock = vi.hoisted(() => vi.fn());
const createShellPaneMock = vi.hoisted(() => vi.fn());
const detectShellPaneProjectInfoMock = vi.hoisted(() => vi.fn());
const reserveCrashSafePaneSlugMock = vi.hoisted(() => vi.fn());
const settlePaneSlugReservationAfterFailureMock = vi.hoisted(() => vi.fn());
const createPsychePaneIdMock = vi.hoisted(() => vi.fn());
const tmuxServiceMock = vi.hoisted(() => ({
  getAllPaneIds: vi.fn(),
  getServerIdentity: vi.fn(),
  setPaneTitle: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

vi.mock('../src/utils/shellPaneDetection.js', () => ({
  getUntrackedPanes: getUntrackedPanesMock,
  createShellPane: createShellPaneMock,
  detectShellPaneProjectInfo: detectShellPaneProjectInfoMock,
  getNextPsycheId: vi.fn(() => 2),
}));

vi.mock('../src/utils/paneIdentity.js', () => ({
  createPsychePaneId: createPsychePaneIdMock,
}));

vi.mock('../src/services/PaneSlugRegistry.js', () => ({
  allocateUniquePaneSlug: vi.fn(async (baseSlug: string, occupied: Set<string>) => {
    let slug = baseSlug;
    let suffix = 2;
    while (occupied.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }),
}));

vi.mock('../src/services/PaneSlugReservation.js', () => ({
  reserveCrashSafePaneSlug: reserveCrashSafePaneSlugMock,
  settlePaneSlugReservationAfterFailure: settlePaneSlugReservationAfterFailureMock,
}));

vi.mock('../src/utils/paneColors.js', () => ({
  syncPaneColorThemes: vi.fn((panes: PsychePane[]) => panes),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  capturePaneInsertion: capturePaneInsertionMock,
  insertPanesIntoStoredLayout: insertPanesIntoStoredLayoutMock,
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
    const occupiedSlugs = new Set<string>();
    let nextPaneId = 1;
    createPsychePaneIdMock.mockImplementation(() => `detected-${nextPaneId++}`);
    detectShellPaneProjectInfoMock.mockResolvedValue({});
    tmuxServiceMock.getServerIdentity.mockReturnValue({
      pid: 42,
      socketPath: '/tmux.sock',
    });
    tmuxServiceMock.setPaneTitle.mockResolvedValue(undefined);
    reserveCrashSafePaneSlugMock.mockImplementation(async (options) => {
      const candidate = await options.allocate({ occupiedSlugs });
      if (occupiedSlugs.has(candidate.slug)) {
        throw new Error(`Pane slug "${candidate.slug}" is already owned`);
      }
      occupiedSlugs.add(candidate.slug);
      let effect: { paneId: string } | undefined;
      return {
        recoveryId: `recovery-${candidate.slug}`,
        sessionProjectRoot: options.sessionProjectRoot,
        projectRoot: options.projectRoot,
        paneId: options.paneId,
        worktreePath: candidate.worktreePath,
        slug: candidate.slug,
        get effect() {
          return effect;
        },
        recordPaneEffect: vi.fn(async (paneId: string) => {
          effect = { paneId };
        }),
        completeAfterPanePersisted: vi.fn(async () => {
          occupiedSlugs.delete(candidate.slug);
        }),
        clearBeforeEffect: vi.fn(),
        clearAfterConfirmedTeardown: vi.fn(),
      };
    });
    readFileMock.mockResolvedValue(JSON.stringify({
      controlPaneId: '%0',
      paneLayout: {
        version: 1,
        root: { kind: 'leaf', paneId: 'focused' },
      },
    }));
    getUntrackedPanesMock.mockResolvedValue([{ paneId: '%2', title: 'zsh' }]);
    createShellPaneMock.mockImplementation(async (
      paneId: string,
      _nextId: number,
      _title: string,
      options: { paneRecordId: string; slug: string; tmuxServerIdentity: object },
    ) => ({
      ...pane(options.paneRecordId, paneId),
      slug: options.slug,
      tmuxServerIdentity: options.tmuxServerIdentity,
    }));
    capturePaneInsertionMock.mockResolvedValue({
      targetPaneId: 'focused',
      targetTmuxPaneId: '%1',
      direction: 'vertical',
    });
    insertPanesIntoStoredLayoutMock.mockResolvedValue({});
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
    expect(insertPanesIntoStoredLayoutMock).toHaveBeenCalledWith({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [focused],
      insertions: [{
        pane: expect.objectContaining({
          id: 'detected-1',
          paneId: '%2',
          slug: 'shell-2',
        }),
        insertion: {
          targetPaneId: 'focused',
          targetTmuxPaneId: '%1',
          direction: 'vertical',
        },
      }],
      controlPaneId: '%0',
      sidebarWidth: 4,
    });
    expect(result.updatedPanes).toEqual([
      focused,
      expect.objectContaining({
        id: 'detected-1',
        paneId: '%2',
        slug: 'shell-2',
      }),
    ]);
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

  it('keeps shell adoption in the config session namespace', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    readFileMock.mockResolvedValue(JSON.stringify({
      controlPaneId: '%0',
      projectRoot: '/selected-project',
    }));

    await detectAndAddShellPanes(
      '/session/.psyche/psyche.config.json',
      [pane('focused', '%1')],
      ['%0', '%1', '%2'],
    );

    expect(reserveCrashSafePaneSlugMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionProjectRoot: '/session',
      }),
    );
  });

  it('reserves distinct slugs when after-split adoption races', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    getUntrackedPanesMock
      .mockResolvedValueOnce([{ paneId: '%2', title: 'zsh' }])
      .mockResolvedValueOnce([{ paneId: '%3', title: 'bash' }]);
    const reserve = reserveCrashSafePaneSlugMock.getMockImplementation()!;
    reserveCrashSafePaneSlugMock.mockImplementation(async (options) => {
      const reservation = await reserve(options);
      return {
        ...reservation,
        completeAfterPanePersisted: vi.fn(async () => {}),
      };
    });

    const first = await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [pane('focused', '%1')],
      ['%0', '%1', '%2'],
    );
    const second = await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [pane('focused', '%1')],
      ['%0', '%1', '%3'],
    );

    expect([
      first.updatedPanes[1].slug,
      second.updatedPanes[1].slug,
    ].sort()).toEqual(['shell-2', 'shell-2-2']);
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
    expect(insertPanesIntoStoredLayoutMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      updatedPanes: [stale],
      shellPanesAdded: false,
    });
  });

  it('does not persist an earlier shell when a later stale target cannot be recovered', async () => {
    const { detectAndAddShellPanes } = await import('../src/hooks/useShellDetection.js');
    const focused = pane('focused', '%1');
    getUntrackedPanesMock.mockResolvedValue([
      { paneId: '%2', title: 'zsh' },
      { paneId: '%3', title: 'bash' },
    ]);
    createShellPaneMock
      .mockResolvedValueOnce(pane('detected-1', '%2'))
      .mockResolvedValueOnce(pane('detected-2', '%3'));
    capturePaneInsertionMock
      .mockResolvedValueOnce({
        targetPaneId: 'focused',
        targetTmuxPaneId: '%1',
        direction: 'vertical',
      })
      .mockRejectedValueOnce(new Error('Pane layout insertion target %1 is no longer available'))
      .mockResolvedValueOnce(undefined);
    tmuxServiceMock.getAllPaneIds.mockResolvedValue(['%0', '%2', '%3']);

    const result = await detectAndAddShellPanes(
      '/project/.psyche/psyche.config.json',
      [focused],
      ['%0', '%1', '%2', '%3'],
      { focusedTmuxPaneId: '%1' }
    );

    expect(capturePaneInsertionMock).toHaveBeenCalledTimes(3);
    expect(insertPanesIntoStoredLayoutMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      updatedPanes: [focused],
      shellPanesAdded: false,
    });
  });
});
