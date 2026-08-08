import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection, type ConnectionDeps } from '../../src/daemon/index.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import type { CommandOutcome, ControlCommand } from '../../src/control/types.js';

/**
 * The daemon is no longer allowed to mutate panes directly: every v0 pane
 * mutation must be translated into a canonical control command submitted to the
 * runtime. These tests pin the translation shape and the mechanical
 * source-boundary that keeps the effect surface in one place.
 */

const TOKEN = 'a'.repeat(64);

let tempRoots: string[] = [];

async function projectWithPanes(panes: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-control-adapter-'));
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

class FakeSocket extends EventEmitter {
  readonly sent: any[] = [];
  readonly binary: Buffer[] = [];
  send(data: string | Buffer): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data));
    else this.binary.push(data);
  }
  close(): void {}
  deliver(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg), 'utf8'), false);
  }
}

/**
 * A control runtime whose only job is to record the commands the daemon submits
 * and hand back a caller-controlled outcome per command kind.
 */
function spyRuntime(
  outcomeFor: (command: ControlCommand) => CommandOutcome = () => ({ status: 'succeeded' }),
) {
  const submitted: ControlCommand[] = [];
  const submit = vi.fn(async (command: ControlCommand): Promise<CommandOutcome> => {
    submitted.push(command);
    return outcomeFor(command);
  });
  return { submitted, submit } satisfies {
    submitted: ControlCommand[];
    submit: ConnectionDeps['controlRuntime']['submit'];
  };
}

function buildConnection(
  projectRoot: string,
  controlRuntime: ConnectionDeps['controlRuntime'],
) {
  const ws = new FakeSocket();
  const tmux = new TmuxControl('psyche-test');
  const deps: ConnectionDeps = {
    token: TOKEN,
    projectRoot,
    serverVersion: 'test',
    authedViaHeader: true,
    tmux,
    controlRuntime,
    ownerEpoch: 1,
  };
  const conn = new Connection(ws as any, deps);
  conn.bind();
  ws.sent.length = 0; // drop the welcome frame
  return { ws, conn };
}

async function request(ws: FakeSocket, msg: any, label = 'reply'): Promise<void> {
  const before = ws.sent.length;
  ws.deliver(msg);
  const deadline = Date.now() + 5000;
  while (ws.sent.length === before) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function attachStream(ws: FakeSocket, paneId: string): Promise<string> {
  await request(ws, { type: 'panes.attach', requestId: `attach-${paneId}`, id: paneId });
  const result = ws.sent.find((m) => m.type === 'panes.attach.result');
  if (!result) throw new Error('no attach result');
  return result.streamId as string;
}

describe('daemon control adapter translation', () => {
  it('translates interactive input into a human takeover then input', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const runtime = spyRuntime((command) =>
      command.kind === 'pane.takeover'
        ? { status: 'succeeded', value: { actorId: 'human', revision: 7 } }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);

    const streamId = await attachStream(ws, '%3');
    runtime.submitted.length = 0;

    await request(ws, {
      type: 'panes.input',
      requestId: 'in-1',
      streamId,
      data: Buffer.from('ls\r').toString('base64'),
    });

    expect(runtime.submitted.map((c) => c.kind)).toEqual(['pane.takeover', 'pane.input']);
    const [takeover, input] = runtime.submitted;
    expect(takeover.actor.kind).toBe('human');
    expect(takeover.payload).toMatchObject({ paneId: '%3' });
    expect(input.actor.kind).toBe('human');
    expect(input.payload).toMatchObject({
      paneId: '%3',
      dataBase64: Buffer.from('ls\r').toString('base64'),
      leaseRevision: 7,
    });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'ack', ok: true });
  });

  it('reuses a cached lease across keystrokes without re-taking the pane', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const runtime = spyRuntime((command) =>
      command.kind === 'pane.takeover'
        ? { status: 'succeeded', value: { actorId: 'human', revision: 1 } }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);
    const streamId = await attachStream(ws, '%3');
    runtime.submitted.length = 0;

    await request(ws, {
      type: 'panes.input', requestId: 'a', streamId,
      data: Buffer.from('a').toString('base64'),
    });
    await request(ws, {
      type: 'panes.input', requestId: 'b', streamId,
      data: Buffer.from('b').toString('base64'),
    });

    const takeovers = runtime.submitted.filter((c) => c.kind === 'pane.takeover');
    const inputs = runtime.submitted.filter((c) => c.kind === 'pane.input');
    // One takeover acquires the lease; the second keystroke reuses the cache.
    expect(takeovers).toHaveLength(1);
    expect(inputs).toHaveLength(2);
    // Each keystroke must carry a distinct key so none is deduped.
    expect(inputs[0].idempotencyKey).not.toBe(inputs[1].idempotencyKey);
    for (const input of inputs) {
      expect(input.payload).toMatchObject({ leaseRevision: 1 });
    }
  });

  it('re-acquires the lease and retries when a keystroke hits a stale revision', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    let revision = 1;
    let failNextInput = false;
    const runtime = spyRuntime((command) => {
      if (command.kind === 'pane.takeover') {
        return { status: 'succeeded', value: { actorId: 'human', revision } };
      }
      if (command.kind === 'pane.input') {
        if (failNextInput) {
          failNextInput = false;
          // Simulate another actor having preempted the pane: our cached
          // revision is now stale.
          revision = 5;
          return { status: 'failed', code: 'lease_revision_mismatch', message: 'lease revision mismatch' };
        }
        return { status: 'succeeded' };
      }
      return { status: 'succeeded' };
    });
    const { ws } = buildConnection(root, runtime);
    const streamId = await attachStream(ws, '%3');

    // First keystroke acquires revision 1.
    await request(ws, {
      type: 'panes.input', requestId: 'first', streamId,
      data: Buffer.from('x').toString('base64'),
    });
    runtime.submitted.length = 0;

    // Next keystroke is rejected as stale, forcing a fresh takeover + retry.
    failNextInput = true;
    await request(ws, {
      type: 'panes.input', requestId: 'second', streamId,
      data: Buffer.from('y').toString('base64'),
    });

    const takeovers = runtime.submitted.filter((c) => c.kind === 'pane.takeover');
    const inputs = runtime.submitted.filter((c) => c.kind === 'pane.input');
    // Exactly one re-takeover with a rotated key, then a successful retry.
    expect(takeovers).toHaveLength(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].payload).toMatchObject({ leaseRevision: 5 });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'ack', ok: true });
  });

  it('translates resize into a canonical pane.resize', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const runtime = spyRuntime();
    const { ws } = buildConnection(root, runtime);
    const streamId = await attachStream(ws, '%3');
    runtime.submitted.length = 0;

    await request(ws, { type: 'panes.resize', requestId: 'rz', streamId, cols: 120, rows: 40 });

    expect(runtime.submitted).toHaveLength(1);
    expect(runtime.submitted[0].kind).toBe('pane.resize');
    expect(runtime.submitted[0].payload).toMatchObject({ paneId: '%3', cols: 120, rows: 40 });
  });

  it('translates kill into a canonical pane.kill', async () => {
    const root = await projectWithPanes([{ id: 'psyche-1', paneId: '%3' }]);
    const runtime = spyRuntime();
    const { ws } = buildConnection(root, runtime);

    await request(ws, { type: 'panes.kill', requestId: 'k', id: '%3' });

    const kills = runtime.submitted.filter((c) => c.kind === 'pane.kill');
    expect(kills).toHaveLength(1);
    expect(kills[0].payload).toMatchObject({ paneId: '%3' });
  });

  it('translates spawn into a compatibility pane.spawn carrying the v0 request', async () => {
    const root = await projectWithPanes([]);
    const runtime = spyRuntime((command) =>
      command.kind === 'pane.spawn'
        ? {
            status: 'succeeded',
            value: {
              id: '%9',
              pane: { id: '%9', cwd: root, title: 'lane' },
              worktreePath: `${root}/.psyche/worktrees/lane`,
              branch: 'lane',
            },
          }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);

    await request(ws, {
      type: 'panes.spawn', requestId: 'sp', idempotencyKey: 'lane-1', cwd: root, title: 'lane',
    });

    const spawns = runtime.submitted.filter((c) => c.kind === 'pane.spawn');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].actor.kind).toBe('compatibility');
    expect(spawns[0].payload).toMatchObject({ cwd: root, title: 'lane' });
    expect(ws.sent[0]).toMatchObject({ type: 'panes.spawn.result', requestId: 'sp', id: '%9' });
  });
});

describe('daemon coven adapter translation', () => {
  it('translates a coven session launch into a canonical coven.session.launch', async () => {
    const root = await projectWithPanes([]);
    const session = {
      id: 'sess-1', projectRoot: root, harness: 'codex', title: 'Fix', status: 'running',
      createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z',
    };
    const runtime = spyRuntime((command) =>
      command.kind === 'coven.session.launch'
        ? { status: 'succeeded', value: session }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);

    await request(ws, {
      type: 'coven.sessions.launch',
      requestId: 'cl',
      launch: { harness: 'codex', prompt: 'Fix the bug', cwd: root, title: 'Fix' },
    });

    const launches = runtime.submitted.filter((c) => c.kind === 'coven.session.launch');
    expect(launches).toHaveLength(1);
    expect(launches[0].actor.kind).toBe('compatibility');
    expect(launches[0].payload).toMatchObject({ harness: 'codex', prompt: 'Fix the bug', cwd: root, title: 'Fix' });
    expect(ws.sent.find((m) => m.type === 'coven.sessions.launch.result')).toMatchObject({
      requestId: 'cl',
      session,
    });
  });

  it('translates a coven session open into a canonical coven.session.open', async () => {
    const root = await projectWithPanes([]);
    const opened = { id: '%7', pane: { id: '%7', cwd: root, title: 'coven' }, session: { id: 'sess-9' } };
    const runtime = spyRuntime((command) =>
      command.kind === 'coven.session.open'
        ? { status: 'succeeded', value: opened }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);

    await request(ws, { type: 'coven.sessions.open', requestId: 'co', id: 'sess-9' });

    const opens = runtime.submitted.filter((c) => c.kind === 'coven.session.open');
    expect(opens).toHaveLength(1);
    expect(opens[0].payload).toMatchObject({ sessionId: 'sess-9' });
    expect(ws.sent.find((m) => m.type === 'coven.sessions.open.result')).toMatchObject({
      requestId: 'co', id: '%7', session: { id: 'sess-9' },
    });
  });

  it('translates a coven desktop action into a canonical coven.desktop.action', async () => {
    const root = await projectWithPanes([]);
    const runtime = spyRuntime();
    const { ws } = buildConnection(root, runtime);

    await request(ws, {
      type: 'coven.desktop.action', requestId: 'cd', sessionId: 'sess-3', action: 'screenshot',
    });

    const actions = runtime.submitted.filter((c) => c.kind === 'coven.desktop.action');
    expect(actions).toHaveLength(1);
    expect(actions[0].payload).toMatchObject({ sessionId: 'sess-3', action: 'screenshot' });
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'coven.desktop.action.result', requestId: 'cd', sessionId: 'sess-3', action: 'screenshot', accepted: true,
    });
  });

  it('translates a coven capability execution carrying the full v0 request', async () => {
    const root = await projectWithPanes([]);
    const execution = { output: { harness: 'codex' }, trace: { taskId: 'task-1' } };
    const runtime = spyRuntime((command) =>
      command.kind === 'coven.capability.execute'
        ? { status: 'succeeded', value: { sessionId: 'sess-2', execution } }
        : { status: 'succeeded' },
    );
    const { ws } = buildConnection(root, runtime);

    await request(ws, {
      type: 'coven.capabilities.execute',
      requestId: 'cc',
      sessionId: 'sess-2',
      capability: {
        taskId: 'task-1', capability: 'planning', prompt: 'Plan it',
        title: 'Planner', state: { step: 1 }, attempt: 2, traceId: 'trace-1',
        idempotencyKey: 'idem-1',
      },
    });

    const execs = runtime.submitted.filter((c) => c.kind === 'coven.capability.execute');
    expect(execs).toHaveLength(1);
    // A client-supplied idempotency key must be threaded so retries dedupe.
    expect(execs[0].idempotencyKey).toContain('idem-1');
    // The additive fields carried from the v0 request must survive translation.
    expect(execs[0].payload).toMatchObject({
      sessionId: 'sess-2', capability: 'planning', prompt: 'Plan it', taskId: 'task-1',
      traceId: 'trace-1', title: 'Planner', state: { step: 1 }, attempt: 2,
    });
    expect(ws.sent.find((m) => m.type === 'coven.capabilities.execute.result')).toMatchObject({
      requestId: 'cc', sessionId: 'sess-2', execution,
    });
  });
});

describe('daemon pane-mutation source boundary', () => {
  it('never reaches the forbidden pane-mutation effects directly', async () => {
    const indexPath = fileURLToPath(new URL('../../src/daemon/index.ts', import.meta.url));
    const source = await readFile(indexPath, 'utf8');
    const forbidden =
      /this\.deps\.tmux\.(sendKeysHex|resizePane|selectPane|killPane)|spawnBridgePane\(/;
    expect(source).not.toMatch(forbidden);
  });

  it('never performs coven session mutations directly in dispatch', async () => {
    const indexPath = fileURLToPath(new URL('../../src/daemon/index.ts', import.meta.url));
    const source = await readFile(indexPath, 'utf8');
    // Mutations are routed through the runtime; the daemon must not call the
    // coven mutation effects or the capability router directly.
    const forbidden =
      /launchProjectCovenSession\(|openProjectCovenSession\(|routeProjectCovenSessionCapability\(|buildDesktopUseQuickInput\(|this\.deps\.capabilityRouter/;
    expect(source).not.toMatch(forbidden);
    // Read-only coven ops stay direct and must remain reachable.
    expect(source).toMatch(/listProjectCovenSessions\(/);
  });
});
