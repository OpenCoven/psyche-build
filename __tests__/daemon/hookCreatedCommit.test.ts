import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnBridgePane } from '../../src/daemon/bridge.js';

const roots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(path.join(process.cwd(), '.psyche-hook-ownership-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--allow-empty', '-m', 'initial',
    ],
    { cwd: root },
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('hook-created worktree commit ownership', () => {
  it('preserves a real post-checkout hook commit after a later daemon failure', async () => {
    const root = createRepository();
    const startingOid = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const hookPath = path.join(root, '.git', 'hooks', 'post-checkout');
    writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        'if [ "$3" = "1" ]; then',
        '  git -c user.email=test@example.com -c user.name=Test -c commit.gpgsign=false commit --allow-empty -m post-checkout-hook',
        'fi',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(hookPath, 0o755);

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'hook-owned',
        cwd: root,
        agent: 'coven-code',
        prompt: 'trigger hook ownership',
        title: 'hook-owned',
      },
      {
        tmuxSessionExists: () => true,
        createTmuxPane: () => {
          throw new Error('later tmux allocation failed');
        },
        sendTmuxCommand: () => {},
      },
    )).rejects.toThrow(/preserved hook-modified worktree and branch/);

    const worktreePath = path.join(root, '.psyche', 'worktrees', 'hook-owned');
    expect(() => execFileSync(
      'git',
      ['-C', root, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' },
    )).not.toThrow();
    expect(() => execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8' },
    )).not.toThrow();
    const hookOid = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--verify', 'refs/heads/psyche/hook-owned'],
      { encoding: 'utf8' },
    ).trim();
    expect(hookOid).not.toBe(startingOid);
    expect(
      execFileSync(
        'git',
        ['-C', worktreePath, 'log', '-1', '--format=%s'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('post-checkout-hook');
    const markerDirectory = path.join(
      root,
      '.psyche',
      'runtime',
      'worktree-recovery',
    );
    expect(readdirSync(markerDirectory).filter((entry) => entry.endsWith('.json'))).not.toEqual([]);
  });
});
