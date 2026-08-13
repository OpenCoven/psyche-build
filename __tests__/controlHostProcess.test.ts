import { describe, expect, it, vi } from 'vitest';
import { ensureHostControlPlane } from '../src/control/hostProcess.js';

function connectionError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('ensureHostControlPlane', () => {
  it('connects before starting an owner', async () => {
    const client = { getState: vi.fn() } as never;
    const connect = vi.fn(async () => client);
    const spawn = vi.fn();

    await expect(ensureHostControlPlane({
      projectRoot: '/canonical/project', token: 'secret-agent-token',
      clientName: 'mcp', entryPath: '/app/dist/index.js', connect, spawn,
      canonicalize: async () => '/canonical/project',
    })).resolves.toBe(client);

    expect(connect).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts exactly one detached owner on connection absence and polls authenticated health', async () => {
    const client = { getState: vi.fn() } as never;
    const connect = vi.fn()
      .mockRejectedValueOnce(connectionError('ENOENT'))
      .mockRejectedValueOnce(connectionError('ECONNREFUSED'))
      .mockResolvedValueOnce(client);
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref } as never));
    let now = 0;
    const sleep = vi.fn(async (delay: number) => { now += delay; });

    await expect(ensureHostControlPlane({
      projectRoot: '/project/link', token: 'secret-agent-token', clientName: 'mcp',
      entryPath: '/app/dist/index.js', connect, spawn,
      canonicalize: async () => '/canonical/project', now: () => now, sleep,
    })).resolves.toBe(client);

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/app/dist/index.js', 'daemon', '--port', '0', '--project-root', '/canonical/project'],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenLastCalledWith({
      projectRoot: '/canonical/project', token: 'secret-agent-token', clientName: 'mcp',
    });
  });

  it('does not spawn or retry authentication and protocol failures', async () => {
    const failure = new Error('authentication_failed: invalid credentials');
    const connect = vi.fn(async () => { throw failure; });
    const spawn = vi.fn();

    await expect(ensureHostControlPlane({
      projectRoot: '/project', token: 'do-not-print', clientName: 'mcp',
      entryPath: '/entry.js', connect, spawn, canonicalize: async (root) => root,
    })).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('times out after five seconds without exposing the token', async () => {
    const connect = vi.fn(async () => { throw connectionError('ENOENT'); });
    let now = 0;
    const token = 'top-secret-agent-token';

    const result = ensureHostControlPlane({
      projectRoot: '/project', token, clientName: 'mcp', entryPath: '/entry.js',
      connect, spawn: vi.fn(() => ({ unref: vi.fn() } as never)),
      canonicalize: async (root) => root, now: () => now,
      sleep: async (delay) => { now += delay; },
    });
    await expect(result).rejects.toMatchObject({ code: 'control_owner_unavailable' });
    await expect(result).rejects.not.toThrow(token);
  });
});
