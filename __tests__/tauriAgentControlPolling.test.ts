import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error Native web runtime is plain JavaScript by design.
import { createAgentControlPoller } from '../native/desktop/psyche-build-tauri/web/control/agent-control-poller.mjs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  let current = { projectRoot: '/project-a', worktreeRoot: '/project-a/wt-a', contextToken: 'a:7', ownerEpoch: 7 };
  const loads: ReturnType<typeof deferred<Record<string, unknown>>>[] = [];
  const load = vi.fn((_context: typeof current) => {
    const next = deferred<Record<string, unknown>>();
    loads.push(next);
    return next.promise;
  });
  const accept = vi.fn();
  const fail = vi.fn();
  const clear = vi.fn();
  const ticks: (() => void)[] = [];
  const poller = createAgentControlPoller({
    captureContext: () => ({ ...current }),
    contextMatches: (captured: typeof current) => captured.contextToken === current.contextToken,
    load, accept, fail, clear,
    setIntervalFn: (tick: () => void) => { ticks.push(tick); return ticks.length; },
    clearIntervalFn: vi.fn(), intervalMs: 1_000,
  });
  return { poller, loads, load, accept, fail, clear, ticks,
    setCurrent: (next: typeof current) => { current = next; } };
}

describe('native agent control polling', () => {
  it('keeps one request in flight, accepts its matching response, and coalesces all ticks into one refresh', async () => {
    const test = harness();
    test.poller.start();
    expect(test.ticks).toHaveLength(1);
    test.ticks[0]!();
    test.ticks[0]!();
    test.ticks[0]!();
    expect(test.load).toHaveBeenCalledTimes(1);
    test.loads[0]!.resolve({ snapshot: { ownerEpoch: 7 } });
    await vi.waitFor(() => expect(test.load).toHaveBeenCalledTimes(2));
    expect(test.accept).toHaveBeenCalledWith({ snapshot: { ownerEpoch: 7 } },
      expect.objectContaining({ contextToken: 'a:7' }));
    test.loads[1]!.resolve({ snapshot: { ownerEpoch: 7 } });
    await vi.waitFor(() => expect(test.accept).toHaveBeenCalledTimes(2));
    expect(test.load).toHaveBeenCalledTimes(2);
  });

  it('discards a matching-generation response after a real context switch and refreshes only the new context', async () => {
    const test = harness();
    const first = test.poller.refresh();
    test.poller.refresh();
    test.setCurrent({ projectRoot: '/project-b', worktreeRoot: '/project-b/wt-b', contextToken: 'b:8', ownerEpoch: 8 });
    test.loads[0]!.resolve({ snapshot: { ownerEpoch: 7 } });
    await first;
    await vi.waitFor(() => expect(test.load).toHaveBeenCalledTimes(2));
    expect(test.accept).not.toHaveBeenCalled();
    expect(test.load.mock.calls[1]![0]).toMatchObject({ contextToken: 'b:8' });
    test.loads[1]!.resolve({ snapshot: { ownerEpoch: 8 } });
    await vi.waitFor(() => expect(test.accept).toHaveBeenCalledTimes(1));
  });

  it('preserves captured context for a transient fetch error but suppresses errors after a switch', async () => {
    const test = harness();
    const sameContext = test.poller.refresh();
    test.loads[0]!.reject(new Error('offline'));
    await sameContext;
    expect(test.fail).toHaveBeenCalledWith(expect.objectContaining({ contextToken: 'a:7', ownerEpoch: 7 }));

    const switched = test.poller.refresh();
    test.setCurrent({ projectRoot: '/project-b', worktreeRoot: '/project-b/wt-b', contextToken: 'b:8', ownerEpoch: 8 });
    test.loads[1]!.reject(new Error('old context'));
    await switched;
    expect(test.fail).toHaveBeenCalledTimes(1);
  });

  it.each(['hidden', 'unload'] as const)('synchronously clears authority and ignores an in-flight response on %s', async (reason) => {
    const test = harness();
    const pending = test.poller.refresh();
    test.poller.stop(reason);
    expect(test.clear).toHaveBeenCalledOnce();
    expect(test.clear).toHaveBeenCalledWith(reason);
    test.loads[0]!.resolve({ snapshot: { ownerEpoch: 7 } });
    await pending;
    expect(test.accept).not.toHaveBeenCalled();
    expect(test.fail).not.toHaveBeenCalled();
    expect(test.load).toHaveBeenCalledOnce();
  });

  it('keeps authority cleared after visibility resumes until the replacement fetch succeeds', async () => {
    const test = harness();
    const hiddenFlight = test.poller.refresh();
    test.poller.stop('hidden');
    test.poller.start();
    expect(test.clear).toHaveBeenCalledWith('hidden');
    expect(test.accept).not.toHaveBeenCalled();
    test.loads[0]!.resolve({ snapshot: { ownerEpoch: 7, stale: true } });
    await hiddenFlight;
    await vi.waitFor(() => expect(test.load).toHaveBeenCalledTimes(2));
    expect(test.accept).not.toHaveBeenCalled();
    test.loads[1]!.resolve({ snapshot: { ownerEpoch: 7, fresh: true } });
    await vi.waitFor(() => expect(test.accept).toHaveBeenCalledOnce());
    expect(test.accept).toHaveBeenCalledWith({ snapshot: { ownerEpoch: 7, fresh: true } },
      expect.objectContaining({ contextToken: 'a:7' }));
  });
});
