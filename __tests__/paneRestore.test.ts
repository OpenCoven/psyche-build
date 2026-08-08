import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  setPaneTitle: vi.fn(async () => {}),
  sendKeys: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  paneExists: vi.fn(async () => true),
  probePanePresence: vi.fn(async () => 'present'),
  killPane: vi.fn(async () => {}),
  getServerIdentity: vi.fn(),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%9'));
const beginWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const replaceProjectPaneConfigPaneIdentityMock = vi.hoisted(() => vi.fn());
const mutateProjectPaneConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  splitPane: splitPaneMock,
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      beginWorktreeReuseReservation: beginWorktreeReuseReservationMock,
    })),
  },
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  mutateProjectPaneConfig: mutateProjectPaneConfigMock,
  projectPaneConfigPath: (projectRoot: string) => `${projectRoot}/.psyche/psyche.config.json`,
  replaceProjectPaneConfigPaneIdentity: replaceProjectPaneConfigPaneIdentityMock,
}));

describe('pane restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitPaneMock.mockReturnValue('%9');
    tmuxServiceMock.paneExists.mockResolvedValue(true);
    tmuxServiceMock.probePanePresence.mockResolvedValue('present');
    tmuxServiceMock.killPane.mockResolvedValue(undefined);
    tmuxServiceMock.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    });
    replaceProjectPaneConfigPaneIdentityMock.mockImplementation(async (
      _projectRoot: string,
      _expected: unknown,
      replacement: PsychePane,
    ) => ({ result: replacement }));
    beginWorktreeReuseReservationMock.mockImplementation(async (
      worktreePath: string,
    ) => ({
      canonicalWorktreePath: worktreePath,
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }));
  });

  it('resumes restored worktree panes with their original agent command', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');

    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-codex',
      prompt: 'fix the failing tests',
      paneId: '%2',
      worktreePath: '/repo/.psyche/worktrees/feature-codex',
      projectRoot: '/repo',
      agent: 'codex',
      permissionMode: 'bypassPermissions',
    };

    await recreateMissingPanes([pane], '/repo/.psyche/psyche.config.json');

    expect(replaceProjectPaneConfigPaneIdentityMock).toHaveBeenCalledWith(
      '/repo',
      { id: 'psyche-1', paneId: '%2' },
      expect.objectContaining({
        id: 'psyche-1',
        paneId: '%9',
        tmuxServerIdentity: expect.objectContaining({
          pid: 4242,
          processStartIdentity: 'tmux-server-start',
        }),
        worktreePath: '/repo/.psyche/worktrees/feature-codex',
      }),
    );
    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%9',
      expect.stringContaining(
        "export PSYCHE_PANE_ID='psyche-1'; export PSYCHE_TMUX_PANE_ID='%9'; codex --enable codex_hooks resume --last --dangerously-bypass-approvals-and-sandbox"
      )
    );
    expect(tmuxServiceMock.sendTmuxKeys).toHaveBeenCalledWith('%9', 'Enter');
  });

  it('retains destructive protection when stale-pane recovery cannot persist', async () => {
    const complete = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    beginWorktreeReuseReservationMock.mockResolvedValueOnce({
      canonicalWorktreePath: '/repo/.psyche/worktrees/feature-codex',
      complete,
      cancel,
    });
    replaceProjectPaneConfigPaneIdentityMock.mockRejectedValue(
      new Error('config disk unavailable'),
    );
    tmuxServiceMock.probePanePresence.mockResolvedValue('unknown');

    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    await recreateMissingPanes([{
      id: 'psyche-1',
      slug: 'feature-codex',
      prompt: 'fix the failing tests',
      paneId: '%2',
      worktreePath: '/repo/.psyche/worktrees/feature-codex',
      projectRoot: '/repo',
      agent: 'codex',
    }], '/repo/.psyche/psyche.config.json');

    expect(tmuxServiceMock.killPane).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();
  });

  it('does not retain old-generation background IDs in the restored in-memory pane', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-codex',
      prompt: 'fix the failing tests',
      paneId: '%2',
      worktreePath: '/repo/.psyche/worktrees/feature-codex',
      projectRoot: '/repo',
      tmuxServerIdentity: {
        pid: 111,
        processStartIdentity: 'old-server-start',
      },
      testPaneId: '%old-test',
      testWindowId: '@old-test',
      devPaneId: '%old-dev',
      devWindowId: '@old-dev',
      backgroundWindowRecoveries: [{
        type: 'test',
        paneId: '%old-recovery',
        windowId: '@old-recovery',
        reason: 'old server',
      }],
    };
    replaceProjectPaneConfigPaneIdentityMock.mockImplementationOnce(async (
      _projectRoot: string,
      _expected: unknown,
      replacement: PsychePane,
    ) => {
      const result = { ...replacement };
      delete result.testPaneId;
      delete result.testWindowId;
      delete result.devPaneId;
      delete result.devWindowId;
      delete result.backgroundWindowRecoveries;
      return { result };
    });

    await recreateMissingPanes([pane], '/repo/.psyche/psyche.config.json');

    expect(pane).toMatchObject({
      paneId: '%9',
      tmuxServerIdentity: expect.objectContaining({
        pid: 4242,
        processStartIdentity: 'tmux-server-start',
      }),
    });
    expect(pane).not.toHaveProperty('testPaneId');
    expect(pane).not.toHaveProperty('testWindowId');
    expect(pane).not.toHaveProperty('devPaneId');
    expect(pane).not.toHaveProperty('devWindowId');
    expect(pane).not.toHaveProperty('backgroundWindowRecoveries');
  });

  it('does not kill a reused pane ID after tmux restarts during restoration rollback', async () => {
    const cancel = vi.fn(async () => {});
    beginWorktreeReuseReservationMock.mockResolvedValueOnce({
      canonicalWorktreePath: '/repo/.psyche/worktrees/feature-codex',
      complete: vi.fn(async () => {}),
      cancel,
    });
    replaceProjectPaneConfigPaneIdentityMock.mockRejectedValue(
      new Error('config disk unavailable'),
    );
    const allocationGeneration = {
      pid: 4242,
      processStartIdentity: 'allocation-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    };
    const restartedGeneration = {
      pid: 5252,
      processStartIdentity: 'replacement-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$2',
    };
    tmuxServiceMock.getServerIdentity
      .mockReset()
      .mockReturnValueOnce(allocationGeneration)
      .mockReturnValue(restartedGeneration);

    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    await recreateMissingPanes([{
      id: 'psyche-1',
      slug: 'feature-codex',
      prompt: 'fix the failing tests',
      paneId: '%2',
      worktreePath: '/repo/.psyche/worktrees/feature-codex',
      projectRoot: '/repo',
      agent: 'codex',
    }], '/repo/.psyche/psyche.config.json');

    expect(tmuxServiceMock.killPane).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
