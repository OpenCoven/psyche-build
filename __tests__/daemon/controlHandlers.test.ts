import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserScriptContextResolver, createBrowserSnapshotResolver, createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import { SurfaceRegistry } from '../../src/control/surfaces.js';
import { PaneObservationStore } from '../../src/control/resources/paneObservation.js';
import { PaneResourceController } from '../../src/control/resources/panes.js';
import type { ControlCommand, PaneNamedKey } from '../../src/control/types.js';
import { ControlRuntime } from '../../src/control/runtime.js';
import { CapabilityLeaseStore } from '../../src/control/capabilityLeases.js';
import { ApprovalStore } from '../../src/control/approvals.js';

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
      getSession: async (id: string) => sessions.find((session) => session.id === id) ?? null,
      sendInput,
    }),
  });
}

function paneHandlerHarness() {
  const tmux = {
    sendKeysHexAcknowledged: vi.fn(async () => {}),
    sendNamedKeysAcknowledged: vi.fn(async () => {}),
    selectPaneAcknowledged: vi.fn(async () => {}),
    resizePaneAcknowledged: vi.fn(async () => {}),
    killPaneAcknowledged: vi.fn(async () => {}),
    queryPane: vi.fn(async (paneId: string) => ({ paneId, cols: 100, rows: 30, focused: true })),
  };
  const observations = new PaneObservationStore();
  const panes = new PaneResourceController({
    surfaces: new SurfaceRegistry(), observations,
    projectRoot: '/tmp/psyche-test-root',
  });
  const pane = panes.upsert({
    id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/tmp/psyche-test-root/wt',
    title: 'Agent', agent: 'codex', writable: true,
  });
  const spawnPane = vi.fn();
  const handlers = createDaemonControlHandlers({
    tmux: tmux as unknown as TmuxControl,
    panes,
    projectRoot: '/tmp/psyche-test-root',
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => ({ listSessions: async () => [] }),
    spawnPane,
  });
  const auth = {
    taskId: 'task', leaseId: 'lease', leaseRevision: 1,
    paneId: pane.id, generation: pane.generation,
  };
  return { handlers, tmux, observations, panes, pane, auth, spawnPane };
}

describe('createDaemonControlHandlers agent pane surfaces', () => {
  it('resolves a browser script context through a source-free provider preflight', async () => {
    const dispatch = vi.fn(async () => ({ status: 'succeeded', value: {
      documentId: 'document-1', documentToken: 'opaque-token', navigationEpoch: 4,
      navigationUrl: 'https://example.test/path',
    } }));
    const resolve = createBrowserScriptContextResolver({ dispatch } as never);
    await expect(resolve({ tabId: 'tab-1', generation: 3 })).resolves.toEqual({
      tabId: 'tab-1', generation: 3, documentId: 'document-1', documentToken: 'opaque-token',
      navigationEpoch: 4, navigationUrl: 'https://example.test/path',
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1', generation: 3,
      operation: { kind: 'script_context' } }));
  });

  it('binds script dispatch to the exact approved context without adding raw context to results', async () => {
    const dispatch = vi.fn(async () => ({ status: 'succeeded', value: { value: 1, byteCount: 1, durationMs: 2 } }));
    const handlers = createDaemonControlHandlers({ tmux: new TmuxControl('psyche-test'),
      projectRoot: '/tmp/psyche-test-root', sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }), browserProviders: { dispatch } as never });
    const context = { tabId: 'tab-1', generation: 3, documentId: 'document-1',
      documentToken: 'opaque-token', navigationEpoch: 4, navigationUrl: 'https://example.test/path' };
    await handlers.runBrowserScript({ taskId: 'task', leaseId: 'lease', leaseRevision: 1,
      tabId: 'tab-1', generation: 3, source: 'return 1' }, 'action-1', context);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: {
      kind: 'script', source: 'return 1', expectedContext: {
        documentId: 'document-1', documentToken: 'opaque-token', navigationEpoch: 4,
        navigationUrl: 'https://example.test/path',
      },
    } }));
  });

  it('marks an exhausted browser-script realm pool as non-retryable', async () => {
    const dispatch = vi.fn(async () => ({ status: 'failed', code: 'script_realm_limit',
      message: 'browser script realm limit reached', durationMs: 17 }));
    const handlers = createDaemonControlHandlers({ tmux: new TmuxControl('psyche-test'),
      projectRoot: '/tmp/psyche-test-root', sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }), browserProviders: { dispatch } as never });
    await expect(handlers.runBrowserScript({ taskId: 'task', leaseId: 'lease', leaseRevision: 1,
      tabId: 'tab-1', generation: 3, source: 'return 1' }, 'action-1', {
      tabId: 'tab-1', generation: 3, documentId: 'document-1', documentToken: 'opaque-token',
      navigationEpoch: 4, navigationUrl: 'https://example.test/path',
    })).rejects.toMatchObject({ code: 'script_realm_limit', noRetry: true, durationMs: 17 });
  });

  it('resolves browser risk through the exact provider binding without caller semantic metadata', async () => {
    const dispatch = vi.fn(async () => ({ status: 'succeeded', value: {
      snapshotId: 'snapshot-1', ref: 'e7', actionKind: 'click', documentId: 'document-1',
      submit: true, formId: 'form-1', secret: null,
    } }));
    const resolve = createBrowserSnapshotResolver({ dispatch } as never);
    await expect(resolve({
      taskId: 'task', leaseId: 'lease', leaseRevision: 1, tabId: 'tab-1', generation: 4,
      snapshotId: 'snapshot-1', action: { kind: 'click', elementRef: 'e7', semantic: { submit: false } },
    })).resolves.toMatchObject({
      tabId: 'tab-1', generation: 4, snapshotId: 'snapshot-1', elementRef: 'e7',
      actionKind: 'click', documentId: 'document-1', submit: true, formId: 'form-1', secret: null,
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1', generation: 4,
      operation: { kind: 'resolve', snapshotId: 'snapshot-1', elementRef: 'e7', actionKind: 'click' },
    }));
  });

  it('preserves every canonical browser risk field including nulls through action dispatch', async () => {
    const dispatch = vi.fn(async () => ({ status: 'succeeded', value: {
      clicked: true, submit: false, url: 'https://example.test', title: 'Example',
    } }));
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'), projectRoot: '/tmp/psyche-test-root',
      sessionName: 'psyche-test', capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      browserProviders: { dispatch } as never,
      createCovenClient: () => ({ listSessions: async () => [] }),
    });
    await handlers.actOnBrowser({
      taskId: 'task', leaseId: 'lease', leaseRevision: 1, tabId: 'tab-1', generation: 4,
      snapshotId: 'snapshot-1', action: { kind: 'click', elementRef: 'e7' },
    }, 'action-1', {
      tabId: 'tab-1', generation: 4, snapshotId: 'snapshot-1', elementRef: 'e7',
      actionKind: 'click', documentId: 'document-1', submit: false, formId: null, secret: null,
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ expectedRisk: {
        documentId: 'document-1', submit: false, formId: null, secret: null,
      } }),
    }));
  });

  it('keeps browser provider backends fail closed when no provider is composed', async () => {
    const spawnPane = vi.fn();
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot: '/tmp/psyche-test-root',
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      createCovenClient: () => ({ listSessions: async () => [] }),
      spawnPane,
    });
    const calls = [() => handlers.inspectBrowser({
        taskId: 'task', leaseId: 'lease', leaseRevision: 1, tabId: 'tab', generation: 1,
      }, 'inspect-action'),
      () => handlers.actOnBrowser({
        taskId: 'task', leaseId: 'lease', leaseRevision: 1,
        tabId: 'tab', generation: 1, action: { kind: 'reload' },
      }, 'browser-action'),
      () => handlers.runBrowserScript({
        taskId: 'task', leaseId: 'lease', leaseRevision: 1,
        tabId: 'tab', generation: 1, source: '1',
      }, 'script-action', { tabId: 'tab', generation: 1, documentId: 'document-1',
        documentToken: 'token-1', navigationEpoch: 1, navigationUrl: 'https://example.test' }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    expect(spawnPane).not.toHaveBeenCalled();
  });

  it('observes sequenced output without exposing tmux identity', async () => {
    const { handlers, observations, auth } = paneHandlerHarness();
    observations.append(auth.paneId, Buffer.from('hello'));
    await expect(handlers.observePane({ ...auth, afterSequence: 0 })).resolves.toEqual({
      paneId: 'psyche-1', fromSequence: 1, nextSequence: 2,
      text: 'hello', bytes: 5, truncated: false,
    });
  });

  it('send_text dispatches exactly one acknowledged UTF-8 hex operation', async () => {
    const { handlers, tmux, auth } = paneHandlerHarness();
    await handlers.actOnPane({ ...auth, action: { kind: 'send_text', text: 'hi 🧪' } });
    expect(tmux.sendKeysHexAcknowledged).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeysHexAcknowledged).toHaveBeenCalledWith('%3', Buffer.from('hi 🧪'));
    expect(tmux.sendNamedKeysAcknowledged).not.toHaveBeenCalled();
  });

  it('send_text dispatches exactly one acknowledged operation for empty text', async () => {
    const { handlers, tmux, auth } = paneHandlerHarness();
    await handlers.actOnPane({ ...auth, action: { kind: 'send_text', text: '' } });
    expect(tmux.sendKeysHexAcknowledged).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeysHexAcknowledged).toHaveBeenCalledWith('%3', Buffer.alloc(0));
  });

  it.each(['Enter', 'Tab', 'Escape', 'Backspace', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d'] as const)(
    'send_keys accepts named key %s',
    async (key) => {
      const { handlers, tmux, auth } = paneHandlerHarness();
      await handlers.actOnPane({ ...auth, action: { kind: 'send_keys', keys: [key] } });
      expect(tmux.sendNamedKeysAcknowledged).toHaveBeenCalledWith('%3', [key]);
    },
  );

  it.each(['\n', 'Enter\nrun-shell id', 'C-x', 'send-keys'])(
    'send_keys rejects non-allowlisted runtime key %j',
    async (key) => {
      const { handlers, tmux, auth } = paneHandlerHarness();
      await expect(handlers.actOnPane({
        ...auth,
        action: { kind: 'send_keys', keys: [key] } as never,
      })).rejects.toMatchObject({ code: 'invalid_pane_key' });
      expect(tmux.sendNamedKeysAcknowledged).not.toHaveBeenCalled();
    },
  );

  it('interrupt dispatches one acknowledged named-key operation', async () => {
    const { handlers, tmux, auth } = paneHandlerHarness();
    await handlers.actOnPane({ ...auth, action: { kind: 'interrupt' } });
    expect(tmux.sendNamedKeysAcknowledged).toHaveBeenCalledTimes(1);
    expect(tmux.sendNamedKeysAcknowledged).toHaveBeenCalledWith('%3', ['C-c']);
  });

  it('focus and resize each perform one mutation followed by an observed postcondition', async () => {
    const focus = paneHandlerHarness();
    await expect(focus.handlers.actOnPane({ ...focus.auth, action: { kind: 'focus' } })).resolves.toEqual({
      paneId: 'psyche-1', generation: 1, focused: true, cols: 100, rows: 30,
    });
    expect(focus.tmux.selectPaneAcknowledged).toHaveBeenCalledTimes(1);
    expect(focus.tmux.queryPane).toHaveBeenCalledTimes(1);

    const resize = paneHandlerHarness();
    await resize.handlers.actOnPane({ ...resize.auth, action: { kind: 'resize', cols: 120, rows: 40 } });
    expect(resize.tmux.resizePaneAcknowledged).toHaveBeenCalledTimes(1);
    expect(resize.tmux.resizePaneAcknowledged).toHaveBeenCalledWith('%3', 120, 40);
    expect(resize.tmux.queryPane).toHaveBeenCalledTimes(1);
  });

  it('close invokes kill only through the approved handler effect', async () => {
    const { handlers, tmux, auth } = paneHandlerHarness();
    await handlers.actOnPane({ ...auth, action: { kind: 'close' } });
    expect(tmux.killPaneAcknowledged).toHaveBeenCalledTimes(1);
    expect(tmux.killPaneAcknowledged).toHaveBeenCalledWith('%3');
  });

  it('create delegates canonical scope to spawnBridgePane and upserts the stable config identity', async () => {
    const harness = paneHandlerHarness();
    harness.spawnPane.mockResolvedValue({
      id: '%9',
      pane: { id: '%9', cwd: '/tmp/psyche-test-root/wt-2', title: 'New', agent: 'codex' },
      worktreePath: '/tmp/psyche-test-root/wt-2', branch: 'agent/new',
    });
    harness.panes.refresh = vi.fn(async () => [harness.panes.upsert({
      id: 'psyche-2', tmuxPaneId: '%9', worktreeRoot: '/tmp/psyche-test-root/wt-2',
      title: 'New', agent: 'codex', writable: true,
    })]);

    const result = await harness.handlers.actOnPane({
      taskId: 'task', leaseId: 'lease', leaseRevision: 1,
      projectId: '/tmp/psyche-test-root',
      action: { kind: 'create', cwd: 'wt-2', title: 'New', agent: 'codex' },
    });
    expect(harness.spawnPane).toHaveBeenCalledWith(
      '/tmp/psyche-test-root', 'psyche-test',
      expect.objectContaining({ cwd: 'wt-2', title: 'New', agent: 'codex' }),
    );
    expect(result).toMatchObject({ id: 'psyche-2', tmuxPaneId: '%9', generation: 1 });
  });

  it('rejects an injected tmux binding before dispatch', async () => {
    const harness = paneHandlerHarness();
    harness.panes.upsert({
      id: 'psyche-bad', tmuxPaneId: '%3\nrun-shell id',
      worktreeRoot: '/tmp/psyche-test-root/wt', writable: true,
    });
    const bad = harness.panes.current('psyche-bad')!;
    await expect(harness.handlers.actOnPane({
      ...harness.auth, paneId: bad.id, generation: bad.generation,
      action: { kind: 'focus' },
    })).rejects.toThrow(/invalid pane id/);
    expect(harness.tmux.selectPaneAcknowledged).not.toHaveBeenCalled();
  });

  it('denies a stale generation action after the stable pane is rebound', async () => {
    const harness = paneHandlerHarness();
    const stale = harness.pane;
    harness.panes.upsert({
      id: stale.id, tmuxPaneId: '%9', worktreeRoot: '/tmp/psyche-test-root/wt', writable: true,
    });
    await expect(harness.handlers.actOnPane({
      ...harness.auth, paneId: stale.id, generation: stale.generation,
      action: { kind: 'focus' },
    })).rejects.toMatchObject({ code: 'resource_replaced' });
    expect(harness.tmux.selectPaneAcknowledged).not.toHaveBeenCalled();
  });

  it('preserves ambiguous acknowledged failures for effect_unknown mapping', async () => {
    const { handlers, tmux, auth } = paneHandlerHarness();
    tmux.sendKeysHexAcknowledged.mockRejectedValueOnce(
      Object.assign(new Error('control dropped'), { ambiguous: true }),
    );
    await expect(handlers.actOnPane({
      ...auth, action: { kind: 'send_text', text: 'x' },
    })).rejects.toMatchObject({ ambiguous: true });
    expect(tmux.sendKeysHexAcknowledged).toHaveBeenCalledTimes(1);
  });
});

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

function paneHandlerHarness() {
  const sendKeysHex = vi.fn(async () => {});
  const killPane = vi.fn(async () => {});
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
