import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeQueueItem } from '../../src/actions/merge/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { PsychePane } from '../../src/types.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { createWorktreePane, mockTmuxServerIdentity } from '../fixtures/mockPanes.js';

const createConflictResolutionPaneMock = vi.hoisted(() => vi.fn());
const mergeWorktreeIntoMainMock = vi.hoisted(() => vi.fn());
const tearDownPaneWithVerificationMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const monitoredConflict = vi.hoisted(() => ({
  onResolved: undefined as undefined | (() => Promise<void> | void),
}));
const restartedTmuxServerIdentity = {
  ...mockTmuxServerIdentity,
  pid: mockTmuxServerIdentity.pid + 1,
  processStartIdentity: `${mockTmuxServerIdentity.processStartIdentity}-restarted`,
  sessionId: '$test-restarted',
};
const tmuxServiceMock = vi.hoisted(() => ({
  getServerIdentity: vi.fn(() => mockTmuxServerIdentity),
  killPane: vi.fn(async () => {}),
  probePanePresence: vi.fn(async () => 'present'),
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  filterEnabledAgents: vi.fn(() => ['claude']),
  getInstalledAgents: vi.fn(async () => ['claude']),
}));
vi.mock('../../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: () => ({ enabledAgents: ['claude'] }),
  })),
}));
vi.mock('../../src/utils/agentLaunch.js', () => ({
  getAgentDescription: vi.fn(() => 'Claude'),
  getAgentLabel: vi.fn(() => 'Claude'),
  isAgentName: vi.fn(() => true),
}));
vi.mock('../../src/utils/worktreeDiscovery.js', () => ({
  getWorktreeDisplayLabel: vi.fn((worktree: { repoName: string }) => worktree.repoName),
}));
vi.mock('../../src/utils/conflictResolutionPane.js', () => ({
  createConflictResolutionPane: createConflictResolutionPaneMock,
}));
vi.mock('../../src/utils/conflictMonitor.js', () => ({
  startConflictMonitoring: vi.fn((options: { onResolved: () => Promise<void> | void }) => {
    monitoredConflict.onResolved = options.onResolved;
    return () => {};
  }),
}));
vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));
vi.mock('../../src/utils/paneTeardown.js', () => ({
  tearDownPaneWithVerification: tearDownPaneWithVerificationMock,
}));
vi.mock('../../src/utils/mergeExecution.js', () => ({
  mergeWorktreeIntoMain: mergeWorktreeIntoMainMock,
}));
vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: triggerHookMock,
}));

describe('executeMultiMerge conflict cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitoredConflict.onResolved = undefined;
    tmuxServiceMock.getServerIdentity.mockReturnValue(mockTmuxServerIdentity);
    tmuxServiceMock.killPane.mockResolvedValue(undefined);
    tmuxServiceMock.probePanePresence.mockResolvedValue('present');
    tearDownPaneWithVerificationMock.mockImplementation(async (options: {
      probe?: () => Promise<'present' | 'absent' | 'unknown'> | 'present' | 'absent' | 'unknown';
      kill?: () => Promise<void> | void;
    }) => {
      const presence = await options.probe?.();
      if (presence && presence !== 'present') {
        return { presence };
      }
      await options.kill?.();
      return { presence: 'absent' };
    });
    mergeWorktreeIntoMainMock.mockReturnValue({ success: true });
  });

  it('removes the exact conflict pane identity before continuing the queue', async () => {
    const pane = createWorktreePane({
      id: 'psyche-root',
      slug: 'root-feature',
      paneId: '%1',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/root-feature',
    });
    const conflictPane = createWorktreePane({
      id: 'conflict-pane-id',
      slug: 'merge-child-into-main',
      paneId: '%9',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/child-feature',
      tmuxServerIdentity: mockTmuxServerIdentity,
    });
    createConflictResolutionPaneMock.mockResolvedValue(conflictPane);

    const queue: MergeQueueItem[] = [{
      worktree: {
        worktreePath: '/repo/.psyche/worktrees/child-feature',
        parentRepoPath: '/repo',
        repoName: 'child-repo',
        branch: 'child-feature',
        mainBranch: 'main',
        isRoot: false,
        relativePath: 'packages/child-repo',
        depth: 1,
      },
      validation: {
        canMerge: false,
        mainBranch: 'main',
        worktreeBranch: 'child-feature',
        issues: [{
          type: 'merge_conflict',
          message: 'conflicts detected',
          files: ['src/conflict.ts'],
          canAutoResolve: true,
        }],
      },
      status: 'pending',
    }];
    const onActionResult = vi.fn(async () => {});
    const removePaneIdentitiesFromConfigImpl:
      NonNullable<ActionContext['removePaneIdentitiesFromConfig']> = async (
      _identities,
      beforeRemove,
    ) => {
      await beforeRemove?.([pane, conflictPane], [conflictPane]);
      return [pane];
    };
    const removePaneIdentitiesFromConfig = vi.fn(removePaneIdentitiesFromConfigImpl);
    const context = createMockContext([pane], {
      projectName: 'Repo',
      onActionResult,
      removePaneIdentitiesFromConfig:
        removePaneIdentitiesFromConfig as ActionContext['removePaneIdentitiesFromConfig'],
    });
    const { executeMultiMerge } = await import(
      '../../src/actions/merge/multiMergeOrchestrator.js'
    );

    const confirmation = await executeMultiMerge(pane, context, queue);
    expect(confirmation).toMatchObject({
      type: 'confirm',
      title: 'Multi-Repository Merge',
    });

    const conflictChoice = await confirmation.onConfirm!();
    expect(conflictChoice).toMatchObject({
      type: 'choice',
    });

    const navigation = await conflictChoice.onSelect!('ai_merge');
    expect(navigation).toMatchObject({
      type: 'navigation',
      title: 'Conflict Resolution Started',
      targetPaneId: conflictPane.id,
    });

    await monitoredConflict.onResolved?.();

    expect(removePaneIdentitiesFromConfig).toHaveBeenCalledWith(
      [{
        id: conflictPane.id,
        paneId: conflictPane.paneId,
        tmuxServerIdentity: conflictPane.tmuxServerIdentity,
      }],
      expect.any(Function),
    );
    expect(mergeWorktreeIntoMainMock).toHaveBeenCalledWith(
      '/repo',
      'child-feature',
    );
    expect(triggerHookMock).toHaveBeenCalledWith(
      'post_merge',
      '/repo',
      pane,
      expect.objectContaining({
        PSYCHE_TARGET_BRANCH: 'main',
        PSYCHE_WORKTREE_PATH: '/repo/.psyche/worktrees/child-feature',
        PSYCHE_REPO_NAME: 'child-repo',
      }),
    );
    expect(onActionResult).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Multi-Merge Complete',
    }));
  });

  it('does not kill or remove a same-pane replacement after tmux restarts', async () => {
    const pane = createWorktreePane({
      id: 'psyche-root',
      slug: 'root-feature',
      paneId: '%1',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/root-feature',
    });
    const conflictPane = createWorktreePane({
      id: 'conflict-pane-id',
      slug: 'merge-child-into-main',
      paneId: '%9',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/child-feature',
      tmuxServerIdentity: mockTmuxServerIdentity,
    });
    createConflictResolutionPaneMock.mockResolvedValue(conflictPane);
    tmuxServiceMock.getServerIdentity.mockReturnValue(restartedTmuxServerIdentity);

    const queue: MergeQueueItem[] = [{
      worktree: {
        worktreePath: '/repo/.psyche/worktrees/child-feature',
        parentRepoPath: '/repo',
        repoName: 'child-repo',
        branch: 'child-feature',
        mainBranch: 'main',
        isRoot: false,
        relativePath: 'packages/child-repo',
        depth: 1,
      },
      validation: {
        canMerge: false,
        mainBranch: 'main',
        worktreeBranch: 'child-feature',
        issues: [{
          type: 'merge_conflict',
          message: 'conflicts detected',
          files: ['src/conflict.ts'],
          canAutoResolve: true,
        }],
      },
      status: 'pending',
    }];
    const removedPaneIds: string[] = [];
    const onActionResult = vi.fn(async () => {});
    const removePaneIdentitiesFromConfigImpl:
      NonNullable<ActionContext['removePaneIdentitiesFromConfig']> = async (
      _identities,
      beforeRemove,
    ) => {
      await beforeRemove?.([pane, conflictPane], [conflictPane]);
      removedPaneIds.push(conflictPane.id);
      return [pane];
    };
    const removePaneIdentitiesFromConfig = vi.fn(removePaneIdentitiesFromConfigImpl);
    const context = createMockContext([pane], {
      projectName: 'Repo',
      onActionResult,
      removePaneIdentitiesFromConfig:
        removePaneIdentitiesFromConfig as ActionContext['removePaneIdentitiesFromConfig'],
    });
    const { executeMultiMerge } = await import(
      '../../src/actions/merge/multiMergeOrchestrator.js'
    );

    const confirmation = await executeMultiMerge(pane, context, queue);
    const conflictChoice = await confirmation.onConfirm!();
    await conflictChoice.onSelect!('ai_merge');
    await monitoredConflict.onResolved?.();

    expect(removePaneIdentitiesFromConfig).toHaveBeenCalledWith(
      [{
        id: conflictPane.id,
        paneId: conflictPane.paneId,
        tmuxServerIdentity: conflictPane.tmuxServerIdentity,
      }],
      expect.any(Function),
    );
    expect(removedPaneIds).toEqual([]);
    expect(tmuxServiceMock.killPane).not.toHaveBeenCalled();
    expect(mergeWorktreeIntoMainMock).not.toHaveBeenCalled();
    expect(triggerHookMock).not.toHaveBeenCalled();
    expect(onActionResult).not.toHaveBeenCalled();
  });
});
