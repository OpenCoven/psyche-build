import { describe, it, expect } from 'vitest';
import { StatusDetector } from '../src/services/StatusDetector.js';

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
});
