import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FrameScheduler,
  type FrameRequestCallback,
} from '../native/desktop/psyche-build-tauri/web/runtime/frame-scheduler';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function functionSource(name: string): string {
  const start = mainJs.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

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
    expect(scheduler.snapshot()).toEqual({
      pendingCallbacks: 0,
      coalescedVisualUpdates: 1,
    });
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
    expect(scheduler.snapshot().pendingCallbacks).toBe(2);

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

    expect(scheduler.snapshot()).toEqual({
      pendingCallbacks: 1,
      coalescedVisualUpdates: 0,
    });
    frames.queued.shift()!(16);
    expect(values).toEqual(['other']);
  });

  it('tracks coalescing and pending callbacks when cancellation removes only part of a batch', () => {
    const frames = createFrameQueue();
    const scheduler = new FrameScheduler(frames.requestFrame);

    scheduler.schedule('pane-1:fit', () => undefined);
    scheduler.schedule('pane-1:fit', () => undefined);
    scheduler.schedule('pane-2:fit', () => undefined);
    scheduler.cancelPrefix('pane-1:');

    expect(scheduler.snapshot()).toEqual({
      pendingCallbacks: 1,
      coalescedVisualUpdates: 1,
    });
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
    expect(scheduler.snapshot()).toEqual({
      pendingCallbacks: 0,
      coalescedVisualUpdates: 0,
    });
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

describe('desktop geometry scheduling contracts', () => {
  it('binds requestAnimationFrame to Window before passing it to FrameScheduler', () => {
    expect(mainJs).toContain(
      'new ptyRuntime.FrameScheduler(window.requestAnimationFrame.bind(window))',
    );
  });

  it('coalesces pane-tree rendering and sidebar width mutation with layout keys', () => {
    expect(functionSource('schedulePaneTreeLayout')).toContain(
      'terminalFrameScheduler.schedule("layout:pane-tree"',
    );
    expect(functionSource('scheduleSidebarLayout')).toContain(
      'terminalFrameScheduler.schedule("layout:sidebar"',
    );

    const splitUpdate = functionSource('updateActiveSplit');
    expect(splitUpdate).toContain('schedulePaneTreeLayout(restoreFocus ? splitId : null);');
    expect(splitUpdate).not.toContain('renderPaneWorkspace();');

    const sidebarMove = functionSource('scheduleSidebarWidth');
    expect(sidebarMove).toContain('pendingSidebarWidth = width;');
    expect(sidebarMove).toContain('scheduleSidebarLayout();');
    expect(sidebarMove).not.toContain('style.setProperty');
  });

  it('uses per-browser identity keys and replaces direct bounds sync in geometry handlers', () => {
    const browserScheduling = functionSource('scheduleBrowserBounds');
    expect(browserScheduling).toMatch(
      /terminalFrameScheduler\.schedule\("browser:" \+ identity \+ ":bounds"/,
    );
    expect(browserScheduling).toContain('syncBrowserBounds();');

    const resizeObserver = mainJs.match(
      /new ResizeObserver\(function \(\) \{([^}]*)\}\)/,
    );
    expect(resizeObserver?.[1]).toContain('scheduleBrowserBounds();');
    expect(resizeObserver?.[1]).not.toContain('syncBrowserBounds();');

    const sidebarOpen = functionSource('setSidebarOpen');
    expect(sidebarOpen).toContain('scheduleSidebarLayout();');
    expect(sidebarOpen).not.toContain('syncBrowserBounds();');
  });

  it('schedules resize fits, browser bounds, and tab measurements without synchronous geometry work', () => {
    const resizeHandler = mainJs.match(
      /window\.addEventListener\("resize", function \(\) \{([\s\S]*?)\n  \}\);/,
    );
    expect(resizeHandler?.[1]).toContain('scheduleTerminalPaneFits();');
    expect(resizeHandler?.[1]).toContain('scheduleBrowserBounds();');
    expect(resizeHandler?.[1]).toContain('scheduleTabMeasurements();');
    expect(resizeHandler?.[1]).not.toContain('syncBrowserBounds();');
    expect(resizeHandler?.[1]).not.toContain('syncTabStripOverflow();');

    const tabMeasurements = functionSource('scheduleTabMeasurements');
    expect(tabMeasurements).toContain(
      'terminalFrameScheduler.schedule("layout:tabs"',
    );
    expect(functionSource('refreshTabs')).toContain('scheduleTabMeasurements(true);');
  });

  it('does not queue a second geometry frame when sidebar state did not change', () => {
    const frames = createFrameQueue();
    const scheduler = new FrameScheduler(frames.requestFrame);
    const scheduleTerminalPaneFits = vi.fn();
    const scheduleBrowserBounds = vi.fn();
    const syncSessionListScroll = vi.fn();
    const scheduleSidebarLayout = Function(
      'terminalFrameScheduler',
      'pendingSidebarOpen',
      'pendingSidebarWidth',
      'scheduleTerminalPaneFits',
      'scheduleBrowserBounds',
      'syncSessionListScroll',
      `"use strict"; return (${functionSource('scheduleSidebarLayout')});`,
    )(
      scheduler,
      null,
      null,
      scheduleTerminalPaneFits,
      scheduleBrowserBounds,
      syncSessionListScroll,
    ) as () => void;

    scheduleSidebarLayout();
    frames.queued.shift()!(16);

    expect(scheduleTerminalPaneFits).not.toHaveBeenCalled();
    expect(scheduleBrowserBounds).not.toHaveBeenCalled();
    expect(syncSessionListScroll).toHaveBeenCalledOnce();
    expect(frames.queued).toHaveLength(0);
  });
});
