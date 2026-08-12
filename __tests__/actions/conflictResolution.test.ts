import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../src/actions/types.js';
import type { PsychePane } from '../../src/types.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { createWorktreePane, mockTmuxServerIdentity } from '../fixtures/mockPanes.js';

const createConflictResolutionPaneMock = vi.hoisted(() => vi.fn());
const executeMergeMock = vi.hoisted(() => vi.fn());
const tearDownPaneWithVerificationMock = vi.hoisted(() => vi.fn());
const monitoredConflict = vi.hoisted(() => ({
  onResolved: undefined as undefined | (() => Promise<void> | void),
}));
const restartedTmuxServerIdentity = {
  ...mockTmuxServerIdentity,
  pid: mockTmuxServerIdentity.pid + 1,
  processStartIdentity: `${mockTmuxServerIdentity.processStartIdentity}-restarted`,
  sessionId: '$test-restarted',
};
const stateManagerMock = vi.hoisted(() => ({
  getPanes: vi.fn(() => [] as PsychePane[]),
}));
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
vi.mock('../../src/utils/git.js', () => ({
  getPaneBranchName: vi.fn((pane) => pane.branchName || pane.slug),
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
vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => stateManagerMock),
  },
}));
vi.mock('../../src/actions/merge/mergeExecution.js', () => ({
  executeMerge: executeMergeMock,
}));

describe('createConflictResolutionPaneForMerge', () => {
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
    executeMergeMock.mockResolvedValue({
      type: 'confirm',
      title: 'Merge Worktree',
      message: 'done',
    });
  });

  it('removes the exact conflict pane identity before re-running the merge', async () => {
    const pane = createWorktreePane({
      id: 'psyche-source',
      slug: 'feature',
      branchName: 'feature',
      paneId: '%1',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/feature',
    });
    const conflictPane = createWorktreePane({
      id: 'conflict-pane-id',
      slug: 'merge-feature-into-main',
      paneId: '%9',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/feature',
      tmuxServerIdentity: mockTmuxServerIdentity,
    });
    createConflictResolutionPaneMock.mockResolvedValue(conflictPane);
    stateManagerMock.getPanes.mockReturnValue([pane, conflictPane]);

    const onPaneUpdate = vi.fn();
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
      onPaneUpdate,
      onActionResult,
      removePaneIdentitiesFromConfig:
        removePaneIdentitiesFromConfig as ActionContext['removePaneIdentitiesFromConfig'],
    });
    const { createConflictResolutionPaneForMerge } = await import(
      '../../src/actions/merge/conflictResolution.js'
    );

    const result = await createConflictResolutionPaneForMerge(
      pane,
      context,
      'main',
      '/repo',
    );

    expect(result).toMatchObject({
      type: 'navigation',
      title: 'Conflict Resolution Pane Created',
      targetPaneId: conflictPane.id,
    });
    expect(onPaneUpdate).toHaveBeenCalledWith(conflictPane);

    await monitoredConflict.onResolved?.();

    expect(removePaneIdentitiesFromConfig).toHaveBeenCalledWith(
      [{
        id: conflictPane.id,
        paneId: conflictPane.paneId,
        tmuxServerIdentity: conflictPane.tmuxServerIdentity,
      }],
      expect.any(Function),
    );
    expect(executeMergeMock).toHaveBeenCalledWith(
      pane,
      expect.objectContaining({
        panes: [pane],
      }),
      'main',
      '/repo',
      true,
    );
    expect(onActionResult).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Merge Worktree',
    }));
  });

  it('does not kill or remove a same-pane replacement after tmux restarts', async () => {
    const pane = createWorktreePane({
      id: 'psyche-source',
      slug: 'feature',
      branchName: 'feature',
      paneId: '%1',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/feature',
    });
    const conflictPane = createWorktreePane({
      id: 'conflict-pane-id',
      slug: 'merge-feature-into-main',
      paneId: '%9',
      projectRoot: '/repo',
      projectName: 'Repo',
      worktreePath: '/repo/.psyche/worktrees/feature',
      tmuxServerIdentity: mockTmuxServerIdentity,
    });
    createConflictResolutionPaneMock.mockResolvedValue(conflictPane);
    stateManagerMock.getPanes.mockReturnValue([pane, conflictPane]);
    tmuxServiceMock.getServerIdentity.mockReturnValue(restartedTmuxServerIdentity);

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
    const { createConflictResolutionPaneForMerge } = await import(
      '../../src/actions/merge/conflictResolution.js'
    );

    await createConflictResolutionPaneForMerge(
      pane,
      context,
      'main',
      '/repo',
    );
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
    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(onActionResult).not.toHaveBeenCalled();
  });
});
