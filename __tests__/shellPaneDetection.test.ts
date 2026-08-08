import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());
const setPaneTitleMock = vi.hoisted(() => vi.fn(async () => {}));
const resolveProjectRootFromPathMock = vi.hoisted(() => vi.fn());
const resolveGitWorktreeRootFromPathMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => ({
      setPaneTitle: setPaneTitleMock,
      getServerIdentity: () => ({
        pid: 4242,
        processStartIdentity: 'test-tmux-server-start',
        socketPath: '/tmux.sock',
        sessionId: '$test',
      }),
    })),
  },
}));

vi.mock('../src/utils/projectRoot.js', () => ({
  resolveProjectRootFromPath: resolveProjectRootFromPathMock,
  resolveGitWorktreeRootFromPath: resolveGitWorktreeRootFromPathMock,
}));

describe('shell pane worktree references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('#{pane_current_command}')) {
        return 'zsh\n';
      }
      if (command.includes('#{pane_current_path}')) {
        return '/repo/.psyche/worktrees/feature/src/components\n';
      }
      return '';
    });
    resolveProjectRootFromPathMock.mockReturnValue({
      projectRoot: '/repo',
      projectName: 'repo',
      requestedPath: '/repo/.psyche/worktrees/feature/src/components',
    });
    resolveGitWorktreeRootFromPathMock.mockReturnValue(
      '/repo/.psyche/worktrees/feature',
    );
  });

  it('persists the effective worktree root for a shell started in a subdirectory', async () => {
    const { createShellPane } = await import('../src/utils/shellPaneDetection.js');
    const pane = await createShellPane('%9', 1);

    expect(resolveGitWorktreeRootFromPathMock).toHaveBeenCalledWith(
      '/repo/.psyche/worktrees/feature/src/components',
      '/repo/.psyche/worktrees/feature/src/components',
    );
    expect(pane).toMatchObject({
      paneId: '%9',
      type: 'shell',
      cwdReference: '/repo/.psyche/worktrees/feature',
      projectRoot: '/repo',
    });
    expect(pane.id).toMatch(/^psyche-[\da-f-]+$/);
  });

  it('keeps shell display suffixes unique after pane IDs became UUIDs', async () => {
    const { getNextPsycheId } = await import('../src/utils/shellPaneDetection.js');

    expect(getNextPsycheId([{
      id: 'psyche-550e8400-e29b-41d4-a716-446655440000',
      slug: 'shell-4',
      prompt: '',
      paneId: '%4',
      type: 'shell',
    }])).toBe(5);
  });
});
