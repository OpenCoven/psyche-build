/**
 * OPEN_IN_EDITOR Action - Open worktree in external editor
 */

import { execSync } from 'child_process';
import type { PsychePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';

export function getDefaultEditor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'xed' : 'code';
}

/**
 * Open worktree in external editor
 */
export async function openInEditor(
  pane: PsychePane,
  context: ActionContext,
  params?: { editor?: string }
): Promise<ActionResult> {
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree to open',
      dismissable: true,
    };
  }

  const editor = params?.editor || process.env.EDITOR || getDefaultEditor();

  try {
    execSync(`${editor} "${pane.worktreePath}"`, { stdio: 'pipe' });

    return {
      type: 'success',
      message: `Opened in ${editor}`,
      dismissable: true,
    };
  } catch (error) {
    return {
      type: 'error',
      message: `Failed to open in editor: ${error}`,
      dismissable: true,
    };
  }
}
