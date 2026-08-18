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

  it('clears the old lifecycle before publishing replacement worker events', async () => {
    const detector = new StatusDetector();
    const statuses: Map<string, string> = (detector as any).paneStatuses;
    const requests: Map<string, AbortController> = (detector as any).llmRequests;
    const paneIds: Map<string, string> = (detector as any).paneIdMap;
    const messageBus = (detector as any).messageBus;
    const lifecycle: string[] = [];

    detector.on('pane-removed', () => {
      expect(statuses.has('pane-a')).toBe(false);
      expect(requests.has('pane-a')).toBe(false);
      expect(paneIds.has('pane-a')).toBe(false);
      lifecycle.push('removed');
    });
    messageBus.on('worker:ready', () => lifecycle.push('ready'));

    try {
      await detector.monitorPanes([pane('%1')]);
      lifecycle.length = 0;
      statuses.set('pane-a', 'waiting');
      const controller = new AbortController();
      requests.set('pane-a', controller);

      await detector.monitorPanes([pane('%2')]);

      expect(controller.signal.aborted).toBe(true);
      expect(lifecycle).toEqual(['removed', 'ready']);
      expect(statuses.has('pane-a')).toBe(false);
      expect(paneIds.get('pane-a')).toBe('%2');
    } finally {
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
