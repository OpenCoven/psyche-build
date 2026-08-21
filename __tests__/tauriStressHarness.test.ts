import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStressFocusOrder,
  buildStressGeometry,
  buildStressPlan,
  createDiagnosticBrowserPage,
  createLargeEditorDocument,
  runStressPlan,
  stressFocusId,
  type StressFixture,
  type StressHarnessDependencies,
  type StressResource,
} from '../native/desktop/psyche-build-tauri/web/runtime/stress-harness';
import {
  formatDiagnosticsStressProgress,
} from '../native/desktop/psyche-build-tauri/web/runtime/diagnostics-surface';

function abortError(): Error {
  const error = new Error('stress run cancelled');
  error.name = 'AbortError';
  return error;
}

function abortableWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? abortError()),
      { once: true },
    );
  });
}

function timerWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function createFrameDriver() {
  let nextHandle = 1;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const cancelled: number[] = [];
  return {
    request(callback: (timestamp: number) => void) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number) {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
    flush(timestamp: number) {
      const entry = callbacks.entries().next().value as
        | [number, (frameTimestamp: number) => void]
        | undefined;
      if (!entry) return;
      callbacks.delete(entry[0]);
      entry[1](timestamp);
    },
    cancelled,
    pending() {
      return callbacks.size;
    },
  };
}

function createResource(id: string, disposed: string[]): StressResource {
  return {
    id,
    async dispose() {
      disposed.push(id);
    },
  };
}

describe('Tauri diagnostics stress harness', () => {
  it('formats actual stress progress for the accessible diagnostics status', () => {
    expect(formatDiagnosticsStressProgress({
      scenarioIndex: 1,
      paneCount: 6,
      phase: 'measure',
      elapsedMs: 12_500,
      phaseDurationMs: 30_000,
    })).toBe('Scenario 2 of 4 · 6 panes · Measuring · 12.5 of 30.0 seconds');

    expect(formatDiagnosticsStressProgress({
      scenarioIndex: 3,
      paneCount: 24,
      phase: 'cleanup',
      elapsedMs: 0,
      phaseDurationMs: 0,
    })).toBe('Scenario 4 of 4 · 24 panes · Cleaning up');
  });

  it('builds the fixed scenario order, phase durations, and fixture assignments', () => {
    const plan = buildStressPlan();

    expect(plan.map((scenario) => scenario.paneCount)).toEqual([1, 6, 12, 24]);
    expect(plan.every((scenario) => (
      scenario.warmupMs === 10_000
      && scenario.measureMs === 30_000
      && scenario.restoreMs === 5_000
    ))).toBe(true);
    expect(plan[2]?.fixtures).toEqual([
      'steady', 'burst', 'rewrite',
      'steady', 'burst', 'rewrite',
      'steady', 'burst', 'rewrite',
      'steady', 'burst', 'rewrite',
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every(Object.isFrozen)).toBe(true);
  });

  it('uses deterministic focus and split/sidebar geometry with editor/browser adjacency', () => {
    const order = buildStressFocusOrder(
      ['terminal-0', 'terminal-1', 'terminal-2'],
      'editor',
      'browser',
    );

    expect(order).toEqual([
      'terminal-0',
      'terminal-1',
      'terminal-2',
      'editor',
      'browser',
    ]);
    expect(order.indexOf('browser') - order.indexOf('editor')).toBe(1);
    expect([0, 1, 2, 3, 4, 5, 6].map((step) => stressFocusId(order, step))).toEqual([
      'terminal-0',
      'terminal-1',
      'terminal-2',
      'editor',
      'browser',
      'terminal-0',
      'terminal-1',
    ]);

    expect(buildStressGeometry(1, 6, 0, order)).toEqual({
      scenarioIndex: 1,
      paneCount: 6,
      frameStep: 0,
      sidebarWidth: 288,
      splitRatios: [0.45, 0.55, 0.65, 0.35],
      surfaceOrder: order,
    });
    expect(buildStressGeometry(1, 6, 1, order)).toEqual({
      scenarioIndex: 1,
      paneCount: 6,
      frameStep: 1,
      sidebarWidth: 336,
      splitRatios: [0.55, 0.65, 0.35, 0.45],
      surfaceOrder: order,
    });
  });

  it('generates a large deterministic editor document and an authorized local diagnostic page', () => {
    const document = createLargeEditorDocument(12);
    const page = createDiagnosticBrowserPage(12);
    const pageUrl = new URL(page.url, 'tauri://localhost/index.html');
    expect(pageUrl.href).toBe(
      'tauri://localhost/diagnostics-fixture.html?paneCount=12',
    );
    const fixtureScript = readFileSync(
      join(
        process.cwd(),
        'native/desktop/psyche-build-tauri/web/diagnostics-fixture.js',
      ),
      'utf8',
    );
    const reports: Array<[string, { title: string }]> = [];
    let contextLost = false;
    const browserWindow: {
      location: { search: string };
      __TAURI__: {
        core: {
          invoke(command: string, payload: { title: string }): Promise<void>;
        };
      };
      losePsycheDiagnosticsContext?: () => boolean;
    } = {
      location: { search: pageUrl.search },
      __TAURI__: {
        core: {
          async invoke(command, payload) {
            reports.push([command, payload]);
          },
        },
      },
    };
    const browserDocument = {
      title: page.title,
      getElementById() {
        return {
          getContext() {
            return {
              clearColor() {},
              clear() {},
              COLOR_BUFFER_BIT: 0x4000,
              getExtension() {
                return {
                  loseContext() {
                    contextLost = true;
                  },
                };
              },
            };
          },
        };
      },
    };
    Function('window', 'document', 'requestAnimationFrame', fixtureScript)(
      browserWindow,
      browserDocument,
      () => 1,
    );

    expect(document.name).toBe('psyche-render-stress-12.txt');
    expect(document.languageId).toBe('text');
    expect(document.text.length).toBeGreaterThan(1_000_000);
    expect(document.text).toContain('pane=12 sequence=00000');
    expect(document.text).toContain('\u001b[36mrender-diagnostics\u001b[0m');
    expect(page.title).toBe('Psyche render diagnostics · 12 panes');
    expect(fixtureScript).toContain('requestAnimationFrame');
    expect(fixtureScript).toContain('WEBGL_lose_context');
    expect(fixtureScript).toContain('context-unavailable');
    expect(fixtureScript).toContain('context-lost');
    expect(browserWindow.losePsycheDiagnosticsContext?.()).toBe(true);
    expect(contextLost).toBe(true);
    expect(browserDocument.title).toBe(
      'Psyche render diagnostics · 12 panes · context-lost',
    );
    expect(reports).toEqual([
      [
        'browser_report_title',
        { title: 'Psyche render diagnostics · 12 panes · context-lost' },
      ],
    ]);
  });

  it('runs fixed scenarios with per-frame geometry, hidden panes, window cycling, and context loss', async () => {
    const events: string[] = [];
    const disposed: string[] = [];
    const visibility: Array<[string, boolean]> = [];
    const fixtures: StressFixture[] = [];
    const frames = createFrameDriver();
    let now = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index, fixture) {
        fixtures.push(fixture);
        return createResource(`terminal-${fixtures.length - 1}-${index}`, disposed);
      },
      async createEditor(document) {
        events.push(`editor:${document.name}`);
        return createResource(`editor-${document.paneCount}`, disposed);
      },
      async createBrowser(page) {
        events.push(`browser:${page.url}:${page.paneCount}`);
        return createResource(`browser-${page.paneCount}`, disposed);
      },
      async focus(id) {
        events.push(`focus:${id}`);
      },
      resize(_step, geometry) {
        events.push(`resize:${geometry.paneCount}:${geometry.frameStep}:${geometry.sidebarWidth}`);
      },
      async setVisible(id, visible) {
        visibility.push([id, visible]);
      },
      async cycleWindow() {
        events.push('window:cycle');
      },
      async loseGraphicsContext() {
        events.push('context:lose');
        return true;
      },
      resetMetrics() {
        events.push('metrics:reset');
      },
      snapshotMetrics() {
        return { at: now };
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress(progress) {
        if (progress.elapsedMs === 0) {
          events.push(`phase:${progress.paneCount}:${progress.phase}`);
        }
      },
    };

    const result = await runStressPlan(dependencies);

    expect(result.scenarios.map((scenario) => scenario.paneCount)).toEqual([1, 6, 12, 24]);
    expect(result.scenarios.every((scenario) => scenario.contextLossSupported)).toBe(true);
    expect(fixtures).toHaveLength(43);
    expect(fixtures.slice(0, 7)).toEqual([
      'steady',
      'steady', 'burst', 'rewrite', 'steady', 'burst', 'rewrite',
    ]);
    expect(events.filter((event) => event === 'window:cycle')).toHaveLength(4);
    expect(events.filter((event) => event === 'context:lose')).toHaveLength(4);
    expect(events.some((event) => event.startsWith('focus:editor-'))).toBe(true);
    expect(events.some((event) => event.startsWith('focus:browser-'))).toBe(true);
    expect(events.some((event) => event.startsWith('resize:24:'))).toBe(true);

    const hidden = visibility.filter(([, visible]) => !visible);
    const restored = visibility.filter(([, visible]) => visible);
    expect(hidden).toHaveLength(21);
    expect(restored).toEqual(hidden.map(([id]) => [id, true]));
    expect(disposed).toHaveLength(51);
    expect(frames.pending()).toBe(0);
    expect(frames.cancelled.length).toBeGreaterThan(0);
  });

  it('keeps warmup, measurement, and restore phases on fixed wall-clock budgets', async () => {
    const frames = createFrameDriver();
    let now = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, []);
      },
      async createEditor() {
        return createResource('editor', []);
      },
      async createBrowser() {
        return createResource('browser', []);
      },
      async focus() {
        now += 100;
      },
      resize() {},
      async setVisible() {},
      async cycleWindow() {
        now += 100;
      },
      async loseGraphicsContext() {
        now += 100;
        return true;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    const result = await runStressPlan(dependencies);

    expect(result.finishedAt - result.startedAt).toBe(4 * 45_000);
    expect(result.scenarios.map((scenario) => scenario.finishedAt - scenario.startedAt))
      .toEqual([45_000, 45_000, 45_000, 45_000]);
  });

  it('ends the phase at its deadline when a slow focus overlaps the budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const frames = createFrameDriver();
      const disposed: string[] = [];
      let activeFocuses = 0;
      let abortedFocuses = 0;
      let focusCalls = 0;
      let measurementStartedAt = -1;
      const dependencies: StressHarnessDependencies = {
        authorized: true,
        async createTerminal(index) {
          return createResource(`terminal-${index}`, disposed);
        },
        async createEditor() {
          return createResource('editor', disposed);
        },
        async createBrowser() {
          return createResource('browser', disposed);
        },
        async focus(_id, signal) {
          focusCalls += 1;
          activeFocuses += 1;
          try {
            await timerWait(2_000, signal ?? new AbortController().signal);
          } catch (error) {
            if (signal?.aborted) abortedFocuses += 1;
            throw error;
          } finally {
            activeFocuses -= 1;
          }
        },
        resize() {},
        async setVisible() {},
        async cycleWindow() {},
        async loseGraphicsContext() {
          return false;
        },
        resetMetrics() {},
        snapshotMetrics() {
          return {};
        },
        sleep: timerWait,
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => Date.now(),
        onProgress(progress) {
          if (progress.phase === 'measure' && progress.elapsedMs === 0) {
            measurementStartedAt = Date.now();
            throw new Error('stop after warmup');
          }
        },
      };

      const run = runStressPlan(dependencies);
      const outcome = run.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(12_000);

      await expect(outcome).resolves.toMatchObject({ message: 'stop after warmup' });
      expect(measurementStartedAt).toBe(10_000);
      expect(focusCalls).toBe(5);
      expect(abortedFocuses).toBe(1);
      expect(activeFocuses).toBe(0);
      expect(frames.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a hung focus at the phase deadline without leaking work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const frames = createFrameDriver();
      let activeFocuses = 0;
      let abortedFocuses = 0;
      let measurementStartedAt = -1;
      const dependencies: StressHarnessDependencies = {
        authorized: true,
        async createTerminal(index) {
          return createResource(`terminal-${index}`, []);
        },
        async createEditor() {
          return createResource('editor', []);
        },
        async createBrowser() {
          return createResource('browser', []);
        },
        async focus(_id, signal) {
          activeFocuses += 1;
          try {
            await new Promise<void>((_resolve, reject) => {
              const safetyTimer = setTimeout(() => {
                reject(new Error('hung focus leaked beyond phase deadline'));
              }, 20_000);
              signal?.addEventListener('abort', () => {
                clearTimeout(safetyTimer);
                abortedFocuses += 1;
                reject(abortError());
              }, { once: true });
            });
          } finally {
            activeFocuses -= 1;
          }
        },
        resize() {},
        async setVisible() {},
        async cycleWindow() {},
        async loseGraphicsContext() {
          return false;
        },
        resetMetrics() {},
        snapshotMetrics() {
          return {};
        },
        sleep: timerWait,
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => Date.now(),
        onProgress(progress) {
          if (progress.phase === 'measure' && progress.elapsedMs === 0) {
            measurementStartedAt = Date.now();
            throw new Error('stop after warmup');
          }
        },
      };

      const run = runStressPlan(dependencies);
      const outcome = run.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(21_000);

      await expect(outcome).resolves.toMatchObject({ message: 'stop after warmup' });
      expect(measurementStartedAt).toBe(10_000);
      expect(abortedFocuses).toBe(1);
      expect(activeFocuses).toBe(0);
      expect(frames.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps focus operations on absolute 250 ms boundaries when focusing is slow', async () => {
    const controller = new AbortController();
    const focusTimes: number[] = [];
    const frames = createFrameDriver();
    let now = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, []);
      },
      async createEditor() {
        return createResource('editor', []);
      },
      async createBrowser() {
        return createResource('browser', []);
      },
      async focus() {
        focusTimes.push(now);
        now += 100;
        if (focusTimes.length === 4) controller.abort(abortError());
      },
      resize() {},
      async setVisible() {},
      async cycleWindow() {},
      async loseGraphicsContext() {
        return false;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    await expect(runStressPlan(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(focusTimes).toEqual([250, 500, 750, 1_000]);
    expect(frames.pending()).toBe(0);
  });

  it('focuses once per interval despite consistent small timer lateness', async () => {
    const controller = new AbortController();
    const focusTimes: number[] = [];
    const frames = createFrameDriver();
    let now = 0;
    let sleepCount = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, []);
      },
      async createEditor() {
        return createResource('editor', []);
      },
      async createBrowser() {
        return createResource('browser', []);
      },
      async focus() {
        focusTimes.push(now);
        if (focusTimes.length === 3) controller.abort(abortError());
      },
      resize() {},
      async setVisible() {},
      async cycleWindow() {},
      async loseGraphicsContext() {
        return false;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms + 1;
        sleepCount += 1;
        frames.flush(now);
        if (sleepCount === 4) controller.abort(abortError());
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    await expect(runStressPlan(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(focusTimes).toEqual([251, 501, 751]);
    expect(frames.pending()).toBe(0);
  });

  it('focuses once at wakeup and skips extra missed boundaries after a stall', async () => {
    const controller = new AbortController();
    const focusTimes: number[] = [];
    const frames = createFrameDriver();
    let now = 0;
    let firstSleep = true;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, []);
      },
      async createEditor() {
        return createResource('editor', []);
      },
      async createBrowser() {
        return createResource('browser', []);
      },
      async focus() {
        focusTimes.push(now);
        if (focusTimes.length === 3) controller.abort(abortError());
      },
      resize() {},
      async setVisible() {},
      async cycleWindow() {},
      async loseGraphicsContext() {
        return false;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += firstSleep ? 1_100 : ms;
        firstSleep = false;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    await expect(runStressPlan(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(focusTimes).toEqual([1_100, 1_250, 1_500]);
    expect(frames.pending()).toBe(0);
  });

  it('keeps the 250 ms focus cycle on visible resources after hiding panes', async () => {
    const controller = new AbortController();
    const hidden = new Set<string>();
    const focusedWhileHidden: string[] = [];
    const frames = createFrameDriver();
    let now = 0;
    let measuredFocuses = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, []);
      },
      async createEditor() {
        return createResource('editor', []);
      },
      async createBrowser() {
        return createResource('browser', []);
      },
      async focus(id) {
        if (hidden.size === 0) return;
        measuredFocuses += 1;
        if (hidden.has(id)) focusedWhileHidden.push(id);
        if (focusedWhileHidden.length > 0 || measuredFocuses === 20) {
          controller.abort(abortError());
        }
      },
      resize() {},
      async setVisible(id, visible) {
        if (visible) hidden.delete(id);
        else hidden.add(id);
      },
      async cycleWindow() {},
      async loseGraphicsContext() {
        return false;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    await expect(runStressPlan(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(measuredFocuses).toBe(20);
    expect(focusedWhileHidden).toEqual([]);
    expect(frames.pending()).toBe(0);
  });

  it('uses the same complete cleanup path when cancellation occurs during restore', async () => {
    const controller = new AbortController();
    const disposed: string[] = [];
    const visibility: Array<[string, boolean]> = [];
    const frames = createFrameDriver();
    let restoreStarted!: () => void;
    const restoreStart = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    let now = 0;
    let restoreCount = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, disposed);
      },
      async createEditor() {
        return createResource('editor', disposed);
      },
      async createBrowser() {
        return createResource('browser', disposed);
      },
      async focus() {},
      resize() {},
      async setVisible(id, visible) {
        visibility.push([id, visible]);
      },
      async cycleWindow() {},
      async loseGraphicsContext() {
        return false;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (ms === 5_000) {
          restoreCount += 1;
          if (restoreCount === 1) {
            now += ms;
            return;
          }
          restoreStarted();
          await abortableWait(signal);
          return;
        }
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    const run = runStressPlan(dependencies, { signal: controller.signal });
    await restoreStart;
    controller.abort(abortError());

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(visibility).toEqual([
      ['terminal-3', false],
      ['terminal-4', false],
      ['terminal-5', false],
      ['terminal-3', true],
      ['terminal-4', true],
      ['terminal-5', true],
    ]);
    expect(disposed.slice(-8)).toEqual([
      'browser',
      'editor',
      'terminal-5',
      'terminal-4',
      'terminal-3',
      'terminal-2',
      'terminal-1',
      'terminal-0',
    ]);
    expect(frames.pending()).toBe(0);
  });

  it('continues restoring and disposing resources after an operational and cleanup failure', async () => {
    const disposed: string[] = [];
    const visibility: Array<[string, boolean]> = [];
    const frames = createFrameDriver();
    let now = 0;
    let windowCycles = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, disposed);
      },
      async createEditor() {
        return createResource('editor', disposed);
      },
      async createBrowser() {
        return createResource('browser', disposed);
      },
      async focus() {},
      resize() {},
      async setVisible(id, visible) {
        visibility.push([id, visible]);
        if (visible && id === 'terminal-3') {
          throw new Error('restore terminal-3 failed');
        }
      },
      async cycleWindow() {
        windowCycles += 1;
        if (windowCycles === 2) throw new Error('window cycle failed');
      },
      async loseGraphicsContext() {
        return true;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    const error = await runStressPlan(dependencies).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: 'window cycle failed',
    });
    expect(visibility.filter(([, visible]) => visible)).toEqual([
      ['terminal-3', true],
      ['terminal-4', true],
      ['terminal-5', true],
    ]);
    expect(disposed.slice(-8)).toEqual([
      'browser',
      'editor',
      'terminal-5',
      'terminal-4',
      'terminal-3',
      'terminal-2',
      'terminal-1',
      'terminal-0',
    ]);
    expect(frames.pending()).toBe(0);
  });

  it('attempts visibility restoration when hiding a pane fails after changing native state', async () => {
    const disposed: string[] = [];
    const visibility: Array<[string, boolean]> = [];
    const frames = createFrameDriver();
    let now = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, disposed);
      },
      async createEditor() {
        return createResource('editor', disposed);
      },
      async createBrowser() {
        return createResource('browser', disposed);
      },
      async focus() {},
      resize() {},
      async setVisible(id, visible) {
        visibility.push([id, visible]);
        if (!visible && id === 'terminal-3') {
          throw new Error('hide terminal-3 failed after native transition');
        }
      },
      async cycleWindow() {},
      async loseGraphicsContext() {
        return true;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress() {},
    };

    await expect(runStressPlan(dependencies))
      .rejects.toThrow('hide terminal-3 failed after native transition');
    expect(visibility.slice(-2)).toEqual([
      ['terminal-3', false],
      ['terminal-3', true],
    ]);
    expect(disposed.slice(-8)).toEqual([
      'browser',
      'editor',
      'terminal-5',
      'terminal-4',
      'terminal-3',
      'terminal-2',
      'terminal-1',
      'terminal-0',
    ]);
  });

  it('still disposes every resource when cleanup progress reporting fails', async () => {
    const disposed: string[] = [];
    const frames = createFrameDriver();
    let now = 0;
    const dependencies: StressHarnessDependencies = {
      authorized: true,
      async createTerminal(index) {
        return createResource(`terminal-${index}`, disposed);
      },
      async createEditor() {
        return createResource('editor', disposed);
      },
      async createBrowser() {
        return createResource('browser', disposed);
      },
      async focus() {},
      resize() {},
      async setVisible() {},
      async cycleWindow() {},
      async loseGraphicsContext() {
        return true;
      },
      resetMetrics() {},
      snapshotMetrics() {
        return {};
      },
      async sleep(ms, signal) {
        if (signal.aborted) throw signal.reason ?? abortError();
        now += ms;
        frames.flush(now);
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      onProgress(progress) {
        if (progress.phase === 'cleanup') throw new Error('cleanup progress failed');
      },
    };

    const error = await runStressPlan(dependencies).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: 'cleanup progress failed',
    });
    expect(disposed).toEqual(['browser', 'editor', 'terminal-0']);
    expect(frames.pending()).toBe(0);
  });

  it('rejects authorization before allocating any resource', async () => {
    let allocations = 0;
    const dependencies = {
      authorized: false,
      createTerminal: async () => {
        allocations += 1;
        return createResource('terminal', []);
      },
    } as unknown as StressHarnessDependencies;

    await expect(runStressPlan(dependencies))
      .rejects.toThrow('render diagnostics are not authorized');
    expect(allocations).toBe(0);
  });
});
