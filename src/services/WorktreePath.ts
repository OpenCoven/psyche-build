import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves symlinks in the deepest existing ancestor while retaining any
 * planned path suffix. This gives a stable identity before a worktree exists.
 */
export function canonicalizePathWithExistingAncestor(value: string): string {
  const unresolvedSegments: string[] = [];
  let candidate = path.resolve(value);

  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...unresolvedSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return path.resolve(value);
      }
      unresolvedSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
