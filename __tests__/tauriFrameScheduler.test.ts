import { describe, expect, it, vi } from 'vitest';
import {
  FrameScheduler,
  type FrameRequestCallback,
} from '../native/desktop/psyche-build-tauri/web/runtime/frame-scheduler';

function createFrameQueue(): {
  queued: FrameRequestCallback[];
  requestFrame: (callback: FrameRequestCallback) => number;
} {
  const queued: FrameRequestCallback[] = [];
  return {
    queued,
    requestFrame: (callback) => {
      queued.push(callback);
      return queued.length;
    },
  };
}

describe('FrameScheduler', () => {
  it('runs only the latest callback for a key in one frame', () => {
    const frames = createFrameQueue();
    const values: number[] = [];
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-1:fit', () => values.push(1));
    scheduler.schedule('pane-1:fit', () => values.push(2));

    expect(frames.queued).toHaveLength(1);
    frames.queued.shift()!(16);
    expect(values).toEqual([2]);
    expect(scheduler.snapshot()).toEqual({ coalescedVisualUpdates: 1 });
  });

  it('keeps work for different keys independent while sharing one frame', () => {
    const frames = createFrameQueue();
    const values: string[] = [];
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-a:fit', () => values.push('a'));
    scheduler.schedule('pane-b:fit', () => values.push('b'));

    expect(frames.queued).toHaveLength(1);
    frames.queued.shift()!(16);
    expect(values).toEqual(['a', 'b']);
    expect(scheduler.snapshot().coalescedVisualUpdates).toBe(0);
  });

  it('schedules one follow-up frame for work enqueued by callbacks', () => {
    const frames = createFrameQueue();
    const values: string[] = [];
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-a:paint', () => {
      values.push('first');
      scheduler.schedule('pane-a:paint', () => values.push('second'));
      scheduler.schedule('pane-b:fit', () => values.push('third'));
    });

    frames.queued.shift()!(16);
    expect(values).toEqual(['first']);
    expect(frames.queued).toHaveLength(1);

    frames.queued.shift()!(32);
    expect(values).toEqual(['first', 'second', 'third']);
    expect(frames.queued).toHaveLength(0);
  });

  it('cancels pending work with a matching prefix', () => {
    const frames = createFrameQueue();
    const values: string[] = [];
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-1:fit', () => values.push('fit'));
    scheduler.schedule('pane-1:paint', () => values.push('paint'));
    scheduler.schedule('pane-2:fit', () => values.push('other'));
    scheduler.cancelPrefix('pane-1:');

    frames.queued.shift()!(16);
    expect(values).toEqual(['other']);
  });

  it('cancels matching callbacks that remain in the active frame', () => {
    const frames = createFrameQueue();
    const values: string[] = [];
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('dispose-pane-1', () => {
      values.push('dispose');
      scheduler.cancelPrefix('pane-1:');
    });
    scheduler.schedule('pane-1:fit', () => values.push('cancelled'));
    scheduler.schedule('pane-2:fit', () => values.push('other'));

    frames.queued.shift()!(16);
    expect(values).toEqual(['dispose', 'other']);
  });

  it('isolates callback failures and reports them to the error sink', () => {
    const frames = createFrameQueue();
    const error = new Error('render failed');
    const errors = vi.fn();
    const afterFailure = vi.fn();
    const scheduler = new FrameScheduler(frames.requestFrame, errors);

    scheduler.schedule('pane-a:paint', () => {
      throw error;
    });
    scheduler.schedule('pane-b:paint', afterFailure);

    expect(() => frames.queued.shift()!(16)).not.toThrow();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(error, 'pane-a:paint');
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it('isolates a throwing error sink from later callbacks', () => {
    const frames = createFrameQueue();
    const errors = vi.fn(() => {
      throw new Error('error sink failed');
    });
    const afterFailure = vi.fn();
    const scheduler = new FrameScheduler(frames.requestFrame, errors);

    scheduler.schedule('pane-a:paint', () => {
      throw new Error('render failed');
    });
    scheduler.schedule('pane-b:paint', afterFailure);

    expect(() => frames.queued.shift()!(16)).not.toThrow();
    expect(errors).toHaveBeenCalledOnce();
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it('does not request a follow-up frame when callbacks enqueue no work', () => {
    const frames = createFrameQueue();
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-a:fit', () => undefined);
    frames.queued.shift()!(16);

    expect(frames.queued).toHaveLength(0);
  });
});
