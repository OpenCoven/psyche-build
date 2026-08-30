import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const desktop = join(root, 'native/desktop/psyche-build-tauri');
const debugBundle = join(desktop, '.psyche-dev-web', 'web', 'runtime-debug.bundle.js');
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const ansiEscape = /\u001b\[[0-?]*[ -/]*[@-~]/g;

describe('Tauri development web server', () => {
  it('serves the generated debug bundle and committed web shell', async () => {
    execFileSync(packageManager, ['run', 'build:web:debug'], {
      cwd: desktop,
      stdio: 'pipe',
    });

    const server = spawn(packageManager, ['run', 'serve:web'], {
      cwd: desktop,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const output: string[] = [];
    server.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    let readinessTimer: ReturnType<typeof setInterval> | undefined;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearReadiness = (): void => {
      if (readinessTimer !== undefined) clearInterval(readinessTimer);
      if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
      readinessTimer = undefined;
      readinessTimeout = undefined;
    };
    const exited = new Promise<never>((_, reject) => {
      server.once('error', (error) => {
        clearReadiness();
        reject(error);
      });
      server.once('exit', (code, signal) => {
        clearReadiness();
        reject(new Error(`serve:web exited before readiness (${code ?? signal})\n${output.join('')}`));
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      readinessTimeout = setTimeout(() => {
        clearReadiness();
        reject(new Error(`serve:web did not become ready\n${output.join('')}`));
      }, 10_000);
      readinessTimer = setInterval(() => {
        if (output.join('').replace(ansiEscape, '').includes('Local:')) {
          clearReadiness();
          resolve();
        }
      }, 25);
    });

    try {
      await Promise.race([
        ready,
        exited,
      ]);
      const shell = await fetch('http://127.0.0.1:1420/');
      const debug = await fetch('http://127.0.0.1:1420/runtime-debug.bundle.js');
      const asset = await fetch('http://127.0.0.1:1420/assets/psyche-mark.png');

      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('./runtime-debug.bundle.js');
      expect(debug.status).toBe(200);
      expect(await debug.text()).toBe(readFileSync(debugBundle, 'utf8'));
      expect(asset.status).toBe(200);
    } finally {
      if (server.exitCode === null) {
        const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (exited: boolean): void => {
            if (stopTimer !== undefined) clearTimeout(stopTimer);
            server.removeListener('exit', onExit);
            server.removeListener('error', onError);
            resolve(exited);
          };
          const onExit = (): void => finish(true);
          const onError = (): void => finish(true);
          if (server.exitCode !== null) {
            finish(true);
            return;
          }
          server.once('exit', onExit);
          server.once('error', onError);
          stopTimer = setTimeout(() => finish(false), timeoutMs);
        });
        const terminateTree = (force: boolean): void => {
          try {
            if (server.pid === undefined) {
              server.kill(force ? 'SIGKILL' : 'SIGTERM');
            } else if (process.platform === 'win32') {
              execFileSync('taskkill.exe', [
                '/PID', String(server.pid), '/T', '/F',
              ], { stdio: 'ignore' });
            } else {
              process.kill(-server.pid, force ? 'SIGKILL' : 'SIGTERM');
            }
          } catch {
            try {
              server.kill(force ? 'SIGKILL' : 'SIGTERM');
            } catch {
              // The process may have exited between the state check and kill.
            }
          }
        };
        terminateTree(false);
        if (!(await waitForExit(2_000))) {
          terminateTree(true);
          if (!(await waitForExit(2_000))) {
            throw new Error('serve:web process tree did not exit after termination');
          }
        }
      }
    }
  }, 30_000);
});
