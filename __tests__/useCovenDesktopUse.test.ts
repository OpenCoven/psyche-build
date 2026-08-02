import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from './utils/deferred.js';
import {
  createDesktopUseLoadCache,
  loadCovenDesktopUseStates,
} from '../src/hooks/useCovenDesktopUse.js';
import type { CovenClient } from '../src/daemon/bridge.js';
import type { CovenSessionEvent, CovenSessionSummary } from '../src/daemon/protocol.js';
import type { PsychePane } from '../src/types.js';

const session: CovenSessionSummary = {
  id: 'session-1',
  projectRoot: '/repo',
  harness: 'codex',
  title: 'Desktop use',
  status: 'running',
  createdAt: '2026-05-10T08:00:00Z',
  updatedAt: '2026-05-10T08:00:03Z',
};

const event = (id: string, createdAt: string, seq?: number): CovenSessionEvent => ({
  seq,
  id,
  sessionId: 'session-1',
  kind: 'tool_result',
  payloadJson: JSON.stringify({ action: 'screenshot', imagePath: `/tmp/${id}.png` }),
  createdAt,
});

const pane = (id: string, sessionId = 'session-1'): PsychePane => ({
  id,
  slug: id,
  prompt: '',
  paneId: `%${id}`,
  type: 'desktop-use',
  desktopUse: { sessionId },
});

describe('loadCovenDesktopUseStates', () => {
  it('loads desktop-use panes in parallel instead of waiting pane-by-pane', async () => {
    const first = createDeferred<CovenSessionSummary>();
    const second = createDeferred<CovenSessionSummary>();
    const requestedSessions: string[] = [];
    const client: Pick<CovenClient, 'getSession' | 'listEvents'> = {
      getSession: vi.fn(async (sessionId: string) => {
        requestedSessions.push(sessionId);
        return sessionId === 'session-1' ? first.promise : second.promise;
      }),
      listEvents: vi.fn(async () => []),
    };

    const loading = loadCovenDesktopUseStates([pane('pane-1'), pane('pane-2', 'session-2')], client);
    await vi.waitFor(() => expect(requestedSessions).toEqual(['session-1', 'session-2']));

    first.resolve({ ...session, id: 'session-1' });
    second.resolve({ ...session, id: 'session-2' });
    await expect(loading).resolves.toHaveProperty('size', 2);
  });

  it('loads each shared desktop-use session once for multiple panes', async () => {
    const client: Pick<CovenClient, 'getSession' | 'listEvents'> = {
      getSession: vi.fn(async () => session),
      listEvents: vi.fn(async () => [event('event-1', '2026-05-10T08:00:01Z')]),
    };

    const states = await loadCovenDesktopUseStates([pane('pane-1'), pane('pane-2')], client);

    expect(client.getSession).toHaveBeenCalledTimes(1);
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    expect(states.get('pane-1')?.screenshotPath).toBe('/tmp/event-1.png');
    expect(states.get('pane-2')?.screenshotPath).toBe('/tmp/event-1.png');
  });

  it('prunes cached session events for desktop-use panes that are no longer active', async () => {
    const cache = createDesktopUseLoadCache();
    cache.eventsBySessionId.set('stale-session', [event('stale-event', '2026-05-10T07:59:00Z')]);
    cache.cursorBySessionId.set('stale-session', { afterSeq: 1 });

    const client: Pick<CovenClient, 'getSession' | 'listEvents'> = {
      getSession: vi.fn(async () => session),
      listEvents: vi.fn(async () => [event('event-1', '2026-05-10T08:00:01Z')]),
    };

    await loadCovenDesktopUseStates([pane('pane-1')], client, cache);

    expect(cache.eventsBySessionId.has('stale-session')).toBe(false);
    expect(cache.cursorBySessionId.has('stale-session')).toBe(false);
    expect(cache.eventsBySessionId.has('session-1')).toBe(true);
  });

  it('uses the Coven event sequence cursor and bounded cached events for subsequent refreshes', async () => {
    const cache = createDesktopUseLoadCache();
    const calls: Array<{ sessionId: string; afterSeq?: number }> = [];
    const client: Pick<CovenClient, 'getSession' | 'listEvents'> = {
      getSession: vi.fn(async () => session),
      listEvents: vi.fn(async (sessionId: string, options?: { afterSeq?: number }) => {
        calls.push({ sessionId, afterSeq: options?.afterSeq });
        return calls.length === 1
          ? [event('event-1', '2026-05-10T08:00:01Z', 41)]
          : [event('event-2', '2026-05-10T08:00:02Z', 42)];
      }),
    };

    const first = await loadCovenDesktopUseStates([pane('pane-1')], client, cache);
    const second = await loadCovenDesktopUseStates([pane('pane-1')], client, cache);

    expect(calls).toEqual([
      { sessionId: 'session-1', afterSeq: undefined },
      { sessionId: 'session-1', afterSeq: 41 },
    ]);
    expect(first.get('pane-1')?.screenshotPath).toBe('/tmp/event-1.png');
    expect(second.get('pane-1')?.actions.map((action) => action.id)).toEqual(['event-2', 'event-1']);
  });
});
