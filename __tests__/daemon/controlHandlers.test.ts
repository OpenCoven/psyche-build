import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import { PaneObservationStore } from '../../src/control/resources/paneObservation.js';
import type { ControlCommand, PaneNamedKey } from '../../src/control/types.js';
import { SurfaceRegistry } from '../../src/control/surfaces.js';
import { ControlRuntime } from '../../src/control/runtime.js';
import { CapabilityLeaseStore } from '../../src/control/capabilityLeases.js';
import { ApprovalStore } from '../../src/control/approvals.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';

describe('createDaemonControlHandlers executeOrchestration', () => {
  it('uses the authorized task and daemon root while preserving validated claimed cwd', async () => {
    const projectRoot = await realpath(process.cwd());
    const completed = {
      taskId: 'authorized-task',
      traceId: 'trace-1',
      status: 'completed' as const,
      startedAt: '2026-08-17T12:00:00.000Z',
      completedAt: '2026-08-17T12:00:01.000Z',
      lanes: [],
    };
    const execute = vi.fn(async () => completed);
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot,
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      orchestrator: { execute },
    });

    const authorizeEffect = vi.fn(async () => undefined);
    const result = await handlers.executeOrchestration(
      {
        taskId: 'authorized-task',
        leaseId: 'lease-1',
        leaseRevision: 1,
        request: {
          taskId: 'caller-task',
          projectRoot: path.join(projectRoot, 'src'),
          cwd: 'daemon',
          prompt: 'test',
          lanes: [{ id: 'one', mode: 'terminal' }],
        },
      },
      authorizeEffect,
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'authorized-task',
        projectRoot,
        cwd: path.join(projectRoot, 'src', 'daemon'),
      }),
      { beforeLaneEffect: authorizeEffect },
    );
    expect(result).toEqual(completed);
  });
});

function handlersWithCovenClient(
  sendInput: (sessionId: string, input: string) => Promise<void>,
  projectRoot = '/tmp/psyche-test-root',
  sessionIds = ['sess-1'],
) {
  const sessions = sessionIds.map((id) => ({
    id,
    projectRoot,
    harness: 'codex' as const,
    title: id,
    status: 'running' as const,
    createdAt: '2026-04-27T10:00:00Z',
    updatedAt: '2026-04-27T10:01:00Z',
  }));
  return createDaemonControlHandlers({
    tmux: new TmuxControl('psyche-test'),
    projectRoot,
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => ({
      listSessions: async () => sessions,
      getSession: async (id: string) => sessions.find((session) => session.id === id)!,
      sendInput,
    }),
  });
}

describe('createDaemonControlHandlers runCovenDesktopAction', () => {
  it('sends a known desktop quick action to the coven client', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-handler-'));
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput, root);

    try {
      const result = await handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'screenshot' });

      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(sendInput.mock.calls[0][0]).toBe('sess-1');
      expect(sendInput.mock.calls[0][1]).toContain('computer_use');
      expect(result).toMatchObject({ sessionId: 'sess-1', action: 'screenshot', accepted: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not send desktop input to a session outside the project scope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-outside-'));
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});

    try {
      // Build handlers for root while the client reports its session under outside.
      const scopedHandlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({
          listSessions: async () => [],
          getSession: async (_id: string) => ({
            id: 'sess-1', projectRoot: outside, harness: 'codex', title: 'Outside', status: 'running',
            createdAt: '2026-04-27T10:00:00Z', updatedAt: '2026-04-27T10:01:00Z',
          }),
          sendInput,
        }),
      });
      await expect(scopedHandlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'approve' }))
        .rejects.toMatchObject({ code: 'coven_session_not_found' });
      expect(sendInput).not.toHaveBeenCalled();
    } finally {
      await Promise.all([root, outside].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  it('uses the canonical session id returned after scope validation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-canonical-'));
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});

    try {
      const handlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({
          listSessions: async () => [],
          getSession: async () => ({
            id: 'canonical-session',
            projectRoot: root,
            harness: 'codex',
            title: 'Canonical',
            status: 'running',
            createdAt: '2026-04-27T10:00:00Z',
            updatedAt: '2026-04-27T10:01:00Z',
          }),
          sendInput,
        }),
      });

      const result = await handlers.runCovenDesktopAction({
        sessionId: 'requested-session',
        action: 'approve',
      });

      expect(sendInput).toHaveBeenCalledWith('canonical-session', expect.any(String));
      expect(result).toMatchObject({
        sessionId: 'canonical-session',
        action: 'approve',
        accepted: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown desktop action instead of sending undefined input', async () => {
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput);

    await expect(
      handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'not-a-real-action' }),
    ).rejects.toMatchObject({ code: 'invalid_desktop_action' });
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe('createDaemonControlHandlers updatePaneMeta', () => {
  it('patches the pane registry through the bridge', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-meta-handler-'));
    try {
      await mkdir(path.join(root, '.psyche'), { recursive: true });
      const configPath = path.join(root, '.psyche', 'psyche.config.json');
      await writeFile(
        configPath,
        JSON.stringify({ panes: [{ id: 'psyche-1', paneId: '%3', title: 'old', agent: 'codex' }] }, null, 2),
      );

      const handlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({ listSessions: async () => [] }),
      });

      await handlers.updatePaneMeta({ paneId: '%3', title: 'renamed', agent: 'claude' });

      const config = JSON.parse(await readFile(configPath, 'utf8'));
      expect(config.panes[0]).toMatchObject({ paneId: '%3', title: 'renamed', agent: 'claude' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects when the pane is not in the registry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-meta-handler-'));
    try {
      await mkdir(path.join(root, '.psyche'), { recursive: true });
      await writeFile(
        path.join(root, '.psyche', 'psyche.config.json'),
        JSON.stringify({ panes: [] }, null, 2),
      );

      const handlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({ listSessions: async () => [] }),
      });

      await expect(
        handlers.updatePaneMeta({ paneId: '%404', title: 'x' }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('createDaemonControlHandlers executeOrchestration', () => {
  it('executes the canonical task through the configured orchestrator', async () => {
    const executeLane = vi.fn(async () => ({}));
    const orchestrator = new Orchestrator({ executeLane });
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot: process.cwd(),
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      orchestrator,
    } as any);

    const result = await handlers.executeOrchestration(
      {
        taskId: 'task-1',
        leaseId: 'lease-1',
        leaseRevision: 1,
        request: {
          taskId: 'task-1',
          projectRoot: process.cwd(),
          prompt: 'Fix tests',
          lanes: [{ id: 'terminal', mode: 'terminal' }],
        },
      },
      async () => undefined,
    );

    expect(executeLane).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      taskId: 'task-1',
      status: 'completed',
      lanes: [{ id: 'terminal', status: 'completed' }],
    });
  });
});

function paneHandlerHarness() {
  const sendKeysHex = vi.fn(async () => {});
  const killPane = vi.fn(async (_paneId: string) => {});
  const executeCommand = vi.fn(async () => {});
  const executeCommandWithOutput = vi.fn(async (line: string) =>
    line.includes('pane_active') ? ['1'] : ['120 40']);
  const spawnPane = vi.fn(async () => ({
    id: '%9',
    pane: { id: '%9', cwd: '/repo/.psyche/worktrees/test', title: 'Agent', agent: 'codex' },
    worktreePath: '/repo/.psyche/worktrees/test',
    branch: 'feat/test',
  }));
  const observations = new PaneObservationStore();
  const surfaces = new SurfaceRegistry();
  surfaces.upsertPane({
    id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
    writable: true, outputSequence: 0,
  });
  const refreshPaneSurfaces = vi.fn(async () => {
    const stable = surfaces.upsertPane({
      id: 'psyche-9', tmuxPaneId: '%9', projectRoot: '/repo',
      worktreeRoot: '/repo/.psyche/worktrees/test', title: 'Agent', agent: 'codex',
      writable: true, outputSequence: 0,
    });
    return [stable];
  });
  const handlers = createDaemonControlHandlers({
    tmux: {
      sendKeysHex, killPane, executeCommand, executeCommandWithOutput,
    } as unknown as TmuxControl,
    projectRoot: '/repo',
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    spawnPane,
    paneObservations: observations,
    surfaces,
    refreshPaneSurfaces,
    closePane: async (_projectRoot, _paneId) => killPane('%3'),
  });
  return {
    handlers, observations, surfaces, sendKeysHex, killPane, executeCommand,
    executeCommandWithOutput, spawnPane, refreshPaneSurfaces,
  };
}

const paneAuthorization = {
  taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, paneId: 'pane-1', generation: 1,
};

describe('createDaemonControlHandlers leased pane controls', () => {
  it('observes bounded output without exposing a journal dependency', async () => {
    const { handlers, observations } = paneHandlerHarness();
    observations.append('pane-1', Buffer.from('one'));
    observations.append('pane-1', Buffer.from('two'));

    await expect(handlers.observePane({ ...paneAuthorization, afterSequence: 1 })).resolves.toMatchObject({
      paneId: 'pane-1', fromSequence: 2, nextSequence: 2, text: 'two', truncated: false,
    });
    expect(observations).not.toHaveProperty('journal');
  });

  it('sends exact UTF-8 bytes for send_text', async () => {
    const { handlers, sendKeysHex } = paneHandlerHarness();

    await handlers.actOnPane({ ...paneAuthorization, action: { kind: 'send_text', text: 'hi 🧪' } });

    expect(sendKeysHex).toHaveBeenCalledOnce();
    expect(sendKeysHex).toHaveBeenCalledWith('%3', Buffer.from('hi 🧪', 'utf8'));
  });

  it('sends only allowlisted named keys through one acknowledged command', async () => {
    const { handlers, executeCommand } = paneHandlerHarness();

    await handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'send_keys', keys: ['Enter', 'C-c', 'Left'] },
    });

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith("send-keys -t '%3' Enter C-c Left");
  });

  it('rejects non-allowlisted keys before dispatch', async () => {
    const { handlers, executeCommand } = paneHandlerHarness();
    const keys = ['Enter', 'run-shell'] as unknown as readonly PaneNamedKey[];

    await expect(handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'send_keys', keys },
    })).rejects.toMatchObject({ code: 'invalid_pane_key' });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('acknowledges interrupt, focus, and resize with postconditions', async () => {
    const { handlers, executeCommand, executeCommandWithOutput } = paneHandlerHarness();

    await expect(handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'interrupt', key: 'C-c' },
    })).resolves.toMatchObject({ paneId: 'pane-1', interrupted: true });
    await expect(handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'focus' },
    })).resolves.toMatchObject({ paneId: 'pane-1', focused: true });
    await expect(handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'resize', cols: 120, rows: 40 },
    })).resolves.toMatchObject({ paneId: 'pane-1', cols: 120, rows: 40 });
    expect(executeCommand.mock.calls).toEqual([
      ["send-keys -t '%3' C-c"],
    ]);
    expect(executeCommandWithOutput).toHaveBeenCalledTimes(2);
  });

  it('rejects pane effects when refreshPaneSurfaces is unavailable', async () => {
    const sendKeysHex = vi.fn(async () => {});
    const handlers = createDaemonControlHandlers({
      tmux: { sendKeysHex } as unknown as TmuxControl,
      projectRoot: '/repo',
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      surfaces: new SurfaceRegistry(),
    });

    await expect(handlers.actOnPane({
      ...paneAuthorization, action: { kind: 'send_text', text: 'hi' },
    })).rejects.toMatchObject({ code: 'backend_unavailable' });
    expect(sendKeysHex).not.toHaveBeenCalled();
  });

  it('creates through the canonical project scope', async () => {
    const { handlers, surfaces, spawnPane, refreshPaneSurfaces } = paneHandlerHarness();

    const result = await handlers.actOnPane({
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, projectId: '/repo',
      action: { kind: 'create', cwd: '/repo', title: 'Agent', agent: 'codex', branch: 'feat/test' },
    });

    expect(spawnPane).toHaveBeenCalledWith('/repo', 'psyche-test', expect.objectContaining({
      cwd: '/repo', title: 'Agent', agent: 'codex', branch: 'feat/test',
    }));
    expect(refreshPaneSurfaces).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: 'psyche-9', pane: { id: 'psyche-9' } });
    expect(result).not.toMatchObject({ id: '%9' });
    expect(surfaces.get('psyche-9')).toMatchObject({ tmuxPaneId: '%9' });
    expect(surfaces.get('%9')).toBeUndefined();
  });

  it('closes only after runtime approval and executes the immutable original once', async () => {
    const { handlers, surfaces, killPane } = paneHandlerHarness();
    const now = () => new Date('2026-08-12T12:00:00.000Z');
    const leases = new CapabilityLeaseStore(now, 7);
    const approvals = new ApprovalStore(now, () => 'approval-close');
    const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7,
      handlers,
      journal: {
        append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
          const event = { sequence: events.length + 1, kind, payload };
          events.push(event);
          return event;
        }),
        read: () => [...events],
        findByIdempotencyKey: (key: string) =>
          [...events].reverse().find((event) => event.payload.idempotencyKey === key),
        recoverNonterminalCommands: vi.fn(async () => []),
      },
      surfaces,
      capabilityLeases: leases,
      approvals,
    });
    const makeCommand = (input: Partial<ControlCommand> & Pick<ControlCommand, 'id' | 'kind' | 'payload'>) => ({
      idempotencyKey: input.id,
      projectRoot: '/repo',
      actor: { id: 'operator-1', kind: 'human' as const },
      ownerEpoch: 7,
      createdAt: '2026-08-12T12:00:00.000Z',
      ...input,
    }) as ControlCommand;
    await runtime.submit(makeCommand({
      id: 'request-close', kind: 'lease.request', actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 1 }, capabilities: ['pane.close'] }],
      },
    }));
    const granted = await runtime.submit(makeCommand({
      id: 'grant-close', kind: 'lease.grant', payload: { requestId: 'request-close' },
    }));
    const lease = (granted as { value: { lease: { id: string; revision: number } } }).value.lease;
    const close = makeCommand({
      id: 'close-pane', kind: 'pane.action', actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        paneId: 'pane-1', generation: 1, action: { kind: 'close' },
      },
    }) as Extract<ControlCommand, { kind: 'pane.action' }>;
    const requested = await runtime.submit(close);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    expect(requested).toMatchObject({ status: 'succeeded', value: { state: 'approval_required' } });
    expect(killPane).not.toHaveBeenCalled();

    (close.payload as { action: unknown }).action = { kind: 'send_text', text: 'substituted' };
    await expect(runtime.submit(makeCommand({
      id: 'approve-close', kind: 'approval.resolve', payload: {
        approvalId: approval.approvalId, payloadDigest: approval.payloadDigest, decision: 'approve',
      },
    }))).resolves.toMatchObject({ status: 'succeeded', value: { state: 'succeeded' } });
    expect(killPane).toHaveBeenCalledOnce();
    expect(killPane).toHaveBeenCalledWith('%3');
  });

  it('rejects raw tmux syntax and newline pane ids before any effect', async () => {
    const {
      handlers, surfaces, sendKeysHex, executeCommand, executeCommandWithOutput,
    } = paneHandlerHarness();
    surfaces.upsertPane({
      id: 'malicious', tmuxPaneId: "%3\nrun-shell 'id'", projectRoot: '/repo', worktreeRoot: '/repo',
      writable: true, outputSequence: 0,
    });

    await expect(handlers.actOnPane({
      ...paneAuthorization, paneId: 'malicious', action: { kind: 'send_text', text: 'x' },
    })).rejects.toThrow(/invalid pane id/);
    expect(sendKeysHex).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(executeCommandWithOutput).not.toHaveBeenCalled();
  });
});

describe('createDaemonControlHandlers browser provider', () => {
  it('dispatches typed inspect, action, and script operations through the broker', async () => {
    const dispatch = vi.fn(async () => ({
      actionId: 'provider-action', status: 'succeeded' as const, value: { ok: true },
    }));
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot: '/repo', sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      browserProvider: { dispatch },
    });
    const authorization = {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2,
    };

    await expect(handlers.inspectBrowser({ ...authorization, includeScreenshot: true }))
      .resolves.toEqual({ ok: true });
    await expect(handlers.actOnBrowser({ ...authorization, action: { kind: 'reload' } }))
      .resolves.toEqual({ ok: true });
    await expect(handlers.runBrowserScript({ ...authorization, source: 'return 1' }))
      .resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tabId: 'tab-1', generation: 2,
      operation: { kind: 'inspect', includeScreenshot: true },
      timeoutMs: 15_000,
    }));
    expect(dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: { kind: 'action', action: { kind: 'reload' } },
      timeoutMs: 15_000,
    }));
    expect(dispatch).toHaveBeenNthCalledWith(3, expect.objectContaining({
      operation: { kind: 'script', source: 'return 1' },
      timeoutMs: 5_000,
    }));
  });
});
