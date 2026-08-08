import { describe, expect, it } from 'vitest';
import {
  readRepositoryContext,
  type RawGitRemote,
  type ReadOnlyCommandRunner,
} from '../src/github/repositoryContext.js';

interface RunnerResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: { cwd: string; allowFailure?: boolean };
}

function createRunner(script: Record<string, RunnerResult>) {
  const calls: RecordedCall[] = [];

  const runner: ReadOnlyCommandRunner = {
    async run(command, args, options) {
      calls.push({
        command,
        args: [...args],
        options: { ...options },
      });

      const entry = script[[command, ...args].join('\0')];
      if (!entry) {
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      }

      if (entry.error) {
        throw entry.error;
      }

      return {
        stdout: entry.stdout ?? '',
        stderr: entry.stderr ?? '',
        exitCode: entry.exitCode ?? 0,
      };
    },
  };

  return { runner, calls };
}

function expectRawRemotes(actual: readonly RawGitRemote[], expected: readonly RawGitRemote[]) {
  expect(actual).toEqual(expected);
}

describe('readRepositoryContext', () => {
  it('reads the current branch, configured upstream remote, and ordered remotes with raw diagnostics', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner, calls } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'upstream\n' },
      'git\0remote': { stdout: 'origin\nupstream\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'git@github.com:OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0upstream': { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context).toEqual({
      worktreePath,
      branch: 'feat/pr',
      upstreamRemote: 'upstream',
      rawRemotes: [
        { name: 'upstream', url: 'https://github.com/OpenCoven/psyche-build.git' },
        { name: 'origin', url: 'git@github.com:OpenCoven/psyche-build.git' },
      ],
      remotes: [
        {
          name: 'upstream',
          rawUrl: 'https://github.com/OpenCoven/psyche-build.git',
          repository: {
            host: 'github.com',
            owner: 'OpenCoven',
            name: 'psyche-build',
            url: 'https://github.com/OpenCoven/psyche-build',
          },
        },
        {
          name: 'origin',
          rawUrl: 'git@github.com:OpenCoven/psyche-build.git',
          repository: {
            host: 'github.com',
            owner: 'OpenCoven',
            name: 'psyche-build',
            url: 'https://github.com/OpenCoven/psyche-build',
          },
        },
      ],
    });

    expect(calls).toEqual([
      {
        command: 'git',
        args: ['branch', '--show-current'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['config', 'branch.feat/pr.remote'],
        options: { cwd: worktreePath, allowFailure: true },
      },
      {
        command: 'git',
        args: ['remote'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', '--', 'origin'],
        options: { cwd: worktreePath, allowFailure: true },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', '--', 'upstream'],
        options: { cwd: worktreePath, allowFailure: true },
      },
    ]);
  });

  it('preserves non-ASCII branch and remote names exactly when reading Git output', async () => {
    const nbsp = '\u00a0';
    const branch = `feat${nbsp}pr`;
    const remoteName = `origi${nbsp}n`;
    const worktreePath = '/repo/.worktrees/pr';
    const { runner, calls } = createRunner({
      'git\0branch\0--show-current': { stdout: `${branch}\n` },
      [`git\0config\0branch.${branch}.remote`]: { stdout: `${remoteName}\r\n` },
      'git\0remote': { stdout: `origin\n${remoteName}\r\n` },
      'git\0remote\0get-url\0--\0origin': { stdout: 'https://github.com/OpenCoven/origin-repo.git\n' },
      [`git\0remote\0get-url\0--\0${remoteName}`]: { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.branch).toBe(branch);
    expect(context.upstreamRemote).toBe(remoteName);
    expect(context.rawRemotes).toEqual([
      { name: remoteName, url: 'https://github.com/OpenCoven/psyche-build.git' },
      { name: 'origin', url: 'https://github.com/OpenCoven/origin-repo.git' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: remoteName,
        rawUrl: 'https://github.com/OpenCoven/psyche-build.git',
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://github.com/OpenCoven/psyche-build',
        },
      },
      {
        name: 'origin',
        rawUrl: 'https://github.com/OpenCoven/origin-repo.git',
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'origin-repo',
          url: 'https://github.com/OpenCoven/origin-repo',
        },
      },
    ]);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['branch', '--show-current'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['config', `branch.${branch}.remote`],
        options: { cwd: worktreePath, allowFailure: true },
      },
      {
        command: 'git',
        args: ['remote'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', '--', 'origin'],
        options: { cwd: worktreePath, allowFailure: true },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', '--', remoteName],
        options: { cwd: worktreePath, allowFailure: true },
      },
    ]);
  });

  it('treats detached HEAD as branchless and never queries branch config', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner, calls } = createRunner({
      'git\0branch\0--show-current': { stdout: '\n' },
      'git\0remote': { stdout: 'origin\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.branch).toBeNull();
    expect(context.upstreamRemote).toBeNull();
    expectRawRemotes(context.rawRemotes, [
      { name: 'origin', url: 'https://github.com/OpenCoven/psyche-build.git' },
    ]);
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'branch --show-current',
      'remote',
      'remote get-url -- origin',
    ]);
  });

  it('falls back to origin ordering, preserves unsupported raw remotes, and skips only failing get-url calls', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner, calls } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': { stdout: 'mirror\norigin\nbroken\norigin\n' },
      'git\0remote\0get-url\0--\0mirror': { stdout: 'file:///Users/buns/mirror\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0broken': { stdout: '', exitCode: 2 },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.branch).toBe('feat/pr');
    expect(context.upstreamRemote).toBeNull();
    expectRawRemotes(context.rawRemotes, [
      { name: 'origin', url: 'https://github.com/OpenCoven/psyche-build.git' },
      { name: 'mirror', url: 'file:///Users/buns/mirror' },
    ]);
    expect(context.remotes.map((remote) => remote.name)).toEqual(['origin']);
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'branch --show-current',
      'config branch.feat/pr.remote',
      'remote',
      'remote get-url -- mirror',
      'remote get-url -- origin',
      'remote get-url -- broken',
    ]);
  });

  it('canonicalizes repository identity for gh hostnames while ignoring transport and default web ports', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'upstream\n' },
      'git\0remote': { stdout: 'origin\nupstream\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'ssh://git@ghe.example.test:2222/Open%43oven/psyche%2Dbuild%2Egit\n' },
      'git\0remote\0get-url\0--\0upstream': { stdout: 'https://ghe.example.test:443/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([
      { name: 'upstream', url: 'https://ghe.example.test:443/OpenCoven/psyche-build.git' },
      { name: 'origin', url: 'ssh://git@ghe.example.test:2222/Open%43oven/psyche%2Dbuild%2Egit' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: 'upstream',
        rawUrl: 'https://ghe.example.test:443/OpenCoven/psyche-build.git',
        repository: {
          host: 'ghe.example.test',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://ghe.example.test/OpenCoven/psyche-build',
        },
      },
      {
        name: 'origin',
        rawUrl: 'ssh://git@ghe.example.test:2222/Open%43oven/psyche%2Dbuild%2Egit',
        repository: {
          host: 'ghe.example.test',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://ghe.example.test/OpenCoven/psyche-build',
        },
      },
    ]);
  });

  it('skips malformed get-url output with ASCII padding instead of trimming it into validity', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'origin\n' },
      'git\0remote': { stdout: 'origin\nupstream\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: ' git@github.com:OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0upstream': { stdout: 'https://github.com/OpenCoven/psyche-build.git \n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([]);
    expect(context.remotes).toEqual([]);
  });

  it('rejects ASCII-padded required Git names instead of trimming them', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': { stdout: 'origin \n' },
    });

    await expect(readRepositoryContext(worktreePath, runner)).rejects.toThrowError(
      new Error('unable to read Git repository context'),
    );
  });

  it('uses an option terminator when reading option-like remote names', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner, calls } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '-foo\n' },
      'git\0remote': { stdout: '-foo\n' },
      'git\0remote\0get-url\0--\0-foo': { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([
      { name: '-foo', url: 'https://github.com/OpenCoven/psyche-build.git' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: '-foo',
        rawUrl: 'https://github.com/OpenCoven/psyche-build.git',
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://github.com/OpenCoven/psyche-build',
        },
      },
    ]);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['branch', '--show-current'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['config', 'branch.feat/pr.remote'],
        options: { cwd: worktreePath, allowFailure: true },
      },
      {
        command: 'git',
        args: ['remote'],
        options: { cwd: worktreePath },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', '--', '-foo'],
        options: { cwd: worktreePath, allowFailure: true },
      },
    ]);
  });

  it('throws a fixed error when required git reads fail or return malformed branch output', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const branchFailure = createRunner({
      'git\0branch\0--show-current': { stdout: '', exitCode: 1, stderr: 'fatal: not a git repository' },
    });

    await expect(readRepositoryContext(worktreePath, branchFailure.runner)).rejects.toThrowError(
      new Error('unable to read Git repository context'),
    );

    const malformedBranch = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\nsecond-line\n' },
      'git\0remote': { stdout: '' },
    });

    await expect(readRepositoryContext(worktreePath, malformedBranch.runner)).rejects.toThrowError(
      new Error('unable to read Git repository context'),
    );

    const remoteFailure = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'origin\n' },
      'git\0remote': { error: new Error('EACCES') },
    });

    await expect(readRepositoryContext(worktreePath, remoteFailure.runner)).rejects.toThrowError(
      new Error('unable to read Git repository context'),
    );
  });
});
