import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0' })),
}));

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getCurrentSessionNameSync: vi.fn(() => 'psyche-test'),
  paneExists: vi.fn(async () => true),
  setSessionOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%1'));
const setupSidebarLayoutMock = vi.hoisted(() => vi.fn(() => '%1'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const getInstalledAgentsMock = vi.hoisted(() => vi.fn(async () => ['claude', 'codex']));
const filterEnabledAgentsMock = vi.hoisted(() => vi.fn((agents: string[]) => agents));
const destroyWelcomePaneCoordinatedMock = vi.hoisted(() => vi.fn());
const acquireWorktreeReuseLeaseMock = vi.hoisted(() => vi.fn());
const atomicWriteJsonSyncMock = vi.hoisted(() => vi.fn());
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
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enabledAgents: ['claude', 'codex'],
      enableAutopilotByDefault: false,
    })),
  })),
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
      acquireWorktreeReuseLease: acquireWorktreeReuseLeaseMock,
    })),
  },
}));

describe('reopenWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));
    readWorktreeMetadataMock.mockReturnValue({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      branchName: 'feature/reopen-me',
    });
    acquireWorktreeReuseLeaseMock.mockImplementation(async (worktreePath: string) => ({
      canonicalWorktreePath: worktreePath,
      release: vi.fn(),
    }));
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
    });

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%1',
      expect.stringMatching(
        /^export PSYCHE_PANE_ID='psyche-\d+'; export PSYCHE_TMUX_PANE_ID='%1'; codex --enable codex_hooks resume --last --dangerously-bypass-approvals-and-sandbox$/
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
    });

    expect(result.pane.projectName).toBe('Renamed Repo');
  });

  it('acquires a reuse lease before persisting a reopened worktree pane', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.psyche/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.psyche/psyche.config.json',
    });

    expect(acquireWorktreeReuseLeaseMock).toHaveBeenCalledWith(
      '/repo/.psyche/worktrees/reopen-me'
    );
  });

  it('waits for a launched cleanup and does not edit a removed worktree', async () => {
    const worktreePath = '/repo/.psyche/worktrees/reopen-me';
    let rejectLease!: (error: Error) => void;
    const cleanupLease = new Promise<never>((_resolve, reject) => {
      rejectLease = reject;
    });

    try {
      acquireWorktreeReuseLeaseMock.mockImplementationOnce(() => cleanupLease);
      const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
      const reopenPromise = reopenWorktree({
        slug: 'reopen-me',
        worktreePath,
        projectRoot: '/repo',
        existingPanes: [],
        sessionProjectRoot: '/repo',
        sessionConfigPath: '/repo/.psyche/psyche.config.json',
      });

      await Promise.resolve();
      expect(readWorktreeMetadataMock).not.toHaveBeenCalled();
      expect(atomicWriteJsonSyncMock).not.toHaveBeenCalled();
      expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();

      rejectLease(new Error(`Worktree is no longer available for reuse at ${worktreePath}`));
      await expect(reopenPromise).rejects.toThrow('no longer available for reuse');
      expect(readWorktreeMetadataMock).not.toHaveBeenCalled();
      expect(atomicWriteJsonSyncMock).not.toHaveBeenCalled();
      expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();
    } finally {
      acquireWorktreeReuseLeaseMock.mockReset();
    }
  });
});
