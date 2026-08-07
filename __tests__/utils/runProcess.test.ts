import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunProcessError, runProcess } from '../../src/utils/runProcess.js';

const sentinelPath = path.join(process.cwd(), '.run-process-shell-sentinel');

afterEach(async () => {
  await fs.rm(sentinelPath, { force: true });
});

describe('runProcess', () => {
  it('passes hostile arguments and stdin literally without executing shell syntax', async () => {
    const hostileValues = [
      `$(touch ${sentinelPath})`,
      '`touch ignored`',
      '"quoted"; touch ignored',
      'semi;colon',
      'line one\nline two',
      '--leading-dash',
    ];
    const input = hostileValues.join('\n');
    const result = await runProcess(process.execPath, {
      args: [
        '-e',
        [
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input }));',
          '});',
        ].join(''),
        ...hostileValues,
      ],
      input,
    });

    expect(JSON.parse(result.stdout)).toEqual({
      args: hostileValues,
      input,
    });
    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });

  it('rejects with a typed error containing stderr and the exit code', async () => {
    const error = await runProcess(process.execPath, {
      args: ['-e', 'process.stderr.write("expected stderr"); process.exit(42);'],
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RunProcessError);
    expect(error).toMatchObject({
      exitCode: 42,
      stderr: 'expected stderr',
    });
  });

  it('terminates timed out processes', async () => {
    const error = await runProcess(process.execPath, {
      args: ['-e', 'setInterval(() => {}, 1000);'],
      timeoutMs: 25,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RunProcessError);
    expect((error as RunProcessError).message).toContain('timed out');
  });

  it('caps process output', async () => {
    const error = await runProcess(process.execPath, {
      args: ['-e', 'process.stdout.write("x".repeat(32));'],
      maxOutputBytes: 16,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RunProcessError);
    expect((error as RunProcessError).message).toContain('output limit');
  });
});
