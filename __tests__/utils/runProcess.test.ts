import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunProcessError, runProcess } from '../../src/utils/runProcess.js';

const sentinelPath = path.join(process.cwd(), '.run-process-shell-sentinel');
const descendantPidPath = path.join(process.cwd(), '.run-process-descendant.pid');
const stdinPidPath = path.join(process.cwd(), '.run-process-stdin.pid');
const childPids = new Set<number>();

afterEach(async () => {
  for (const pidPath of [descendantPidPath, stdinPidPath]) {
    try {
      const pid = Number.parseInt(await fs.readFile(pidPath, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0) childPids.add(pid);
    } catch {
      // The process did not create its PID file.
    }
  }
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process has already exited.
    }
  }
  childPids.clear();
  await fs.rm(sentinelPath, { force: true });
  await fs.rm(descendantPidPath, { force: true });
  await fs.rm(stdinPidPath, { force: true });
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readChildPid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await fs.readFile(pidPath, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0) {
        childPids.add(pid);
        return pid;
      }
    } catch {
      // The child has not recorded its PID yet.
    }
    await wait(10);
  }
  throw new Error(`Child did not record a PID at ${pidPath}`);
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await wait(10);
  }
  throw new Error(`Child process ${pid} did not terminate`);
}

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

  it('bounds timeout settlement when a descendant holds inherited pipes open', async () => {
    const timeoutMs = 500;
    const startedAt = Date.now();
    const result = await Promise.race([
      runProcess(process.execPath, {
        args: [
          '-e',
          [
            'const { spawn } = require("node:child_process");',
            'const fs = require("node:fs");',
            'const descendant = spawn(process.execPath, ["-e",',
            '  \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\'],',
            '  { stdio: "inherit" });',
            'fs.writeFileSync(process.env.PSYCHE_RUN_PROCESS_PID_FILE, String(descendant.pid));',
            'setInterval(() => {}, 1000);',
          ].join(''),
        ],
        env: {
          ...process.env,
          PSYCHE_RUN_PROCESS_PID_FILE: descendantPidPath,
        },
        timeoutMs,
      }).catch((error: unknown) => ({ error, elapsedMs: Date.now() - startedAt })),
      wait(timeoutMs + 1_000).then(() => null),
    ]);

    const descendantPid = await readChildPid(descendantPidPath);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      error: expect.any(RunProcessError),
    });
    expect((result as { elapsedMs: number }).elapsedMs).toBeLessThan(timeoutMs + 1_000);
    await waitForExit(descendantPid);
  });

  it('terminates a child after stdin EPIPE', async () => {
    const result = await Promise.race([
      runProcess(process.execPath, {
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'fs.writeFileSync(process.env.PSYCHE_RUN_PROCESS_PID_FILE, String(process.pid));',
            'fs.closeSync(0);',
            'setInterval(() => {}, 1000);',
          ].join(''),
        ],
        env: {
          ...process.env,
          PSYCHE_RUN_PROCESS_PID_FILE: stdinPidPath,
        },
        input: Buffer.alloc(8 * 1_024 * 1_024),
        timeoutMs: 0,
      }).catch((error: unknown) => error),
      wait(1_500).then(() => null),
    ]);

    const childPid = await readChildPid(stdinPidPath);
    expect(result).toBeInstanceOf(RunProcessError);
    expect((result as RunProcessError).message).toContain('EPIPE');
    await waitForExit(childPid);
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
