import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameScheduler, type FrameRequestCallback } from '../native/desktop/psyche-build-tauri/web/runtime/frame-scheduler';
import {
  createPtyClient,
  routePtyBatch,
} from '../native/desktop/psyche-build-tauri/web/runtime/pty-client';
import {
  createTerminalPaneController,
  type TerminalPaneController,
  type TerminalPaneControllerOptions,
  type TerminalPanePtyClient,
  type TerminalPanePtyFactory,
  type VisibilityState,
} from '../native/desktop/psyche-build-tauri/web/runtime/terminal-pane-controller';

type Disposable = { dispose(): void };

const unavailableObserverFactories = {
  createResizeObserver: () => null,
  createIntersectionObserver: () => null,
} satisfies Pick<
  TerminalPaneControllerOptions,
  'createResizeObserver' | 'createIntersectionObserver'
>;

class FakeElement {
  isConnected = true;
  clientWidth = 640;
  clientHeight = 360;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: () => void) {
    this.listeners.get(name)?.delete(listener);
  }
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  opened: unknown[] = [];
  loadedAddons: unknown[] = [];
  writes: Array<{ data: string | Uint8Array; complete: () => void }> = [];
  focusCalls = 0;
  blurCalls = 0;
  disposeCalls = 0;
  registrationDisposals = 0;

  constructor(options: Record<string, unknown>, private readonly lifecycleEvents?: string[]) {
    this.options = options;
  }

  loadAddon(addon: unknown) {
    if (addon instanceof FakeWebglAddon) {
      if (addon.loadError) throw addon.loadError;
      this.lifecycleEvents?.push('webgl');
    }
    this.loadedAddons.push(addon);
  }

  open(container: unknown) {
    this.lifecycleEvents?.push('open');
    this.opened.push(container);
  }

  write(data: string | Uint8Array, complete: () => void = () => undefined) {
    this.writes.push({ data, complete });
  }

  onData(_listener: (data: string) => void): Disposable {
    return { dispose: () => { this.registrationDisposals += 1; } };
  }

  onBell(_listener: () => void): Disposable {
    return { dispose: () => { this.registrationDisposals += 1; } };
  }

  focus() { this.focusCalls += 1; }
  blur() { this.blurCalls += 1; }
  dispose() { this.disposeCalls += 1; }
}

class FakeFitAddon {
  fitCalls = 0;
  disposeCalls = 0;
  nextSize: { cols: number; rows: number } | null = null;

  constructor(private readonly term: FakeTerminal, private readonly events?: string[]) {}

  fit() {
    this.fitCalls += 1;
    this.events?.push('fit');
    if (this.nextSize) {
      this.term.cols = this.nextSize.cols;
      this.term.rows = this.nextSize.rows;
    }
  }

  dispose() { this.disposeCalls += 1; }
}

class FakeWebglAddon {
  disposeCalls = 0;
  contextLossDisposals = 0;
  private contextLossListener: (() => void) | null = null;

  constructor(readonly loadError: Error | null = null) {}

  onContextLoss(listener: () => void): Disposable {
    this.contextLossListener = listener;
    return {
      dispose: () => {
        this.contextLossDisposals += 1;
        if (this.contextLossListener === listener) this.contextLossListener = null;
      },
    };
  }

  loseContext() { this.contextLossListener?.(); }

  dispose() { this.disposeCalls += 1; }
}

function frameQueue() {
  const queued: FrameRequestCallback[] = [];
  return {
    queued,
    requestFrame(callback: FrameRequestCallback) {
      queued.push(callback);
      return queued.length;
    },
    flush(timestamp = 16) {
      queued.shift()?.(timestamp);
    },
  };
}

function batch(threadId: string, sequence: number, bytes: number[]) {
  return { threadId, sequence, bytes, byteCount: bytes.length };
}

const visible: VisibilityState = {
  documentVisible: true,
  paneVisible: true,
  intersecting: true,
};

const controllers: TerminalPaneController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

function createHarness(
  paneId: string,
  options: {
    scheduler?: FrameScheduler;
    frames?: ReturnType<typeof frameQueue>;
    visibility?: VisibilityState;
    selected?: () => boolean;
    events?: string[];
    lifecycleEvents?: string[];
    ptyFactory?: TerminalPanePtyFactory;
    webglFactory?: () => FakeWebglAddon | null;
    reportError?: (error: unknown, operation: string) => void;
    now?: () => number;
  } = {},
) {
  const frames = options.frames ?? frameQueue();
  const scheduler = options.scheduler ?? new FrameScheduler(frames.requestFrame);
  const element = new FakeElement();
  const terminals: FakeTerminal[] = [];
  const fits: FakeFitAddon[] = [];
  const webgls: FakeWebglAddon[] = [];
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => undefined);
  const observerDisposals: string[] = [];
  const controller = createTerminalPaneController({
    paneId,
    threadId: paneId,
    container: element,
    frameScheduler: scheduler,
    invoke,
    initialVisibility: options.visibility ?? visible,
    isSelected: options.selected,
    terminalFactory: (terminalOptions) => {
      const terminal = new FakeTerminal(terminalOptions, options.lifecycleEvents);
      const originalWrite = terminal.write.bind(terminal);
      terminal.write = (data, complete = () => undefined) => {
        options.events?.push('write');
        originalWrite(data, complete);
      };
      terminals.push(terminal);
      return terminal;
    },
    fitAddonFactory: (terminal) => {
      const fit = new FakeFitAddon(terminal as unknown as FakeTerminal, options.events);
      fits.push(fit);
      return fit;
    },
    webglAddonFactory: options.webglFactory ?? (() => {
      const webgl = new FakeWebglAddon();
      webgls.push(webgl);
      return webgl;
    }),
    ptyFactory: options.ptyFactory,
    createResizeObserver: () => ({
      observe: () => undefined,
      disconnect: () => { observerDisposals.push('resize'); },
    }),
    createIntersectionObserver: () => ({
      observe: () => undefined,
      disconnect: () => { observerDisposals.push('intersection'); },
    }),
    onData: () => undefined,
    onBell: () => undefined,
    reportError: options.reportError,
    now: options.now,
  });
  controllers.push(controller);
  return { controller, element, terminals, fits, webgls, frames, scheduler, invoke, observerDisposals };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalPaneController lifecycle', () => {
  it('creates one terminal lifecycle per pane and isolates disposal', () => {
    const first = createHarness('pane-one');
    const duplicate = createTerminalPaneController({
      paneId: 'pane-one',
      threadId: 'pane-one',
      container: first.element,
      frameScheduler: first.scheduler,
      invoke: first.invoke,
      terminalFactory: () => { throw new Error('must not create a duplicate terminal'); },
    });
    const second = createHarness('pane-two');

    expect(duplicate).toBe(first.controller);
    expect(first.terminals).toHaveLength(1);
    expect(second.terminals).toHaveLength(1);

    first.controller.dispose();
    expect(first.controller.rendererSnapshot().state).toBe('disposed');
    expect(second.controller.rendererSnapshot().state).toBe('webgl');
    expect(second.terminals[0].disposeCalls).toBe(0);
  });

  it('coalesces visible delivery per frame and preserves write completion ordering', async () => {
    const harness = createHarness('visible-output');
    expect(harness.controller.receive(batch('visible-output', 1, [1, 2]))).toBe(true);
    expect(harness.controller.receive(batch('visible-output', 2, [3, 4]))).toBe(true);
    expect(harness.frames.queued).toHaveLength(1);
    expect(harness.terminals[0].writes).toHaveLength(0);

    harness.frames.flush();
    expect(harness.terminals[0].writes.map((write) => Array.from(write.data as Uint8Array)))
      .toEqual([[1, 2]]);
    expect(harness.invoke.mock.calls.some(([command]) => command === 'pty_ack')).toBe(false);

    harness.terminals[0].writes[0].complete();
    await flushPromises();
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(1);
    expect(harness.frames.queued).toHaveLength(1);
    harness.frames.flush(32);
    expect(harness.terminals[0].writes.map((write) => Array.from(write.data as Uint8Array)))
      .toEqual([[1, 2], [3, 4]]);
  });

  it('releases a failed terminal write gate exactly once without acknowledging it', async () => {
    const completions: Array<ReturnType<typeof vi.fn<() => void>>> = [];
    const ptyFactory: TerminalPanePtyFactory = (options) => {
      const client = createPtyClient({
        ...options,
        write(data, complete) {
          const trackedComplete = vi.fn(complete);
          completions.push(trackedComplete);
          options.write(data, trackedComplete);
        },
      });
      return { ...client, receive: routePtyBatch };
    };
    const reportError = vi.fn();
    const harness = createHarness('write-throw', { ptyFactory, reportError });
    const terminal = harness.terminals[0];
    const originalWrite = terminal.write.bind(terminal);
    let attempts = 0;
    terminal.write = (data, complete = () => undefined) => {
      attempts += 1;
      if (attempts === 1) throw new Error('xterm write failed');
      originalWrite(data, complete);
    };

    expect(harness.controller.receive(batch('write-throw', 1, [1]))).toBe(true);
    harness.frames.flush();

    expect(completions[0]).toHaveBeenCalledTimes(1);
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(0);
    expect(harness.controller.receive(batch('write-throw', 2, [2]))).toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'write');

    const startAttempt = harness.controller.prepareForPtyStart();
    await harness.controller.markPtyStarted(startAttempt);
    expect(harness.controller.receive(batch('write-throw', 1, [3]))).toBe(true);
    harness.frames.flush(32);

    expect(attempts).toBe(2);
    expect(Array.from(terminal.writes[0].data as Uint8Array)).toEqual([3]);
    expect(completions[0]).toHaveBeenCalledTimes(1);
    expect(completions[1]).not.toHaveBeenCalled();
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(0);
  });

  it('bounds repeated synthetic writes to one retained payload', () => {
    const harness = createHarness('synthetic-bound');
    const chunk = 'x'.repeat(4096);
    let completed = 0;

    harness.controller.write(chunk);
    harness.frames.flush();
    for (let index = 0; index < 100; index += 1) {
      harness.controller.write(`${index}:${chunk}`, () => { completed += 1; });
    }

    const snapshot = harness.controller.rendererSnapshot();
    expect(snapshot.syntheticQueuedWrites).toBe(1);
    expect(snapshot.syntheticRetainedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.queuedWrites).toBe(1);
    expect(completed).toBe(99);
  });

  it('keeps raw PTY batches lossless and ahead of coalesced synthetic output', async () => {
    const harness = createHarness('raw-priority');
    expect(harness.controller.receive(batch('raw-priority', 1, [1, 2]))).toBe(true);
    expect(harness.controller.receive(batch('raw-priority', 2, [3, 4]))).toBe(true);
    expect(harness.controller.receive(batch('raw-priority', 3, [5, 6]))).toBe(false);

    harness.frames.flush();
    for (let index = 0; index < 100; index += 1) {
      harness.controller.write(`status-${index}\r\n`);
    }

    harness.terminals[0].writes[0].complete();
    await flushPromises();
    harness.frames.flush(32);
    expect(Array.from(harness.terminals[0].writes[1].data as Uint8Array)).toEqual([3, 4]);

    harness.terminals[0].writes[1].complete();
    await flushPromises();
    harness.frames.flush(48);
    expect(new TextDecoder().decode(harness.terminals[0].writes[2].data as Uint8Array))
      .toContain('status-99');
    expect(harness.terminals[0].writes.slice(0, 2).map((write) =>
      Array.from(write.data as Uint8Array))).toEqual([[1, 2], [3, 4]]);
  });

  it('parses hidden output no faster than every 100ms without fitting or refreshing', async () => {
    vi.useFakeTimers();
    const harness = createHarness('hidden-output', {
      visibility: { ...visible, paneVisible: false },
    });
    harness.controller.receive(batch('hidden-output', 1, [1]));
    harness.controller.receive(batch('hidden-output', 2, [2]));

    await vi.advanceTimersByTimeAsync(99);
    expect(harness.terminals[0].writes).toHaveLength(0);
    expect(harness.fits[0].fitCalls).toBe(0);
    expect(harness.frames.queued).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.terminals[0].writes).toHaveLength(1);
    harness.terminals[0].writes[0].complete();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.terminals[0].writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.terminals[0].writes).toHaveLength(2);
    expect(harness.fits[0].fitCalls).toBe(0);
  });

  it('fits exactly once before the next visible write after visibility is restored', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const harness = createHarness('restore-output', {
      visibility: { ...visible, intersecting: false },
      events,
    });
    harness.controller.receive(batch('restore-output', 1, [9]));
    await vi.advanceTimersByTimeAsync(50);

    await harness.controller.setVisibility(visible);
    expect(harness.frames.queued).toHaveLength(1);
    harness.frames.flush();

    expect(events).toEqual(['fit', 'write']);
    expect(harness.fits[0].fitCalls).toBe(1);
    expect(harness.terminals[0].writes).toHaveLength(1);
  });

  it('fits and resizes only while visible, connected, and measurably sized', async () => {
    const harness = createHarness('fit-guards');
    harness.element.clientWidth = 0;
    harness.controller.scheduleFit();
    harness.frames.flush();
    expect(harness.fits[0].fitCalls).toBe(0);

    harness.element.clientWidth = 640;
    harness.element.isConnected = false;
    harness.controller.scheduleFit();
    harness.frames.flush(32);
    expect(harness.fits[0].fitCalls).toBe(0);

    harness.element.isConnected = true;
    harness.fits[0].nextSize = { cols: 90, rows: 30 };
    harness.controller.scheduleFit();
    harness.controller.scheduleFit();
    expect(harness.frames.queued).toHaveLength(1);
    harness.frames.flush(48);
    await flushPromises();
    expect(harness.fits[0].fitCalls).toBe(1);
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_resize')).toHaveLength(1);

    harness.controller.scheduleFit();
    harness.frames.flush(64);
    await flushPromises();
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_resize')).toHaveLength(1);

    harness.fits[0].nextSize = { cols: 100, rows: 32 };
    harness.controller.scheduleFit();
    harness.frames.flush(80);
    await flushPromises();
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'pty_resize')).toHaveLength(2);
  });

  it('focuses only a selected pane controller', () => {
    let selected = 'pane-a';
    const first = createHarness('pane-a', { selected: () => selected === 'pane-a' });
    const second = createHarness('pane-b', { selected: () => selected === 'pane-b' });

    first.controller.focus();
    second.controller.focus();
    expect(first.terminals[0].focusCalls).toBe(1);
    expect(second.terminals[0].focusCalls).toBe(0);

    selected = 'pane-b';
    second.controller.focus();
    expect(second.terminals[0].focusCalls).toBe(1);
  });

  it('disposes all pane-owned work exactly once without cancelling another pane', () => {
    vi.useFakeTimers();
    const frames = frameQueue();
    const scheduler = new FrameScheduler(frames.requestFrame);
    const ptyDisposals: string[] = [];
    const ptyFactory: TerminalPanePtyFactory = (options) => {
      const client: TerminalPanePtyClient = {
        threadId: options.threadId,
        receive(input) {
          options.write(Uint8Array.from(input.bytes), () => undefined);
          return true;
        },
        prepareForPtyStart: () => 1,
        restoreAfterFailedPtyStart: () => undefined,
        adoptRunningPty: async () => false,
        setVisible: async () => false,
        markPtyStarted: async () => false,
        markPtyExited: () => undefined,
        stopPtyDelivery: () => undefined,
        dispose: () => { ptyDisposals.push(options.threadId); },
      };
      return client;
    };
    const first = createHarness('dispose-a', {
      frames,
      scheduler,
      visibility: { ...visible, paneVisible: false },
      ptyFactory,
    });
    const second = createHarness('dispose-b', { frames, scheduler, ptyFactory });
    first.controller.receive(batch('dispose-a', 1, [1]));
    second.controller.receive(batch('dispose-b', 1, [2]));
    expect(frames.queued).toHaveLength(1);

    first.controller.dispose();
    first.controller.dispose();
    frames.flush();

    expect(first.observerDisposals.sort()).toEqual(['intersection', 'resize']);
    expect(first.terminals[0].registrationDisposals).toBe(2);
    expect(first.fits[0].disposeCalls).toBe(1);
    expect(first.webgls[0].contextLossDisposals).toBe(1);
    expect(first.webgls[0].disposeCalls).toBe(1);
    expect(first.terminals[0].disposeCalls).toBe(1);
    expect(ptyDisposals.filter((id) => id === 'dispose-a')).toHaveLength(1);
    expect(second.terminals[0].writes).toHaveLength(1);
    expect(second.controller.rendererSnapshot().state).toBe('webgl');
    vi.advanceTimersByTime(100);
    expect(first.terminals[0].writes).toHaveLength(0);
  });

  it('loads WebGL after open and falls back safely when setup fails', () => {
    const lifecycleEvents: string[] = [];
    const success = createHarness('webgl-success', { lifecycleEvents });
    expect(success.terminals[0].opened).toHaveLength(1);
    expect(success.terminals[0].options.scrollback).toBe(10_000);
    expect(success.terminals[0].loadedAddons).toEqual([success.fits[0], success.webgls[0]]);
    expect(lifecycleEvents).toEqual(['open', 'webgl']);
    expect(success.controller.rendererSnapshot().state).toBe('webgl');
    expect(success.controller.rendererSnapshot().fallbackReason).toBeNull();

    const failedAddon = new FakeWebglAddon(new Error('GPU load failed'));
    const loadFailure = createHarness('webgl-load-failure', {
      webglFactory: () => failedAddon,
    });
    expect(loadFailure.controller.rendererSnapshot()).toMatchObject({
      state: 'fallback',
      fallbackReason: 'webgl_setup_failed',
    });
    expect(failedAddon.disposeCalls).toBe(1);
    expect(loadFailure.terminals[0].loadedAddons).toEqual([loadFailure.fits[0]]);

    const unavailable = createHarness('webgl-unavailable', { webglFactory: () => null });
    expect(unavailable.controller.rendererSnapshot()).toMatchObject({
      state: 'fallback',
      fallbackReason: 'webgl_unavailable',
    });
  });

  it('recreates WebGL exactly once on a visible frame and schedules a fresh fit', () => {
    const first = new FakeWebglAddon();
    const recovered = new FakeWebglAddon();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(recovered);
    const harness = createHarness('webgl-recovery', { webglFactory: factory });
    harness.frames.flush();
    const fitsBeforeLoss = harness.fits[0].fitCalls;

    first.loseContext();
    expect(harness.controller.rendererSnapshot()).toMatchObject({
      state: 'recovering',
      fallbackReason: null,
    });
    expect(first.contextLossDisposals).toBe(1);
    expect(first.disposeCalls).toBe(1);

    harness.frames.flush(32);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(harness.terminals[0].loadedAddons.at(-1)).toBe(recovered);
    expect(harness.controller.rendererSnapshot()).toMatchObject({
      state: 'webgl',
      fallbackReason: null,
    });
    expect(harness.frames.queued).toHaveLength(1);
    harness.frames.flush(48);
    expect(harness.fits[0].fitCalls).toBe(fitsBeforeLoss + 1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(harness.terminals[0].disposeCalls).toBe(0);
    expect(harness.fits[0].disposeCalls).toBe(0);
  });

  it('keeps disposed state when the recovery factory disposes the pane', () => {
    const first = new FakeWebglAddon();
    const replacement = new FakeWebglAddon();
    let controller: TerminalPaneController | null = null;
    let factoryCalls = 0;
    const harness = createHarness('webgl-reentrant-dispose', {
      webglFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) return first;
        controller?.dispose();
        return replacement;
      },
    });
    controller = harness.controller;
    harness.frames.flush();

    first.loseContext();
    harness.frames.flush(32);

    expect(harness.controller.rendererSnapshot().state).toBe('disposed');
    expect(replacement.disposeCalls).toBe(1);
    expect(replacement.contextLossDisposals).toBe(0);
    expect(harness.terminals[0].loadedAddons).not.toContain(replacement);
    expect(harness.frames.queued).toHaveLength(0);
  });

  it.each([
    ['null recreation', () => null],
    ['factory throw', () => { throw new Error('recreate failed'); }],
    ['load throw', () => new FakeWebglAddon(new Error('load failed'))],
  ])('falls back without crashing after %s', (_label, recreate) => {
    const first = new FakeWebglAddon();
    let factoryCalls = 0;
    const reportError = vi.fn();
    const harness = createHarness(`webgl-failed-${_label}`, {
      webglFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? first : recreate();
      },
      reportError,
    });
    harness.frames.flush();

    expect(() => first.loseContext()).not.toThrow();
    expect(() => harness.frames.flush(32)).not.toThrow();

    const snapshot = harness.controller.rendererSnapshot();
    expect(snapshot.state).toBe('fallback');
    expect(snapshot.fallbackReason).toBe('webgl_recovery_failed');
    expect(snapshot.fallbackReason).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(factoryCalls).toBe(2);
    expect(harness.terminals[0].disposeCalls).toBe(0);
    expect(harness.fits[0].disposeCalls).toBe(0);
  });

  it('keeps a second loss inside the recovery cooldown on fallback without retrying', () => {
    let timestamp = 1_000;
    const first = new FakeWebglAddon();
    const recovered = new FakeWebglAddon();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(recovered);
    const harness = createHarness('webgl-cooldown', {
      webglFactory: factory,
      now: () => timestamp,
    });
    harness.frames.flush();
    first.loseContext();
    harness.frames.flush(32);

    timestamp += 29_999;
    recovered.loseContext();

    expect(harness.controller.rendererSnapshot()).toMatchObject({
      state: 'fallback',
      fallbackReason: 'webgl_recovery_cooldown',
    });
    expect(recovered.contextLossDisposals).toBe(1);
    expect(recovered.disposeCalls).toBe(1);
    harness.frames.flush(48);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps disposed state when cooldown evaluation disposes the pane', () => {
    let controller: TerminalPaneController | null = null;
    let nowCalls = 0;
    const harness = createHarness('webgl-cooldown-reentrant-dispose', {
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return 0;
        controller?.dispose();
        return 30_000;
      },
    });
    controller = harness.controller;
    harness.frames.flush();

    harness.webgls[0].loseContext();
    harness.frames.flush(32);
    harness.frames.flush(48);
    const recovered = harness.webgls[1];

    recovered.loseContext();

    expect(harness.controller.rendererSnapshot().state).toBe('disposed');
    expect(recovered.contextLossDisposals).toBe(1);
    expect(recovered.disposeCalls).toBe(1);
    expect(harness.frames.queued).toHaveLength(0);
  });

  it('permits recovery at 30 seconds and resets cooldown on success', () => {
    let timestamp = 10;
    const addons = [new FakeWebglAddon(), new FakeWebglAddon(), new FakeWebglAddon()];
    const factory = vi.fn(() => addons.shift() ?? null);
    const harness = createHarness('webgl-cooldown-reset', {
      webglFactory: factory,
      now: () => timestamp,
    });
    harness.frames.flush();

    const initial = harness.terminals[0].loadedAddons.at(-1) as FakeWebglAddon;
    initial.loseContext();
    harness.frames.flush(32);
    const firstRecovery = harness.terminals[0].loadedAddons.at(-1) as FakeWebglAddon;

    timestamp += 30_000;
    firstRecovery.loseContext();
    expect(harness.controller.rendererSnapshot().state).toBe('recovering');
    harness.frames.flush(48);
    expect(harness.controller.rendererSnapshot().state).toBe('webgl');
    expect(factory).toHaveBeenCalledTimes(3);

    timestamp += 29_999;
    const secondRecovery = harness.terminals[0].loadedAddons.at(-1) as FakeWebglAddon;
    secondRecovery.loseContext();
    expect(harness.controller.rendererSnapshot()).toMatchObject({
      state: 'fallback',
      fallbackReason: 'webgl_recovery_cooldown',
    });
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('defers recovery until a hidden pane becomes visible and measurably sized', async () => {
    const first = new FakeWebglAddon();
    const recovered = new FakeWebglAddon();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(recovered);
    const harness = createHarness('webgl-hidden-recovery', {
      visibility: { ...visible, paneVisible: false },
      webglFactory: factory,
    });

    first.loseContext();
    harness.frames.flush();
    expect(harness.controller.rendererSnapshot().state).toBe('recovering');
    expect(factory).toHaveBeenCalledTimes(1);

    harness.element.clientWidth = 0;
    await harness.controller.setVisibility(visible);
    harness.frames.flush(32);
    expect(harness.controller.rendererSnapshot().state).toBe('recovering');
    expect(factory).toHaveBeenCalledTimes(1);

    harness.element.clientWidth = 640;
    harness.controller.scheduleFit();
    harness.frames.flush(48);
    expect(harness.controller.rendererSnapshot().state).toBe('webgl');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isolates renderer recovery from other panes', () => {
    const first = createHarness('webgl-isolation-a');
    const second = createHarness('webgl-isolation-b');
    first.frames.flush();
    second.frames.flush();

    first.webgls[0].loseContext();
    first.frames.flush(32);

    expect(first.controller.rendererSnapshot().state).toBe('webgl');
    expect(first.webgls).toHaveLength(2);
    expect(second.controller.rendererSnapshot().state).toBe('webgl');
    expect(second.webgls).toHaveLength(1);
    expect(second.webgls[0].disposeCalls).toBe(0);
    expect(second.terminals[0].disposeCalls).toBe(0);
  });

  it('continues raw PTY delivery through renderer recovery', () => {
    const ptyDispose = vi.fn();
    const ptyStop = vi.fn();
    const ptyFactory: TerminalPanePtyFactory = (options) => {
      const client = createPtyClient(options);
      return {
        ...client,
        receive: routePtyBatch,
        stopPtyDelivery() {
          ptyStop();
          client.stopPtyDelivery();
        },
        dispose() {
          ptyDispose();
          client.dispose();
        },
      };
    };
    const harness = createHarness('webgl-raw-continuity', { ptyFactory });
    harness.frames.flush();
    harness.webgls[0].loseContext();

    expect(harness.controller.receive(batch('webgl-raw-continuity', 1, [7, 8, 9]))).toBe(true);
    harness.frames.flush(32);

    expect(harness.controller.rendererSnapshot().state).toBe('webgl');
    expect(harness.terminals[0].writes).toHaveLength(1);
    expect(Array.from(harness.terminals[0].writes[0].data as Uint8Array)).toEqual([7, 8, 9]);
    expect(harness.terminals[0].disposeCalls).toBe(0);
    expect(harness.fits[0].disposeCalls).toBe(0);
    expect(ptyStop).not.toHaveBeenCalled();
    expect(ptyDispose).not.toHaveBeenCalled();
  });
});

describe('Tauri terminal controller integration', () => {
  const mainSource = readFileSync(
    resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
    'utf8',
  );
  const runtimeEntry = readFileSync(
    resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts'),
    'utf8',
  );
  const runtimeBundle = readFileSync(
    resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/runtime.bundle.js'),
    'utf8',
  );

  it('mounts terminals through the runtime controller and removes global fit/output ownership', () => {
    expect(runtimeEntry).toContain("export { createTerminalPaneController }");
    expect(mainSource).toContain('PsycheRuntime.createTerminalPaneController({');
    expect(mainSource).toContain('thread.terminalController = controller;');
    expect(mainSource).toContain('thread.term = controller.compatibilityTerminal();');
    expect(mainSource).not.toContain('var visiblePaneFitFrame');
    expect(mainSource).not.toContain('function fitVisiblePanes(');
    expect(mainSource).not.toContain('function scheduleVisiblePaneFit(');
    expect(mainSource).not.toContain('thread.fit');
    expect(mainSource).not.toMatch(/new window\.Terminal|new window\.FitAddon|new window\.WebglAddon/);
    expect(mainSource).not.toContain('ptyRuntime.routePtyBatch(payload)');
    expect(mainSource).toContain('thread.terminalController.receive(payload)');
    expect(mainSource).toContain('thread.terminalController.setTheme(terminalTheme())');
  });

  it('ships the WebGL recovery and cooldown state machine in the runtime bundle', () => {
    expect(runtimeBundle).toContain('webgl_recovery_failed');
    expect(runtimeBundle).toContain('webgl_recovery_cooldown');
  });
});
