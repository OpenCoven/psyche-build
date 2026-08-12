/**
 * COPY_PATH Action - Copy worktree path to clipboard
 */

import type { PsychePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import { runProcess } from '../../utils/runProcess.js';

/**
 * Copy worktree path to clipboard
 */
export async function copyPath(
  pane: PsychePane,
  context: ActionContext
): Promise<ActionResult> {
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree path',
      dismissable: true,
    };
  }

  try {
    // Try to copy to clipboard (works on macOS)
    await runProcess('pbcopy', { input: pane.worktreePath });

    return {
      type: 'success',
      message: `Path copied: ${pane.worktreePath}`,
      dismissable: true,
    };
  } catch {
    // If clipboard copy fails, just show the path
    return {
      type: 'info',
      message: `Path: ${pane.worktreePath}`,
      dismissable: true,
    };
  }
}
