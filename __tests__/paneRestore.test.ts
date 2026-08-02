import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  setPaneTitle: vi.fn(async () => {}),
  sendKeys: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%9'));

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

describe('pane restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitPaneMock.mockReturnValue('%9');
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

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%9',
      expect.stringContaining(
        "export PSYCHE_PANE_ID='psyche-1'; export PSYCHE_TMUX_PANE_ID='%9'; codex --enable codex_hooks resume --last --dangerously-bypass-approvals-and-sandbox"
      )
    );
    expect(tmuxServiceMock.sendTmuxKeys).toHaveBeenCalledWith('%9', 'Enter');
  });
});
