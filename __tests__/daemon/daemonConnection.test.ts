import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_DEADLINE_MS,
  Connection,
  MAX_STREAMS_PER_CONNECTION,
  MAX_CONNECTION_BUFFERED_BYTES,
  tokensMatch,
  type ConnectionDeps,
} from '../../src/daemon/index.js';
import { PaneOutputFanout } from '../../src/daemon/paneOutputFanout.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { ControlRuntime } from '../../src/control/runtime.js';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import type { BridgeSpawnRequest } from '../../src/daemon/bridge.js';

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
  bufferedAmount = 0;

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

async function buildConnection(
  projectRoot: string,
  opts: {
    authed?: boolean;
    tmux?: TmuxControl;
    workspaceProvider?: ConnectionDeps['workspaceProvider'];
    spawnPane?: (
      projectRoot: string,
      sessionName: string,
      request: BridgeSpawnRequest,
    ) => Promise<import('../../src/daemon/bridge.js').BridgeSpawnResult>;
    controlRuntime?: ConnectionDeps['controlRuntime'];
    paneOutput?: ConnectionDeps['paneOutput'];
  } = {},
) {
  const ws = new FakeSocket();
  const tmux = opts.tmux ?? new RecordingTmux('psyche-test');
  const ownerEpoch = 1;
  // Wire a real runtime backed by the same recording tmux so existing
  // `tmux.calls` assertions still observe effects, now routed through the
  // canonical control path. Tests that need to observe the submitted commands
  // directly can inject a spying `controlRuntime`.
  const controlRuntime =
    opts.controlRuntime ??
    (await ControlRuntime.create({
      ownerEpoch,
      handlers: createDaemonControlHandlers({
        tmux,
        projectRoot,
        sessionName: 'psyche-test',
        spawnPane: opts.spawnPane,
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      }),
      journal: createMemoryJournal(),
    }));
  const deps: ConnectionDeps = {
    token: TOKEN,
    projectRoot,
    serverVersion: 'test',
    authedViaHeader: opts.authed ?? true,
    tmux,
    paneOutput: opts.paneOutput ?? new PaneOutputFanout(tmux),
    workspaceProvider: opts.workspaceProvider,
    controlRuntime,
    ownerEpoch,
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

function createMemoryJournal() {
  const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
  return {
    append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
      const event = { sequence: events.length + 1, kind, payload };
      events.push(event);
      return event;
    }),
    read: () => [...events],
    findByIdempotencyKey: (key: string) =>
      [...events].reverse().find((event) => event.payload.idempotencyKey === key),
    recoverNonterminalCommands: vi.fn(
      async (): Promise<Array<{ sequence: number; kind: string; payload: Record<string, unknown> }>> => [],
    ),
  };
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
    const { ws } = await buildConnection(root, { authed: false });

    await request(ws, { type: 'panes.list', requestId: 'r1' });

    expect(ws.sent).toEqual([
      { type: 'error', code: 'unauthorized', message: 'hello required' },
    ]);
    expect(ws.closes[0].code).toBe(4401);
  });

  describe('daemon WebSocket orchestration routing', () => {
    it('requests a project lease and executes through the canonical runtime', async () => {
      const root = await projectWithPanes([]);
      const submitted: any[] = [];
      const controlRuntime = {
        submit: vi.fn(async (command: any) => {
          submitted.push(command);
          if (command.kind === 'lease.request') {
            return { status: 'succeeded', value: { requestId: command.id } };
          }
          if (command.kind === 'lease.grant') {
            return {
              status: 'succeeded',
              value: { lease: { id: 'lease-1', revision: 1 } },
            };
          }
          return {
            status: 'succeeded',
            value: {
              taskId: 'task-1',
              traceId: 'trace-1',
              status: 'completed',
              startedAt: '2026-08-18T00:00:00.000Z',
              completedAt: '2026-08-18T00:00:00.000Z',
              lanes: [],
            },
          };
        }),
      };
      const { ws } = await buildConnection(root, {
        controlRuntime: controlRuntime as ConnectionDeps['controlRuntime'],
      });

      await request(ws, {
        type: 'orchestration.execute',
        requestId: 'request-1',
        task: {
          taskId: 'task-1',
          projectRoot: root,
          prompt: 'Fix tests',
          lanes: [{ id: 'terminal', mode: 'terminal' }],
        },
      });

      expect(submitted.map((command) => command.kind)).toEqual([
        'lease.request',
        'lease.grant',
        'orchestration.execute',
      ]);
      expect(submitted[2]).toMatchObject({
        payload: {
          taskId: 'task-1',
          leaseId: 'lease-1',
          leaseRevision: 1,
        },
      });
      expect(ws.sent[0]).toMatchObject({
        type: 'orchestration.execute.result',
        requestId: 'request-1',
        result: { status: 'completed' },
      });
    });

    it('reconciles the same explicit daemon operation across reconnects and request ids', async () => {
      const root = await projectWithPanes([]);
      const submitted: any[] = [];
      const executionOutcomes = new Map<string, unknown>();
      let executionEffects = 0;
      const controlRuntime = {
        submit: vi.fn(async (command: any) => {
          submitted.push(command);
          if (command.kind === 'lease.request') {
            return { status: 'succeeded', value: { requestId: command.id } };
          }
          if (command.kind === 'lease.grant') {
            return {
              status: 'succeeded',
              value: { lease: { id: `lease-${submitted.length}`, revision: 1 } },
            };
          }
          const prior = executionOutcomes.get(command.idempotencyKey);
          if (prior) return prior;
          executionEffects += 1;
          const outcome = {
            status: 'succeeded',
            value: {
              taskId: 'shared-task',
              traceId: 'shared-trace',
              status: 'completed',
              startedAt: '2026-08-18T00:00:00.000Z',
              completedAt: '2026-08-18T00:00:00.000Z',
              lanes: [],
            },
          };
          executionOutcomes.set(command.idempotencyKey, outcome);
          return outcome;
        }),
      };
      const message = {
        type: 'orchestration.execute',
        operationId: 'stable-daemon-operation',
        task: {
          taskId: 'shared-task',
          projectRoot: root,
          prompt: 'Fix tests',
          lanes: [{ id: 'same-lane', mode: 'terminal' }],
        },
      };
      const first = await buildConnection(root, {
        controlRuntime: controlRuntime as unknown as ConnectionDeps['controlRuntime'],
      });
      const retry = await buildConnection(root, {
        controlRuntime: controlRuntime as unknown as ConnectionDeps['controlRuntime'],
      });

      await request(first.ws, { ...message, requestId: 'request-before-disconnect' });
      await request(retry.ws, { ...message, requestId: 'request-after-reconnect' });

      const executions = submitted.filter((candidate) => candidate.kind === 'orchestration.execute');
      expect(executions).toHaveLength(2);
      expect(executions[1].idempotencyKey).toBe(executions[0].idempotencyKey);
      expect(executions[0].idempotencyKey).not.toContain(executions[0].actor.id);
      expect(executionEffects).toBe(1);
      expect(first.ws.sent[0]).toMatchObject({ requestId: 'request-before-disconnect' });
      expect(retry.ws.sent[0]).toMatchObject({ requestId: 'request-after-reconnect' });
    });

    it('keeps distinct explicit operations separate when connections reuse a request id', async () => {
      const root = await projectWithPanes([]);
      const submitted: any[] = [];
      const controlRuntime = {
        submit: vi.fn(async (command: any) => {
          submitted.push(command);
          if (command.kind === 'lease.request') {
            return { status: 'succeeded', value: { requestId: command.id } };
          }
          if (command.kind === 'lease.grant') {
            return { status: 'succeeded', value: { lease: { id: command.id, revision: 1 } } };
          }
          return {
            status: 'succeeded',
            value: {
              taskId: 'shared-task',
              traceId: 'shared-trace',
              status: 'completed',
              startedAt: '2026-08-18T00:00:00.000Z',
              completedAt: '2026-08-18T00:00:00.000Z',
              lanes: [],
            },
          };
        }),
      };
      const first = await buildConnection(root, {
        controlRuntime: controlRuntime as ConnectionDeps['controlRuntime'],
      });
      const second = await buildConnection(root, {
        controlRuntime: controlRuntime as ConnectionDeps['controlRuntime'],
      });
      const task = {
        taskId: 'shared-task',
        projectRoot: root,
        prompt: 'Fix tests',
        lanes: [{ id: 'same-lane', mode: 'terminal' }],
      };

      await request(first.ws, {
        type: 'orchestration.execute',
        requestId: '1',
        operationId: 'daemon-operation-a',
        task,
      });
      await request(second.ws, {
        type: 'orchestration.execute',
        requestId: '1',
        operationId: 'daemon-operation-b',
        task,
      });

      const executions = submitted.filter((candidate) => candidate.kind === 'orchestration.execute');
      expect(executions).toHaveLength(2);
      expect(executions[1].idempotencyKey).not.toBe(executions[0].idempotencyKey);
    });

    it('scopes legacy request-id fallback to one connection', async () => {
      const root = await projectWithPanes([]);
      const submitted: any[] = [];
      const controlRuntime = {
        submit: vi.fn(async (command: any) => {
          submitted.push(command);
          if (command.kind === 'lease.request') {
            return { status: 'succeeded', value: { requestId: command.id } };
          }
          if (command.kind === 'lease.grant') {
            return { status: 'succeeded', value: { lease: { id: command.id, revision: 1 } } };
          }
          return {
            status: 'succeeded',
            value: {
              taskId: 'shared-task',
              traceId: 'shared-trace',
              status: 'completed',
              startedAt: '2026-08-18T00:00:00.000Z',
              completedAt: '2026-08-18T00:00:00.000Z',
              lanes: [],
            },
          };
        }),
      };
      const first = await buildConnection(root, {
        controlRuntime: controlRuntime as ConnectionDeps['controlRuntime'],
      });
      const reconnect = await buildConnection(root, {
        controlRuntime: controlRuntime as ConnectionDeps['controlRuntime'],
      });
      const message = {
        type: 'orchestration.execute',
        requestId: '1',
        task: {
          taskId: 'shared-task',
          projectRoot: root,
          prompt: 'Fix tests',
          lanes: [{ id: 'same-lane', mode: 'terminal' }],
        },
      };

      await request(first.ws, message);
      await request(reconnect.ws, message);

      const executions = submitted.filter((candidate) => candidate.kind === 'orchestration.execute');
      expect(executions).toHaveLength(2);
      expect(executions[1].idempotencyKey).not.toBe(executions[0].idempotencyKey);
    });

    it('rejects an oversized explicit daemon operation id before control execution', async () => {
      const root = await projectWithPanes([]);
      const controlRuntime = { submit: vi.fn() };
      const { ws } = await buildConnection(root, {
        controlRuntime: controlRuntime as unknown as ConnectionDeps['controlRuntime'],
      });

      await request(ws, {
        type: 'orchestration.execute',
        requestId: 'oversized-operation',
        operationId: 'x'.repeat(129),
        task: {
          taskId: 'task-1',
          projectRoot: root,
          prompt: 'Fix tests',
          lanes: [{ id: 'same-lane', mode: 'terminal' }],
        },
      });

      expect(ws.sent[0]).toMatchObject({
        type: 'error',
        requestId: 'oversized-operation',
        code: 'invalid_orchestration_request',
      });
      expect(controlRuntime.submit).not.toHaveBeenCalled();
    });
  });

  it('rejects a wrong token', async () => {
    const root = await projectWithPanes([]);
    const { ws } = await buildConnection(root, { authed: false });

    await request(ws, { type: 'hello', token: 'b'.repeat(64) });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect(ws.closes[0].code).toBe(4401);
  });

  it('welcomes a correct token', async () => {
    const root = await projectWithPanes([]);
    const { ws } = await buildConnection(root, { authed: false });

    await request(ws, { type: 'hello', token: TOKEN });

    expect(ws.sent[0]).toMatchObject({ type: 'welcome' });
    expect(ws.closes).toEqual([]);
  });

  it('closes a connection that never authenticates', async () => {
    vi.useFakeTimers();
    try {
      const root = await projectWithPanes([]);
      const { ws } = await buildConnection(root, { authed: false });

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
      const { ws } = await buildConnection(root, { authed: false });

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
    const { ws, tmux } = await buildConnection(root);

    await request(ws, { type: 'panes.kill', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.calls).toEqual([]);
  });

  it('will not attach to a pane this project does not own', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = await buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.listenerCount('output')).toBe(1);
  });

  it('will not focus a pane this project does not own', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = await buildConnection(root);

    await request(ws, { type: 'panes.focus', requestId: 'r1', id: FOREIGN_PANE });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'pane_not_found' });
    expect(tmux.calls).toEqual([]);
  });

  it('still serves panes the project registered, resolving psyche ids to tmux ids', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = await buildConnection(root);

    await request(ws, { type: 'panes.focus', requestId: 'r1', id: 'psyche-1' });

    expect(ws.sent[0]).toMatchObject({ type: 'ack', ok: true });
    expect(tmux.calls).toEqual([{ op: 'select', paneId: '%3' }]);
  });

  it('refuses a config pane whose id is not a usable tmux target', async () => {
    // Config is a plain file on disk, and a pane id becomes tmux command text.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: "%3'\nrun-shell 'id'" }]);
    const { ws, tmux } = await buildConnection(root);

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
    const { ws } = await buildConnection(root, { workspaceProvider });

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
    const { ws } = await buildConnection(root, {
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

describe('daemon lane creation', () => {
  it('replays an idempotent single-lane result without spawning or emitting twice', async () => {
    const root = await projectWithPanes([]);
    const spawnPane = vi.fn(async () => ({
      id: '%7',
      pane: { id: '%7', cwd: root, title: 'lane' },
      worktreePath: `${root}/.psyche/worktrees/lane`,
      branch: 'lane',
    }));
    const workspaceProvider = vi.fn(async () => ({ revision: 1, projects: [] }));
    const { ws } = await buildConnection(root, { spawnPane, workspaceProvider });

    await request(ws, {
      type: 'panes.spawn', requestId: 'first', idempotencyKey: 'lane-1', cwd: root,
      title: 'lane',
    });
    await waitFor(() => ws.sent.length === 2, 'first workspace change');
    await request(ws, {
      type: 'panes.spawn', requestId: 'replay', idempotencyKey: 'lane-1', cwd: root,
      title: 'lane',
    });

    expect(spawnPane).toHaveBeenCalledOnce();
    expect(ws.sent.map((message) => message.type)).toEqual([
      'panes.spawn.result', 'workspace.changed', 'panes.spawn.result',
    ]);
    expect(ws.sent[0]).toMatchObject({ requestId: 'first', id: '%7' });
    expect(ws.sent[2]).toMatchObject({ requestId: 'replay', id: '%7' });
  });

  it('keeps successful siblings when a batch lane launch partially fails', async () => {
    const root = await projectWithPanes([]);
    const spawnPane = vi.fn(async (
      _projectRoot: string,
      _sessionName: string,
      launch: BridgeSpawnRequest,
    ) => {
      if (launch.title === 'broken') {
        throw Object.assign(new Error('tmux refused lane'), { code: 'spawn_failed' });
      }
      return {
        id: launch.title === 'one' ? '%1' : '%3',
        pane: { id: launch.title === 'one' ? '%1' : '%3', cwd: root, title: launch.title },
        worktreePath: `${root}/.psyche/worktrees/${launch.title}`,
        branch: launch.title ?? 'lane',
      };
    });
    const { ws } = await buildConnection(root, {
      spawnPane,
      workspaceProvider: vi.fn(async () => ({ revision: 2, projects: [] })),
    });

    await request(ws, {
      type: 'panes.spawnMany', requestId: 'batch', idempotencyKey: 'batch-1',
      launches: [
        { cwd: root, title: 'one' },
        { cwd: root, title: 'broken' },
        { cwd: root, title: 'three' },
      ],
    });
    await waitFor(() => ws.sent.length === 2, 'batch workspace change');

    expect(ws.sent[0]).toEqual({
      type: 'panes.spawnMany.result',
      requestId: 'batch',
      outcomes: [
        expect.objectContaining({ index: 0, ok: true, id: '%1' }),
        { index: 1, ok: false, code: 'spawn_failed', message: 'tmux refused lane' },
        expect.objectContaining({ index: 2, ok: true, id: '%3' }),
      ],
    });
    expect(ws.sent[1].type).toBe('workspace.changed');
    expect(spawnPane).toHaveBeenCalledTimes(3);
  });

  it('rejects unbounded batches and unsafe idempotency keys before spawning', async () => {
    const root = await projectWithPanes([]);
    const spawnPane = vi.fn();
    const { ws } = await buildConnection(root, { spawnPane });

    await request(ws, {
      type: 'panes.spawnMany', requestId: 'empty', idempotencyKey: 'batch', launches: [],
    });
    await request(ws, {
      type: 'panes.spawnMany', requestId: 'unsafe', idempotencyKey: 'bad key',
      launches: [{ cwd: root }],
    });

    expect(ws.sent).toEqual([
      expect.objectContaining({ requestId: 'empty', code: 'invalid_batch' }),
      expect.objectContaining({ requestId: 'unsafe', code: 'invalid_idempotency_key' }),
    ]);
    expect(spawnPane).not.toHaveBeenCalled();
  });
});

describe('daemon connection resilience', () => {
  it('answers a malformed attach with an error instead of dying', async () => {
    // Regression: `panes.attach` with no `id` threw out of the async dispatch
    // chain. Nothing caught it, so one frame killed the daemon.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws } = await buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1' });

    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'missing_pane' });

    // Still serving.
    await request(ws, { type: 'panes.list', requestId: 'r2' });
    expect(ws.sent[1]).toMatchObject({ type: 'panes.list.result', requestId: 'r2' });
  });

  it('reports an unexpected handler failure as an error frame', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const paneOutput = { subscribe: () => { throw new Error('fanout exploded'); } };
    const { ws } = await buildConnection(root, { paneOutput });

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });

    expect(ws.sent.some((m) => m.code === 'internal_error')).toBe(true);
  });

  it('rejects malformed base64 input rather than sending mangled keys', async () => {
    // Regression: this was a try/catch, which never fired — Buffer.from with
    // 'base64' skips characters outside the alphabet instead of throwing.
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = await buildConnection(root);

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
    const { ws } = await buildConnection(root);

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
    const { ws, tmux } = await buildConnection(root);

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
    const { ws, tmux } = await buildConnection(root);

    expect(tmux.listenerCount('output')).toBe(1);
    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    await request(ws, { type: 'panes.attach', requestId: 'r2', id: '%4' });
    expect(tmux.listenerCount('output')).toBe(1);

    ws.emit('close');
    expect(tmux.listenerCount('output')).toBe(1);
  });

  it('detaches the connection subscriber without removing the global listener', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const { ws, tmux } = await buildConnection(root);

    await request(ws, { type: 'panes.attach', requestId: 'r1', id: '%3' });
    const streamId = ws.sent.find((m) => m.type === 'panes.attach.result').streamId;
    expect(tmux.listenerCount('output')).toBe(1);

    await request(ws, { type: 'panes.detach', requestId: 'r2', streamId });
    expect(tmux.listenerCount('output')).toBe(1);
  });

  it('routes pane output only to the streams watching that pane', async () => {
    const root = await projectWithPanes([
      { id: 'psyche-1', paneId: '%3' },
      { id: 'psyche-2', paneId: '%4' },
    ]);
    const { ws, tmux } = await buildConnection(root);

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

  it('closes a slow client while a healthy client continues on the sole output listener', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const tmux = new RecordingTmux('psyche-test');
    const paneOutput = new PaneOutputFanout(tmux);
    const slow = await buildConnection(root, { tmux, paneOutput });
    const healthy = await buildConnection(root, { tmux, paneOutput });
    await request(slow.ws, { type: 'panes.attach', requestId: 'slow', id: '%3' });
    await request(healthy.ws, { type: 'panes.attach', requestId: 'healthy', id: '%3' });
    const healthyBefore = healthy.ws.binary.length;
    slow.ws.bufferedAmount = MAX_CONNECTION_BUFFERED_BYTES;

    tmux.emit('output', '%3', Buffer.from('one'));
    expect(slow.ws.closes).toEqual([{ code: 4409, reason: 'pane output backpressure' }]);
    expect(healthy.ws.binary).toHaveLength(healthyBefore + 1);
    tmux.emit('output', '%3', Buffer.from('two'));
    expect(healthy.ws.binary).toHaveLength(healthyBefore + 2);
    expect(tmux.listenerCount('output')).toBe(1);
  });
});
