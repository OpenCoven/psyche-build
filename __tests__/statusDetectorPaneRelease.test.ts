import { describe, it, expect, vi } from 'vitest';
import { PaneWorkerManager } from '../src/services/PaneWorkerManager.js';
import { StatusDetector } from '../src/services/StatusDetector.js';
import { WorkerMessageBus } from '../src/services/WorkerMessageBus.js';
import type { PsychePane } from '../src/types.js';
import { createDeferred } from './utils/deferred.js';

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
    const removed: string[] = [];

    messageBus.subscribe('pane-reset', () => {
      expect(statuses.has('pane-a')).toBe(false);
      expect(requests.has('pane-a')).toBe(false);
      expect(paneIds.has('pane-a')).toBe(false);
      lifecycle.push('reset');
    });
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
      expect(removed).toEqual([]);
      expect(statuses.has('pane-a')).toBe(false);
      expect(paneIds.get('pane-a')).toBe('%2');
      expect((detector as any).workerManager.getStats().workerCount).toBe(1);
    } finally {
      await detector.shutdown();
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
