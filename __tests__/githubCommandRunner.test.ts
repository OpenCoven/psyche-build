import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createCommandRunner, GitHubCommandError } from '../src/github/commandRunner.js';

const cwd = process.cwd();

describe('createCommandRunner', () => {
  it('returns stdout and stderr for a successful command', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 1_024 });

    await expect(
      runner.run(
        process.execPath,
        ['-e', 'process.stdout.write("ok"); process.stderr.write("warn\\n");'],
        { cwd },
      ),
    ).resolves.toEqual({
      stdout: 'ok',
      stderr: 'warn\n',
      exitCode: 0,
    });
  });

  it('preserves UTF-8 output when chunks split inside a multibyte sequence', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 1_024 });
    const expected = 'A🙂B';
    const utf8Bytes = [...Buffer.from(expected, 'utf8')];
    const script = `
      const bytes = [${utf8Bytes.join(',')}];
      process.stdout.write(Buffer.from(bytes.slice(0, 3)));
      setTimeout(() => {
        process.stdout.write(Buffer.from(bytes.slice(3)));
      }, 0);
      setTimeout(() => process.exit(0), 20);
    `;

    await expect(runner.run(process.execPath, ['-e', script], { cwd })).resolves.toMatchObject({
      stdout: expected,
      stderr: '',
      exitCode: 0,
    });
  });

  it('resolves nonzero exits when allowFailure is enabled', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 1_024 });

    await expect(
      runner.run(
        process.execPath,
        ['-e', 'process.stdout.write("partial"); process.stderr.write("warn"); process.exit(3);'],
        { cwd, allowFailure: true },
      ),
    ).resolves.toEqual({
      stdout: 'partial',
      stderr: 'warn',
      exitCode: 3,
    });
  });

  it('rejects nonzero exits with a sanitized bounded stderr summary and no secret leakage', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 8_192 });
    const leakedArg = 'gho_SHOULD_NOT_LEAK_FROM_ARGS';
    const stderr = [
      'boom',
      '\u0000',
      '\u2028',
      'ghp_SECRET_TOKEN',
      'password=swordfish',
      'access_token:abc123',
      'key=xyz',
      'token=def456',
      'secret=ghi789',
      ' tail ',
      'x'.repeat(900),
    ].join(' ');

    let error: unknown;
    try {
      await runner.run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(7);`, leakedArg], { cwd });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubCommandError);
    expect(error).toMatchObject({
      kind: 'exit',
      command: process.execPath,
      exitCode: 7,
      message: 'GitHub command failed: exit',
    });

    const commandError = error as GitHubCommandError;
    expect(commandError.stderrSummary).toBeDefined();
    expect(commandError.stderrSummary?.length).toBeLessThanOrEqual(512);
    expect(commandError.stderrSummary).not.toMatch(/[\r\n\0\u2028\u2029]/u);
    expect(commandError.stderrSummary).not.toContain('ghp_SECRET_TOKEN');
    expect(commandError.stderrSummary).not.toContain('swordfish');
    expect(commandError.stderrSummary).not.toContain('abc123');
    expect(commandError.stderrSummary).not.toContain('xyz');
    expect(commandError.stderrSummary).not.toContain('def456');
    expect(commandError.stderrSummary).not.toContain('ghi789');
    expect(commandError.stderrSummary).toContain('<redacted>');
    expect(commandError.command).not.toContain(leakedArg);
    expect(commandError.message).not.toContain(leakedArg);
  });

  it('terminates commands that exceed the timeout', async () => {
    const runner = createCommandRunner({ timeoutMs: 75, maxOutputBytes: 1_024 });

    await expect(
      runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1_000);'], { cwd }),
    ).rejects.toMatchObject({
      kind: 'timeout',
      command: process.execPath,
      message: 'GitHub command failed: timeout',
    });
  });

  it('settles once when timeout and process close race', async () => {
    const runner = createCommandRunner({ timeoutMs: 75, maxOutputBytes: 1_024 });
    let multipleResolveEvent: unknown = null;
    const onMultipleResolves = (type: unknown) => {
      multipleResolveEvent = type;
    };

    process.once('multipleResolves', onMultipleResolves);

    try {
      await expect(
        runner.run(
          process.execPath,
          [
            '-e',
            'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 0)); setInterval(() => {}, 1_000);',
          ],
          { cwd },
        ),
      ).rejects.toMatchObject({ kind: 'timeout' });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(multipleResolveEvent).toBeNull();
    } finally {
      process.off('multipleResolves', onMultipleResolves);
    }
  });

  it('rejects output beyond the combined byte bound without leaking captured output', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 8 });
    const leakedOutput = 'VISIBLE-DATA';

    let error: unknown;
    try {
      await runner.run(
        process.execPath,
        [
          '-e',
          `process.stdout.write("1234"); process.stderr.write(${JSON.stringify(leakedOutput)}); setTimeout(() => {}, 10_000);`,
        ],
        { cwd },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubCommandError);
    expect(error).toMatchObject({
      kind: 'outputLimit',
      command: process.execPath,
      message: 'GitHub command failed: outputLimit',
    });

    const commandError = error as GitHubCommandError;
    expect(commandError.exitCode).toBeUndefined();
    expect(commandError.stderrSummary).toBeUndefined();
    expect(commandError.message).not.toContain(leakedOutput);
    expect(commandError.command).not.toContain(leakedOutput);
  });

  it('allows output that matches the exact combined byte limit', async () => {
    const stdout = 'é';
    const stderr = '🙂';
    const maxOutputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes });

    await expect(
      runner.run(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`],
        { cwd },
      ),
    ).resolves.toEqual({
      stdout,
      stderr,
      exitCode: 0,
    });
  });

  it('counts output bytes rather than JavaScript characters', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: '🙂'.length });

    await expect(
      runner.run(process.execPath, ['-e', 'process.stdout.write("🙂");'], { cwd }),
    ).rejects.toMatchObject({
      kind: 'outputLimit',
      command: process.execPath,
    });
  });

  it('rejects spawn failures with a fixed safe error', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 1_024 });
    const missingCommand = '__psyche_missing_command__';

    await expect(runner.run(missingCommand, [], { cwd })).rejects.toMatchObject({
      kind: 'spawn',
      command: missingCommand,
      message: 'GitHub command failed: spawn',
    });
  });

  it('uses safe defaults when options are omitted', async () => {
    const runner = createCommandRunner();

    await expect(
      runner.run(process.execPath, ['-e', 'process.stdout.write("defaults");'], { cwd }),
    ).resolves.toEqual({
      stdout: 'defaults',
      stderr: '',
      exitCode: 0,
    });
  });

  it('rejects invalid timeout and output limit options with fixed safe errors', () => {
    expect(() => createCommandRunner({ timeoutMs: 0 })).toThrowError(
      new Error('invalid GitHub command runner timeout'),
    );
    expect(() => createCommandRunner({ maxOutputBytes: Number.NaN })).toThrowError(
      new Error('invalid GitHub command runner output limit'),
    );
  });
});
