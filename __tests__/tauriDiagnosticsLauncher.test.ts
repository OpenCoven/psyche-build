import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { launchDiagnostics } from '../scripts/dev-tauri-diagnostics.mjs';

class FakeChild extends EventEmitter {}

describe('Tauri diagnostics launcher', () => {
  it('spawns the desktop dev command with inherited environment authorization and Windows shell', () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const processApi = {
      env: { PATH: '/tools', KEEP_ME: 'yes' },
      platform: 'win32',
      pid: 41,
      exitCode: undefined as number | undefined,
      kill: vi.fn(),
    };

    launchDiagnostics({ spawnImpl, processApi });

    expect(spawnImpl).toHaveBeenCalledWith('pnpm', ['dev:tauri'], {
      env: {
        PATH: '/tools',
        KEEP_ME: 'yes',
        PSYCHE_RENDER_DIAGNOSTICS: '1',
      },
      shell: true,
      stdio: 'inherit',
    });
  });

  it('disables the shell outside Windows and propagates zero and nonzero exit codes', () => {
    for (const code of [0, 17]) {
      const child = new FakeChild();
      const spawnImpl = vi.fn(() => child);
      const processApi = {
        env: {},
        platform: 'darwin',
        pid: 42,
        exitCode: undefined as number | undefined,
        kill: vi.fn(),
      };

      launchDiagnostics({ spawnImpl, processApi });
      child.emit('exit', code, null);

      expect(spawnImpl).toHaveBeenCalledWith('pnpm', ['dev:tauri'], {
        env: { PSYCHE_RENDER_DIAGNOSTICS: '1' },
        shell: false,
        stdio: 'inherit',
      });
      expect(processApi.exitCode).toBe(code);
      expect(processApi.kill).not.toHaveBeenCalled();
    }
  });

  it('uses exit code one when the child exits without a code or signal', () => {
    const child = new FakeChild();
    const processApi = {
      env: {},
      platform: 'linux',
      pid: 43,
      exitCode: undefined as number | undefined,
      kill: vi.fn(),
    };

    launchDiagnostics({ spawnImpl: () => child, processApi });
    child.emit('exit', null, null);

    expect(processApi.exitCode).toBe(1);
  });

  it('propagates child termination signals to the launcher process', () => {
    const child = new FakeChild();
    const processApi = {
      env: {},
      platform: 'linux',
      pid: 44,
      exitCode: undefined as number | undefined,
      kill: vi.fn(),
    };

    launchDiagnostics({ spawnImpl: () => child, processApi });
    child.emit('exit', null, 'SIGTERM');

    expect(processApi.kill).toHaveBeenCalledWith(44, 'SIGTERM');
    expect(processApi.exitCode).toBeUndefined();
  });

  it('converts spawn errors into a controlled nonzero exit and settles only once', () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const write = vi.fn();
    const processApi = {
      env: {},
      platform: 'linux',
      pid: 45,
      exitCode: undefined as number | undefined,
      stderr: { write },
      kill: vi.fn(),
    };

    launchDiagnostics({ spawnImpl, processApi });
    child.emit('error', new Error('pnpm missing'));
    child.emit('exit', 17, null);

    expect(processApi.exitCode).toBe(1);
    expect(write).toHaveBeenCalledWith(
      'failed to start Tauri diagnostics: pnpm missing\n',
    );
    expect(processApi.kill).not.toHaveBeenCalled();
  });

  it('bounds an unexpectedly large spawn error before writing it', () => {
    const child = new FakeChild();
    const write = vi.fn();
    const processApi = {
      env: {},
      platform: 'linux',
      pid: 46,
      exitCode: undefined as number | undefined,
      stderr: { write },
      kill: vi.fn(),
    };

    launchDiagnostics({ spawnImpl: vi.fn(() => child), processApi });
    child.emit('error', new Error('x'.repeat(2_000)));

    const message = write.mock.calls[0]?.[0] as string;
    expect(message).toHaveLength('failed to start Tauri diagnostics: '.length + 512 + 1);
    expect(message.endsWith('…\n')).toBe(true);
    expect(processApi.exitCode).toBe(1);
  });
});
