import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlScope } from '../src/control/scope.js';

it('rejects cross-project and symlink-escape paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-scope-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'psyche-outside-'));
  await mkdir(path.join(root, 'worktree'));
  await symlink(outside, path.join(root, 'escape'), 'dir');
  const scope = await ControlScope.create(root, {
    panes: [{ paneId: '%3', cwd: path.join(root, 'worktree') }],
  });
  await expect(scope.requireContainedPath(path.join(root, 'escape')))
    .rejects.toThrow('outside the canonical project');
  await expect(scope.requireContainedPath(outside))
    .rejects.toThrow('outside the canonical project');
  expect(scope.requireOwnedPane('%3').paneId).toBe('%3');
  expect(() => scope.requireOwnedPane('%99')).toThrow('pane is not owned');
});
