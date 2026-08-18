import { describe, expect, it } from 'vitest';
import { PaneStatusTracker, type PaneStatusEvent } from '../src/services/PaneStatusTracker.js';

const BASE = 1_000_000;

function tracker(overrides: Partial<{ agent: any; worktreePath: string }> = {}) {
  return new PaneStatusTracker({
    paneId: 'pane-1',
    tmuxPaneId: '%1',
    ...overrides,
  });
}

function types(events: PaneStatusEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Feeds the same frame repeatedly, which is what "terminal is static" means. */
function settle(t: PaneStatusTracker, frame: string, from: number, ticks = 3): PaneStatusEvent[] {
  const seen: PaneStatusEvent[] = [];
  for (let index = 0; index < ticks; index += 1) {
    seen.push(...t.observe(frame, from + index * 1000));
  }
  return seen;
}

describe('PaneStatusTracker', () => {
  it('stays quiet until it has enough captures to judge movement', () => {
    const t = tracker();
    expect(types(t.observe('idle screen', BASE))).toEqual([]);
    expect(types(t.observe('idle screen', BASE + 1000))).toEqual([]);
    expect(t.status).toBe('idle');
  });

  it('requests analysis once the terminal goes static', () => {
    const t = tracker();
    const events = settle(t, '$ ready', BASE, 3);

    expect(types(events)).toEqual(['status-change', 'analysis-needed']);
    expect(t.status).toBe('analyzing');
    const analysis = events.find((event) => event.type === 'analysis-needed');
    expect(analysis?.payload).toMatchObject({ reason: 'new-static-content', captureSnapshot: '$ ready' });
  });

  it('does not re-request analysis for content it has already settled on', () => {
    const t = tracker();
    settle(t, '$ ready', BASE, 3);
    t.onAnalysisComplete({ status: 'idle' });

    // Same frame, well past the cooldown: nothing new to ask about.
    const later = settle(t, '$ ready', BASE + 60_000, 3);

    expect(types(later)).toEqual([]);
    expect(t.status).toBe('idle');
  });

  it('holds off a second analysis inside the cooldown window', () => {
    const t = tracker();
    settle(t, '$ first', BASE, 3);
    t.onAnalysisComplete({ status: 'waiting' });

    // New content, but only 1s later — inside the 5s cooldown.
    const events = settle(t, '$ second', BASE + 1000, 3);

    expect(types(events)).not.toContain('analysis-needed');
  });

  it('reports the analyzer verdict and any requested pause', () => {
    const t = tracker();
    const result = t.onAnalysisComplete({ status: 'waiting', delayBeforeNextCheck: 4000 });

    expect(result.pauseMs).toBe(4000);
    expect(types(result.events)).toEqual(['status-change']);
    expect(result.events[0].payload).toMatchObject({ status: 'waiting' });
    expect(t.status).toBe('waiting');
  });

  it('ignores an analyzer reply that carries no status', () => {
    const t = tracker();
    expect(t.onAnalysisComplete({})).toEqual({ events: [] });
    expect(t.status).toBe('idle');
  });

  it('treats keys sent on the user behalf as a user interaction', () => {
    const t = tracker();
    settle(t, '$ ready', BASE, 3);
    expect(t.status).toBe('analyzing');

    const events = t.onKeysSent(BASE + 5000);

    // Analyzing is abandoned and the pane is marked touched.
    expect(types(events)).toEqual(['status-change', 'user-interaction']);
    expect(t.status).toBe('idle');
  });

  it('suppresses analysis while a user interaction is still settling', () => {
    const t = tracker();
    t.onKeysSent(BASE);

    // Static content 1s after typing — inside the 3.5s settle window.
    const events = settle(t, '$ typed', BASE + 1000, 3);

    expect(types(events)).not.toContain('analysis-needed');
  });

  describe('codex turn events', () => {
    const codex = () => tracker({ agent: 'codex', worktreePath: '/repo' });

    function event(overrides: Record<string, unknown> = {}) {
      return {
        timestamp: BASE,
        turnId: 'turn-1',
        psychePaneId: 'pane-1',
        tmuxPaneId: '%1',
        source: 'codex-hook',
        ...overrides,
      };
    }

    it('goes idle and reports the turn once', () => {
      const t = codex();
      const events = t.observe('done', BASE, event());

      expect(types(events)).toEqual(['status-change', 'codex-turn-stopped']);
      expect(t.status).toBe('idle');
      const stopped = events.find((e) => e.type === 'codex-turn-stopped');
      expect(stopped?.payload).toMatchObject({ turnId: 'turn-1', source: 'codex-hook' });
    });

    it('ignores a repeat of the same turn', () => {
      const t = codex();
      t.observe('done', BASE, event());
      const again = t.observe('done', BASE + 1000, event());

      expect(types(again)).not.toContain('codex-turn-stopped');
    });

    it('ignores an event addressed to another pane', () => {
      const t = codex();
      const events = t.observe('done', BASE, event({ psychePaneId: 'pane-2' }));

      expect(types(events)).not.toContain('codex-turn-stopped');
    });

    it('ignores an event whose tmux pane no longer matches', () => {
      const t = codex();
      const events = t.observe('done', BASE, event({ tmuxPaneId: '%9' }));

      expect(types(events)).not.toContain('codex-turn-stopped');
    });

    it('ignores a stale timestamp', () => {
      const t = codex();
      t.observe('done', BASE, event({ timestamp: BASE + 5000, turnId: 'turn-2' }));
      const older = t.observe('done', BASE + 6000, event({ timestamp: BASE, turnId: 'turn-1' }));

      expect(types(older)).not.toContain('codex-turn-stopped');
    });

    it('does not read codex events for a non-codex pane', () => {
      const t = tracker();
      expect(t.codexEventFile).toBeUndefined();
      const events = t.observe('done', BASE, event());
      expect(types(events)).not.toContain('codex-turn-stopped');
    });

    it('marks the settled state so no analysis is requested afterwards', () => {
      const t = codex();
      t.observe('done', BASE, event());

      const later = settle(t, 'done', BASE + 60_000, 3);

      expect(types(later)).not.toContain('analysis-needed');
    });
  });
});
