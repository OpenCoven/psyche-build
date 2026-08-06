import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const capturePaneInsertionMock = vi.hoisted(() => vi.fn());
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn());
const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%1'),
  getAllPaneIdsSync: vi.fn(() => ['%0', '%1']),
  getCurrentSessionNameSync: vi.fn(() => 'psyche-test'),
  setSessionOptionSync: vi.fn(),
  splitPaneSync: vi.fn(() => '%2'),
  setPaneTitle: vi.fn(async () => {}),
  resizePane: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: () => tmuxServiceMock,
  },
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
}));

vi.mock('../src/utils/promptStore.js', () => ({
  writePromptFile: vi.fn(async () => {
    throw new Error('skip prompt file');
  }),
  deletePromptFile: vi.fn(async () => {}),
  buildPromptReadAndDeleteSnippet: vi.fn(),
}));

function pane(id: string, paneId: string): PsychePane {
  return { id, slug: id, prompt: id, paneId };
}

describe('createConflictResolutionPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturePaneInsertionMock.mockResolvedValue({
      targetPaneId: 'existing',
      targetTmuxPaneId: '%1',
      direction: 'horizontal',
    });
    insertPaneIntoStoredLayoutMock.mockResolvedValue({});
    vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
      if (typeof callback === 'function') callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts the conflict agent leaf before returning it to the caller for pane persistence', async () => {
    const { createConflictResolutionPane } = await import('../src/utils/conflictResolutionPane.js');
    const existingPane = pane('existing', '%1');

    const conflictPane = await createConflictResolutionPane({
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/project/worktree',
      agent: 'coven-code',
      projectName: 'project',
      existingPanes: [existingPane],
      sessionConfigPath: '/project/.psyche/psyche.config.json',
      controlPaneId: '%0',
    });

    expect(tmuxServiceMock.splitPaneSync).toHaveBeenCalledWith({
      targetPane: '%1',
      cwd: '/project/worktree',
    });
    expect(insertPaneIntoStoredLayoutMock).toHaveBeenCalledWith({
      panesFile: '/project/.psyche/psyche.config.json',
      panes: [existingPane],
      pane: conflictPane,
      controlPaneId: '%0',
      insertion: {
        targetPaneId: 'existing',
        targetTmuxPaneId: '%1',
        direction: 'horizontal',
      },
      sidebarWidth: 40,
    });
  });
});
