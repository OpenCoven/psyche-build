import path from 'path';
import { describe, it, expect } from 'vitest';
import { groupPanesByProject } from '../src/utils/paneGrouping.js';
import type { PsychePane } from '../src/types.js';

const repo = (name: string) => path.resolve(`/${name}`);

function pane(id: string, slug: string, projectRoot?: string): PsychePane {
  return {
    id,
    slug,
    prompt: `prompt-${slug}`,
    paneId: `%${id.replace('psyche-', '')}`,
    projectRoot,
  };
}

describe('groupPanesByProject', () => {
  it('groups panes by project while preserving pane order', () => {
    const panes: PsychePane[] = [
      pane('psyche-1', 'a1', repo('repo-a')),
      pane('psyche-2', 'a2', repo('repo-a')),
      pane('psyche-3', 'b1', repo('repo-b')),
      pane('psyche-4', 'a3', repo('repo-a')),
    ];

    const groups = groupPanesByProject(panes, repo('repo-main'), 'repo-main');

    expect(groups).toHaveLength(3);
    expect(groups[0].projectRoot).toBe(repo('repo-main'));
    expect(groups[0].panes).toHaveLength(0);

    expect(groups[1].projectRoot).toBe(repo('repo-a'));
    expect(groups[1].panes.map((entry) => entry.pane.slug)).toEqual(['a1', 'a2', 'a3']);
    expect(groups[1].panes.map((entry) => entry.index)).toEqual([0, 1, 3]);

    expect(groups[2].projectRoot).toBe(repo('repo-b'));
    expect(groups[2].panes.map((entry) => entry.pane.slug)).toEqual(['b1']);
    expect(groups[2].panes.map((entry) => entry.index)).toEqual([2]);
  });

  it('falls back to session project root for panes without metadata', () => {
    const panes: PsychePane[] = [pane('psyche-1', 'main-pane')];

    const groups = groupPanesByProject(panes, repo('repo-main'), 'repo-main');
    expect(groups).toHaveLength(1);
    expect(groups[0].projectRoot).toBe(repo('repo-main'));
    expect(groups[0].projectName).toBe('repo-main');
  });

  it('includes empty sidebar projects and keeps sidebar ordering stable', () => {
    const panes: PsychePane[] = [
      pane('psyche-1', 'main-pane', repo('repo-main')),
      pane('psyche-2', 'aux-pane', repo('repo-aux')),
    ];

    const groups = groupPanesByProject(
      panes,
      repo('repo-main'),
      'repo-main',
      [
        { projectRoot: repo('repo-main'), projectName: 'repo-main' },
        { projectRoot: repo('repo-empty'), projectName: 'repo-empty' },
        { projectRoot: repo('repo-aux'), projectName: 'repo-aux' },
      ]
    );

    expect(groups.map((group) => group.projectRoot)).toEqual([
      repo('repo-main'),
      repo('repo-empty'),
      repo('repo-aux'),
    ]);
    expect(groups[1].panes).toHaveLength(0);
    expect(groups[2].panes.map((entry) => entry.pane.slug)).toEqual(['aux-pane']);
  });
});
