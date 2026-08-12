import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMobileInspection,
  MobileInspectionError,
} from '../../src/services/bridge/mobileInspection.js';
import { MAX_PREVIEW_BYTES } from '../../src/utils/fileBrowser.js';

describe('mobile inspection', () => {
  let fixtureRoot: string;
  let repositoryRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'psyche-mobile-inspection-'));
    repositoryRoot = path.join(fixtureRoot, 'repository');
    outsideRoot = path.join(fixtureRoot, 'outside');
    mkdirSync(path.join(repositoryRoot, 'nested'), { recursive: true });
    mkdirSync(outsideRoot);

    writeFileSync(path.join(repositoryRoot, 'nested', 'changed.txt'), 'before\n');
    writeFileSync(path.join(repositoryRoot, 'nested', 'deleted.txt'), 'deleted contents\n');
    mkdirSync(path.join(repositoryRoot, 'node_modules', 'tracked-package'), { recursive: true });
    writeFileSync(
      path.join(repositoryRoot, 'node_modules', 'tracked-package', 'index.js'),
      'module.exports = {};\n',
    );
    writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret\n');

    git(['init']);
    git(['config', 'user.name', 'Psyche Test']);
    git(['config', 'user.email', 'psyche@example.test']);
    git(['add', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);

    writeFileSync(path.join(repositoryRoot, 'nested', 'changed.txt'), 'after\n');
    unlinkSync(path.join(repositoryRoot, 'nested', 'deleted.txt'));
    writeFileSync(path.join(repositoryRoot, 'nested', 'untracked.txt'), 'untracked\n');
    symlinkSync(outsideRoot, path.join(repositoryRoot, 'escape'), 'dir');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  }

  it.each([
    ['parent traversal', '../outside/secret.txt'],
    ['absolute escape', () => path.join(outsideRoot, 'secret.txt')],
    ['symlink escape', 'escape/secret.txt'],
  ])('rejects %s with a typed error', async (_label, requestedPath) => {
    const inspection = createMobileInspection();
    const relativePath = typeof requestedPath === 'function'
      ? requestedPath()
      : requestedPath;

    await expect(inspection.readFile({
      root: repositoryRoot,
      relativePath,
    })).rejects.toEqual(expect.objectContaining({
      name: 'MobileInspectionError',
      code: 'path_outside_root',
    }));
  });

  it('reads valid nested files with a bounded preview', async () => {
    const inspection = createMobileInspection({ maxPreviewBytes: 4 });

    await expect(inspection.readFile({
      root: repositoryRoot,
      relativePath: 'nested/changed.txt',
    })).resolves.toEqual({
      text: 'afte',
      truncated: true,
    });
  });

  it('allows valid names that begin with two dots', async () => {
    writeFileSync(path.join(repositoryRoot, '..notes.txt'), 'notes\n');

    await expect(createMobileInspection().readFile({
      root: repositoryRoot,
      relativePath: '..notes.txt',
    })).resolves.toEqual({
      text: 'notes\n',
      truncated: false,
    });
  });

  it('lists tracked, deleted, and untracked files through the existing snapshot utility', async () => {
    const inspection = createMobileInspection();
    const snapshot = await inspection.list(repositoryRoot);

    expect(snapshot.rootPath).toBe(realpathSync(repositoryRoot));
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nested/changed.txt', exists: true, statusLabel: 'M' }),
      expect.objectContaining({ path: 'nested/deleted.txt', exists: false, statusLabel: 'D' }),
      expect.objectContaining({ path: 'nested/untracked.txt', exists: true, statusLabel: '??' }),
    ]));
    expect(snapshot.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'node_modules/tracked-package/index.js' }),
    ]));
  });

  it('uses the existing file-browser preview cap by default', async () => {
    const relativePath = 'nested/oversized.txt';
    writeFileSync(
      path.join(repositoryRoot, relativePath),
      Buffer.alloc(MAX_PREVIEW_BYTES + 1, 'x'),
    );

    const preview = await createMobileInspection().readFile({
      root: repositoryRoot,
      relativePath,
    });

    expect(Buffer.byteLength(preview.text)).toBe(MAX_PREVIEW_BYTES);
    expect(preview.truncated).toBe(true);
  });

  it.each([
    ['deleted tracked file', 'nested/deleted.txt', ' D', '-deleted contents'],
    ['untracked file', 'nested/untracked.txt', '??', '+untracked'],
  ])('returns a plain diff for a %s', async (_label, relativePath, statusCode, expectedLine) => {
    const inspection = createMobileInspection();
    const diff = await inspection.diff(repositoryRoot, relativePath, statusCode);

    expect(diff).toContain(expectedLine);
    expect(diff).not.toMatch(/\u001b\[/);
  });

  it('exposes a stable typed error class', () => {
    const error = new MobileInspectionError('path_outside_root', 'outside');
    expect(error).toMatchObject({
      name: 'MobileInspectionError',
      code: 'path_outside_root',
      message: 'outside',
    });
  });
});
