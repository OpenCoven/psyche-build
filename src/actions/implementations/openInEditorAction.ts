/**
 * OPEN_IN_EDITOR Action - Open worktree in external editor
 */

import type { PsychePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import { runProcess } from '../../utils/runProcess.js';

export function getDefaultEditor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'xed' : 'code';
}

function validateEditorExecutable(editor: string): string {
  if (
    !editor
    || editor.trim() !== editor
    || /\s/.test(editor)
    || /[`$;&|<>"']/.test(editor)
  ) {
    throw new Error(
      'Editor must be a single executable path; command strings with whitespace are not supported',
    );
  }
  return editor;
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

  try {
    const editor = validateEditorExecutable(
      params?.editor || process.env.EDITOR || getDefaultEditor(),
    );
    await runProcess(editor, { args: [pane.worktreePath] });

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
