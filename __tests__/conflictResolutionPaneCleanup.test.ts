import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTmuxServerIdentity } from './fixtures/mockPanes.js';

const tmuxService = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getServerIdentity: vi.fn(),
  paneExists: vi.fn(async () => true),
  setPaneTitle: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
}));
const splitPaneMock = vi.hoisted(() => vi.fn(() => '%9'));
const beginReservationMock = vi.hoisted(() => vi.fn());
const compareAndRemoveProjectPaneConfigPaneIdentitiesMock = vi.hoisted(() => vi.fn());
const tearDownPaneWithVerificationMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => tmuxService },
}));
vi.mock('../src/utils/tmux.js', () => ({
  enforceControlPaneSize: vi.fn(async () => {}),
  ensurePaneBorderStatusForCurrentSession: vi.fn(),
  splitPane: splitPaneMock,
}));
vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: () => ({ permissionMode: 'plan' }),
  })),
}));
vi.mock('../src/utils/agentLaunch.js', () => ({
  buildAgentCommand: () => 'opencode',
  buildInitialPromptCommand: () => 'opencode --prompt',
  getAgentProcessName: () => 'opencode',
  getPromptTransport: () => 'inline',
  getSendKeysPostPasteDelayMs: () => 0,
  getSendKeysPrePrompt: () => [],
  getSendKeysReadyDelayMs: () => 0,
  getSendKeysSubmit: () => [],
}));
vi.mock('../src/utils/promptStore.js', () => ({
  buildPromptReadAndDeleteSnippet: () => 'read-prompt',
  deletePromptFile: vi.fn(async () => {}),
  writePromptFile: vi.fn(async () => {
    throw new Error('use inline prompt');
  }),
}));
vi.mock('../src/utils/paneColors.js', () => ({
  resolveProjectColorTheme: () => 'blue',
}));
vi.mock('../src/utils/paneIdentity.js', () => ({
  createPsychePaneId: () => 'conflict-pane-id',
}));
vi.mock('../src/utils/paneTeardown.js', () => ({
  tearDownPaneWithVerification: tearDownPaneWithVerificationMock,
}));
vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: () => ({
      beginWorktreeReuseReservation: beginReservationMock,
    }),
  },
}));
vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  compareAndRemoveProjectPaneConfigPaneIdentities:
    compareAndRemoveProjectPaneConfigPaneIdentitiesMock,
  ensureProjectPaneConfigPane: vi.fn(),
  projectPaneConfigPath: (root: string) => `${root}/.psyche/psyche.config.json`,
}));
vi.mock('../src/constants/timing.js', () => ({
  TMUX_LAYOUT_APPLY_DELAY: 0,
  TMUX_SPLIT_DELAY: 0,
}));

describe('conflictResolutionPane rollback cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginReservationMock.mockResolvedValue({
      canonicalWorktreePath: '/repo/.psyche/worktrees/feature',
      retain: vi.fn(),
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });
    tmuxService.paneExists.mockResolvedValue(true);
    tmuxService.getServerIdentity.mockReturnValue(mockTmuxServerIdentity);
    tmuxService.setPaneTitle.mockResolvedValue(undefined);
    tmuxService.sendShellCommand.mockResolvedValue(undefined);
    tmuxService.sendTmuxKeys.mockResolvedValue(undefined);
    tmuxService.selectPane.mockResolvedValue(undefined);
    tmuxService.killPane.mockResolvedValue(undefined);
    compareAndRemoveProjectPaneConfigPaneIdentitiesMock.mockImplementation(
      async (
        _sessionProjectRoot: string,
        _identities: unknown,
        beforeRemove?: () => Promise<void> | void,
      ) => {
        await beforeRemove?.();
      },
    );
    tearDownPaneWithVerificationMock.mockImplementation(async (options: {
      kill?: () => Promise<void> | void;
    }) => {
      await options.kill?.();
      return { presence: 'absent' };
    });
  });

  it('removes the exact persisted pane identity after launch setup fails', async () => {
    tmuxService.sendShellCommand.mockRejectedValueOnce(new Error('cwd setup failed'));
    const persistConflictPane = vi.fn(async () => {});
    const { createConflictResolutionPane } = await import(
      '../src/utils/conflictResolutionPane.js'
    );

    await expect(createConflictResolutionPane({
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/repo/.psyche/worktrees/feature',
      sessionProjectRoot: '/repo',
      projectName: 'repo',
      existingPanes: [],
      agent: 'opencode',
      persistConflictPane,
    })).rejects.toThrow('cwd setup failed');

    expect(persistConflictPane).toHaveBeenCalledWith(expect.objectContaining({
      id: 'conflict-pane-id',
      paneId: '%9',
      tmuxServerIdentity: mockTmuxServerIdentity,
    }));
    expect(compareAndRemoveProjectPaneConfigPaneIdentitiesMock).toHaveBeenCalledWith(
      '/repo',
      [{
        id: 'conflict-pane-id',
        paneId: '%9',
        tmuxServerIdentity: mockTmuxServerIdentity,
      }],
      expect.any(Function),
    );
    expect(tmuxService.killPane).toHaveBeenCalledWith('%9');
  });
});
