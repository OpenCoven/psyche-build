/**
 * TOGGLE_AUTOPILOT Action - Toggle autopilot mode for a pane
 */

import type { PsychePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';

/**
 * Toggle autopilot mode for a pane
 */
export async function toggleAutopilot(
  pane: PsychePane,
  context: ActionContext
): Promise<ActionResult> {
  try {
    const paneName = getPaneDisplayName(pane);
    // Toggle the autopilot setting
    const newAutopilotState = !pane.autopilot;

    // Update the pane
    const updatedPanes = context.panes.map(p =>
      p.id === pane.id ? { ...p, autopilot: newAutopilotState } : p
    );

    // Save the updated panes
    await context.savePanes(updatedPanes, context.panes);

    // Notify about the update
    if (context.onPaneUpdate) {
      context.onPaneUpdate({ ...pane, autopilot: newAutopilotState });
    }

    return {
      type: 'success',
      message: `Autopilot ${newAutopilotState ? 'enabled' : 'disabled'} for "${paneName}"`,
      dismissable: true,
    };
  } catch (error) {
    return {
      type: 'error',
      message: `Failed to toggle autopilot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      dismissable: true,
    };
  }
}
