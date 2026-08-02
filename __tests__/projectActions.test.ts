import path from 'path';
import { describe, expect, it } from 'vitest';
import type { PsychePane, SidebarProject } from '../src/types.js';
import {
  buildProjectActionLayout,
  buildVisualNavigationRows,
  resolveSelectionAfterPaneClose,
} from '../src/utils/projectActions.js';

const repo = (name: string) => path.resolve(`/${name}`);

function pane(id: string, slug: string, projectRoot: string): PsychePane {
  return {
    id,
    slug,
    prompt: `prompt-${slug}`,
    paneId: `%${id.replace('psyche-', '')}`,
    projectRoot,
  };
}

describe('projectActions', () => {
  it('adds remove-project only for empty non-root sidebar projects', () => {
    const panes: PsychePane[] = [
      pane('psyche-1', 'main-pane', repo('repo-main')),
      pane('psyche-2', 'aux-pane', repo('repo-aux')),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: repo('repo-main'), projectName: 'repo-main' },
      { projectRoot: repo('repo-empty'), projectName: 'repo-empty' },
      { projectRoot: repo('repo-aux'), projectName: 'repo-aux' },
    ];

    const layout = buildProjectActionLayout(
      panes,
      sidebarProjects,
      repo('repo-main'),
      'repo-main'
    );

    expect(layout.multiProjectMode).toBe(true);
    expect(
      layout.actionItems
        .filter((action) => action.kind === 'remove-project')
        .map((action) => action.projectRoot)
    ).toEqual([repo('repo-empty')]);
  });

  it('adds action rows to navigation for empty projects', () => {
    const layout = buildProjectActionLayout(
      [],
      [
        { projectRoot: repo('repo-main'), projectName: 'repo-main' },
        { projectRoot: repo('repo-empty'), projectName: 'repo-empty' },
      ],
      repo('repo-main'),
      'repo-main'
    );

    expect(buildVisualNavigationRows(layout)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
  });

  it('selects the next pane down in the same project after closing a pane', () => {
    const panes: PsychePane[] = [
      pane('psyche-1', 'main-pane', repo('repo-main')),
      pane('psyche-2', 'aux-one', repo('repo-aux')),
      pane('psyche-3', 'aux-two', repo('repo-aux')),
      pane('psyche-4', 'main-two', repo('repo-main')),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: repo('repo-main'), projectName: 'repo-main' },
      { projectRoot: repo('repo-aux'), projectName: 'repo-aux' },
    ];

    const selection = resolveSelectionAfterPaneClose(
      panes,
      '%2',
      sidebarProjects,
      repo('repo-main'),
      'repo-main'
    );

    expect(selection?.selectedIndex).toBe(1);
    expect(selection?.pane?.slug).toBe('aux-two');
  });

  it('selects the project new-agent action when closing the last pane in that project', () => {
    const panes: PsychePane[] = [
      pane('psyche-1', 'main-pane', repo('repo-main')),
      pane('psyche-2', 'aux-one', repo('repo-aux')),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: repo('repo-main'), projectName: 'repo-main' },
      { projectRoot: repo('repo-aux'), projectName: 'repo-aux' },
    ];

    const selection = resolveSelectionAfterPaneClose(
      panes,
      '%2',
      sidebarProjects,
      repo('repo-main'),
      'repo-main'
    );

    expect(selection?.pane).toBeUndefined();
    expect(selection?.action?.kind).toBe('new-agent');
    expect(selection?.action?.projectRoot).toBe(repo('repo-aux'));
    expect(selection?.selectedIndex).toBe(3);
  });
});
