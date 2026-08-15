import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeProjectRoot,
  normalizeCanonicalProjectIdentity,
} from '../src/control/projectIdentity.js';

it('maps a symlink alias to one canonical project root', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'psyche-project-'));
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'dir');
  expect(await canonicalizeProjectRoot(alias))
    .toBe(await canonicalizeProjectRoot(real));
});

describe('control project identity parity', () => {
  it.each([
    ['darwin', '/tmp/Cafe\u0301', '/tmp/Café', 'c5d313be878d0ecbc02e'],
    ['win32', '\\\\?\\C:\\Users\\Val\\Repo', 'C:\\Users\\Val\\Repo', 'c256e15c0de5a4be0851'],
    ['win32', '\\\\?\\UNC\\Server\\Share\\Repo', '\\\\Server\\Share\\Repo', 'a9c53493f2ac537428dd'],
  ] as const)('normalizes %s identity and preserves its golden endpoint hash', (
    platform, raw, expected, expectedHash,
  ) => {
    const identity = normalizeCanonicalProjectIdentity(raw, platform);
    expect(identity).toBe(expected);
    expect(createHash('sha256').update(identity).digest('hex').slice(0, 20)).toBe(expectedHash);
  });
});
