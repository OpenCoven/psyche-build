import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserSnapshotResolver, createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import { SurfaceRegistry } from '../../src/control/surfaces.js';
import { PaneObservationStore } from '../../src/control/resources/paneObservation.js';
import { PaneResourceController } from '../../src/control/resources/panes.js';

function handlersWithCovenClient(
  sendInput: (sessionId: string, input: string) => Promise<void>,
) {
  return createDaemonControlHandlers({
    tmux: new TmuxControl('psyche-test'),
    projectRoot: '/tmp/psyche-test-root',
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => ({ listSessions: async () => [], sendInput }),
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
      }, 'script-action'),
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
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput);

    const result = await handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'screenshot' });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0][0]).toBe('sess-1');
    expect(sendInput.mock.calls[0][1]).toContain('computer_use');
    expect(result).toMatchObject({ sessionId: 'sess-1', action: 'screenshot', accepted: true });
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
