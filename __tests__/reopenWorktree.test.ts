import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0' })),
}));

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getServerIdentity: vi.fn(),
  getCurrentSessionNameSync: vi.fn(() => 'psyche-test'),
  paneExists: vi.fn(async () => true),
  setSessionOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
  probePanePresence: vi.fn(async () => 'present'),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%1'));
const setupSidebarLayoutMock = vi.hoisted(() => vi.fn(() => '%1'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const capturePaneInsertionMock = vi.hoisted(() => vi.fn(async () => undefined));
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn(async () => ({})));
const getInstalledAgentsMock = vi.hoisted(() => vi.fn(async () => ['claude', 'codex']));
const filterEnabledAgentsMock = vi.hoisted(() => vi.fn((agents: string[]) => agents));
const destroyWelcomePaneCoordinatedMock = vi.hoisted(() => vi.fn());
const withWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const beginWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const atomicWriteJsonSyncMock = vi.hoisted(() => vi.fn());
const persistReopenedPaneMock = vi.hoisted(() => vi.fn(async () => {}));
const mutateProjectPaneConfigMock = vi.hoisted(() => vi.fn());
const ensureProjectPaneConfigPaneMock = vi.hoisted(() => vi.fn());
const reserveCrashSafePaneSlugMock = vi.hoisted(() => vi.fn());
const settlePaneSlugReservationAfterFailureMock = vi.hoisted(() => vi.fn());
const readWorktreeMetadataMock = vi.hoisted(() => vi.fn(() => ({
  agent: 'codex',
  permissionMode: 'bypassPermissions',
  branchName: 'feature/reopen-me',
})));

vi.mock('fs', () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  ensurePaneBorderStatusForCurrentSession: vi.fn(() => {
    tmuxServiceMock.setSessionOptionSync(
      tmuxServiceMock.getCurrentSessionNameSync(),
      'pane-border-status',
      'top'
    );
  }),
  setupSidebarLayout: setupSidebarLayoutMock,
  splitPane: splitPaneMock,
  getTerminalDimensions: vi.fn(() => ({ width: 160, height: 40 })),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  recalculateAndApplyLayout: recalculateAndApplyLayoutMock,
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(function SettingsManager() { return {
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enabledAgents: ['claude', 'codex'],
      enableAutopilotByDefault: false,
    })),
  }; }),
}));

vi.mock('../src/utils/agentDetection.js', () => ({
  getInstalledAgents: getInstalledAgentsMock,
  filterEnabledAgents: filterEnabledAgentsMock,
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  readWorktreeMetadata: readWorktreeMetadataMock,
}));

vi.mock('../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn((slug: string) => slug),
}));

vi.mock('../src/utils/git.js', () => ({
  getCurrentBranch: vi.fn(() => 'feature/reopen-me'),
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

vi.mock('../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: atomicWriteJsonSyncMock,
}));

vi.mock('../src/utils/welcomePaneManager.js', () => ({
  destroyWelcomePaneCoordinated: destroyWelcomePaneCoordinatedMock,
}));

vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      withWorktreeReuseReservation: withWorktreeReuseReservationMock,
      beginWorktreeReuseReservation: beginWorktreeReuseReservationMock,
    })),
  },
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  mutateProjectPaneConfig: mutateProjectPaneConfigMock,
  ensureProjectPaneConfigPane: ensureProjectPaneConfigPaneMock,
  readProjectPaneConfigUnderLock: vi.fn(async () => ({ panes: [] })),
  readProjectPaneConfig: vi.fn(async () => ({ controlPaneId: '%0', panes: [] })),
  projectPaneConfigPath: (projectRoot: string) => `${projectRoot}/.psyche/psyche.config.json`,
}));

vi.mock('../src/services/PaneSlugReservation.js', () => ({
  reserveCrashSafePaneSlug: reserveCrashSafePaneSlugMock,
  settlePaneSlugReservationAfterFailure: settlePaneSlugReservationAfterFailureMock,
}));

describe('reopenWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitPaneMock.mockImplementation(() => '%1');
    setupSidebarLayoutMock.mockImplementation(() => '%1');
    const occupiedSlugs = new Set<string>();
    reserveCrashSafePaneSlugMock.mockImplementation(async (options) => {
      const state = {
        config: { panes: [] },
        occupiedSlugs,
        persistedSlugs: new Set<string>(),
        ownershipRecords: [],
      };
      const candidate = await options.allocate(state);
      let slug = candidate.slug;
      let suffix = 2;
      while (occupiedSlugs.has(slug)) {
        slug = `${candidate.slug}-${suffix}`;
        suffix += 1;
      }
      occupiedSlugs.add(slug);
      let effect: { paneId: string; tmuxServerIdentity?: object } | undefined;
      return {
        recoveryId: `recovery-${slug}`,
        sessionProjectRoot: options.sessionProjectRoot,
        projectRoot: options.projectRoot,
        paneId: options.paneId,
        worktreePath: candidate.worktreePath,
        slug,
        get effect() {
          return effect;
        },
        recordPaneEffect: vi.fn(async (paneId, tmuxServerIdentity) => {
          effect = { paneId, tmuxServerIdentity };
        }),
        completeAfterPanePersisted: vi.fn(async () => {
          occupiedSlugs.delete(slug);
        }),
        clearBeforeEffect: vi.fn(async () => {
          occupiedSlugs.delete(slug);
        }),
        clearAfterConfirmedTeardown: vi.fn(async () => {
          occupiedSlugs.delete(slug);
        }),
      };
    });
    settlePaneSlugReservationAfterFailureMock.mockResolvedValue({
      released: true,
      quarantined: false,
    });
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));
    readWorktreeMetadataMock.mockReturnValue({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      branchName: 'feature/reopen-me',
    });
    withWorktreeReuseReservationMock.mockImplementation(
      async (
        worktreePath: string,
        operation: (canonicalWorktreePath: string) => Promise<unknown>
      ) => operation(worktreePath)
    );
    beginWorktreeReuseReservationMock.mockImplementation(async (
      worktreePath: string,
    ) => ({
      canonicalWorktreePath: worktreePath,
      retain: vi.fn(),
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }));
    ensureProjectPaneConfigPaneMock.mockResolvedValue(undefined);
    persistReopenedPaneMock.mockResolvedValue(undefined);
    tmuxServiceMock.killPane.mockResolvedValue(undefined);
    tmuxServiceMock.probePanePresence.mockResolvedValue('present');
    tmuxServiceMock.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'test-tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$test',
    });
    mutateProjectPaneConfigMock.mockImplementation(async (
      _projectRoot: string,
      mutation: (config: Record<string, unknown>) => unknown | Promise<unknown>,
    ) => {
      const config = JSON.parse(fsMock.readFileSync()) as Record<string, unknown>;
      const result = await mutation(config);
      return { config, result };
    });
  });

  it('uses stored agent metadata and permission mode for resume', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    const result = await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    });

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%1',
      expect.stringMatching(
        /^export PSYCHE_PANE_ID='psyche-[\da-f-]+'; export PSYCHE_TMUX_PANE_ID='%1'; codex --enable codex_hooks resume --last --dangerously-bypass-approvals-and-sandbox$/
      )
    );
    expect(tmuxServiceMock.setSessionOptionSync).toHaveBeenCalledWith(
      'psyche-test',
      'pane-border-status',
      'top'
    );
    expect(result.pane.agent).toBe('codex');
    expect(result.pane.permissionMode).toBe('bypassPermissions');
  });

  it('destroys the welcome pane even when only shell panes already exist', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [
        {
          id: 'psyche-1',
          slug: 'shell-1',
          prompt: '',
          paneId: '%9',
          type: 'shell',
          shellType: 'zsh',
        },
      ],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    });

    expect(destroyWelcomePaneCoordinatedMock).toHaveBeenCalledWith('/repo');
  });

  it('keeps a renamed project name when reopening a worktree', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      controlPaneId: '%0',
      sidebarProjects: [
        { projectRoot: '/repo', projectName: 'Renamed Repo' },
      ],
    }));

    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    const result = await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    });

    expect(result.pane.projectName).toBe('Renamed Repo');
  });

  it('persists a reopened pane inside its worktree lifecycle reservation', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    });

    expect(beginWorktreeReuseReservationMock).toHaveBeenCalledWith(
      '/repo/.psyche/worktrees/reopen-me',
      '/repo'
    );
    expect(persistReopenedPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo/.psyche/worktrees/reopen-me' })
    );
  });

  it('reserves distinct slugs when concurrent reopen producers race', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
    let paneNumber = 0;
    splitPaneMock.mockImplementation(() => `%${++paneNumber}`);
    setupSidebarLayoutMock.mockImplementation(() => `%${++paneNumber}`);
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persisted: PsychePane[] = [];
    const persist = vi.fn(async (pane: PsychePane) => {
      persisted.push(pane);
      if (persisted.length === 2) {
        releasePersist();
      }
      await persistGate;
    });

    const [first, second] = await Promise.all([
      reopenWorktree({
        slug: 'reopen-me',
        worktreePath: '/repo/.psyche/worktrees/reopen-me',
        projectRoot: '/repo',
        existingPanes: [],
        sessionProjectRoot: '/session',
        sessionConfigPath: '/session/.psyche/psyche.config.json',
        persistReopenedPane: persist,
      }),
      reopenWorktree({
        slug: 'reopen-me',
        worktreePath: '/repo/.psyche/worktrees/reopen-me',
        projectRoot: '/repo',
        existingPanes: [],
        sessionProjectRoot: '/session',
        sessionConfigPath: '/session/.psyche/psyche.config.json',
        persistReopenedPane: persist,
      }),
    ]);

    expect([first.pane.slug, second.pane.slug].sort()).toEqual([
      'reopen-me',
      'reopen-me-2',
    ]);
    expect(reserveCrashSafePaneSlugMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionProjectRoot: '/session',
        projectRoot: '/repo',
        operation: 'reopen-worktree',
      }),
    );
  });

  it('waits for a launched cleanup and does not edit a removed worktree', async () => {
    const worktreePath = '/repo/.psyche/worktrees/reopen-me';
    let rejectReservation!: (error: Error) => void;
    const cleanupReservation = new Promise<never>((_resolve, reject) => {
      rejectReservation = reject;
    });

    try {
      beginWorktreeReuseReservationMock.mockImplementationOnce(() => cleanupReservation);
      const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
      const reopenPromise = reopenWorktree({
        slug: 'reopen-me',
        worktreePath,
        projectRoot: '/repo',
        existingPanes: [],
        sessionProjectRoot: '/repo',
        sessionConfigPath: '/repo/.psyche/psyche.config.json',
        persistReopenedPane: persistReopenedPaneMock,
      });

      await Promise.resolve();
      expect(readWorktreeMetadataMock).not.toHaveBeenCalled();
      expect(atomicWriteJsonSyncMock).not.toHaveBeenCalled();
      expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();

      rejectReservation(new Error(`Worktree is no longer available for reuse at ${worktreePath}`));
      await expect(reopenPromise).rejects.toThrow('no longer available for reuse');
      expect(readWorktreeMetadataMock).not.toHaveBeenCalled();
      expect(atomicWriteJsonSyncMock).not.toHaveBeenCalled();
      expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();
    } finally {
      beginWorktreeReuseReservationMock.mockReset();
    }
  });

  it('kills an unpersisted reopened pane before releasing its reuse reservation', async () => {
    const order: string[] = [];
    persistReopenedPaneMock.mockRejectedValueOnce(new Error('config unavailable'));
    tmuxServiceMock.killPane.mockImplementationOnce(async () => {
      order.push('pane-killed');
    });
    beginWorktreeReuseReservationMock.mockImplementationOnce(async (
      worktreePath: string,
    ) => ({
      canonicalWorktreePath: worktreePath,
      retain: () => {},
      complete: async () => {
        order.push('lease-released');
      },
      cancel: async () => {
        order.push('lease-released');
      },
    }));
    tmuxServiceMock.probePanePresence
      .mockResolvedValueOnce('present')
      .mockResolvedValueOnce('absent');

    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
    await expect(reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    })).rejects.toThrow(/Failed to persist reopened pane/);

    expect(tmuxServiceMock.killPane).toHaveBeenCalledWith('%1');
    expect(order).toEqual(['pane-killed', 'lease-released']);
    expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalledWith(
      '%1',
      expect.stringContaining('codex')
    );
  });

  it('retains a recovery record when pane teardown is uncertain after a kill failure', async () => {
    const order: string[] = [];
    persistReopenedPaneMock.mockRejectedValueOnce(new Error('config unavailable'));
    tmuxServiceMock.killPane.mockRejectedValueOnce(new Error('tmux refused'));
    tmuxServiceMock.probePanePresence
      .mockResolvedValueOnce('present')
      .mockResolvedValueOnce('unknown');
    ensureProjectPaneConfigPaneMock.mockImplementationOnce(async () => {
      order.push('recovery-persisted');
    });
    beginWorktreeReuseReservationMock.mockImplementationOnce(async (
      worktreePath: string,
    ) => ({
      canonicalWorktreePath: worktreePath,
      retain: () => {},
      complete: async () => {
        order.push('lease-completed');
      },
      cancel: async () => {
        order.push('lease-released');
      },
    }));

    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
    await expect(reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
      persistReopenedPane: persistReopenedPaneMock,
    })).rejects.toThrow(/pane teardown is unknown/);

    expect(ensureProjectPaneConfigPaneMock).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ paneId: '%1', worktreePath: '/repo/.psyche/worktrees/reopen-me' }),
    );
    expect(order).toEqual(['recovery-persisted', 'lease-released']);
    expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalledWith(
      '%1',
      expect.stringContaining('codex'),
    );
  });
});
