import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureHostControlPlane,
  setHostProcessDeps,
} from '../src/control/hostProcess.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-host-process-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function unavailable(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('ensureHostControlPlane', () => {
  it('connects first and does not spawn when the owner already answers', async () => {
    const root = await projectRoot();
    const client = { close: vi.fn() } as any;
    const connect = vi.fn(async () => client);
    const spawn = vi.fn();
    cleanups.push(setHostProcessDeps({ connect, spawn: spawn as never }));

    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'agent-secret', clientName: 'mcp', entryPath: '/psyche.js',
    })).resolves.toBe(client);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: await realpath(root), token: 'agent-secret', clientName: 'mcp',
      signal: expect.any(AbortSignal),
    }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns exactly one detached daemon and polls authenticated health', async () => {
    const root = await projectRoot();
    const canonicalRoot = await realpath(root);
    const client = { close: vi.fn() } as any;
    const connect = vi.fn()
      .mockRejectedValueOnce(unavailable('ENOENT'))
      .mockRejectedValueOnce(unavailable('ECONNREFUSED'))
      .mockResolvedValueOnce(client);
    const child = { unref: vi.fn(), once: vi.fn(), exitCode: null, signalCode: null };
    const spawn = vi.fn(() => child);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    cleanups.push(setHostProcessDeps({ connect, spawn: spawn as never, now: () => now, sleep }));

    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'agent-secret', clientName: 'mcp', entryPath: '/psyche.js',
    })).resolves.toBe(client);

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      '/psyche.js', 'daemon', '--port', '0', '--project-root', canonicalRoot,
    ], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('does not spawn or retry authentication and protocol failures', async () => {
    const root = await projectRoot();
    const connect = vi.fn(async () => { throw new Error('unauthorized: invalid token'); });
    const spawn = vi.fn();
    cleanups.push(setHostProcessDeps({ connect, spawn: spawn as never }));

    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'do-not-print', clientName: 'mcp', entryPath: '/psyche.js',
    })).rejects.toMatchObject({
      code: 'control_authentication_failed', message: 'control authentication failed',
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds a never-settling initial connection by the same five-second deadline', async () => {
    const root = await projectRoot();
    let now = 0;
    const connect = vi.fn(() => new Promise<any>(() => undefined));
    const spawn = vi.fn();
    cleanups.push(setHostProcessDeps({
      connect, spawn: spawn as never, now: () => now,
      timeout: async (ms) => { now += ms; },
    }));
    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'never-print-this', clientName: 'mcp', entryPath: '/secret/path.js',
    })).rejects.toMatchObject({
      code: 'control_owner_unavailable', message: 'control owner unavailable',
    });
    expect(now).toBe(5000);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds a never-settling poll connection by the original five-second deadline', async () => {
    const root = await projectRoot();
    let now = 0;
    const connect = vi.fn()
      .mockRejectedValueOnce(unavailable('ENOENT'))
      .mockImplementationOnce(() => new Promise<any>(() => undefined));
    const child = { unref: vi.fn(), once: vi.fn(), exitCode: null, signalCode: null };
    let timeoutCall = 0;
    cleanups.push(setHostProcessDeps({
      connect, spawn: vi.fn(() => child) as never, now: () => now,
      sleep: async (ms) => { now += ms; },
      timeout: async (ms) => {
        timeoutCall += 1;
        if (timeoutCall === 1) return new Promise<void>(() => undefined);
        now += ms;
      },
    }));
    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'token', clientName: 'mcp', entryPath: '/psyche.js',
    })).rejects.toMatchObject({ code: 'control_owner_unavailable' });
    expect(now).toBe(5000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not reset the deadline after a slow unavailable initial connection', async () => {
    const root = await projectRoot();
    let now = 0;
    const connect = vi.fn(async () => {
      now = 4990;
      throw unavailable('ENOENT');
    });
    const child = { unref: vi.fn(), once: vi.fn(), exitCode: null, signalCode: null };
    cleanups.push(setHostProcessDeps({
      connect, spawn: vi.fn(() => child) as never, now: () => now,
      sleep: async (ms) => { now += ms; }, timeout: async () => new Promise<void>(() => undefined),
    }));
    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'token', clientName: 'mcp', entryPath: '/psyche.js',
    })).rejects.toMatchObject({ code: 'control_owner_unavailable' });
    expect(now).toBe(5000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('redacts non-retry protocol errors', async () => {
    const root = await projectRoot();
    cleanups.push(setHostProcessDeps({
      connect: vi.fn(async () => { throw new Error('bad frame token-123 /private/repo'); }),
      spawn: vi.fn() as never,
    }));
    const error = await ensureHostControlPlane({
      projectRoot: root, token: 'token-123', clientName: 'mcp', entryPath: '/private/entry.js',
    }).catch((caught) => caught as Error & { code?: string });
    expect(error).toMatchObject({ code: 'control_protocol_error', message: 'control protocol error' });
    expect(JSON.stringify(error)).not.toMatch(/token-123|private/);
  });

  it('normalizes synchronous spawn failures without leaking paths or tokens', async () => {
    const root = await projectRoot();
    cleanups.push(setHostProcessDeps({
      connect: vi.fn(async () => { throw unavailable('ENOENT'); }),
      spawn: vi.fn(() => { throw new Error('token-123 /private/entry.js failed'); }) as never,
    }));
    const error = await ensureHostControlPlane({
      projectRoot: root, token: 'token-123', clientName: 'mcp', entryPath: '/private/entry.js',
    }).catch((caught) => caught as Error & { code?: string });
    expect(error).toMatchObject({
      code: 'control_owner_unavailable', message: 'control owner unavailable',
    });
    expect(JSON.stringify(error)).not.toMatch(/token-123|private/);
  });

  it('times out after five seconds with a stable redacted diagnostic', async () => {
    const root = await projectRoot();
    const connect = vi.fn(async () => { throw unavailable('ECONNREFUSED'); });
    const child = { unref: vi.fn(), once: vi.fn(), exitCode: 12, signalCode: null };
    let now = 0;
    cleanups.push(setHostProcessDeps({
      connect,
      spawn: vi.fn(() => child) as never,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    }));

    let error!: Error & { code?: string };
    try {
      await ensureHostControlPlane({
        projectRoot: root, token: 'extremely-secret', clientName: 'mcp', entryPath: '/psyche.js',
      });
    } catch (caught) {
      error = caught as Error & { code?: string };
    }

    expect(error.code).toBe('control_owner_unavailable');
    expect(error.message).toContain('control owner unavailable');
    expect(error.message).toContain('exit code 12');
    expect(error.message).not.toContain('extremely-secret');
    expect(now).toBe(5000);
  });

  it('accepts a concurrently started owner once its socket answers', async () => {
    const root = await projectRoot();
    const client = {} as any;
    const connect = vi.fn()
      .mockRejectedValueOnce(unavailable('ENOENT'))
      .mockRejectedValueOnce(unavailable('ECONNREFUSED'))
      .mockResolvedValueOnce(client);
    const child = { unref: vi.fn(), once: vi.fn(), exitCode: 1, signalCode: null };
    cleanups.push(setHostProcessDeps({
      connect, spawn: vi.fn(() => child) as never, now: () => 0, sleep: async () => undefined,
    }));

    await expect(ensureHostControlPlane({
      projectRoot: root, token: 'token', clientName: 'mcp', entryPath: '/psyche.js',
    })).resolves.toBe(client);
  });
});
