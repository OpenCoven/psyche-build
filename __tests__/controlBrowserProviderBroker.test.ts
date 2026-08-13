import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  BrowserProviderBroker,
  type BrowserProviderOperation,
  type ProviderPush,
} from '../src/control/browserProviderBroker.js';
import type { BrowserTabSurface } from '../src/control/surfaces.js';
import { ControlServer } from '../src/control/server.js';
import type { ControlCredentialStore } from '../src/control/credentials.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup().catch(() => undefined)));
});

function tab(overrides: Partial<BrowserTabSurface> = {}): BrowserTabSurface {
  return {
    id: 'tab-1', kind: 'browser_tab', generation: 2,
    providerId: 'desktop-1', webviewLabel: 'main',
    projectRoot: '/repo', worktreeRoot: '/repo',
    url: 'https://example.test', title: 'Example', loading: false,
    viewport: { width: 1200, height: 800 },
    ...overrides,
  };
}

function operation(): BrowserProviderOperation {
  return { kind: 'inspect', includeScreenshot: false };
}

describe('BrowserProviderBroker', () => {
  it('registers a provider and correlates one completed effect', async () => {
    const sent: ProviderPush[] = [];
    const broker = new BrowserProviderBroker();
    const provider = broker.register('desktop-1', (frame) => sent.push(frame));
    await provider.upsert(tab());

    const pending = broker.dispatch({
      actionId: 'action-1', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 15_000,
    });
    expect(sent[0]).toMatchObject({
      version: 1, type: 'provider.effect.request', actionId: 'action-1',
      tabId: 'tab-1', generation: 2,
    });
    provider.complete({ actionId: 'action-1', status: 'succeeded', value: { ok: true } });
    await expect(pending).resolves.toMatchObject({ status: 'succeeded', value: { ok: true } });
    expect(broker.pendingCount).toBe(0);
  });

  it('enforces exact provider, tab, and generation ownership', async () => {
    const broker = new BrowserProviderBroker();
    const first = broker.register('desktop-1', () => undefined);
    const second = broker.register('desktop-2', () => undefined);
    await first.upsert(tab());

    await expect(second.upsert(tab())).rejects.toMatchObject({ code: 'provider_scope_mismatch' });
    await expect(second.remove('tab-1', 2)).rejects.toMatchObject({ code: 'provider_scope_mismatch' });
    await expect(broker.dispatch({
      actionId: 'bad-generation', tabId: 'tab-1', generation: 3,
      operation: operation(), timeoutMs: 10,
    })).rejects.toMatchObject({ code: 'resource_replaced' });
  });

  it('tracks the generation returned by the runtime authority', async () => {
    const sent: ProviderPush[] = [];
    const broker = new BrowserProviderBroker({
      upsertResource: async (_providerId, resource) => ({ ...resource, generation: 3 }),
    });
    const provider = broker.register('desktop-1', (frame) => sent.push(frame));
    await provider.upsert(tab({ generation: 2 }));
    const pending = broker.dispatch({
      actionId: 'canonical-generation', tabId: 'tab-1', generation: 3,
      operation: operation(), timeoutMs: 15_000,
    });
    expect(sent[0]).toMatchObject({ generation: 3 });
    provider.complete({ actionId: 'canonical-generation', status: 'succeeded' });
    await pending;
  });

  it('allows only one in-flight effect per tab', async () => {
    const broker = new BrowserProviderBroker();
    const provider = broker.register('desktop-1', () => undefined);
    await provider.upsert(tab());
    const first = broker.dispatch({
      actionId: 'action-1', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 15_000,
    });
    await expect(broker.dispatch({
      actionId: 'action-2', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 15_000,
    })).rejects.toMatchObject({ code: 'provider_busy' });
    provider.complete({ actionId: 'action-1', status: 'succeeded' });
    await first;
  });

  it('times out sent effects as ambiguous and removes pending state', async () => {
    vi.useFakeTimers();
    try {
      const broker = new BrowserProviderBroker();
      const provider = broker.register('desktop-1', () => undefined);
      await provider.upsert(tab());
      const pending = broker.dispatch({
        actionId: 'action-1', tabId: 'tab-1', generation: 2,
        operation: operation(), timeoutMs: 50,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'effect_unknown', ambiguous: true,
      });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(broker.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes disconnect before send from disconnect after send', async () => {
    const unavailable = new BrowserProviderBroker();
    await expect(unavailable.dispatch({
      actionId: 'missing', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 10,
    })).rejects.toMatchObject({ code: 'provider_unavailable' });

    const broker = new BrowserProviderBroker();
    const provider = broker.register('desktop-1', () => undefined);
    await provider.upsert(tab());
    const pending = broker.dispatch({
      actionId: 'sent', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 15_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'effect_unknown', ambiguous: true,
    });
    await provider.disconnect();
    await rejected;
  });

  it('removes resources through the authority callback before disconnect resolves', async () => {
    const order: string[] = [];
    const broker = new BrowserProviderBroker({
      removeProviderResources: async (providerId) => { order.push(`remove:${providerId}`); },
    });
    const provider = broker.register('desktop-1', () => undefined);
    await provider.upsert(tab());
    await provider.disconnect();
    order.push('resolved');
    expect(order).toEqual(['remove:desktop-1', 'resolved']);
  });

  it('stays fail-closed when disconnect authority cleanup fails', async () => {
    const broker = new BrowserProviderBroker({
      removeProviderResources: async () => { throw new Error('revoke failed'); },
    });
    const provider = broker.register('desktop-1', () => undefined);
    await provider.upsert(tab());
    await expect(provider.disconnect()).rejects.toThrow('revoke failed');
    await expect(broker.ready()).rejects.toThrow('revoke failed');
  });

  it('bounds provider and pending state', async () => {
    const broker = new BrowserProviderBroker({ maxProviders: 1, maxPending: 1 });
    const first = broker.register('desktop-1', () => undefined);
    expect(() => broker.register('desktop-2', () => undefined)).toThrow(/provider limit/);
    await first.upsert(tab());
    const pending = broker.dispatch({
      actionId: 'action-1', tabId: 'tab-1', generation: 2,
      operation: operation(), timeoutMs: 15_000,
    });
    await expect(broker.dispatch({
      actionId: 'action-2', tabId: 'tab-2', generation: 1,
      operation: operation(), timeoutMs: 15_000,
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    first.complete({ actionId: 'action-1', status: 'succeeded' });
    await pending;
  });

  it('bounds resources globally and per provider and releases capacity', async () => {
    const broker = new BrowserProviderBroker({ maxResources: 2, maxResourcesPerProvider: 1 });
    const first = broker.register('desktop-1', () => undefined);
    const second = broker.register('desktop-2', () => undefined);
    await first.upsert(tab());
    await expect(first.upsert(tab({ id: 'tab-2', webviewLabel: 'two' })))
      .rejects.toMatchObject({ code: 'provider_resource_limit' });
    await second.upsert(tab({ id: 'tab-2', providerId: 'desktop-2', webviewLabel: 'two' }));
    await first.remove('tab-1', 2);
    await first.upsert(tab({ id: 'tab-3', webviewLabel: 'three' }));
    await first.disconnect();
    const replacement = broker.register('desktop-1', () => undefined);
    await replacement.upsert(tab({ id: 'tab-4', webviewLabel: 'four' }));
  });

  it('serializes competing tab upserts and rechecks ownership after authority returns', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const broker = new BrowserProviderBroker({
      upsertResource: async (providerId, resource) => {
        if (providerId === 'desktop-1') await gate;
        return resource;
      },
    });
    const first = broker.register('desktop-1', () => undefined);
    const second = broker.register('desktop-2', () => undefined);
    const firstUpsert = first.upsert(tab());
    const competing = second.upsert(tab({ providerId: 'desktop-2' }));
    release();
    await firstUpsert;
    await expect(competing).rejects.toMatchObject({ code: 'provider_scope_mismatch' });
  });

  it('revokes an authority upsert that finishes while its provider disconnects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const removals: string[] = [];
    const broker = new BrowserProviderBroker({
      upsertResource: async (_providerId, resource) => {
        await gate;
        return resource;
      },
      removeResource: async (_providerId, id) => { removals.push(id); },
    });
    const provider = broker.register('desktop-1', () => undefined);
    const upsert = provider.upsert(tab());
    const disconnected = provider.disconnect();
    release();

    await expect(upsert).rejects.toMatchObject({ code: 'provider_unavailable' });
    await disconnected;
    expect(removals).toEqual(['tab-1']);
    expect(() => broker.register('desktop-1', () => undefined)).not.toThrow();
  });

  it('retains failed disconnect ownership, retries all removals, and reconciles on ready', async () => {
    const attempts: string[] = [];
    let failFirst = true;
    const broker = new BrowserProviderBroker({
      removeResource: async (_providerId, id) => {
        attempts.push(id);
        if (id === 'tab-1' && failFirst) throw new Error('temporary revoke failure');
      },
    });
    const provider = broker.register('desktop-1', () => undefined);
    await provider.upsert(tab());
    await provider.upsert(tab({ id: 'tab-2', webviewLabel: 'two' }));
    await expect(provider.disconnect()).rejects.toThrow('temporary revoke failure');
    expect(attempts).toEqual(['tab-1', 'tab-2']);
    expect(() => broker.register('desktop-1', () => undefined)).toThrow(/already connected/);
    failFirst = false;
    await broker.ready();
    expect(attempts).toEqual(['tab-1', 'tab-2', 'tab-1']);
    expect(() => broker.register('desktop-1', () => undefined)).not.toThrow();
  });
});

async function connectLines(endpoint: string): Promise<{
  socket: Socket;
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
}> {
  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line); else lines.push(line);
      newline = buffer.indexOf('\n');
    }
  });
  cleanups.push(async () => { socket.destroy(); });
  return {
    socket,
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next: async () => JSON.parse(
      lines.shift() ?? await new Promise<string>((resolve) => waiters.push(resolve)),
    ) as Record<string, unknown>,
  };
}

async function startProviderServer(): Promise<{
  endpoint: string;
  root: string;
  broker: BrowserProviderBroker;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-provider-server-'));
  const endpoint = `/tmp/psyche-p-${process.pid}-${Date.now()}.sock`;
  const broker = new BrowserProviderBroker();
  const credentials: ControlCredentialStore = {
    authenticate: async (token) => token === 'operator-token'
      ? { id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] }
      : token === 'agent-token'
        ? { id: 'agent', kind: 'agent', capabilities: ['read', 'mutate'] }
        : null,
    operatorToken: async () => 'operator-token',
    agentToken: async () => 'agent-token',
  };
  const server = await ControlServer.start({
    endpoint,
    projectRoot: root,
    ownerEpoch: 1,
    broker,
    credentials,
    runtime: {
      submit: async () => ({ status: 'succeeded' }),
      snapshot: () => ({ ownerEpoch: 1, sequence: 0, commands: {}, leases: {} }),
      readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
    } as never,
  });
  cleanups.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { endpoint, root, broker };
}

describe('ControlServer provider mode', () => {
  it('requires an operator and rejects provider frames on ordinary sockets', async () => {
    const { endpoint, root } = await startProviderServer();
    const agent = await connectLines(endpoint);
    agent.send({
      version: 1, type: 'hello', requestId: 'hello', token: 'agent-token',
      clientName: 'agent', projectRoot: root,
    });
    expect((await agent.next()).type).toBe('welcome');
    agent.send({ version: 1, type: 'provider.register', requestId: 'r1', providerId: 'desktop-1' });
    expect(await agent.next()).toMatchObject({ type: 'error', code: 'operator_required' });
    agent.send({
      version: 1, type: 'provider.resource.remove', requestId: 'r2', id: 'tab-1', generation: 1,
    });
    expect(await agent.next()).toMatchObject({ type: 'error', code: 'provider_not_registered' });
  });

  it('destroys peers that send an oversized newline-terminated frame', async () => {
    const { endpoint } = await startProviderServer();
    const peer = await connectLines(endpoint);
    const closed = new Promise<void>((resolve) => peer.socket.once('close', () => resolve()));
    peer.socket.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}\n`);
    await closed;
    expect(peer.socket.destroyed).toBe(true);
  });

  it('destroys peers that queue too many tiny frames', async () => {
    const { endpoint, root } = await startProviderServer();
    const peer = await connectLines(endpoint);
    peer.send({
      version: 1, type: 'hello', requestId: 'hello', token: 'operator-token',
      clientName: 'flood', projectRoot: root,
    });
    expect((await peer.next()).type).toBe('welcome');
    const closed = new Promise<void>((resolve) => peer.socket.once('close', () => resolve()));
    const frames = Array.from({ length: 200 }, (_, index) => JSON.stringify({
      version: 1, type: 'state.get', requestId: `state-${index}`,
    })).join('\n');
    peer.socket.write(`${frames}\n`);
    await closed;
    expect(peer.socket.destroyed).toBe(true);
  });

  it('locks a registered operator socket into provider-only mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-provider-mode-'));
    const endpoint = `/tmp/psyche-pm-${process.pid}-${Date.now()}.sock`;
    const broker = new BrowserProviderBroker();
    const credentials: ControlCredentialStore = {
      authenticate: async (token) => token === 'operator-token'
        ? { id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] }
        : null,
      operatorToken: async () => 'operator-token', agentToken: async () => 'agent-token',
    };
    const server = await ControlServer.start({
      endpoint, projectRoot: root, ownerEpoch: 1, broker, credentials,
      runtime: {
        submit: async () => ({ status: 'succeeded' }),
        snapshot: () => ({ ownerEpoch: 1, sequence: 0, commands: {}, leases: {} }),
        readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
      } as never,
    });
    cleanups.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
    const peer = await connectLines(endpoint);
    peer.send({
      version: 1, type: 'hello', requestId: 'hello', token: 'operator-token',
      clientName: 'desktop', projectRoot: root,
    });
    expect((await peer.next()).type).toBe('welcome');
    peer.send({ version: 1, type: 'provider.register', requestId: 'r1', providerId: 'desktop-1' });
    expect(await peer.next()).toMatchObject({ type: 'ack', requestId: 'r1' });
    peer.send({ version: 1, type: 'provider.register', requestId: 'r2', providerId: 'desktop-2' });
    expect(await peer.next()).toMatchObject({ type: 'error', code: 'already_registered' });
    peer.send({ version: 1, type: 'state.get', requestId: 'state-1' });
    expect(await peer.next()).toMatchObject({ type: 'error', code: 'provider_mode_only' });
  });
});

describe('daemon browser provider composition', () => {
  it('creates one broker and shares it with handlers and the socket server', () => {
    const source = readFileSync(new URL('../src/daemon/index.ts', import.meta.url), 'utf8');
    expect(source.match(/new BrowserProviderBroker\(/g)).toHaveLength(1);
    expect(source).toContain('browserProvider,');
    expect(source).toContain('broker: browserProvider,');
  });
});
