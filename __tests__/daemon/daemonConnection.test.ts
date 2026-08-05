import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_DEADLINE_MS,
  Connection,
  MAX_STREAMS_PER_CONNECTION,
  tokensMatch,
  type ConnectionDeps,
} from '../../src/daemon/index.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';

/**
 * The loopback daemon is scoped to exactly one project root, and every pane
 * op is supposed to stay inside it. These tests pin the two properties that
 * were missing: a request can only reach panes this project registered, and no
 * single frame can take the daemon down.
 */

const TOKEN = 'a'.repeat(64);

let tempRoots: string[] = [];

async function projectWithPanes(panes: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-daemon-conn-'));
  tempRoots.push(root);
  await mkdir(path.join(root, '.psyche'), { recursive: true });
  await writeFile(
    path.join(root, '.psyche', 'psyche.config.json'),
    JSON.stringify({ panes }, null, 2),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

/** Minimal stand-in for the `ws` socket surface Connection touches. */
class FakeSocket extends EventEmitter {
  readonly sent: any[] = [];
  readonly binary: Buffer[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(data: string | Buffer): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data));
    else this.binary.push(data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  /** Deliver a JSON control frame the way `ws` would. */
  deliver(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg), 'utf8'), false);
  }
}

/** TmuxControl that records commands instead of driving a real subprocess. */
class RecordingTmux extends TmuxControl {
  readonly calls: Array<{ op: string; paneId: string }> = [];
  override selectPane(paneId: string): void { this.calls.push({ op: 'select', paneId }); }
  override killPane(paneId: string): void { this.calls.push({ op: 'kill', paneId }); }
  override resizePane(paneId: string): void { this.calls.push({ op: 'resize', paneId }); }
  override sendKeysHex(paneId: string): void { this.calls.push({ op: 'input', paneId }); }
}

function buildConnection(
  projectRoot: string,
  opts: { authed?: boolean; tmux?: TmuxControl; workspaceProvider?: ConnectionDeps['workspaceProvider'] } = {},
) {
  const ws = new FakeSocket();
  const tmux = opts.tmux ?? new RecordingTmux('psyche-test');
  const deps: ConnectionDeps = {
    token: TOKEN,
    projectRoot,
    serverVersion: 'test',
    authedViaHeader: opts.authed ?? true,
    tmux,
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    workspaceProvider: opts.workspaceProvider,
  };
  const conn = new Connection(ws as any, deps);
  conn.bind();
  // Header-authenticated connections are welcomed on bind. Drop that frame so
  // each test reads ws.sent[0] as the reply to the request it made.
  if (deps.authedViaHeader) {
    expect(ws.sent).toEqual([{ type: 'welcome', protocol: 0, serverVersion: 'test' }]);
    ws.sent.length = 0;
  }
  return { ws, tmux: tmux as RecordingTmux, conn };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Deliver a control frame and wait until the connection has answered it.
 *
 * Dispatch is async (it reads the project config), so a fixed delay is a race
 * under load. All frames for one request are emitted in the same synchronous
 * block, so observing the first means the rest are there too.
 */
async function request(ws: FakeSocket, msg: unknown): Promise<void> {
  const baseline = ws.sent.length;
  ws.deliver(msg);
  await waitFor(
    () => ws.sent.length > baseline || ws.closes.length > 0,
    `a reply to ${JSON.stringify(msg)}`,
  );
}

describe('daemon token comparison', () => {
  it('accepts the exact token and nothing else', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, TOKEN.slice(0, -1) + 'b')).toBe(false);
  });

  it('returns false rather than throwing on length mismatch or non-strings', () => {
    // timingSafeEqual throws when the buffers differ in length.
    expect(tokensMatch(TOKEN, '')).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN + 'extra')).toBe(false);
    expect(tokensMatch(TOKEN, undefined)).toBe(false);
    expect(tokensMatch(TOKEN, 42)).toBe(false);
  });
});

describe('daemon connection authentication', () => {
  it('refuses every request before hello and closes the socket', async () => {
    const root = await projectWithPanes([]);
    const { ws } = buildConnection(root, { authed: false });

    await request(ws, { type: 'panes.list', requestId: 'r1' });

    expect(ws.sent).toEqual([
      { type: 'error', code: 'unauthorized', message: 'hello required' },
    ]);
    expect(ws.closes[0].code).toBe(4401);
  });

  it('rejects a wrong token', async () => {
    const root = await projectWithPanes([]);
    const { ws } = buildConnection(root, { authed: false });

    await request(ws, { type: 'hello', token: 'b'.repeat(64) });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect(ws.closes[0].code).toBe(4401);
  });

  it('welcomes a correct token', async () => {
    const root = await projectWithPanes([]);
    const { ws } = buildConnection(root, { authed: false });

    await request(ws, { type: 'hello', token: TOKEN });

    expect(ws.sent[0]).toMatchObject({ type: 'welcome' });
    expect(ws.closes).toEqual([]);
  });

  it('closes a connection that never authenticates', async () => {
    vi.useFakeTimers();
    try {
      const root = await projectWithPanes([]);
      const { ws } = buildConnection(root, { authed: false });

      vi.advanceTimersByTime(AUTH_DEADLINE_MS + 1);

      expect(ws.sent[0]).toMatchObject({ code: 'auth_timeout' });
      expect(ws.closes[0].code).toBe(4408);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the auth deadline once authenticated', async () => {
    vi.useFakeTimers();
    try {
      const root = await projectWithPanes([]);
      const { ws } = buildConnection(root, { authed: false });

      ws.deliver({ type: 'hello', token: TOKEN });
      await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS + 1);

      expect(ws.closes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daemon connection project scoping', () => {
  // Regression: these handlers took the tmux pane id straight off the wire, so
  // a client authenticated for one project could stream and type into any pane
  // on the machine — including the user's unrelated shells.
  const FOREIGN_PANE = '%999';

  it('will not kill a pane this project does not own', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.kill', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.calls).toEqual([]);
  });

  it('will not attach to a pane this project does not own', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.listenerCount('output')).toBe(0);
  });

  it('will not focus a pane this project does not own', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.focus', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.calls).toEqual([]);
  });

  it('still serves panes the project registered, resolving psyche ids to tmux ids', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.focus', requestId: 'r1', id: 'psyche-1' });

    expect(ws.sent[0]).toMatchObject({ type: 'ack', ok: true });
    expect(tmux.calls).toEqual([{ op: 'select', paneId: '%3' }]);
  });

  it('refuses a config pane whose id is not a usable tmux target', async () => {
    // Config is a plain file on disk, and a pane id becomes tmux command text.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: "%3'\nrun-shell 'id'" }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.kill', requestId: 'r1', id: 'psyche-1' });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'invalid_pane' });
    expect(tmux.calls).toEqual([]);
  });
});

describe('daemon workspace projection', () => {
  it('returns the shared project-worktree-pane snapshot', async () => {
    const root = await projectWithPanes([]);
    const workspace = {
      revision: 12,
      projects: [{
        id: root,
        root,
        title: 'project',
        worktrees: [],
        projectPanes: [],
        runningCount: 0,
        attentionCount: 0,
      }],
    };
    const workspaceProvider = vi.fn(async () => workspace);
    const { ws } = buildConnection(root, { workspaceProvider });

    await request(ws, { type: 'workspace.snapshot', requestId: 'workspace-1' });

    expect(workspaceProvider).toHaveBeenCalledOnce();
    expect(ws.sent).toEqual([{
      type: 'workspace.snapshot.result',
      requestId: 'workspace-1',
      workspace,
    }]);
  });

  it('emits an ordered workspace change after a successful pane mutation', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3', title: 'old' }]);
    const workspace = {
      revision: 13,
      projects: [{
        id: root,
        root,
        title: 'project',
        worktrees: [],
        projectPanes: [],
        runningCount: 0,
        attentionCount: 0,
      }],
    };
    const { ws } = buildConnection(root, {
      workspaceProvider: vi.fn(async () => workspace),
    });

    await request(ws, {
      type: 'panes.meta',
      requestId: 'rename-1',
      id: 'psyche-1',
      title: 'renamed',
    });
    await waitFor(() => ws.sent.length === 2, 'workspace change event');

    expect(ws.sent).toEqual([
      { type: 'ack', requestId: 'rename-1', ok: true },
      { type: 'workspace.changed', revision: 13, sequence: 1, workspace },
    ]);
  });
});

describe('daemon connection resilience', () => {
  it('answers a malformed attach with an error instead of dying', async () => {
    // Regression: `panes.attach` with no `id` threw out of the async dispatch
    // chain. Nothing caught it, so one frame killed the daemon.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws } = buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1' });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'missing_pane' });

    // Still serving.
    await request(ws, { type: 'panes.list', requestId: 'r2' });
    expect(ws.sent[1]).toMatchObject({ type: 'panes.list.result', requestId: 'r2' });
  });

  it('reports an unexpected handler failure as an error frame', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const tmux = new RecordingTmux('psyche-test');
    tmux.on = () => { throw new Error('emitter exploded'); };
    const { ws } = buildConnection(root, { tmux });

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });

    expect(ws.sent.some((m) => m.code === 'internal_error')).toBe(true);
  });

  it('rejects malformed base64 input rather than sending mangled keys', async () => {
    // Regression: this was a try/catch, which never fired — Buffer.from with
    // 'base64' skips characters outside the alphabet instead of throwing.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    const streamId = ws.sent.find((m) => m.type === 'panes.attach.result').streamId;
    tmux.calls.length = 0;

    await request(ws, { type: 'panes.input', requestId: 'r2', streamId, data: '!!!!' });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'bad_base64' });

    await request(ws, { type: 'panes.input', requestId: 'r3', streamId, data: 'zz z' });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'bad_base64' });

    expect(tmux.calls).toEqual([]);

    // Well-formed input still goes through.
    await request(ws, {
      type: 'panes.input',
      requestId: 'r4',
      streamId,
      data: Buffer.from('ls\r').toString('base64'),
    });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'ack', ok: true });
    expect(tmux.calls).toEqual([{ op: 'input', paneId: '%3' }]);
  });

  it('rejects invalid JSON without closing an authenticated connection', async () => {
    const root = await projectWithPanes([]);
    const { ws } = buildConnection(root);

    ws.emit('message', Buffer.from('{not json', 'utf8'), false);
    await waitFor(() => ws.sent.length > 0, 'bad_json reply');

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'bad_json' });
    expect(ws.closes).toEqual([]);
  });

  it('caps attached streams per connection', async () => {
    const panes = Array.from({ length: MAX_STREAMS_PER_CONNECTION + 1 }, (_, i) => ({
      id: `psyche-${i}`,
      paneId: `%${i}`,
    }));
    const root = await projectWithPanes(panes);
    const { ws, tmux } = buildConnection(root);

    for (const pane of panes) {
      await request(ws, { type: 'panes.attach', requestId: pane.id, id: pane.paneId });
    }

    expect(ws.sent.filter((m) => m.type === 'panes.attach.result')).toHaveLength(
      MAX_STREAMS_PER_CONNECTION,
    );
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', code: 'too_many_streams' });
    // Many streams, still exactly one emitter registration.
    expect(tmux.listenerCount('output')).toBe(1);
  });

  it('registers exactly one output listener however many panes are attached', async () => {
    const root = await projectWithPanes([
      { id: 'psyche-1', paneId: '%3' },
      { id: 'psyche-2', paneId: '%4' },
    ]);
    const { ws, tmux } = buildConnection(root);

    expect(tmux.listenerCount('output')).toBe(0);
    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    await request(ws, { type: 'panes.attach', requestId: 'r2', id: '%4' });
    expect(tmux.listenerCount('output')).toBe(1);

    ws.emit('close');
    expect(tmux.listenerCount('output')).toBe(0);
  });

  it('releases the listener once the last stream detaches', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    const streamId = ws.sent.find((m) => m.type === 'panes.attach.result').streamId;
    expect(tmux.listenerCount('output')).toBe(1);

    await request(ws, { type: 'panes.detach', requestId: 'r2', streamId });
    expect(tmux.listenerCount('output')).toBe(0);
  });

  it('routes pane output only to the streams watching that pane', async () => {
    const root = await projectWithPanes([
      { id: 'psyche-1', paneId: '%3' },
      { id: 'psyche-2', paneId: '%4' },
    ]);
    const { ws, tmux } = buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    await request(ws, { type: 'panes.attach', requestId: 'r2', id: '%4' });
    const streams = ws.sent
      .filter((m) => m.type === 'panes.attach.result')
      .map((m) => ({ streamId: m.streamId, id: m.id }));
    ws.binary.length = 0;

    tmux.emit('output', '%4', Buffer.from('hello from four'));

    expect(ws.binary).toHaveLength(1);
    const forStreamOfPaneFour = streams.find((s) => s.id === '%4')!.streamId;
    // Frame layout: [1-byte streamId length][streamId][payload].
    const frame = ws.binary[0];
    expect(frame.subarray(1, 1 + frame.readUInt8(0)).toString('utf8')).toBe(forStreamOfPaneFour);
    expect(frame.subarray(1 + frame.readUInt8(0)).toString('utf8')).toBe('hello from four');
  });
});
