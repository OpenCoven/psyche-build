import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

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
const persistExactMock = vi.hoisted(() => vi.fn());
const beginReservationMock = vi.hoisted(() => vi.fn());
const capturePaneInsertionMock = vi.hoisted(() => vi.fn(async () => undefined));
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => tmuxService },
}));
vi.mock('../src/utils/tmux.js', () => ({
  enforceControlPaneSize: vi.fn(async () => {}),
  ensurePaneBorderStatusForCurrentSession: vi.fn(),
  splitPane: splitPaneMock,
}));
vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
}));
vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(function SettingsManager() { return {
    getSettings: () => ({ permissionMode: 'plan' }),
  }; }),
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
vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: () => ({
      beginWorktreeReuseReservation: beginReservationMock,
    }),
  },
}));
vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  compareAndRemoveProjectPaneConfigPaneIdentities: vi.fn(),
  ensureProjectPaneConfigPane: vi.fn(),
  projectPaneConfigPath: (root: string) => `${root}/.psyche/psyche.config.json`,
  readProjectPaneConfig: vi.fn(async () => ({ controlPaneId: '%0', panes: [] })),
}));
vi.mock('../src/constants/timing.js', () => ({
  TMUX_LAYOUT_APPLY_DELAY: 0,
  TMUX_SPLIT_DELAY: 0,
}));

describe('conflict resolution pane transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginReservationMock.mockResolvedValue({
      canonicalWorktreePath: '/repo/.psyche/worktrees/feature',
      retain: vi.fn(),
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });
    tmuxService.paneExists.mockResolvedValue(true);
    tmuxService.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'test-tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$test',
    });
    tmuxService.sendShellCommand.mockResolvedValue(undefined);
    tmuxService.sendTmuxKeys.mockResolvedValue(undefined);
    tmuxService.selectPane.mockResolvedValue(undefined);
  });

  it('persists the exact conflict pane before issuing merge or agent commands', async () => {
    const order: string[] = [];
    const { createConflictResolutionPane } = await import(
      '../src/utils/conflictResolutionPane.js'
    );
    (tmuxService.sendShellCommand as any).mockImplementation(async (
      _paneId: string,
      command: string,
    ) => {
      order.push(`command:${command}`);
    });

    const pane = await createConflictResolutionPane({
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/repo/.psyche/worktrees/feature',
      sessionProjectRoot: '/repo',
      projectName: 'repo',
      existingPanes: [] as PsychePane[],
      agent: 'opencode',
      persistConflictPane: async (record) => {
        order.push(`persist:${record.id}:${record.paneId}`);
        persistExactMock(record);
      },
    });

    const firstMergeCommand = order.findIndex((entry) => entry.startsWith('command:git merge'));
    expect(order[0]).toBe('persist:conflict-pane-id:%9');
    expect(firstMergeCommand).toBeGreaterThan(0);
    expect(persistExactMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'conflict-pane-id',
      paneId: '%9',
      worktreePath: '/repo/.psyche/worktrees/feature',
    }));
    expect(pane.worktreePath).toBe('/repo/.psyche/worktrees/feature');
    expect(beginReservationMock).toHaveBeenCalledWith(
      '/repo/.psyche/worktrees/feature',
      '/repo',
    );
  });
});
