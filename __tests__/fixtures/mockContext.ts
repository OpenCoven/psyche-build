/**
 * Mock ActionContext for testing
 */

import type { PsychePane } from '../../src/types.js';
import type { ActionContext } from '../../src/actions/types.js';

export function createMockContext(
  panes: PsychePane[] = [],
  overrides?: Partial<ActionContext>
): ActionContext {
  const context: ActionContext = {
    panes,
    sessionName: 'test-session',
    projectName: 'test-project',
    savePanes: async (newPanes: PsychePane[]) => {
      // Mock implementation - in real tests, you can spy on this
      panes.splice(0, panes.length, ...newPanes);
    },
    onPaneUpdate: undefined,
    onPaneRemove: undefined,
    ...overrides,
  };

  context.removePaneFromConfig ??= async (paneId: string) => {
    const nextPanes = context.panes.filter((pane) => pane.id !== paneId);
    await context.savePanes(nextPanes);
    context.panes = nextPanes;
    return nextPanes;
  };
  context.removePanesFromConfig ??= async (paneIds: Iterable<string>) => {
    const ids = new Set(paneIds);
    const nextPanes = context.panes.filter((pane) => !ids.has(pane.id));
    await context.savePanes(nextPanes);
    context.panes = nextPanes;
    return nextPanes;
  };

  return context;
}
