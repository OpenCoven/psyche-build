import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PaneOutputFanout } from '../../src/daemon/paneOutputFanout.js';

describe('PaneOutputFanout', () => {
  it('uses one tmux output listener for multiple consumers and isolates cleanup', () => {
    const tmux = new EventEmitter();
    const observe = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const fanout = new PaneOutputFanout(tmux, observe);

    const unsubscribeFirst = fanout.subscribe(first);
    const unsubscribeSecond = fanout.subscribe(second);
    expect(tmux.listenerCount('output')).toBe(1);

    tmux.emit('output', '%3', Buffer.from('one'));
    expect(observe).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst();
    tmux.emit('output', '%3', Buffer.from('two'));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(tmux.listenerCount('output')).toBe(1);

    unsubscribeSecond();
    fanout.close();
    expect(tmux.listenerCount('output')).toBe(0);
  });
});
