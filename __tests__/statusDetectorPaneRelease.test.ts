import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { PaneWorkerManager } from '../src/services/PaneWorkerManager.js';
import { StatusDetector } from '../src/services/StatusDetector.js';
import { WorkerMessageBus } from '../src/services/WorkerMessageBus.js';
import type { PsychePane } from '../src/types.js';
import { createDeferred } from './utils/deferred.js';
import { StateManager } from '../src/shared/StateManager.js';
import { acquireProjectPaneConfigLock } from '../src/services/ProjectPaneConfig.js';

function pane(paneId: string): PsychePane {
  return {
    id: 'pane-a',
    slug: 'pane-a',
    prompt: '',
    paneId,
    type: 'worktree',
    agent: 'claude',
  };
}

/**
 * Drives the worker message the same way PaneWorkerManager does when a worker
 * reports that its pane is gone.
 */
function reportPaneRemoved(detector: StatusDetector, paneId: string): void {
  (detector as any).messageBus.handleWorkerMessage(paneId, {
    type: 'pane-removed',
    payload: { reason: 'Pane no longer exists' },
  });
}

describe('StatusDetector pane release', () => {
  it('drops per-pane state when a pane is removed', () => {
    const detector = new StatusDetector();
    const statuses: Map<string, string> = (detector as any).paneStatuses;
    const paneIds: Map<string, string> = (detector as any).paneIdMap;

    statuses.set('pane-a', 'idle');
    statuses.set('pane-b', 'working');
    paneIds.set('pane-a', '%1');
    paneIds.set('pane-b', '%2');

    reportPaneRemoved(detector, 'pane-a');

    expect(statuses.has('pane-a')).toBe(false);
    expect(paneIds.has('pane-a')).toBe(false);
    // An unrelated pane is untouched.
    expect(statuses.get('pane-b')).toBe('working');
    expect(paneIds.get('pane-b')).toBe('%2');
  });

  it('aborts an in-flight analyzer request for the removed pane', () => {
    const detector = new StatusDetector();
    const requests: Map<string, AbortController> = (detector as any).llmRequests;
    const controller = new AbortController();
    requests.set('pane-a', controller);

    reportPaneRemoved(detector, 'pane-a');

    expect(controller.signal.aborted).toBe(true);
    expect(requests.has('pane-a')).toBe(false);
  });

  it('still emits pane-removed to listeners', () => {
    const detector = new StatusDetector();
    const seen: string[] = [];
    detector.on('pane-removed', (event: { paneId: string }) => seen.push(event.paneId));

    reportPaneRemoved(detector, 'pane-a');

    expect(seen).toEqual(['pane-a']);
  });

  it('releases detector state when updateWorkers removes a pane, once', async () => {
    const detector = new StatusDetector();
    const statuses: Map<string, string> = (detector as any).paneStatuses;
    const paneIds: Map<string, string> = (detector as any).paneIdMap;
    const removed: string[] = [];
    detector.on('pane-removed', (event: { paneId: string }) => removed.push(event.paneId));

    try {
      await detector.monitorPanes([pane('%1')]);
      statuses.set('pane-a', 'idle');

      await detector.monitorPanes([]);
      await detector.monitorPanes([]);

      expect(statuses.has('pane-a')).toBe(false);
      expect(paneIds.has('pane-a')).toBe(false);
      expect(removed).toEqual(['pane-a']);
    } finally {
      await detector.shutdown();
    }
  });

  it('resets a same-id rebind internally without publishing pane removal', async () => {
    const detector = new StatusDetector();
    const statuses: Map<string, string> = (detector as any).paneStatuses;
    const requests: Map<string, AbortController> = (detector as any).llmRequests;
    const paneIds: Map<string, string> = (detector as any).paneIdMap;
    const messageBus = (detector as any).messageBus;
    const lifecycle: string[] = [];
    const reset: string[] = [];
    const removed: string[] = [];

    messageBus.subscribe('pane-reset', () => {
      expect(statuses.has('pane-a')).toBe(false);
      expect(requests.has('pane-a')).toBe(false);
      expect(paneIds.has('pane-a')).toBe(false);
      lifecycle.push('reset');
    });
    detector.on('pane-reset', (event: { paneId: string }) => reset.push(event.paneId));
    detector.on('pane-removed', (event: { paneId: string }) => removed.push(event.paneId));
    messageBus.on('worker:ready', () => lifecycle.push('ready'));

    try {
      await detector.monitorPanes([pane('%1')]);
      lifecycle.length = 0;
      statuses.set('pane-a', 'waiting');
      const controller = new AbortController();
      requests.set('pane-a', controller);

      await detector.monitorPanes([pane('%2')]);

      expect(controller.signal.aborted).toBe(true);
      expect(lifecycle).toEqual(['reset', 'ready']);
      expect(reset).toEqual(['pane-a']);
      expect(removed).toEqual([]);
      expect(statuses.has('pane-a')).toBe(false);
      expect(paneIds.get('pane-a')).toBe('%2');
      expect((detector as any).workerManager.getStats().workerCount).toBe(1);
    } finally {
      await detector.shutdown();
    }
  });

  it('serializes overlapping rebinds so the latest pane owns detector and worker state', async () => {
    const detector = new StatusDetector();
    const manager = (detector as any).workerManager as PaneWorkerManager;
    const messageBus = (detector as any).messageBus;
    const paneIds: Map<string, string> = (detector as any).paneIdMap;
    const replacementStarted = createDeferred<void>();
    const releaseReplacement = createDeferred<void>();
    const staleAnalysis = createDeferred<{ state: 'open_prompt'; summary: string }>();
    const updates: Array<{ summary?: string }> = [];
    const lifecycle: string[] = [];
    const originalUpdateWorkers = manager.updateWorkers.bind(manager);

    vi.spyOn(manager, 'updateWorkers').mockImplementation(async (panes) => {
      if (panes[0]?.paneId === '%2') {
        replacementStarted.resolve();
        await releaseReplacement.promise;
      }
      await originalUpdateWorkers(panes);
    });
    (detector as any).paneAnalyzer.analyzePane = vi.fn(() => staleAnalysis.promise);
    detector.on('status-updated', (event) => updates.push(event));
    messageBus.on('worker:pane-reset', (message: { paneId: string }) => {
      lifecycle.push(`reset:${paneIds.get(message.paneId)}`);
    });
    messageBus.on('worker:ready', (message: { paneId: string }) => {
      const tracked = (manager as any).panes.get(message.paneId);
      lifecycle.push(`ready:${tracked?.tmuxPaneId}`);
    });

    try {
      await detector.monitorPanes([pane('%1')]);
      lifecycle.length = 0;
      messageBus.handleWorkerMessage('pane-a', {
        id: 'stale-analysis',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'old pane', reason: 'static' },
      });
      await vi.waitFor(() => expect((detector as any).paneAnalyzer.analyzePane).toHaveBeenCalledOnce());

      const replaceWithTwo = detector.monitorPanes([pane('%2')]);
      await replacementStarted.promise;
      const replaceWithThree = detector.monitorPanes([pane('%3')]);
      releaseReplacement.resolve();
      await Promise.all([replaceWithTwo, replaceWithThree]);

      staleAnalysis.resolve({ state: 'open_prompt', summary: 'stale verdict' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(lifecycle).toEqual([
        'reset:%1',
        'ready:%2',
        'reset:%2',
        'ready:%3',
      ]);
      expect(paneIds.get('pane-a')).toBe('%3');
      expect((manager as any).panes.get('pane-a')?.tmuxPaneId).toBe('%3');
      expect(updates.some((event) => event.summary === 'stale verdict')).toBe(false);
    } finally {
      releaseReplacement.resolve();
      staleAnalysis.resolve({ state: 'open_prompt', summary: 'stale verdict' });
      await detector.shutdown();
    }
  });

  it('continues applying queued pane updates after an earlier update fails', async () => {
    const detector = new StatusDetector();
    const manager = (detector as any).workerManager as PaneWorkerManager;
    const originalUpdateWorkers = manager.updateWorkers.bind(manager);

    try {
      await detector.monitorPanes([pane('%1')]);
      vi.spyOn(manager, 'updateWorkers').mockImplementationOnce(async () => {
        throw new Error('update failed');
      }).mockImplementation(originalUpdateWorkers);

      await expect(detector.monitorPanes([pane('%2')])).rejects.toThrow('update failed');
      await detector.monitorPanes([pane('%3')]);

      expect((detector as any).paneIdMap.get('pane-a')).toBe('%3');
      expect((manager as any).panes.get('pane-a')?.tmuxPaneId).toBe('%3');
    } finally {
      await detector.shutdown();
    }
  });

  it('does not apply queued pane updates after shutdown starts', async () => {
    const detector = new StatusDetector();
    const manager = (detector as any).workerManager as PaneWorkerManager;
    const updateStarted = createDeferred<void>();
    const releaseUpdate = createDeferred<void>();
    const originalUpdateWorkers = manager.updateWorkers.bind(manager);

    await detector.monitorPanes([pane('%1')]);
    const updateWorkers = vi.spyOn(manager, 'updateWorkers').mockImplementation(async (panes) => {
      updateStarted.resolve();
      await releaseUpdate.promise;
      await originalUpdateWorkers(panes);
    });

    const replaceWithTwo = detector.monitorPanes([pane('%2')]);
    await updateStarted.promise;
    const replaceWithThree = detector.monitorPanes([pane('%3')]);
    const shutdown = detector.shutdown();
    releaseUpdate.resolve();
    await Promise.allSettled([replaceWithTwo, replaceWithThree, shutdown]);

    expect(updateWorkers).toHaveBeenCalledTimes(1);
    expect((detector as any).paneIdMap.size).toBe(0);
    expect(manager.getStats().workerCount).toBe(0);
  });

  it('publishes nothing from a Codex stop after a rebind during summary extraction', async () => {
    const detector = new StatusDetector();
    const summary = createDeferred<{
      summary: string;
      attentionTitle: string;
      attentionBody: string;
    }>();
    (detector as any).paneAnalyzer.extractSummary = vi.fn(() => summary.promise);
    const updates: Array<{ paneId: string; summary?: string }> = [];
    const attention: Array<{ paneId: string }> = [];
    detector.on('status-updated', (event) => updates.push(event));
    detector.on('attention-needed', (event) => attention.push(event));

    try {
      await detector.monitorPanes([pane('%1')]);
      const completion = (detector as any).handleCodexTurnStopped('pane-a', {
        id: 'codex-stop-1',
        type: 'codex-turn-stopped',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: {
          sessionId: 'old-session',
          lastAssistantMessage: 'old completion',
        },
      });
      await vi.waitFor(() => expect((detector as any).paneAnalyzer.extractSummary).toHaveBeenCalledOnce());

      await detector.monitorPanes([pane('%2')]);
      summary.resolve({
        summary: 'old summary',
        attentionTitle: 'Old title',
        attentionBody: 'Old body',
      });
      await completion;

      expect(updates.some((event) => event.summary === 'old summary')).toBe(false);
      expect(attention).toEqual([]);
      expect((detector as any).paneStatuses.has('pane-a')).toBe(false);
      expect((detector as any).paneIdMap.get('pane-a')).toBe('%2');
    } finally {
      summary.resolve({
        summary: 'old summary',
        attentionTitle: 'Old title',
        attentionBody: 'Old body',
      });
      await detector.shutdown();
    }
  });

  it('does not persist an old Codex reference onto a replacement while persistence is deferred', async () => {
    const detector = new StatusDetector();
    const root = path.join(process.cwd(), '.test-artifacts', `codex-lifecycle-${randomUUID()}`);
    const projectRoot = path.join(root, 'project');
    const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    const config = (tmuxPaneId: string) => ({
      projectName: 'repo',
      projectRoot,
      panes: [
        { id: 'pane-a', slug: 'pane-a', prompt: '', paneId: tmuxPaneId, agent: 'codex' },
      ],
      settings: {},
      lastUpdated: '2026-08-18T00:00:00.000Z',
    });
    await writeFile(configPath, JSON.stringify(config('%1'), null, 2), 'utf8');
    const stateManager = StateManager.getInstance();
    const previousState = (stateManager as any).state;
    (stateManager as any).state = {
      ...previousState,
      panes: [pane('%1')],
      panesFile: configPath,
    };
    const lock = await acquireProjectPaneConfigLock(projectRoot);
    (detector as any).paneAnalyzer.extractSummary = vi.fn(async () => ({
      summary: 'old summary',
    }));
    const updates: Array<{ paneId: string }> = [];
    const attention: Array<{ paneId: string }> = [];
    detector.on('status-updated', (event) => updates.push(event));
    detector.on('attention-needed', (event) => attention.push(event));

    try {
      await detector.monitorPanes([pane('%1')]);
      const completion = (detector as any).handleCodexTurnStopped('pane-a', {
        id: 'codex-stop-2',
        type: 'codex-turn-stopped',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: {
          sessionId: 'old-session',
          lastAssistantMessage: 'old completion',
        },
      });
      await vi.waitFor(() => expect((detector as any).paneAnalyzer.extractSummary).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));

      await writeFile(configPath, JSON.stringify(config('%2'), null, 2), 'utf8');
      (stateManager as any).state = {
        ...(stateManager as any).state,
        panes: [pane('%2')],
      };
      await detector.monitorPanes([pane('%2')]);
      await lock.release();
      await completion;
      const saved = JSON.parse(await readFile(configPath, 'utf8'));
      expect(saved.panes[0].agentSession).toBeUndefined();
      expect(updates).toEqual([]);
      expect(attention).toEqual([]);
      expect((detector as any).paneStatuses.has('pane-a')).toBe(false);
    } finally {
      await lock.release().catch(() => undefined);
      (stateManager as any).state = previousState;
      await detector.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a newer analysis controller when an older request settles', async () => {
    const detector = new StatusDetector();
    const analysisA = createDeferred<{ state: 'open_prompt'; summary: string }>();
    const analysisB = createDeferred<{ state: 'open_prompt'; summary: string }>();
    const controllers: AbortController[] = [];
    (detector as any).paneAnalyzer.analyzePane = vi.fn((
      _tmuxPaneId: string,
      signal: AbortSignal,
      _paneId: string,
      captureSnapshot: string,
    ) => {
      controllers.push((detector as any).llmRequests.get('pane-a'));
      return captureSnapshot === 'analysis-a' ? analysisA.promise : analysisB.promise;
    });
    const messageBus = (detector as any).messageBus;

    try {
      await detector.monitorPanes([pane('%1')]);
      messageBus.handleWorkerMessage('pane-a', {
        id: 'analysis-a',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'analysis-a', reason: 'static' },
      });
      await vi.waitFor(() => expect(controllers).toHaveLength(1));

      messageBus.handleWorkerMessage('pane-a', {
        id: 'analysis-b',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'analysis-b', reason: 'static' },
      });
      await vi.waitFor(() => expect(controllers).toHaveLength(2));

      analysisA.resolve({ state: 'open_prompt', summary: 'old' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect((detector as any).llmRequests.get('pane-a')).toBe(controllers[1]);
      expect(controllers[1].signal.aborted).toBe(false);

      await detector.monitorPanes([pane('%2')]);
      expect(controllers[1].signal.aborted).toBe(true);
      expect((detector as any).llmRequests.has('pane-a')).toBe(false);
    } finally {
      analysisB.resolve({ state: 'open_prompt', summary: 'new' });
      await detector.shutdown();
    }
  });

  it('publishes nothing from an old analysis after a rebind during autopilot', async () => {
    const detector = new StatusDetector();
    const autopilot = createDeferred<void>();
    (detector as any).paneAnalyzer.analyzePane = vi.fn(async () => ({
      state: 'option_dialog',
      summary: 'old verdict',
      options: [{ action: 'Continue', keys: ['Enter'] }],
    }));
    (detector as any).handleAutopilot = vi.fn(() => autopilot.promise);
    const notifyWorker = vi.spyOn((detector as any).workerManager, 'notifyWorker');
    const updates: Array<{ status: string; summary?: string }> = [];
    detector.on('status-updated', (event) => updates.push(event));
    const messageBus = (detector as any).messageBus;

    try {
      await detector.monitorPanes([pane('%1')]);
      messageBus.handleWorkerMessage('pane-a', {
        id: 'analysis-1',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'old pane', reason: 'static' },
      });
      await vi.waitFor(() => expect((detector as any).handleAutopilot).toHaveBeenCalledOnce());

      await detector.monitorPanes([pane('%2')]);
      autopilot.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(updates.some((event) => event.summary === 'old verdict')).toBe(false);
      expect(notifyWorker).not.toHaveBeenCalledWith(
        'pane-a',
        expect.objectContaining({ type: 'analyze-complete' }),
      );
      expect((detector as any).paneStatuses.has('pane-a')).toBe(false);
      expect((detector as any).paneIdMap.get('pane-a')).toBe('%2');
    } finally {
      autopilot.resolve();
      await detector.shutdown();
    }
  });

  it('does not dispatch an autopilot decision to an old or replacement tmux pane after rebind', async () => {
    const detector = new StatusDetector();
    const dispatchStarted = createDeferred<void>();
    const releaseDispatch = createDeferred<void>();
    const manager = (detector as any).workerManager as PaneWorkerManager;
    const tmuxSendKeys = vi.spyOn((manager as any).tmux, 'sendKeys').mockResolvedValue(undefined);
    const originalSendKeysToPane = detector.sendKeysToPane.bind(detector);
    vi.spyOn(detector, 'sendKeysToPane').mockImplementation(async (...args) => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return originalSendKeysToPane(...args);
    });
    (detector as any).paneAnalyzer.analyzePane = vi.fn(async () => ({
      state: 'option_dialog',
      summary: 'continue',
      options: [{ action: 'Continue', keys: ['Enter'] }],
    }));
    const stateManager = StateManager.getInstance();
    const previousState = (stateManager as any).state;
    (stateManager as any).state = {
      ...previousState,
      panes: [{ ...pane('%1'), autopilot: true }],
    };
    const messageBus = (detector as any).messageBus;

    try {
      await detector.monitorPanes([{ ...pane('%1'), autopilot: true }]);
      messageBus.handleWorkerMessage('pane-a', {
        id: 'autopilot-analysis',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'choose Continue', reason: 'static' },
      });
      await dispatchStarted.promise;

      (stateManager as any).state = {
        ...previousState,
        panes: [{ ...pane('%2'), autopilot: true }],
      };
      await detector.monitorPanes([{ ...pane('%2'), autopilot: true }]);
      releaseDispatch.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(tmuxSendKeys).not.toHaveBeenCalledWith('%1', expect.anything());
      expect(tmuxSendKeys).not.toHaveBeenCalledWith('%2', expect.anything());
      expect(tmuxSendKeys).not.toHaveBeenCalled();
    } finally {
      releaseDispatch.resolve();
      (stateManager as any).state = previousState;
      await detector.shutdown();
    }
  });

  it('does not publish a deferred analysis verdict after a same-id rebind', async () => {
    const detector = new StatusDetector();
    const deferred = createDeferred<{
      state: 'open_prompt';
      summary: string;
    }>();
    let analysisSignal: AbortSignal | undefined;
    const analyzePane = vi.fn(async (
      _tmuxPaneId: string,
      signal: AbortSignal,
    ) => {
      analysisSignal = signal;
      return deferred.promise;
    });
    (detector as any).paneAnalyzer.analyzePane = analyzePane;
    const messageBus = (detector as any).messageBus;
    const updates: Array<{ status: string; summary?: string }> = [];
    detector.on('status-updated', (event) => updates.push(event));

    try {
      await detector.monitorPanes([pane('%1')]);
      messageBus.handleWorkerMessage('pane-a', {
        id: 'analysis-1',
        type: 'analysis-needed',
        timestamp: Date.now(),
        paneId: 'pane-a',
        payload: { captureSnapshot: 'old pane', reason: 'static' },
      });
      await vi.waitFor(() => expect(analyzePane).toHaveBeenCalledOnce());

      await detector.monitorPanes([pane('%2')]);
      expect(analysisSignal?.aborted).toBe(true);

      deferred.resolve({ state: 'open_prompt', summary: 'stale verdict' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(updates.some((event) => event.summary === 'stale verdict')).toBe(false);
      expect((detector as any).paneStatuses.has('pane-a')).toBe(false);
      expect((detector as any).paneIdMap.get('pane-a')).toBe('%2');
    } finally {
      await detector.shutdown();
    }
  });

  it('does not duplicate cleanup after the poller reports a missing pane', async () => {
    const messageBus = new WorkerMessageBus();
    const manager = new PaneWorkerManager(messageBus, {
      capture: async () => {
        throw new Error("can't find pane: %1");
      },
    });
    const removed: string[] = [];
    messageBus.subscribe('pane-removed', (paneId) => {
      removed.push(paneId);
    });

    try {
      await manager.updateWorkers([pane('%1')]);
      await (manager as any).poller.tick();
      await manager.updateWorkers([]);

      expect(removed).toEqual(['pane-a']);
      expect(manager.getStats().workerCount).toBe(0);
    } finally {
      await manager.shutdown();
      messageBus.destroy();
    }
  });
});
