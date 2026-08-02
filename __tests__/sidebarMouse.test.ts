import { describe, expect, it } from 'vitest';
import type { SidebarProject, PsychePane } from '../src/types.js';
import { buildProjectActionLayout } from '../src/utils/projectActions.js';
import {
  isPrimaryMousePress,
  parseSgrMouseEvent,
  resolveSidebarMouseTarget,
} from '../src/utils/sidebarMouse.js';

function pane(id: string, slug: string, projectRoot: string): PsychePane {
  return {
    id,
    slug,
    prompt: '',
    paneId: `%${id}`,
    projectRoot,
  };
}

describe('sidebarMouse', () => {
  it('parses SGR mouse press events', () => {
    const event = parseSgrMouseEvent('\x1b[<0;12;3M');

    expect(event).toEqual({
      button: 0,
      column: 12,
      row: 3,
      pressed: true,
    });
    expect(event && isPrimaryMousePress(event)).toBe(true);
  });

  it('maps project headers and pane rows to sidebar targets', () => {
    const panes = [
      pane('1', 'main-a', '/repo-main'),
      pane('2', 'api-a', '/repo-api'),
    ];
    const projects: SidebarProject[] = [
      { projectRoot: '/repo-main', projectName: 'Main' },
      { projectRoot: '/repo-api', projectName: 'API' },
    ];
    const layout = buildProjectActionLayout(
      panes,
      projects,
      '/repo-main',
      'Main'
    );

    expect(resolveSidebarMouseTarget(layout, 1, 2)?.kind).toBe('project-header');

    const firstPaneTarget = resolveSidebarMouseTarget(layout, 2, 2);
    expect(firstPaneTarget?.kind).toBe('pane');
    if (firstPaneTarget?.kind === 'pane') {
      expect(firstPaneTarget.index).toBe(0);
      expect(firstPaneTarget.pane.slug).toBe('main-a');
    }

    const secondProjectTarget = resolveSidebarMouseTarget(layout, 5, 2);
    expect(secondProjectTarget?.kind).toBe('project-header');
    if (secondProjectTarget?.kind === 'project-header') {
      expect(secondProjectTarget.projectName).toBe('API');
      expect(secondProjectTarget.selectIndex).toBe(1);
    }
  });
});
