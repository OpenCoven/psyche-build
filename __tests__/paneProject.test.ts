import { describe, it, expect } from 'vitest';
import { deriveProjectRootFromWorktreePath, getPaneProjectName, getPaneProjectRoot } from '../src/utils/paneProject.js';
import type { PsychePane } from '../src/types.js';

describe('paneProject helpers', () => {
  const fallbackRoot = '/workspace/root-a';

  it('uses pane metadata root when available', () => {
    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-a',
      prompt: 'test',
      paneId: '%1',
      projectRoot: '/workspace/root-b',
    };

    expect(getPaneProjectRoot(pane, fallbackRoot)).toBe('/workspace/root-b');
  });

  it('derives root from worktree path when metadata is missing', () => {
    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-a',
      prompt: 'test',
      paneId: '%1',
      worktreePath: '/workspace/root-c/.psyche/worktrees/feature-a',
    };

    expect(getPaneProjectRoot(pane, fallbackRoot)).toBe('/workspace/root-c');
    expect(deriveProjectRootFromWorktreePath(pane.worktreePath)).toBe('/workspace/root-c');
  });

  it('falls back to session project root', () => {
    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-a',
      prompt: 'test',
      paneId: '%1',
    };

    expect(getPaneProjectRoot(pane, fallbackRoot)).toBe(fallbackRoot);
  });

  it('resolves project display names', () => {
    const namedPane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature-a',
      prompt: 'test',
      paneId: '%1',
      projectName: 'project-z',
      projectRoot: '/workspace/project-z',
    };
    const derivedNamePane: PsychePane = {
      id: 'psyche-2',
      slug: 'feature-b',
      prompt: 'test',
      paneId: '%2',
      worktreePath: '/workspace/project-y/.psyche/worktrees/feature-b',
    };

    expect(getPaneProjectName(namedPane, fallbackRoot, 'fallback')).toBe('project-z');
    expect(getPaneProjectName(derivedNamePane, fallbackRoot, 'fallback')).toBe('project-y');
  });
});
