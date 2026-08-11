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
        { name: 'upstream', url: 'https://github.com/<redacted-path>' },
        { name: 'origin', url: 'git@github.com:<redacted-path>' },
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
    const branch = '機能-é';
    const remoteName = '遠端-é';
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
      { name: remoteName, url: 'https://github.com/<redacted-path>' },
      { name: 'origin', url: 'https://github.com/<redacted-path>' },
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

  it('rejects unsafe Unicode characters in branch and remote names', async () => {
    const unsafeCharacters = ['\u0085', '\u2028', '\u2029', '\u202e'];

    for (const unsafeCharacter of unsafeCharacters) {
      const branchWorktreePath = '/repo/.worktrees/unsafe-branch';
      const unsafeBranch = createRunner({
        'git\0branch\0--show-current': { stdout: `feat${unsafeCharacter}pr\n` },
      });

      await expect(readRepositoryContext(branchWorktreePath, unsafeBranch.runner)).rejects.toThrowError(
        new Error('unable to read Git repository context'),
      );

      const upstreamWorktreePath = '/repo/.worktrees/unsafe-upstream';
      const unsafeUpstream = createRunner({
        'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
        'git\0config\0branch.feat/pr.remote': { stdout: `origin${unsafeCharacter}\n` },
      });

      await expect(readRepositoryContext(upstreamWorktreePath, unsafeUpstream.runner)).rejects.toThrowError(
        new Error('unable to read Git repository context'),
      );
      expect(unsafeUpstream.calls.map((call) => call.args.join(' '))).toEqual([
        'branch --show-current',
        'config branch.feat/pr.remote',
      ]);

      const remoteListWorktreePath = '/repo/.worktrees/unsafe-remotes';
      const unsafeRemoteList = createRunner({
        'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
        'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
        'git\0remote': { stdout: `origin\nbad${unsafeCharacter}name\n` },
      });

      await expect(readRepositoryContext(remoteListWorktreePath, unsafeRemoteList.runner)).rejects.toThrowError(
        new Error('unable to read Git repository context'),
      );
      expect(unsafeRemoteList.calls.map((call) => call.args.join(' '))).toEqual([
        'branch --show-current',
        'config branch.feat/pr.remote',
        'remote',
      ]);
    }
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
      { name: 'origin', url: 'https://github.com/<redacted-path>' },
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
      'git\0remote\0get-url\0--\0mirror': { stdout: 'file:///Users/buns/My Repo\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'https://github.com/OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0broken': { stdout: '', exitCode: 2 },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.branch).toBe('feat/pr');
    expect(context.upstreamRemote).toBeNull();
    expectRawRemotes(context.rawRemotes, [
      { name: 'origin', url: 'https://github.com/<redacted-path>' },
      { name: 'mirror', url: 'file:///Users/buns/My Repo' },
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

  it('canonicalizes repository identity for gh hostnames while ignoring SSH transport ports', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'upstream\n' },
      'git\0remote': { stdout: 'github-port\norigin\nupstream\n' },
      'git\0remote\0get-url\0--\0github-port': { stdout: 'ssh://git@github.com:2022/OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: 'ssh://git@ghe.example.test:2222/Open%43oven/psyche%2Dbuild%2Egit\n' },
      'git\0remote\0get-url\0--\0upstream': { stdout: 'ssh://git@ssh.github.com:2023/OpenCoven/psyche-build.git\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([
      { name: 'upstream', url: 'ssh://git@github.com/<redacted-path>' },
      { name: 'origin', url: 'ssh://git@ghe.example.test/<redacted-path>' },
      { name: 'github-port', url: 'ssh://git@github.com/<redacted-path>' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: 'upstream',
        rawUrl: 'ssh://git@ssh.github.com:2023/OpenCoven/psyche-build.git',
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://github.com/OpenCoven/psyche-build',
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
      {
        name: 'github-port',
        rawUrl: 'ssh://git@github.com:2022/OpenCoven/psyche-build.git',
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://github.com/OpenCoven/psyche-build',
        },
      },
    ]);
  });

  it('skips malformed get-url output with ASCII padding or controls instead of trimming it into validity', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'origin\n' },
      'git\0remote': { stdout: 'origin\nupstream\ncontrol\nnewline\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: ' git@github.com:OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0upstream': { stdout: 'https://github.com/OpenCoven/psyche-build.git \n' },
      'git\0remote\0get-url\0--\0control': { stdout: 'file:///Users/buns/My\u0007Repo\n' },
      'git\0remote\0get-url\0--\0newline': { stdout: 'file:///Users/buns/Repo\nsecond\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([]);
    expect(context.remotes).toEqual([]);
  });

  it('sanitizes credential-bearing raw diagnostics without leaking secrets', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const malformedSchemeSecret = `https:/${'user:secret@'}github.com/o/r`;
    const parsedSchemeSecret = `https:///${'user:secret@'}github.com/o/r`;
    const parsedSshPathSecret = `ssh:///${'user:secret@'}github.com/OpenCoven/psyche-build.git`;
    const parsedGitPathSecret = `git:///${'user:secret@'}github.com/OpenCoven/psyche-build.git`;
    const nestedHelperSecret = `hg::https://${'token:secret@'}ghe.example.test/OpenCoven/psyche-build.git`;
    const gitlabSummaryUrl = 'http://gitlab.example.test/group/repo.git';
    const scpSummaryUrl = 'git@gitlab.example.test:group/nested/repo.git';
    const querySecretUrl = 'https://gitlab.example.test/group/repo.git?access_token=ghp_S3CR3T_VALUE';
    const malformedScpSecret = `git@${'token@'}github.com:o/r`;
    const maskedUserinfoUrl = 'https://******github.com/OpenCoven/psyche-build.git';
    const usernameOnlyUrl = 'https://user@github.com/OpenCoven/psyche-build.git';
    const usernamePasswordUrl = 'https://user:pass@github.com/OpenCoven/psyche-build.git';
    const unsupportedScpLike = 'gitlab.example.test:group/S3CR3T_VALUE.git';
    const malformedHostlessScp = 'git@github.com/group/S3CR3T_VALUE.git';
    const safeFileUrl = 'file:///Users/a@b/My Repo?download=1#frag';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': {
        stdout: 'masked\nauth\norigin\nscheme-bypass\nparsed-bypass\nssh-path-bypass\ngit-path-bypass\n'
          + 'scp-bypass\nfile-safe\ngitlab-summary\nscp-summary\nnested-helper\nquery-secret\n'
          + 'unsupported-scp-like\nmalformed-hostless-scp\nmasked-userinfo\nusername-only\nusername-password\n',
      },
      'git\0remote\0get-url\0--\0masked': { stdout: '******github.com/o/r.git\n' },
      'git\0remote\0get-url\0--\0auth': { stdout: `https://${'token:secret@'}github.com/OpenCoven/psyche-build.git\n` },
      'git\0remote\0get-url\0--\0origin': { stdout: 'git@github.com:OpenCoven/psyche-build.git\n' },
      'git\0remote\0get-url\0--\0scheme-bypass': { stdout: `${malformedSchemeSecret}\n` },
      'git\0remote\0get-url\0--\0parsed-bypass': { stdout: `${parsedSchemeSecret}\n` },
      'git\0remote\0get-url\0--\0ssh-path-bypass': { stdout: `${parsedSshPathSecret}\n` },
      'git\0remote\0get-url\0--\0git-path-bypass': { stdout: `${parsedGitPathSecret}\n` },
      'git\0remote\0get-url\0--\0scp-bypass': { stdout: `${malformedScpSecret}\n` },
      'git\0remote\0get-url\0--\0file-safe': { stdout: `${safeFileUrl}\n` },
      'git\0remote\0get-url\0--\0gitlab-summary': { stdout: `${gitlabSummaryUrl}\n` },
      'git\0remote\0get-url\0--\0scp-summary': { stdout: `${scpSummaryUrl}\n` },
      'git\0remote\0get-url\0--\0nested-helper': { stdout: `${nestedHelperSecret}\n` },
      'git\0remote\0get-url\0--\0query-secret': { stdout: `${querySecretUrl}\n` },
      'git\0remote\0get-url\0--\0unsupported-scp-like': { stdout: `${unsupportedScpLike}\n` },
      'git\0remote\0get-url\0--\0malformed-hostless-scp': { stdout: `${malformedHostlessScp}\n` },
      'git\0remote\0get-url\0--\0masked-userinfo': { stdout: `${maskedUserinfoUrl}\n` },
      'git\0remote\0get-url\0--\0username-only': { stdout: `${usernameOnlyUrl}\n` },
      'git\0remote\0get-url\0--\0username-password': { stdout: `${usernamePasswordUrl}\n` },
    });

    const context = await readRepositoryContext(worktreePath, runner);
    const serialized = JSON.stringify(context);
    const rawDiagnosticUrls = context.rawRemotes.map((remote) => remote.url).join('\n');

    expect(context.rawRemotes).toEqual([
      { name: 'origin', url: 'git@github.com:<redacted-path>' },
      { name: 'auth', url: '<redacted-remote-url>' },
      { name: 'file-safe', url: 'file:///Users/a@b/My Repo' },
      { name: 'git-path-bypass', url: '<redacted-remote-url>' },
      { name: 'gitlab-summary', url: 'http://gitlab.example.test/<redacted-path>' },
      { name: 'malformed-hostless-scp', url: '<redacted-remote-url>' },
      { name: 'masked', url: '<redacted-remote-url>' },
      { name: 'masked-userinfo', url: '<redacted-remote-url>' },
      { name: 'nested-helper', url: '<redacted-remote-url>' },
      { name: 'parsed-bypass', url: '<redacted-remote-url>' },
      { name: 'query-secret', url: '<redacted-remote-url>' },
      { name: 'scheme-bypass', url: '<redacted-remote-url>' },
      { name: 'scp-bypass', url: '<redacted-remote-url>' },
      { name: 'scp-summary', url: 'git@gitlab.example.test:<redacted-path>' },
      { name: 'ssh-path-bypass', url: '<redacted-remote-url>' },
      { name: 'unsupported-scp-like', url: '<redacted-remote-url>' },
      { name: 'username-only', url: '<redacted-remote-url>' },
      { name: 'username-password', url: '<redacted-remote-url>' },
    ]);
    expect(context.remotes).toEqual([
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
    ]);
    expect(serialized).not.toContain('token:secret');
    expect(serialized).not.toContain('user:secret@');
    expect(serialized).not.toContain('******github.com/o/r.git');
    expect(serialized).not.toContain('ghp_S3CR3T_VALUE');
    expect(serialized).not.toContain(malformedSchemeSecret);
    expect(serialized).not.toContain(parsedSchemeSecret);
    expect(serialized).not.toContain(parsedSshPathSecret);
    expect(serialized).not.toContain(parsedGitPathSecret);
    expect(serialized).not.toContain(nestedHelperSecret);
    expect(serialized).not.toContain(querySecretUrl);
    expect(serialized).not.toContain(scpSummaryUrl);
    expect(serialized).not.toContain(malformedScpSecret);
    expect(serialized).not.toContain(maskedUserinfoUrl);
    expect(serialized).not.toContain(usernameOnlyUrl);
    expect(serialized).not.toContain(usernamePasswordUrl);
    expect(serialized).not.toContain(unsupportedScpLike);
    expect(serialized).not.toContain(malformedHostlessScp);
    expect(rawDiagnosticUrls).not.toContain('group');
    expect(rawDiagnosticUrls).not.toContain('S3CR3T_VALUE');
  });

  it('redacts raw diagnostics for case-insensitive secret markers before GitHub normalization summaries', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const lowercaseTokenPath = 'https://github.com/org/ghp_S3CR3T_VALUE.git';
    const uppercaseTokenPath = 'https://github.com/org/GHS_SECRET_VALUE.git';
    const mixedCaseMarker = 'https://github.com/org/repo.git?AcCeSs_ToKeN=abc123';
    const mixedCaseKeyMarker = 'https://github.com/org/repo.git#SeCrEt=abc123';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': { stdout: 'lower\nupper\nmixed-query\nmixed-fragment\n' },
      'git\0remote\0get-url\0--\0lower': { stdout: `${lowercaseTokenPath}\n` },
      'git\0remote\0get-url\0--\0upper': { stdout: `${uppercaseTokenPath}\n` },
      'git\0remote\0get-url\0--\0mixed-query': { stdout: `${mixedCaseMarker}\n` },
      'git\0remote\0get-url\0--\0mixed-fragment': { stdout: `${mixedCaseKeyMarker}\n` },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([
      { name: 'lower', url: '<redacted-remote-url>' },
      { name: 'mixed-fragment', url: '<redacted-remote-url>' },
      { name: 'mixed-query', url: '<redacted-remote-url>' },
      { name: 'upper', url: '<redacted-remote-url>' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: 'lower',
        rawUrl: lowercaseTokenPath,
        repository: {
          host: 'github.com',
          owner: 'org',
          name: 'ghp_S3CR3T_VALUE',
          url: 'https://github.com/org/ghp_S3CR3T_VALUE',
        },
      },
      {
        name: 'upper',
        rawUrl: uppercaseTokenPath,
        repository: {
          host: 'github.com',
          owner: 'org',
          name: 'GHS_SECRET_VALUE',
          url: 'https://github.com/org/GHS_SECRET_VALUE',
        },
      },
    ]);
  });

  it('redacts diagnostic-only remotes with unsafe Unicode authorities across protocols', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const httpLiteral = 'http://ghe\u200b.example.test/private/repo.git';
    const httpEncoded = 'http://ghe%E2%80%8B.example.test/private/repo.git';
    const httpControl = 'http://ghe\u0085.example.test/private/repo.git';
    const sshLiteral = 'ssh://git@ghe\u2060.example.test/private/repo.git';
    const scpLiteral = 'git@ghe\ufeff.example.test:private/repo.git';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': { stdout: 'http-control\nhttp-encoded\nhttp-literal\nscp-literal\nssh-literal\n' },
      'git\0remote\0get-url\0--\0http-control': { stdout: `${httpControl}\n` },
      'git\0remote\0get-url\0--\0http-encoded': { stdout: `${httpEncoded}\n` },
      'git\0remote\0get-url\0--\0http-literal': { stdout: `${httpLiteral}\n` },
      'git\0remote\0get-url\0--\0scp-literal': { stdout: `${scpLiteral}\n` },
      'git\0remote\0get-url\0--\0ssh-literal': { stdout: `${sshLiteral}\n` },
    });

    const context = await readRepositoryContext(worktreePath, runner);
    const serialized = JSON.stringify(context);

    expect(context.rawRemotes).toEqual([
      { name: 'http-control', url: '<redacted-remote-url>' },
      { name: 'http-encoded', url: '<redacted-remote-url>' },
      { name: 'http-literal', url: '<redacted-remote-url>' },
      { name: 'scp-literal', url: '<redacted-remote-url>' },
      { name: 'ssh-literal', url: '<redacted-remote-url>' },
    ]);
    expect(context.remotes).toEqual([]);
    expect(serialized).not.toContain(httpLiteral);
    expect(serialized).not.toContain(httpEncoded);
    expect(serialized).not.toContain(httpControl);
    expect(serialized).not.toContain(sshLiteral);
    expect(serialized).not.toContain(scpLiteral);
  });

  it('keeps valid GitHub SCP diagnostics path-free without exposing repository segments', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const scpSecretPath = 'git@github.com:group/S3CR3T_VALUE.git';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: 'origin\n' },
      'git\0remote': { stdout: 'origin\n' },
      'git\0remote\0get-url\0--\0origin': { stdout: `${scpSecretPath}\n` },
    });

    const context = await readRepositoryContext(worktreePath, runner);

    expect(context.rawRemotes).toEqual([
      { name: 'origin', url: 'git@github.com:<redacted-path>' },
    ]);
    expect(context.remotes).toEqual([
      {
        name: 'origin',
        rawUrl: scpSecretPath,
        repository: {
          host: 'github.com',
          owner: 'group',
          name: 'S3CR3T_VALUE',
          url: 'https://github.com/group/S3CR3T_VALUE',
        },
      },
    ]);
    expect(context.rawRemotes[0]?.url).not.toContain('group');
    expect(context.rawRemotes[0]?.url).not.toContain('S3CR3T_VALUE');
  });

  it('redacts unsupported plain path remotes and unsafe file URL escapes', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': {
        stdout: 'relative\nabsolute\nwindows\nsafe-file\nhosted-file\nuserinfo-file\nliteral-traversal\n'
          + 'encoded-dot\nencoded-dotdot\nmixed-dotdot\nencoded-hash\nencoded-question\nencoded-percent\n'
          + 'encoded-double-encoded-slash\nencoded-newline\nencoded-tab\nencoded-backslash\nmalformed-file\n'
          + 'unc-empty-authority\nunc-extra-slash\n',
      },
      'git\0remote\0get-url\0--\0relative': { stdout: '../private/repo\n' },
      'git\0remote\0get-url\0--\0absolute': { stdout: '/Users/name/private/repo\n' },
      'git\0remote\0get-url\0--\0windows': { stdout: 'C:\\private\\repo\n' },
      'git\0remote\0get-url\0--\0safe-file': { stdout: 'file:///Users/name/My Repo?download=1#frag\n' },
      'git\0remote\0get-url\0--\0hosted-file': { stdout: 'file://server/share/private-repo\n' },
      'git\0remote\0get-url\0--\0userinfo-file': { stdout: 'file://user@server/share/private-repo\n' },
      'git\0remote\0get-url\0--\0literal-traversal': { stdout: 'file:///Users/name/../secret\n' },
      'git\0remote\0get-url\0--\0encoded-dot': { stdout: 'file:///Users/%2e/name\n' },
      'git\0remote\0get-url\0--\0encoded-dotdot': { stdout: 'file:///Users/%2E%2E/secret\n' },
      'git\0remote\0get-url\0--\0mixed-dotdot': { stdout: 'file:///Users/%2e./secret\n' },
      'git\0remote\0get-url\0--\0encoded-hash': { stdout: 'file:///Users/name/My%23Repo\n' },
      'git\0remote\0get-url\0--\0encoded-question': { stdout: 'file:///Users/name/My%3FRepo\n' },
      'git\0remote\0get-url\0--\0encoded-percent': { stdout: 'file:///Users/name/My%25Repo\n' },
      'git\0remote\0get-url\0--\0encoded-double-encoded-slash': { stdout: 'file:///Users/name/My%252FRepo\n' },
      'git\0remote\0get-url\0--\0encoded-newline': { stdout: 'file:///Users/name/My%0ARepo\n' },
      'git\0remote\0get-url\0--\0encoded-tab': { stdout: 'file:///Users/name/My%09Repo\n' },
      'git\0remote\0get-url\0--\0encoded-backslash': { stdout: 'file:///Users/name/My%5CRepo\n' },
      'git\0remote\0get-url\0--\0malformed-file': { stdout: 'file:///Users/name/My%ZZRepo\n' },
      'git\0remote\0get-url\0--\0unc-empty-authority': { stdout: 'file:////server/share/private-repo\n' },
      'git\0remote\0get-url\0--\0unc-extra-slash': { stdout: 'file://///server/share/private-repo\n' },
    });

    const context = await readRepositoryContext(worktreePath, runner);
    const rawDiagnosticUrls = context.rawRemotes.map((remote) => remote.url).join('\n');

    expect(context.rawRemotes).toEqual([
      { name: 'absolute', url: '<redacted-remote-url>' },
      { name: 'encoded-backslash', url: '<redacted-remote-url>' },
      { name: 'encoded-dot', url: '<redacted-remote-url>' },
      { name: 'encoded-dotdot', url: '<redacted-remote-url>' },
      { name: 'encoded-double-encoded-slash', url: 'file:///Users/name/My%252FRepo' },
      { name: 'encoded-hash', url: 'file:///Users/name/My%23Repo' },
      { name: 'encoded-newline', url: '<redacted-remote-url>' },
      { name: 'encoded-percent', url: 'file:///Users/name/My%25Repo' },
      { name: 'encoded-question', url: 'file:///Users/name/My%3FRepo' },
      { name: 'encoded-tab', url: '<redacted-remote-url>' },
      { name: 'hosted-file', url: '<redacted-remote-url>' },
      { name: 'literal-traversal', url: '<redacted-remote-url>' },
      { name: 'malformed-file', url: '<redacted-remote-url>' },
      { name: 'mixed-dotdot', url: '<redacted-remote-url>' },
      { name: 'relative', url: '<redacted-remote-url>' },
      { name: 'safe-file', url: 'file:///Users/name/My Repo' },
      { name: 'unc-empty-authority', url: '<redacted-remote-url>' },
      { name: 'unc-extra-slash', url: '<redacted-remote-url>' },
      { name: 'userinfo-file', url: '<redacted-remote-url>' },
      { name: 'windows', url: '<redacted-remote-url>' },
    ]);
    expect(context.remotes).toEqual([]);
    expect(rawDiagnosticUrls).not.toContain('private-repo');
    expect(rawDiagnosticUrls).not.toContain('/../secret');
    expect(rawDiagnosticUrls).not.toContain('%2E%2E');
    expect(rawDiagnosticUrls).not.toContain('/server/share');
    expect(rawDiagnosticUrls).not.toContain('My#Repo');
    expect(rawDiagnosticUrls).not.toContain('My?Repo');
    expect(rawDiagnosticUrls).not.toContain('My%2FRepo');
  });

  it('redacts file diagnostics with unsafe Unicode literal or encoded characters', async () => {
    const worktreePath = '/repo/.worktrees/pr';
    const literalNelUrl = 'file:///Users/name/Bad\u0085Repo';
    const literalLineSeparatorUrl = 'file:///Users/name/Bad\u2028Repo';
    const literalParagraphSeparatorUrl = 'file:///Users/name/Bad\u2029Repo';
    const encodedNelUrl = 'file:///Users/name/Bad%C2%85Repo';
    const encodedLineSeparatorUrl = 'file:///Users/name/Bad%E2%80%A8Repo';
    const encodedParagraphSeparatorUrl = 'file:///Users/name/Bad%E2%80%A9Repo';
    const safeUnicodeUrl = 'file:///Users/name/Résumé Repo';
    const { runner } = createRunner({
      'git\0branch\0--show-current': { stdout: 'feat/pr\n' },
      'git\0config\0branch.feat/pr.remote': { stdout: '', exitCode: 1 },
      'git\0remote': {
        stdout: 'encoded-line-separator\nencoded-nel\nencoded-paragraph-separator\nliteral-line-separator\n'
          + 'literal-nel\nliteral-paragraph-separator\nsafe-unicode\n',
      },
      'git\0remote\0get-url\0--\0literal-nel': { stdout: `${literalNelUrl}\n` },
      'git\0remote\0get-url\0--\0literal-line-separator': { stdout: `${literalLineSeparatorUrl}\n` },
      'git\0remote\0get-url\0--\0literal-paragraph-separator': { stdout: `${literalParagraphSeparatorUrl}\n` },
      'git\0remote\0get-url\0--\0encoded-nel': { stdout: `${encodedNelUrl}\n` },
      'git\0remote\0get-url\0--\0encoded-line-separator': { stdout: `${encodedLineSeparatorUrl}\n` },
      'git\0remote\0get-url\0--\0encoded-paragraph-separator': { stdout: `${encodedParagraphSeparatorUrl}\n` },
      'git\0remote\0get-url\0--\0safe-unicode': { stdout: `${safeUnicodeUrl}\n` },
    });

    const context = await readRepositoryContext(worktreePath, runner);
    const serialized = JSON.stringify(context);
    const rawDiagnosticUrls = context.rawRemotes.map((remote) => remote.url).join('\n');

    expect(context.rawRemotes).toEqual([
      { name: 'encoded-line-separator', url: '<redacted-remote-url>' },
      { name: 'encoded-nel', url: '<redacted-remote-url>' },
      { name: 'encoded-paragraph-separator', url: '<redacted-remote-url>' },
      { name: 'literal-line-separator', url: '<redacted-remote-url>' },
      { name: 'literal-nel', url: '<redacted-remote-url>' },
      { name: 'literal-paragraph-separator', url: '<redacted-remote-url>' },
      { name: 'safe-unicode', url: 'file:///Users/name/Résumé Repo' },
    ]);
    expect(context.remotes).toEqual([]);
    expect(rawDiagnosticUrls).not.toMatch(/[\u0085\u2028\u2029]/u);
    expect(rawDiagnosticUrls).not.toContain('%C2%85');
    expect(rawDiagnosticUrls).not.toContain('%E2%80%A8');
    expect(rawDiagnosticUrls).not.toContain('%E2%80%A9');
    expect(serialized).not.toContain(literalNelUrl);
    expect(serialized).not.toContain(literalLineSeparatorUrl);
    expect(serialized).not.toContain(literalParagraphSeparatorUrl);
    expect(serialized).not.toContain(encodedNelUrl);
    expect(serialized).not.toContain(encodedLineSeparatorUrl);
    expect(serialized).not.toContain(encodedParagraphSeparatorUrl);
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
      { name: '-foo', url: 'https://github.com/<redacted-path>' },
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
