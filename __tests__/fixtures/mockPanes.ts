/**
 * Mock PsychePane fixtures for testing
 */

import type { PsychePane } from '../../src/types.js';

export function createMockPane(overrides?: Partial<PsychePane>): PsychePane {
  return {
    id: 'psyche-1',
    slug: 'test-pane',
    prompt: 'test prompt',
    paneId: '%42',
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
