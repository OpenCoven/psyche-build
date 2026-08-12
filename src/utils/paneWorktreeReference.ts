import path from 'node:path';
import { canonicalizePathWithExistingAncestor } from '../services/WorktreePath.js';

export interface PaneWorktreeReference {
  type?: unknown;
  worktreePath?: unknown;
  worktreeDir?: unknown;
  cwdReference?: unknown;
  cwd?: unknown;
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = canonicalizePathWithExistingAncestor(left);
  const normalizedRight = canonicalizePathWithExistingAncestor(right);
  return (
    normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${path.sep}`)
    || normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
  );
}

export function pathIsInsideOrEqual(parent: string, candidate: string): boolean {
  const normalizedParent = canonicalizePathWithExistingAncestor(parent);
  const normalizedCandidate = canonicalizePathWithExistingAncestor(candidate);
  return (
    normalizedParent === normalizedCandidate
    || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`)
  );
}

/**
 * Shell panes retain a directional cwd reference. A shell at the main project
 * root should not block cleanup of every child worktree, but a shell inside a
 * target worktree must keep that target active.
 */
export function paneReferencesWorktree(
  pane: PaneWorktreeReference | null | undefined,
  targetWorktreePath: string,
): boolean {
  if (!pane || typeof pane !== 'object') {
    return false;
  }

  const worktreePath = typeof pane.worktreePath === 'string'
    ? pane.worktreePath
    : typeof pane.worktreeDir === 'string'
      ? pane.worktreeDir
      : undefined;
  if (worktreePath) {
    const isShell = pane.type === 'shell';
    if (
      isShell
        ? pathIsInsideOrEqual(targetWorktreePath, worktreePath)
        : pathsOverlap(worktreePath, targetWorktreePath)
    ) {
      return true;
    }
  }

  return [pane.cwdReference, pane.cwd].some((reference) => (
    typeof reference === 'string'
    && pathIsInsideOrEqual(targetWorktreePath, reference)
  ));
}
