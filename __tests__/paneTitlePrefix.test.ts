import { describe, expect, it, vi } from 'vitest';
import {
  flushPaneOptionCacheChanges,
  type PaneOptionCacheChange,
  type PaneOptionMutation,
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
