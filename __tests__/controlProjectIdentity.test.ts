import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeProjectRoot } from '../src/control/projectIdentity.js';

it('maps a symlink alias to one canonical project root', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'psyche-project-'));
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'dir');
  expect(await canonicalizeProjectRoot(alias))
    .toBe(await canonicalizeProjectRoot(real));
});
