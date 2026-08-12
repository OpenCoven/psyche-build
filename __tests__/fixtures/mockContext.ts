/**
 * Mock ActionContext for testing
 */

import type { PsychePane } from '../../src/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import { mockTmuxServerIdentity } from './mockPanes.js';

export function createMockContext(
  panes: PsychePane[] = [],
  overrides?: Partial<ActionContext>
): ActionContext {
  let context!: ActionContext;
  context = {
    panes,
    sessionName: 'test-session',
    projectName: 'test-project',
    savePanes: async (
      newPanes: PsychePane[],
      _previousPanes: readonly PsychePane[],
    ) => {
      // Mock implementation - in real tests, you can spy on this
      context.panes = newPanes;
    },
    onPaneUpdate: undefined,
    onPaneRemove: undefined,
    getTmuxServerIdentity: () => mockTmuxServerIdentity,
    ...overrides,
  };

  context.removePaneFromConfig ??= async (paneId: string) => {
    const nextPanes = context.panes.filter((pane) => pane.id !== paneId);
    await context.savePanes(nextPanes, context.panes);
    context.panes = nextPanes;
    return nextPanes;
  };
  context.removePanesFromConfig ??= async (paneIds: Iterable<string>) => {
    const ids = new Set(paneIds);
    const nextPanes = context.panes.filter((pane) => !ids.has(pane.id));
    await context.savePanes(nextPanes, context.panes);
    context.panes = nextPanes;
    return nextPanes;
  };
  context.removePaneIdentitiesFromConfig ??= async (identities, beforeRemove) => {
    const expected = Array.from(identities);
    for (const identity of expected) {
      const current = context.panes.find((pane) => pane.id === identity.id);
      if (!current || current.paneId !== identity.paneId) {
        throw new Error(`Pane identity conflict for ${identity.id}`);
      }
    }
    await beforeRemove?.();
    const ids = new Set(expected.map((identity) => identity.id));
    const nextPanes = context.panes.filter((pane) => !ids.has(pane.id));
    await context.savePanes(nextPanes, context.panes);
    context.panes = nextPanes;
    return nextPanes;
  };

  return context;
}
