import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  probePanePresence: vi.fn(async () => 'unknown'),
  killPane: vi.fn(async () => {}),
}));
const executeMergeMock = vi.hoisted(() => vi.fn());
const removePaneIdentitiesFromConfigMock = vi.hoisted(() => vi.fn(async () => []));

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
});
