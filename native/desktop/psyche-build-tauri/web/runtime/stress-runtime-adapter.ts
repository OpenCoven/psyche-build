import {
  createPerformanceMetricsCollector,
  type PerformanceMetricsCollector,
  type PerformanceObserverFactory,
  type PerformanceRendererSnapshot,
  type PerformanceSchedulerSnapshot,
} from './performance-metrics';
import {
  runStressPlan,
  type StressBrowserPage,
  type StressEditorDocument,
  type StressFixture,
  type StressGeometry,
  type StressProgress,
  type StressResource,
  type StressRunOptions,
  type StressRunResult,
} from './stress-harness';

export interface TauriStressRuntimeHost {
  authorized: boolean;
  prepareRun(): Promise<StressResource>;
  createTerminal(index: number, fixture: StressFixture): Promise<StressResource>;
  createEditor(document: StressEditorDocument): Promise<StressResource>;
  createBrowser(page: StressBrowserPage): Promise<StressResource>;
  focus(id: string, signal: AbortSignal): Promise<void>;
  resize(step: number, geometry: StressGeometry): void;
  setVisible(id: string, visible: boolean): Promise<void>;
  loseGraphicsContext(): Promise<boolean>;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  schedulerSnapshot(): PerformanceSchedulerSnapshot;
  rendererSnapshots(): readonly PerformanceRendererSnapshot[];
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(handle: number): void;
  now(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  setInterval?(callback: () => void, delay: number): unknown;
  clearInterval?(handle: unknown): void;
  createPerformanceObserver?: PerformanceObserverFactory;
  onProgress?(progress: StressProgress): void;
  reportError?(error: unknown, operation: string): void;
}

export interface TauriStressHarness {
  run(options?: StressRunOptions): Promise<StressRunResult>;
  cancel(reason?: unknown): boolean;
  running(): boolean;
}

function cancellationError(): Error {
  const error = new Error('stress run cancelled');
  error.name = 'AbortError';
  return error;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? cancellationError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function combineErrors(primaryError: unknown, cleanupErrors: unknown[]): unknown {
  if (cleanupErrors.length === 0) return primaryError;
  if (primaryError !== undefined) {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      primaryError instanceof Error ? primaryError.message : 'stress harness failed',
      { cause: primaryError },
    );
  }
  return new AggregateError(cleanupErrors, 'stress harness cleanup failed');
}

export function createTauriStressHarness(
  host: TauriStressRuntimeHost,
): TauriStressHarness {
  let activeController: AbortController | null = null;

  async function run(options: StressRunOptions = {}): Promise<StressRunResult> {
    if (activeController) throw new Error('render diagnostics are already running');
    if (!host.authorized) throw new Error('render diagnostics are not authorized');

    const controller = new AbortController();
    activeController = controller;
    const forwardAbort = () => controller.abort(abortReason(options.signal as AbortSignal));
    if (options.signal?.aborted) {
      controller.abort(abortReason(options.signal));
    } else {
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
    }

    let runScope: StressResource | null = null;
    let collector: PerformanceMetricsCollector | null = null;
    let primaryError: unknown;
    let result: StressRunResult | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      throwIfAborted(controller.signal);
      runScope = await host.prepareRun();
      throwIfAborted(controller.signal);
      collector = createPerformanceMetricsCollector({
        invoke: host.invoke,
        requestFrame: host.requestFrame,
        cancelFrame: host.cancelFrame,
        setInterval: host.setInterval,
        clearInterval: host.clearInterval,
        now: host.now,
        createPerformanceObserver: host.createPerformanceObserver,
        schedulerSnapshot: host.schedulerSnapshot,
        rendererSnapshots: host.rendererSnapshots,
        reportError: host.reportError,
      });
      collector.start();
      result = await runStressPlan({
        authorized: true,
        createTerminal: host.createTerminal,
        createEditor: host.createEditor,
        createBrowser: host.createBrowser,
        focus: host.focus,
        resize: host.resize,
        setVisible: host.setVisible,
        cycleWindow: async () => {
          await host.invoke('diagnostics_cycle_window', {});
        },
        loseGraphicsContext: host.loseGraphicsContext,
        resetMetrics: collector.reset,
        snapshotMetrics: collector.snapshot,
        sleep: host.sleep ?? sleepWithAbort,
        requestFrame: host.requestFrame,
        cancelFrame: host.cancelFrame,
        now: host.now,
        onProgress: host.onProgress ?? (() => undefined),
      }, { signal: controller.signal });
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        collector?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (runScope) {
        try {
          await runScope.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      options.signal?.removeEventListener('abort', forwardAbort);
      if (activeController === controller) activeController = null;
    }

    if (primaryError === undefined && controller.signal.aborted) {
      primaryError = abortReason(controller.signal);
    }
    const combinedError = combineErrors(primaryError, cleanupErrors);
    if (combinedError !== undefined) throw combinedError;
    return result as StressRunResult;
  }

  return Object.freeze({
    run,
    cancel(reason: unknown = cancellationError()) {
      if (!activeController) return false;
      activeController.abort(reason);
      return true;
    },
    running() {
      return activeController !== null;
    },
  });
}
