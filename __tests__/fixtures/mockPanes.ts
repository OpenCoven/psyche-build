/**
 * Mock PsychePane fixtures for testing
 */

import type { PsychePane } from '../../src/types.js';

export const mockTmuxServerIdentity = {
  pid: 4242,
  processStartIdentity: 'test-tmux-server-start',
  socketPath: '/tmux.sock',
  sessionId: '$test',
};

export function createMockPane(overrides?: Partial<PsychePane>): PsychePane {
  return {
    id: 'psyche-1',
    slug: 'test-pane',
    prompt: 'test prompt',
    paneId: '%42',
    tmuxServerIdentity: mockTmuxServerIdentity,
    worktreePath: '/test/worktree/path',
    agent: 'claude',
    type: 'worktree',
    autopilot: false,
    ...overrides,
  };
}

export function createShellPane(overrides?: Partial<PsychePane>): PsychePane {
  return createMockPane({
    type: 'shell',
    worktreePath: undefined,
    ...overrides,
  });
}

export function createWorktreePane(overrides?: Partial<PsychePane>): PsychePane {
  return createMockPane({
    type: 'worktree',
    worktreePath: '/test/project/.psyche/worktrees/test-pane',
    ...overrides,
  });
}

export function createMultiplePanes(count: number): PsychePane[] {
  return Array.from({ length: count }, (_, i) => createMockPane({
    id: `psyche-${i + 1}`,
    slug: `test-pane-${i + 1}`,
    paneId: `%${40 + i}`,
  }));
}
