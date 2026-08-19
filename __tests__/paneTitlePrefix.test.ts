import { describe, expect, it, vi } from 'vitest';
import {
  flushPaneOptionCacheChanges,
  pruneDeadPaneOptionCacheEntries,
  startPaneOptionSyncEffect,
  type PaneOptionCacheChange,
  type PaneOptionMutation,
  PANE_TITLE_SPINNER_INTERVAL_MS,
} from '../src/utils/paneTitlePrefix.js';

function setChange(
  cache: Map<string, string>,
  paneId: string,
  option: string,
  value: string
): PaneOptionCacheChange {
  return { cache, mutation: { paneId, option, value } };
}

describe('pane title option cache transactions', () => {
  it('prunes dead panes locally while committing live mutations in one batch', () => {
    const prefixCache = new Map([
      ['%dead', 'dead-prefix'],
      ['%control', 'control-prefix'],
    ]);
    const labelCache = new Map([
      ['%dead', 'dead-label'],
      ['%control', 'control-label'],
    ]);
    const livePaneIds = new Set(['%1', '%control']);
    const activePaneIds = new Set(['%1']);
    const writeBatch = vi.fn(() => true);

    pruneDeadPaneOptionCacheEntries(prefixCache, livePaneIds);
    pruneDeadPaneOptionCacheEntries(labelCache, livePaneIds);

    const changes: PaneOptionCacheChange[] = [
      {
        cache: prefixCache,
        mutation: {
          paneId: '%control',
          option: '@psyche_title_prefix',
          unset: true as const,
        },
      },
      {
        cache: labelCache,
        mutation: {
          paneId: '%control',
          option: '@psyche_title_label',
          unset: true as const,
        },
      },
      setChange(prefixCache, '%1', '@psyche_title_prefix', 'live-prefix'),
      setChange(labelCache, '%1', '@psyche_title_label', 'live-label'),
    ].filter(({ mutation }) =>
      'unset' in mutation ? !activePaneIds.has(mutation.paneId) : true
    );

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(true);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch).toHaveBeenCalledWith([
      { paneId: '%1', option: '@psyche_title_prefix', value: 'live-prefix' },
      { paneId: '%1', option: '@psyche_title_label', value: 'live-label' },
      { paneId: '%control', option: '@psyche_title_prefix', unset: true },
      { paneId: '%control', option: '@psyche_title_label', unset: true },
    ]);
    expect(prefixCache).toEqual(new Map([['%1', 'live-prefix']]));
    expect(labelCache).toEqual(new Map([['%1', 'live-label']]));

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(true);
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('retries the full batch after an ambiguous middle failure and commits only after success', () => {
    const cache = new Map<string, string>();
    const changes = [
      setChange(cache, '%1', '@psyche_title_prefix', 'first'),
      setChange(cache, '%invalid', '@psyche_title_prefix', 'middle'),
      setChange(cache, '%3', '@psyche_title_prefix', 'later'),
    ];
    const attemptedBatches: PaneOptionMutation[][] = [];
    const tmuxState = new Map<string, string>();
    let shouldSucceed = false;
    const writeBatch = vi.fn((mutations: readonly PaneOptionMutation[]) => {
      attemptedBatches.push([...mutations]);
      for (const mutation of mutations) {
        if (mutation.paneId === '%invalid' && !shouldSucceed) {
          return false;
        }
        if ('value' in mutation) {
          tmuxState.set(mutation.paneId, mutation.value);
        }
      }
      return true;
    });

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(false);
    expect(tmuxState).toEqual(new Map([['%1', 'first']]));
    expect(cache).toEqual(new Map());

    shouldSucceed = true;
    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(true);
    expect(attemptedBatches).toEqual([
      changes.map(({ mutation }) => mutation),
      changes.map(({ mutation }) => mutation),
    ]);
    expect(cache).toEqual(new Map([
      ['%1', 'first'],
      ['%invalid', 'middle'],
      ['%3', 'later'],
    ]));
    expect(tmuxState).toEqual(cache);

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(true);
    expect(writeBatch).toHaveBeenCalledTimes(2);
  });

  it('keeps failed unset cleanup cached so it remains retryable', () => {
    const cache = new Map([['%stale', 'old']]);
    const changes: PaneOptionCacheChange[] = [{
      cache,
      mutation: {
        paneId: '%stale',
        option: '@psyche_title_prefix',
        unset: true,
      },
    }];
    const writeBatch = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(false);
    expect(cache.get('%stale')).toBe('old');

    expect(flushPaneOptionCacheChanges(changes, writeBatch)).toBe(true);
    expect(cache.has('%stale')).toBe(false);
    expect(writeBatch).toHaveBeenCalledTimes(2);
  });

  it('flushes all changed options with one successful batch write', () => {
    const prefixCache = new Map<string, string>();
    const labelCache = new Map<string, string>();
    const staleCache = new Map([['%stale', 'old']]);
    const writeBatch = vi.fn(() => true);

    expect(flushPaneOptionCacheChanges([
      {
        cache: staleCache,
        mutation: {
          paneId: '%stale',
          option: '@psyche_title_prefix',
          unset: true,
        },
      },
      setChange(prefixCache, '%1', '@psyche_title_prefix', 'prefix'),
      setChange(labelCache, '%1', '@psyche_title_label', 'label'),
    ], writeBatch)).toBe(true);

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch).toHaveBeenCalledWith([
      { paneId: '%1', option: '@psyche_title_prefix', value: 'prefix' },
      { paneId: '%1', option: '@psyche_title_label', value: 'label' },
      { paneId: '%stale', option: '@psyche_title_prefix', unset: true },
    ]);
    expect(prefixCache.get('%1')).toBe('prefix');
    expect(labelCache.get('%1')).toBe('label');
    expect(staleCache.has('%stale')).toBe(false);
  });
});

describe('pane title option sync effect', () => {
  it('retries a failed static batch at spinner cadence and stops after success', () => {
    vi.useFakeTimers();
    try {
      const prefixCache = new Map<string, string>();
      const labelCache = new Map<string, string>();
      const changes = [
        setChange(prefixCache, '%1', '@psyche_title_prefix', 'prefix'),
        setChange(labelCache, '%1', '@psyche_title_label', 'label'),
      ];
      const writeBatch = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const sync = () => flushPaneOptionCacheChanges(changes, writeBatch);

      const dispose = startPaneOptionSyncEffect({
        hasAnimatedPrefix: false,
        sync,
        advanceFrame: vi.fn(),
        intervalMs: PANE_TITLE_SPINNER_INTERVAL_MS,
      });

      expect(writeBatch).toHaveBeenCalledTimes(1);
      expect(writeBatch).toHaveBeenLastCalledWith(changes.map(({ mutation }) => mutation));
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(PANE_TITLE_SPINNER_INTERVAL_MS);

      expect(writeBatch).toHaveBeenCalledTimes(2);
      expect(writeBatch).toHaveBeenLastCalledWith(changes.map(({ mutation }) => mutation));
      expect(prefixCache).toEqual(new Map([['%1', 'prefix']]));
      expect(labelCache).toEqual(new Map([['%1', 'label']]));
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(PANE_TITLE_SPINNER_INTERVAL_MS * 3);
      expect(writeBatch).toHaveBeenCalledTimes(2);

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending static retry on disposal', () => {
    vi.useFakeTimers();
    try {
      const sync = vi.fn(() => false);
      const dispose = startPaneOptionSyncEffect({
        hasAnimatedPrefix: false,
        sync,
        advanceFrame: vi.fn(),
        intervalMs: PANE_TITLE_SPINNER_INTERVAL_MS,
      });

      expect(sync).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(PANE_TITLE_SPINNER_INTERVAL_MS * 3);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
