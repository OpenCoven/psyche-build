import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TmuxControlSupervisor } from '../../src/daemon/tmuxControlSupervisor.js';

function harness(initialExists = false) {
  const control = new EventEmitter() as EventEmitter & { start: () => void; stop: () => void };
  const start = vi.fn<() => void>();
  const stop = vi.fn<() => void>();
  control.start = start;
  control.stop = stop;
  let exists = initialExists;
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const onConnect = vi.fn(async () => vi.fn());
  const supervisor = new TmuxControlSupervisor({
    control,
    sessionExists: () => exists,
    onConnect,
    initialBackoffMs: 100,
    maxBackoffMs: 400,
    setTimer: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  const runNext = async () => {
    const [id, timer] = timers.entries().next().value as [number, { callback: () => void; delay: number }];
    timers.delete(id);
    timer.callback();
    await vi.waitFor(() => expect(timers.size > 0 || start.mock.calls.length > 0).toBe(true));
  };
  return { control, start, stop, supervisor, onConnect, timers, runNext, setExists: (value: boolean) => { exists = value; } };
}

describe('TmuxControlSupervisor', () => {
  it('attaches when a tmux session appears after daemon startup without tight polling', async () => {
    const h = harness(false);
    h.supervisor.start();
    expect([...h.timers.values()].map(({ delay }) => delay)).toEqual([0]);
    await h.runNext();
    expect(h.start).not.toHaveBeenCalled();
    expect([...h.timers.values()].map(({ delay }) => delay)).toEqual([100]);
    h.setExists(true);
    await h.runNext();
    await vi.waitFor(() => expect(h.onConnect).toHaveBeenCalledTimes(1));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.supervisor.connected).toBe(true);
  });

  it('reconnects with bounded backoff and never starts a duplicate active connection', async () => {
    const h = harness(true);
    h.supervisor.start();
    h.supervisor.start();
    await h.runNext();
    await vi.waitFor(() => expect(h.supervisor.connected).toBe(true));
    expect(h.start).toHaveBeenCalledTimes(1);
    h.control.emit('tmuxExit', '%exit');
    expect([...h.timers.values()].map(({ delay }) => delay)).toEqual([100]);
    expect(h.stop).toHaveBeenCalledTimes(1);
    h.control.emit('exit', 0);
    expect([...h.timers.values()].map(({ delay }) => delay)).toEqual([100]);
    await h.runNext();
    await vi.waitFor(() => expect(h.supervisor.connected).toBe(true));
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it('uses bounded exponential polling while the session is absent', async () => {
    const h = harness(false);
    h.supervisor.start();
    await h.runNext();
    expect([...h.timers.values()][0].delay).toBe(100);
    await h.runNext();
    expect([...h.timers.values()][0].delay).toBe(200);
    await h.runNext();
    expect([...h.timers.values()][0].delay).toBe(400);
    await h.runNext();
    expect([...h.timers.values()][0].delay).toBe(400);
  });

  it('cancels retry and active subscription on shutdown', async () => {
    const absent = harness(false);
    absent.supervisor.start();
    absent.supervisor.stop();
    expect(absent.timers.size).toBe(0);
    expect(absent.start).not.toHaveBeenCalled();

    const connected = harness(true);
    connected.supervisor.start();
    await connected.runNext();
    await vi.waitFor(() => expect(connected.supervisor.connected).toBe(true));
    connected.supervisor.stop();
    expect(connected.stop).toHaveBeenCalledTimes(1);
    expect(connected.timers.size).toBe(0);
  });
});
