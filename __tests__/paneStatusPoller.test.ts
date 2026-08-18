import { describe, expect, it, vi } from 'vitest';
import { PaneStatusPoller } from '../src/services/PaneStatusPoller.js';
import type { PaneStatusEvent } from '../src/services/PaneStatusTracker.js';

function harness(
  capture: (tmuxPaneId: string, lines: number) => Promise<string>,
  options: { now?: () => number } = {},
) {
  const events: Array<{ paneId: string; event: PaneStatusEvent }> = [];
  const removed: Array<{ paneId: string; reason: string }> = [];
  const errors: Array<{ paneId: string; error: string }> = [];
  const poller = new PaneStatusPoller(
    {
      onEvent: (paneId, event) => events.push({ paneId, event }),
      onPaneRemoved: (paneId, reason) => removed.push({ paneId, reason }),
      onError: (paneId, error) => errors.push({ paneId, error }),
    },
    { capture, readCodexEvent: async () => undefined, ...options },
  );
  return { poller, events, removed, errors };
}

/** Three identical captures is what the tracker needs to call a pane static. */
async function tickTimes(poller: PaneStatusPoller, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await poller.tick();
  }
}

describe('PaneStatusPoller', () => {
  it('observes every pane on one tick', async () => {
    const capture = vi.fn(async (_tmuxPaneId: string, _lines: number) => 'screen');
    const { poller } = harness(capture);
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });
    poller.add({ paneId: 'b', tmuxPaneId: '%2' });

    await poller.tick();

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.map((call) => call[0]).sort()).toEqual(['%1', '%2']);
  });

  it('drives each pane to its own status', async () => {
    const { poller, events } = harness(async () => 'idle screen');
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });
    poller.add({ paneId: 'b', tmuxPaneId: '%2' });

    await tickTimes(poller, 3);

    const analyses = events.filter((entry) => entry.event.type === 'analysis-needed');
    expect(analyses.map((entry) => entry.paneId).sort()).toEqual(['a', 'b']);
  });

  it('keeps one failing pane from stalling the others', async () => {
    const capture = vi.fn(async (tmuxPaneId: string) => {
      if (tmuxPaneId === '%1') throw new Error('tmux exploded');
      return 'fine';
    });
    const { poller, events, errors } = harness(capture);
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });
    poller.add({ paneId: 'b', tmuxPaneId: '%2' });

    await tickTimes(poller, 3);

    expect(errors.every((entry) => entry.paneId === 'a')).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    // The healthy pane still reached a verdict.
    expect(events.some((entry) => entry.paneId === 'b' && entry.event.type === 'analysis-needed'))
      .toBe(true);
    // The failing pane is retried rather than dropped.
    expect(poller.has('a')).toBe(true);
  });

  it('drops a pane tmux says is gone and reports it once', async () => {
    const { poller, removed, errors } = harness(async () => {
      throw new Error("can't find pane: %1");
    });
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });

    await tickTimes(poller, 3);

    expect(removed).toEqual([{ paneId: 'a', reason: 'Pane no longer exists' }]);
    expect(errors).toEqual([]);
    expect(poller.has('a')).toBe(false);
    expect(poller.size).toBe(0);
  });

  it('honours the cooldown an analyzer verdict asks for', async () => {
    let clock = 1_000_000;
    const capture = vi.fn(async () => 'screen');
    const { poller } = harness(capture, { now: () => clock });
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });

    poller.onAnalysisComplete('a', { status: 'waiting', delayBeforeNextCheck: 5000 });
    await poller.tick();
    expect(capture).not.toHaveBeenCalled();

    clock += 6000;
    await poller.tick();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('does not overlap ticks', async () => {
    let active = 0;
    let maxActive = 0;
    const { poller } = harness(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'screen';
    });
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });

    // Second call lands while the first is still awaiting its capture.
    await Promise.all([poller.tick(), poller.tick()]);

    expect(maxActive).toBe(1);
  });

  it('stops observing a pane once removed', async () => {
    const capture = vi.fn(async () => 'screen');
    const { poller } = harness(capture);
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });
    poller.remove('a');

    await poller.tick();

    expect(capture).not.toHaveBeenCalled();
  });

  it('drops an in-flight capture when the pane id is rebound to another tmux pane', async () => {
    let calls = 0;
    let resolveThirdCapture: ((output: string) => void) | undefined;
    const { poller, events } = harness(async () => {
      calls += 1;
      if (calls < 3) return 'screen';
      return new Promise<string>((resolve) => {
        resolveThirdCapture = resolve;
      });
    });
    poller.add({ paneId: 'a', tmuxPaneId: '%1' });

    // The third identical capture would make the old tracker request analysis.
    await tickTimes(poller, 2);
    const inFlightTick = poller.tick();
    await Promise.resolve();

    poller.remove('a');
    poller.add({ paneId: 'a', tmuxPaneId: '%2' });
    resolveThirdCapture?.('screen');
    await inFlightTick;

    expect(events).toEqual([]);
    expect(poller.tmuxPaneIdFor('a')).toBe('%2');
  });

  it('reads codex events only for codex panes', async () => {
    const readCodexEvent = vi.fn(async (_file: string) => undefined);
    const events: Array<{ paneId: string; event: PaneStatusEvent }> = [];
    const poller = new PaneStatusPoller(
      {
        onEvent: (paneId, event) => events.push({ paneId, event }),
        onPaneRemoved: () => {},
        onError: () => {},
      },
      { capture: async () => 'screen', readCodexEvent },
    );
    poller.add({ paneId: 'plain', tmuxPaneId: '%1' });
    poller.add({ paneId: 'codex', tmuxPaneId: '%2', agent: 'codex' as any, worktreePath: '/repo' });

    await poller.tick();

    expect(readCodexEvent).toHaveBeenCalledTimes(1);
    expect(readCodexEvent.mock.calls[0][0]).toContain('codex');
  });
});
