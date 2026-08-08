import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  getServerIdentity: vi.fn(),
  probePanePresence: vi.fn(async (_paneId: string): Promise<'present' | 'absent' | 'unknown'> => 'unknown'),
  killPane: vi.fn(async (_paneId: string) => {}),
  probeWindowPresence: vi.fn(async (_windowId: string): Promise<'present' | 'absent' | 'unknown'> => 'unknown'),
  killWindow: vi.fn(async (_windowId: string) => {}),
}));
const executeMergeMock = vi.hoisted(() => vi.fn());
const removePaneIdentitiesFromConfigMock = vi.hoisted(() => vi.fn(async (): Promise<PsychePane[]> => []));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../../src/actions/merge/mergeExecution.js', () => ({
  executeMerge: executeMergeMock,
}));

vi.mock('../../src/actions/merge/issueHandlers/index.js', () => ({
  handleNothingToMerge: vi.fn(),
  handleMainDirty: vi.fn(),
  handleWorktreeUncommitted: vi.fn(),
  handleMergeConflict: vi.fn(),
}));

vi.mock('../../src/utils/git.js', () => ({
  getPaneBranchName: (pane: PsychePane) => pane.branchName || pane.slug,
}));

vi.mock('../../src/utils/mergeTargets.js', () => ({
  resolveMergeTarget: vi.fn(() => ({
    targetRepoPath: '/repo',
    targetBranch: 'main',
    targetLabel: 'main',
    requiresConfirmation: false,
  })),
  buildFallbackMergeMessage: vi.fn(() => 'fallback'),
}));

vi.mock('../../src/utils/paneTitle.js', () => ({
  getPaneDisplayName: (pane: PsychePane) => pane.displayName || pane.slug,
}));

vi.mock('../../src/utils/worktreeDiscovery.js', () => ({
  detectAllWorktrees: vi.fn(() => [{
    isRoot: true,
    repoName: 'repo',
    branch: 'feature',
    worktreePath: '/repo/.psyche/worktrees/feature',
    relativePath: '.',
    depth: 0,
    parentRepoPath: '/repo',
    mainBranch: 'main',
  }]),
}));

vi.mock('../../src/actions/merge/multiMergeOrchestrator.js', () => ({
  buildMergeQueue: vi.fn(async (worktrees: unknown[]) => [{
    worktree: worktrees[0],
    validation: { canMerge: true, mainBranch: 'main', issues: [] },
  }]),
  executeMultiMerge: vi.fn(),
}));

vi.mock('../../src/utils/mergeValidation.js', () => ({
  validateMerge: vi.fn(() => ({
    canMerge: true,
    mainBranch: 'main',
    issues: [],
  })),
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn(async () => {}),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

describe('merge sibling teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmuxServiceMock.probePanePresence.mockResolvedValue('unknown');
    tmuxServiceMock.killPane.mockResolvedValue(undefined);
    tmuxServiceMock.probeWindowPresence.mockResolvedValue('unknown');
    tmuxServiceMock.killWindow.mockResolvedValue(undefined);
    tmuxServiceMock.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'test-tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$test',
    });
    removePaneIdentitiesFromConfigMock.mockResolvedValue([]);
  });

  it('aborts on a timeout/unknown sibling and preserves every sibling record', async () => {
    const { mergePane } = await import('../../src/actions/implementations/mergeAction.js');
    const pane: PsychePane = {
      id: 'psyche-owner',
      slug: 'feature',
      prompt: '',
      paneId: '%1',
      worktreePath: '/repo/.psyche/worktrees/feature',
      branchName: 'feature',
    };
    const sibling: PsychePane = {
      ...pane,
      id: 'psyche-sibling',
      slug: 'feature-a2',
      paneId: '%2',
    };
    const context = {
      panes: [pane, sibling],
      sessionName: 'psyche-test',
      projectName: 'repo',
      savePanes: vi.fn(),
      removePaneIdentitiesFromConfig: removePaneIdentitiesFromConfigMock,
    };

    const confirmation = await mergePane(pane, context);
    expect(confirmation).toMatchObject({ type: 'confirm', title: 'Sibling Agents Active' });

    const result = await confirmation.onConfirm!();
    expect(result).toMatchObject({
      type: 'error',
      title: 'Sibling Pane Could Not Be Closed',
    });
    expect(result.message).toContain('retained');
    expect(tmuxServiceMock.killPane).not.toHaveBeenCalled();
    expect(removePaneIdentitiesFromConfigMock).not.toHaveBeenCalled();
    expect(executeMergeMock).not.toHaveBeenCalled();
  });

  it('verified-tears down a sibling dev window before removing its pane record', async () => {
    const { mergePane } = await import('../../src/actions/implementations/mergeAction.js');
    const pane: PsychePane = {
      id: 'psyche-owner',
      slug: 'feature',
      prompt: '',
      paneId: '%1',
      worktreePath: '/repo/.psyche/worktrees/feature',
      branchName: 'feature',
      tmuxServerIdentity: {
        pid: 4242,
        processStartIdentity: 'test-tmux-server-start',
        socketPath: '/tmux.sock',
        sessionId: '$test',
      },
    };
    const sibling: PsychePane = {
      ...pane,
      id: 'psyche-sibling',
      slug: 'feature-a2',
      paneId: '%2',
      devWindowId: '@8',
      devStatus: 'running',
    };
    let siblingPaneLive = true;
    let devWindowLive = true;
    const order: string[] = [];
    tmuxServiceMock.probePanePresence.mockImplementation(async (paneId: string) => (
      paneId === '%2' && siblingPaneLive ? 'present' : 'absent'
    ));
    tmuxServiceMock.probeWindowPresence.mockImplementation(async (windowId: string) => (
      windowId === '@8' && devWindowLive ? 'present' : 'absent'
    ));
    tmuxServiceMock.killWindow.mockImplementation(async () => {
      order.push('kill-window');
      devWindowLive = false;
    });
    tmuxServiceMock.killPane.mockImplementation(async () => {
      order.push('kill-pane');
      siblingPaneLive = false;
    });
    removePaneIdentitiesFromConfigMock.mockImplementation(async () => {
      order.push('remove-record');
      return [pane];
    });
    const context = {
      panes: [pane, sibling],
      sessionName: 'psyche-test',
      projectName: 'repo',
      savePanes: vi.fn(),
      removePaneIdentitiesFromConfig: removePaneIdentitiesFromConfigMock,
    };

    const confirmation = await mergePane(pane, context);
    const result = await confirmation.onConfirm!();

    expect(result).toMatchObject({ type: 'confirm', title: 'Merge Worktree' });
    expect(tmuxServiceMock.killWindow).toHaveBeenCalledWith('@8');
    expect(tmuxServiceMock.killPane).toHaveBeenCalledWith('%2');
    expect(order).toEqual(['kill-window', 'kill-pane', 'remove-record']);
  });
});
