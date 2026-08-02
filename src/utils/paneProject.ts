import path from 'path';
import type { PsychePane } from '../types.js';

const WORKTREE_PATH_PATTERN = /[\\\/]\.psyche[\\\/]worktrees[\\\/][^\\\/]+$/;

/**
 * Derive repository root from a psyche worktree path.
 * Example: /repo/.psyche/worktrees/feature-a -> /repo
 */
export function deriveProjectRootFromWorktreePath(worktreePath?: string): string | undefined {
  if (!worktreePath) return undefined;
  if (!WORKTREE_PATH_PATTERN.test(worktreePath)) return undefined;
  return worktreePath.replace(WORKTREE_PATH_PATTERN, '');
}

/**
 * Resolve a pane's project root using pane metadata first, then worktree path,
 * then the session project root as fallback.
 */
export function getPaneProjectRoot(
  pane: PsychePane,
  fallbackProjectRoot: string
): string {
  const fromPane = pane.projectRoot?.trim();
  if (fromPane) return fromPane;

  const fromWorktree = deriveProjectRootFromWorktreePath(pane.worktreePath);
  if (fromWorktree) return fromWorktree;

  return fallbackProjectRoot;
}

/**
 * Resolve a display name for a pane's project.
 */
export function getPaneProjectName(
  pane: PsychePane,
  fallbackProjectRoot: string,
  fallbackProjectName?: string
): string {
  const fromPane = pane.projectName?.trim();
  if (fromPane) return fromPane;

  const root = getPaneProjectRoot(pane, fallbackProjectRoot);
  const basename = path.basename(root);
  if (basename) return basename;

  return fallbackProjectName || 'project';
}
