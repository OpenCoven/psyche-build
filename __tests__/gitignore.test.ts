import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePsycheRuntimeIgnored } from '../src/utils/gitignore.js';

describe('ensurePsycheRuntimeIgnored', () => {
  it('adds the canonical .psyche* entry to .gitignore', async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'psyche-gitignore-'));

    try {
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/');

      const result = ensurePsycheRuntimeIgnored(repo);

      expect(result.addedEntries).toEqual(['.psyche*']);
      expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe(
        'node_modules/\n.psyche*\n'
      );
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });

  it('adds .psyche* when only one runtime path is already covered', async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'psyche-gitignore-'));

    try {
      fs.writeFileSync(path.join(repo, '.gitignore'), '.psyche/\n');

      const result = ensurePsycheRuntimeIgnored(repo);

      expect(result.addedEntries).toEqual(['.psyche*']);
      expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('.psyche/\n.psyche*\n');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });

  it('is idempotent when .psyche* already exists', async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'psyche-gitignore-'));

    try {
      fs.writeFileSync(path.join(repo, '.gitignore'), '.psyche*\n');

      const result = ensurePsycheRuntimeIgnored(repo);

      expect(result.addedEntries).toEqual([]);
      expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('.psyche*\n');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });

  it('does not append .psyche* when existing rules already cover runtime paths', async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'psyche-gitignore-'));

    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, '.gitignore'), '.psyche/\n.psyche-hooks/\n');

      const result = ensurePsycheRuntimeIgnored(repo);

      expect(result.addedEntries).toEqual([]);
      expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('.psyche/\n.psyche-hooks/\n');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });

  it('can be applied inside a freshly-created pane worktree', async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'psyche-gitignore-repo-'));
    const worktreePath = path.join(repo, '.psyche', 'worktrees', 'pane-a');

    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test repo\n');
      execSync('git add README.md', { cwd: repo, stdio: 'pipe' });
      execSync('git -c user.name=Psyche -c user.email=psyche@example.com -c commit.gpgsign=false commit -m init', {
        cwd: repo,
        stdio: 'pipe',
      });

      // Mirrors psyche startup: the parent checkout may have local ignore edits
      // that a brand-new git worktree does not inherit from HEAD.
      fs.writeFileSync(path.join(repo, '.gitignore'), '.psyche*\n');
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      execSync(`git worktree add "${worktreePath}" -b pane-a`, { cwd: repo, stdio: 'pipe' });

      expect(fs.existsSync(path.join(worktreePath, '.gitignore'))).toBe(false);

      const result = ensurePsycheRuntimeIgnored(worktreePath);

      expect(result.addedEntries).toEqual(['.psyche*']);
      expect(fs.readFileSync(path.join(worktreePath, '.gitignore'), 'utf8')).toBe('.psyche*\n');
    } finally {
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repo, stdio: 'pipe' });
      } catch {}
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });
});
