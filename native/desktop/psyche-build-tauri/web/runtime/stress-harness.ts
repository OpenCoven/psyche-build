export type StressFixture = 'steady' | 'burst' | 'rewrite';
export type StressPhase = 'setup' | 'warmup' | 'measure' | 'restore' | 'cleanup';
export type StressLateOperation = 'focus' | 'visibility' | 'window' | 'graphics';

export const STRESS_FOCUS_INTERVAL_MS = 250;

const STRESS_FIXTURES = Object.freeze<readonly StressFixture[]>([
  'steady',
  'burst',
  'rewrite',
]);
const STRESS_SIDEBAR_WIDTHS = Object.freeze([240, 288, 336, 264] as const);
const STRESS_SPLIT_RATIOS = Object.freeze([0.35, 0.45, 0.55, 0.65] as const);
const LARGE_EDITOR_LINE_COUNT = 12_000;

export interface StressScenario {
  paneCount: 1 | 6 | 12 | 24;
  warmupMs: 10_000;
  measureMs: 30_000;
  restoreMs: 5_000;
  fixtures: readonly StressFixture[];
}

export interface StressProgress {
  scenarioIndex: number;
  paneCount: StressScenario['paneCount'];
  phase: StressPhase;
  elapsedMs: number;
  phaseDurationMs: number;
}

export interface StressEditorDocument {
  paneCount: StressScenario['paneCount'];
  name: string;
  languageId: 'text';
  text: string;
}

export interface StressBrowserPage {
  paneCount: StressScenario['paneCount'];
  url: 'about:blank';
  title: string;
  html: string;
}

export interface StressGeometry {
  scenarioIndex: number;
  paneCount: StressScenario['paneCount'];
  frameStep: number;
  sidebarWidth: number;
  splitRatios: readonly number[];
  surfaceOrder: readonly string[];
}

export interface StressResource {
  id: string;
  dispose(signal?: AbortSignal): void | Promise<void>;
  /**
   * Synchronous native kill path used if graceful disposal exceeds its
   * deadline or a resource arrives after the async cleanup quarantine closes.
   * Implementations must invalidate the resource before returning and make a
   * previously started dispose operation harmless and idempotent.
   */
  forceDispose(): void;
}

export interface StressScenarioResult {
  paneCount: StressScenario['paneCount'];
  startedAt: number;
  finishedAt: number;
  contextLossSupported: boolean;
  metrics: {
    beforeMeasurement: unknown;
    afterMeasurement: unknown;
  };
}

export interface StressRunResult {
  startedAt: number;
  finishedAt: number;
  scenarios: StressScenarioResult[];
}

export interface StressHarnessDependencies {
  authorized: boolean;
  createTerminal(
    index: number,
    fixture: StressFixture,
    signal: AbortSignal,
  ): Promise<StressResource>;
  createEditor(document: StressEditorDocument, signal: AbortSignal): Promise<StressResource>;
  createBrowser(page: StressBrowserPage, signal: AbortSignal): Promise<StressResource>;
  focus(id: string, signal: AbortSignal): Promise<void>;
  /**
   * Must return promptly. JavaScript timers cannot interrupt synchronous
   * native-bound work, so expensive implementations must run off the render
   * thread or yield cooperatively and honor the surrounding phase boundary.
   */
  resize(step: number, geometry: StressGeometry): void;
  setVisible(id: string, visible: boolean, signal: AbortSignal): Promise<void>;
  cycleWindow(signal: AbortSignal): Promise<void>;
  loseGraphicsContext(signal: AbortSignal): Promise<boolean>;
  restoreGraphicsContext?: (signal: AbortSignal) => Promise<void>;
  /**
   * Synchronously invalidates a native operation whose result arrived after
   * its async quarantine closed. Implementations must not start new async
   * work here; they must close the operation's generation/lifecycle fence.
   */
  invalidateLateOperation?: (operation: StressLateOperation) => void;
  resetMetrics(): void;
  snapshotMetrics(): unknown;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(handle: number): void;
  now(): number;
  onProgress(progress: StressProgress): void;
}

export interface StressRunOptions {
  signal?: AbortSignal;
}

function scenario(paneCount: StressScenario['paneCount']): StressScenario {
  const fixtures = Object.freeze(
    Array.from({ length: paneCount }, (_, index) => (
      STRESS_FIXTURES[index % STRESS_FIXTURES.length] as StressFixture
    )),
  );
  return Object.freeze({
    paneCount,
    warmupMs: 10_000,
    measureMs: 30_000,
    restoreMs: 5_000,
    fixtures,
  });
}

const STRESS_PLAN = Object.freeze([
  scenario(1),
  scenario(6),
  scenario(12),
  scenario(24),
]);

export function buildStressPlan(): readonly StressScenario[] {
  return STRESS_PLAN;
}

export function buildStressFocusOrder(
  terminalIds: readonly string[],
  editorId: string,
  browserId: string,
): readonly string[] {
  return Object.freeze([...terminalIds, editorId, browserId]);
}

export function stressFocusId(order: readonly string[], step: number): string {
  if (order.length === 0) throw new Error('stress focus order is empty');
  const normalizedStep = Math.max(0, Math.floor(step));
  return order[normalizedStep % order.length] as string;
}

export function buildStressGeometry(
  scenarioIndex: number,
  paneCount: StressScenario['paneCount'],
  frameStep: number,
  surfaceOrder: readonly string[],
): StressGeometry {
  const normalizedStep = Math.max(0, Math.floor(frameStep));
  const sidebarIndex = (scenarioIndex + normalizedStep) % STRESS_SIDEBAR_WIDTHS.length;
  const splitRatios = STRESS_SPLIT_RATIOS.map((_, splitIndex) => (
    STRESS_SPLIT_RATIOS[
      (scenarioIndex + normalizedStep + splitIndex) % STRESS_SPLIT_RATIOS.length
    ] as number
  ));
  return Object.freeze({
    scenarioIndex,
    paneCount,
    frameStep: normalizedStep,
    sidebarWidth: STRESS_SIDEBAR_WIDTHS[sidebarIndex] as number,
    splitRatios: Object.freeze(splitRatios),
    surfaceOrder: Object.freeze([...surfaceOrder]),
  });
}

export function createLargeEditorDocument(
  paneCount: StressScenario['paneCount'],
): StressEditorDocument {
  const lines = Array.from({ length: LARGE_EDITOR_LINE_COUNT }, (_, index) => {
    const sequence = String(index).padStart(5, '0');
    return [
      `pane=${paneCount} sequence=${sequence}`,
      '\u001b[36mrender-diagnostics\u001b[0m',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz',
    ].join(' ');
  });
  return Object.freeze({
    paneCount,
    name: `psyche-render-stress-${paneCount}.txt`,
    languageId: 'text',
    text: lines.join('\n'),
  });
}

export function createDiagnosticBrowserPage(
  paneCount: StressScenario['paneCount'],
): StressBrowserPage {
  const title = `Psyche render diagnostics · ${paneCount} panes`;
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<canvas id="diagnostics-canvas" width="960" height="540"></canvas>
<script>
const canvas = document.getElementById('diagnostics-canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
let frame = 0;
function draw() {
  frame += 1;
  if (gl) {
    gl.clearColor((frame % 255) / 255, ${paneCount} / 24, 0.5, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
function reportContextStatus(status) {
  document.title = status;
}
window.losePsycheDiagnosticsContext = function () {
  const extension = gl && gl.getExtension('WEBGL_lose_context');
  if (!extension) {
    reportContextStatus(${JSON.stringify(`${title} · context-unavailable`)});
    return Promise.resolve(false);
  }
  return new Promise(function (resolve) {
    let settled = false;
    const timeout = setTimeout(function () {
      if (settled) return;
      settled = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      reportContextStatus(${JSON.stringify(`${title} · context-loss-unconfirmed`)});
      resolve(false);
    }, 1000);
    const onContextLost = function (event) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      reportContextStatus(${JSON.stringify(`${title} · context-lost`)});
      resolve(true);
    };
    canvas.addEventListener('webglcontextlost', onContextLost, { once: true });
    try {
      extension.loseContext();
    } catch (_) {
      clearTimeout(timeout);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      settled = true;
      reportContextStatus(${JSON.stringify(`${title} · context-loss-failed`)});
      resolve(false);
    }
  });
};
</script>
</body>
</html>`;
  return Object.freeze({
    paneCount,
    url: 'about:blank',
    title,
    html,
  });
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

interface AbortableOperationOptions<T> {
  readonly lateSettlements?: Set<Promise<void>>;
  readonly lateReapers?: Set<Promise<void>>;
  readonly onLateResolve?: (value: T) => Promise<void> | void;
  readonly onLateQuarantine?: (value: T) => void;
  readonly onLateTimeout?: (error: Error) => void;
}

type InvokeStressOperation = <T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  signal: AbortSignal,
  onLateResolve?: (cleanupSignal: AbortSignal) => Promise<void> | void,
  onLateQuarantine?: (value: T) => void,
) => Promise<T>;

const LATE_RESOURCE_RESULT_TIMEOUT_MS = 2_000;
const DETACHED_REAPER_RETENTION_MS = 5_000;
const DETACHED_STRESS_REAPERS = new Set<Promise<void>>();

function retainStressReaper(
  reaper: Promise<void>,
  destination: Set<Promise<void>> = DETACHED_STRESS_REAPERS,
): void {
  let retentionTimeout: ReturnType<typeof setTimeout> | undefined;
  const retentionDeadline = new Promise<void>((resolve) => {
    retentionTimeout = setTimeout(resolve, DETACHED_REAPER_RETENTION_MS);
  });
  const retained = Promise.race([reaper, retentionDeadline]).then(() => undefined, () => undefined);
  destination.add(retained);
  void retained.finally(() => {
    if (retentionTimeout !== undefined) clearTimeout(retentionTimeout);
    destination.delete(retained);
  }).catch(() => undefined);
}

async function invokeAbortable<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal,
  options: AbortableOperationOptions<T> = {},
): Promise<T> {
  throwIfAborted(signal);
  const operationPromise = Promise.resolve().then(() => {
    throwIfAborted(signal);
    return operation();
  });
  let lateResolve: (() => void) | undefined;
  let lateReject: ((reason?: unknown) => void) | undefined;
  let lateTimeout: ReturnType<typeof setTimeout> | undefined;
  let lateHardTimeout: ReturnType<typeof setTimeout> | undefined;
  let latePostCutoffTimeout: ReturnType<typeof setTimeout> | undefined;
  let lateCompensationStarted = false;
  let lateCompensationFinished = false;
  let lateSettlementFinished = false;
  let lateQuarantineClosed = false;
  let lateCutoffError: Error | undefined;
  let completeLateCompensation: (() => void) | undefined;
  const hasLateHandler = options.onLateResolve !== undefined || options.onLateQuarantine !== undefined;
  const lateCompensation = options.onLateResolve === undefined
    ? undefined
    : new Promise<void>((resolve) => {
      completeLateCompensation = () => {
        if (lateCompensationFinished) return;
        lateCompensationFinished = true;
        resolve();
      };
    });
  const clearLateTimeouts = (): void => {
    if (lateTimeout !== undefined) clearTimeout(lateTimeout);
    if (lateHardTimeout !== undefined) clearTimeout(lateHardTimeout);
    if (latePostCutoffTimeout !== undefined) clearTimeout(latePostCutoffTimeout);
  };
  const finishLate = (reason?: unknown): void => {
    if (lateSettlementFinished) return;
    lateSettlementFinished = true;
    lateQuarantineClosed = true;
    clearLateTimeouts();
    if (reason === undefined) lateResolve?.();
    else lateReject?.(reason);
    if (lateSettlement) options.lateSettlements?.delete(lateSettlement);
  };
  const armLatePostCutoff = (error: Error): void => {
    if (latePostCutoffTimeout !== undefined) clearTimeout(latePostCutoffTimeout);
    // Keep the scenario in a bounded quarantine while a late native result
    // can still arrive. Starting compensation resets that window so cleanup
    // gets a full bounded interval, and finalization closes the gate before
    // any result that arrives after quarantine can mutate state.
    latePostCutoffTimeout = setTimeout(
      () => {
        if (lateCompensationStarted && !lateCompensationFinished) {
          armLatePostCutoff(error);
          return;
        }
        finishLate(error);
      },
      DETACHED_REAPER_RETENTION_MS,
    );
  };
  const lateSettlement = !hasLateHandler
    ? undefined
    : new Promise<void>((resolve, reject) => {
      lateResolve = resolve;
      lateReject = reject;
    });
  if (lateSettlement) {
    options.lateSettlements?.add(lateSettlement);
    // The settlement remains handled even if the bounded wait expires before
    // the native invoke returns. The late-result callback still runs and owns
    // compensation for a resource that was created after cancellation.
    void lateSettlement.catch(() => undefined);
  }
  const armLateTimeout = (): void => {
    if (!lateSettlement || lateTimeout !== undefined) return;
    lateTimeout = setTimeout(() => {
      const error = new Error('stress resource creation did not settle after cancellation');
      try {
        options.onLateTimeout?.(error);
      } catch {
        // The tracked late settlement remains the authoritative cleanup error.
      }
      // Keep the tracked settlement pending while a late resource can still
      // arrive and be compensated. A second deadline prevents an absent or
      // permanently hung native result from keeping the scenario alive.
      lateHardTimeout = setTimeout(() => {
        // This is the bounded result-wait cutoff. A result that arrives after
        // it is still owned by the harness and is sent through the same bounded
        // compensation path; the cutoff only closes the promise that was
        // keeping the caller waiting for the native invoke itself.
        lateCutoffError = error;
        armLatePostCutoff(error);
      }, LATE_RESOURCE_RESULT_TIMEOUT_MS);
    }, LATE_RESOURCE_RESULT_TIMEOUT_MS);
  };
  const settleLate = (value: T): void => {
    // A late native operation is still owned by this harness even when the
    // bounded result wait has elapsed. Run async compensation during the
    // quarantine rather than dropping a resource and leaking a pane/PTY. A
    // result that arrives after the quarantine gets only the synchronous
    // terminal invalidation path; starting async cleanup after finalization
    // would mutate state out of band.
    if (lateSettlementFinished || lateQuarantineClosed) {
      try {
        options.onLateQuarantine?.(value);
      } catch (error) {
        try {
          options.onLateTimeout?.(error instanceof Error ? error : new Error('late resource quarantine failed'));
        } catch {
          // Late cleanup diagnostics must never create an unhandled rejection.
        }
      }
      return;
    }
    if (lateCompensationStarted) return;
    lateCompensationStarted = true;
    if (lateCutoffError !== undefined) armLatePostCutoff(lateCutoffError);
    let work: Promise<void> | void;
    try {
      work = options.onLateResolve?.(value);
    } catch (error) {
      completeLateCompensation?.();
      finishLate(error);
      return;
    }
    if (lateCompensation && !lateCompensationFinished) {
      retainStressReaper(lateCompensation, options.lateReapers);
    }
    void Promise.resolve(work).then(
      () => {
        completeLateCompensation?.();
        finishLate(lateCutoffError);
      },
      (error) => {
        completeLateCompensation?.();
        finishLate(error);
      },
    ).catch(() => undefined);
  };
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const clearAbortTimer = (): void => {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      abortTimer = undefined;
    };
    const onAbort = () => {
      if (settled || abortTimer !== undefined) return;
      // Give an operation that has already resolved in the current turn a
      // chance to win before classifying it as late. This avoids compensating
      // an operation that synchronously observed cancellation after completing
      // its native work, while an actually pending native promise still enters
      // the late-settlement path on the next turn.
      abortTimer = setTimeout(() => {
        abortTimer = undefined;
        if (settled) return;
        settled = true;
        armLateTimeout();
        cleanup();
        reject(abortReason(signal));
      }, 0);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operationPromise.then(
      (value) => {
        if (settled) {
          if (hasLateHandler) settleLate(value);
          return;
        }
        settled = true;
        clearAbortTimer();
        cleanup();
        clearLateTimeouts();
        completeLateCompensation?.();
        finishLate();
        resolve(value);
      },
      (error) => {
        if (settled) {
          // A late rejection is still observed by this handler. There is no
          // resource to compensate, so release the tracked settlement.
          completeLateCompensation?.();
          finishLate();
          return;
        }
        settled = true;
        clearAbortTimer();
        cleanup();
        clearLateTimeouts();
        completeLateCompensation?.();
        finishLate();
        reject(error);
      },
    );
  });
}

const STRESS_OPERATION_TIMEOUT_MS = 2_000;

interface BoundedOperationOptions<T> {
  readonly lateSettlements?: Set<Promise<void>>;
  readonly lateReapers?: Set<Promise<void>>;
  readonly onLateResolve?: (value: T) => Promise<void> | void;
  readonly onLateQuarantine?: (value: T) => void;
  readonly onLateTimeout?: (error: Error) => void;
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}

interface BoundedCleanupOptions {
  readonly lateSettlements?: Set<Promise<void>>;
  readonly lateReapers?: Set<Promise<void>>;
  readonly onLateCompletion?: (error?: unknown) => void;
}

async function invokeBoundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  signal: AbortSignal,
  options: BoundedOperationOptions<T> = {},
): Promise<T> {
  const operationController = new AbortController();
  const forwardAbort = () => operationController.abort(abortReason(signal));
  if (signal.aborted) forwardAbort();
  else signal.addEventListener('abort', forwardAbort, { once: true });
  const timeoutError = Object.assign(
    new Error(options.timeoutMessage ?? 'stress operation timed out'),
    { name: 'TimeoutError' },
  );
  const timeout = setTimeout(
    () => operationController.abort(timeoutError),
    Math.max(0, options.timeoutMs ?? STRESS_OPERATION_TIMEOUT_MS),
  );
  try {
    return await invokeAbortable(
      () => operation(operationController.signal),
      operationController.signal,
      options,
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', forwardAbort);
  }
}

async function awaitPendingLateSettlements(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

const CLEANUP_OPERATION_TIMEOUT_MS = 2_000;
const LATE_COMPLETION_SETTLEMENT_TIMEOUT_MS = 1_000;

async function invokeBoundedCleanup<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  onTimeout?: () => void,
  options: BoundedCleanupOptions = {},
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let timeoutError: Error | undefined;
  let timeoutCleanup: Promise<void> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeoutResult = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      timeoutError = new Error('stress cleanup operation timed out');
      controller.abort(timeoutError);
      const lateCompletion = operationPromise.then(
        () => {
          try {
            options.onLateCompletion?.();
          } catch {
            // Cleanup diagnostics must never create an unhandled rejection.
          }
        },
        (error) => {
          try {
            options.onLateCompletion?.(error);
          } catch {
            // Cleanup diagnostics must never create an unhandled rejection.
          }
        },
      ).then(() => undefined);
      const forceCleanup = Promise.resolve()
        .then(() => onTimeout?.())
        .then(() => undefined);
      const lateReaper = Promise.allSettled([lateCompletion, forceCleanup])
        .then(() => undefined);
      if (options.lateReapers) retainStressReaper(lateReaper, options.lateReapers);
      const lateCompletionDeadline = new Promise<void>((resolve) => {
        setTimeout(resolve, LATE_COMPLETION_SETTLEMENT_TIMEOUT_MS);
      });
      const boundedLateCompletion = Promise.race([
        lateCompletion,
        lateCompletionDeadline,
      ]).then(() => undefined);
      options.lateSettlements?.add(boundedLateCompletion);
      void boundedLateCompletion.finally(() => {
        options.lateSettlements?.delete(boundedLateCompletion);
      }).catch(() => undefined);
      timeoutCleanup = forceCleanup;
      void timeoutCleanup.catch(() => undefined);
      reject(timeoutError);
    }, CLEANUP_OPERATION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([operationPromise, timeoutResult]);
    if (timeoutCleanup) await timeoutCleanup;
    if (timedOut) throw timeoutError;
    return result;
  } catch (error) {
    if (timeoutCleanup) await timeoutCleanup.catch(() => undefined);
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function emitProgress(
  dependencies: StressHarnessDependencies,
  scenarioIndex: number,
  scenarioValue: StressScenario,
  phase: StressPhase,
  elapsedMs: number,
  phaseDurationMs: number,
): void {
  dependencies.onProgress({
    scenarioIndex,
    paneCount: scenarioValue.paneCount,
    phase,
    elapsedMs,
    phaseDurationMs,
  });
}

async function runActivePhase(
  dependencies: StressHarnessDependencies,
  signal: AbortSignal,
  scenarioIndex: number,
  scenarioValue: StressScenario,
  phase: 'warmup' | 'measure',
  durationMs: number,
  focusOrder: readonly string[],
  invokeOperation: InvokeStressOperation = (operation, operationSignal, onLateResolve, onLateQuarantine) => (
    invokeAbortable(
      () => operation(operationSignal),
      operationSignal,
      onLateResolve === undefined ? {} : {
        onLateResolve: () => invokeBoundedCleanup(onLateResolve),
        onLateQuarantine,
      },
    )
  ),
): Promise<void> {
  const phaseController = new AbortController();
  throwIfAborted(signal);
  const abortPhase = () => phaseController.abort(abortReason(signal));
  signal.addEventListener('abort', abortPhase, { once: true });
  let frameHandle: number | null = null;
  let frameStep = 0;
  let frameError: unknown;
  let frameActive = true;
  let phaseTimeout: ReturnType<typeof setTimeout> | undefined;
  let phaseDeadlineReached = false;
  const phaseTimeoutError = new Error(`stress ${phase} phase timed out`);
  const phaseStartedAt = dependencies.now();
  const abortAtPhaseDeadline = (): void => {
    if (
      !phaseController.signal.aborted
      && dependencies.now() - phaseStartedAt >= durationMs
    ) {
      phaseDeadlineReached = true;
      phaseController.abort(phaseTimeoutError);
    }
  };
  phaseTimeout = setTimeout(() => {
    phaseDeadlineReached = true;
    phaseController.abort(phaseTimeoutError);
  }, Math.max(0, durationMs));

  const requestGeometryFrame = () => {
    if (!frameActive || phaseController.signal.aborted) return;
    frameHandle = dependencies.requestFrame(() => {
      frameHandle = null;
      if (!frameActive || phaseController.signal.aborted) return;
      abortAtPhaseDeadline();
      if (phaseController.signal.aborted) return;
      try {
        dependencies.resize(
          frameStep,
          buildStressGeometry(
            scenarioIndex,
            scenarioValue.paneCount,
            frameStep,
            focusOrder,
          ),
        );
        abortAtPhaseDeadline();
        if (phaseController.signal.aborted) return;
        frameStep += 1;
        requestGeometryFrame();
      } catch (error) {
        frameError = error;
        phaseController.abort(error);
      }
    });
  };

  try {
    emitProgress(dependencies, scenarioIndex, scenarioValue, phase, 0, durationMs);
    abortAtPhaseDeadline();
    throwIfAborted(phaseController.signal);
    requestGeometryFrame();
    abortAtPhaseDeadline();
    throwIfAborted(phaseController.signal);
    let focusStep = 0;
    let nextFocusAt = phaseStartedAt + STRESS_FOCUS_INTERVAL_MS;
    while (true) {
      const nowBeforeSleep = dependencies.now();
      const elapsedBeforeSleep = Math.max(0, nowBeforeSleep - phaseStartedAt);
      const remainingMs = durationMs - elapsedBeforeSleep;
      if (remainingMs <= 0) break;
      const delayMs = Math.min(
        remainingMs,
        Math.max(0, nextFocusAt - nowBeforeSleep),
      );
      if (delayMs > 0) {
        await invokeBoundedOperation(
          (sleepSignal) => dependencies.sleep(delayMs, sleepSignal),
          phaseController.signal,
          {
            timeoutMs: delayMs + 1,
            timeoutMessage: `stress ${phase} sleep timed out`,
          },
        );
      }
      abortAtPhaseDeadline();
      throwIfAborted(phaseController.signal);
      if (frameError !== undefined) throw frameError;
      const focusNow = dependencies.now();
      const elapsedBeforeFocus = Math.max(0, focusNow - phaseStartedAt);
      if (elapsedBeforeFocus >= durationMs) break;
      if (focusNow < nextFocusAt) continue;
      throwIfAborted(phaseController.signal);
      await invokeOperation(
        (operationSignal) => dependencies.focus(stressFocusId(focusOrder, focusStep), operationSignal),
        phaseController.signal,
        (cleanupSignal) => dependencies.focus(
          focusOrder[0] ?? stressFocusId(focusOrder, 0),
          cleanupSignal,
        ),
        () => {
          if (dependencies.invalidateLateOperation === undefined) {
            throw new Error('late focus operation lacks terminal invalidation');
          }
          dependencies.invalidateLateOperation('focus');
        },
      );
      abortAtPhaseDeadline();
      throwIfAborted(phaseController.signal);
      focusStep += 1;
      nextFocusAt += STRESS_FOCUS_INTERVAL_MS;
      const focusCompletedAt = dependencies.now();
      if (focusCompletedAt >= nextFocusAt) {
        nextFocusAt += (
          Math.floor(
            (focusCompletedAt - nextFocusAt) / STRESS_FOCUS_INTERVAL_MS,
          ) + 1
        ) * STRESS_FOCUS_INTERVAL_MS;
      }
      const elapsedMs = Math.min(
        durationMs,
        Math.max(0, focusCompletedAt - phaseStartedAt),
      );
      emitProgress(
        dependencies,
        scenarioIndex,
        scenarioValue,
        phase,
        elapsedMs,
        durationMs,
      );
    }
  } catch (error) {
    if (!phaseDeadlineReached || phaseController.signal.reason !== phaseTimeoutError) {
      throw error;
    }
  } finally {
    if (phaseTimeout !== undefined) clearTimeout(phaseTimeout);
    frameActive = false;
    if (frameHandle !== null) {
      dependencies.cancelFrame(frameHandle);
      frameHandle = null;
    }
    signal.removeEventListener('abort', abortPhase);
    if (!phaseController.signal.aborted) phaseController.abort();
  }
}

async function restoreHiddenPanes(
  dependencies: StressHarnessDependencies,
  hiddenPaneIds: Set<string>,
  signal?: AbortSignal,
  invokeOperation: InvokeStressOperation = (operation, operationSignal, onLateResolve, onLateQuarantine) => (
    invokeAbortable(
      () => operation(operationSignal),
      operationSignal,
      onLateResolve === undefined ? {} : {
        onLateResolve: () => invokeBoundedCleanup(onLateResolve),
        onLateQuarantine,
      },
    )
  ),
  invokeCleanup: (operation: (cleanupSignal: AbortSignal) => Promise<void> | void) => Promise<void> = (
    operation,
  ) => invokeBoundedCleanup(operation),
): Promise<void> {
  const errors: unknown[] = [];
  for (const id of [...hiddenPaneIds]) {
    try {
      if (signal) {
        await invokeOperation(
          (operationSignal) => dependencies.setVisible(id, true, operationSignal),
          signal,
          (cleanupSignal) => dependencies.setVisible(id, true, cleanupSignal),
          () => {
            if (dependencies.invalidateLateOperation === undefined) {
              throw new Error('late visibility operation lacks terminal invalidation');
            }
            dependencies.invalidateLateOperation('visibility');
          },
        );
      } else {
        await invokeCleanup((cleanupSignal) => dependencies.setVisible(id, true, cleanupSignal));
      }
      hiddenPaneIds.delete(id);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'failed to restore hidden stress panes');
  }
}

function combineErrors(primaryError: unknown, cleanupErrors: unknown[]): unknown {
  if (cleanupErrors.length === 0) return primaryError;
  if (primaryError !== undefined) {
    const message = primaryError instanceof Error
      ? primaryError.message
      : 'stress harness failed';
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      message,
      { cause: primaryError },
    );
  }
  return new AggregateError(cleanupErrors, 'stress harness cleanup failed');
}

async function runStressScenario(
  dependencies: StressHarnessDependencies,
  signal: AbortSignal,
  scenarioIndex: number,
  scenarioValue: StressScenario,
): Promise<StressScenarioResult> {
  const resources: StressResource[] = [];
  const terminalIds: string[] = [];
  const hiddenPaneIds = new Set<string>();
  const cleanupErrors: unknown[] = [];
  const pendingLateSettlements = new Set<Promise<void>>();
  const pendingCleanupSettlements = new Set<Promise<void>>();
  let lateCleanupClosed = false;
  const recordCleanupError = (error: unknown): void => {
    // A native creation can settle after the bounded late-result grace period.
    // Its best-effort compensation must not mutate the result after this
    // scenario has finished reporting its cleanup outcome.
    if (!lateCleanupClosed) cleanupErrors.push(error);
  };
  const invokeCleanup = <T>(
    operation: (cleanupSignal: AbortSignal) => Promise<T> | T,
    onTimeout?: () => void,
  ): Promise<T> => invokeBoundedCleanup(operation, onTimeout, {
    lateSettlements: pendingCleanupSettlements,
    lateReapers: DETACHED_STRESS_REAPERS,
    onLateCompletion: (error) => recordCleanupError(
      error ?? new Error('stress cleanup completed after its deadline'),
    ),
  });
  const disposeResource = (resource: StressResource): Promise<void> => (
    invokeCleanup(
      (cleanupSignal) => resource.dispose(cleanupSignal),
      () => resource.forceDispose(),
    )
  );
  const invokeTracked: InvokeStressOperation = (operation, operationSignal, onLateResolve, onLateQuarantine) => (
    invokeBoundedOperation(operation, operationSignal, onLateResolve === undefined ? {
      onLateQuarantine,
    } : {
      lateSettlements: pendingLateSettlements,
      onLateResolve: () => invokeCleanup(onLateResolve),
      onLateQuarantine,
      onLateTimeout: recordCleanupError,
      lateReapers: DETACHED_STRESS_REAPERS,
    })
  );
  let primaryError: unknown;
  let result: StressScenarioResult | undefined;
  const startedAt = dependencies.now();

  const createResource = <T extends StressResource>(operation: (operationSignal: AbortSignal) => Promise<T>): Promise<T> => (
    invokeBoundedOperation(operation, signal, {
      lateSettlements: pendingLateSettlements,
      onLateResolve: async (resource) => {
        try {
          await disposeResource(resource);
        } catch (error) {
          recordCleanupError(error);
          throw error;
        }
      },
      onLateQuarantine: (resource) => {
        resource.forceDispose();
      },
      onLateTimeout: recordCleanupError,
      lateReapers: DETACHED_STRESS_REAPERS,
    })
  );

  try {
    emitProgress(dependencies, scenarioIndex, scenarioValue, 'setup', 0, 0);
    throwIfAborted(signal);
    for (let index = 0; index < scenarioValue.paneCount; index += 1) {
      const terminal = await createResource(
        (operationSignal) => dependencies.createTerminal(
          index,
          scenarioValue.fixtures[index] as StressFixture,
          operationSignal,
        ),
      );
      resources.push(terminal);
      terminalIds.push(terminal.id);
      throwIfAborted(signal);
    }

    throwIfAborted(signal);
    const editor = await createResource(
      (operationSignal) => dependencies.createEditor(
        createLargeEditorDocument(scenarioValue.paneCount),
        operationSignal,
      ),
    );
    resources.push(editor);
    throwIfAborted(signal);

    const browser = await createResource(
      (operationSignal) => dependencies.createBrowser(
        createDiagnosticBrowserPage(scenarioValue.paneCount),
        operationSignal,
      ),
    );
    resources.push(browser);
    throwIfAborted(signal);

    const focusOrder = buildStressFocusOrder(terminalIds, editor.id, browser.id);
    await runActivePhase(
      dependencies,
      signal,
      scenarioIndex,
      scenarioValue,
      'warmup',
      scenarioValue.warmupMs,
      focusOrder,
      invokeTracked,
    );
    await awaitPendingLateSettlements(pendingLateSettlements);

    throwIfAborted(signal);
    const hiddenStart = Math.ceil(terminalIds.length / 2);
    for (const id of terminalIds.slice(hiddenStart)) {
      hiddenPaneIds.add(id);
      await invokeTracked(
        (operationSignal) => dependencies.setVisible(id, false, operationSignal),
        signal,
        (cleanupSignal) => dependencies.setVisible(id, true, cleanupSignal),
        () => {
          if (dependencies.invalidateLateOperation === undefined) {
            throw new Error('late visibility operation lacks terminal invalidation');
          }
          dependencies.invalidateLateOperation('visibility');
        },
      );
      throwIfAborted(signal);
    }
    await awaitPendingLateSettlements(pendingLateSettlements);
    const measurementFocusOrder = buildStressFocusOrder(
      terminalIds.slice(0, hiddenStart),
      editor.id,
      browser.id,
    );

    dependencies.resetMetrics();
    throwIfAborted(signal);
    const beforeMeasurement = dependencies.snapshotMetrics();
    await runActivePhase(
      dependencies,
      signal,
      scenarioIndex,
      scenarioValue,
      'measure',
      scenarioValue.measureMs,
      measurementFocusOrder,
      invokeTracked,
    );
    await awaitPendingLateSettlements(pendingLateSettlements);
    throwIfAborted(signal);
    const afterMeasurement = dependencies.snapshotMetrics();

    emitProgress(
      dependencies,
      scenarioIndex,
      scenarioValue,
      'restore',
      0,
      scenarioValue.restoreMs,
    );
    const restoreStartedAt = dependencies.now();
    const restoreController = new AbortController();
    const restoreTimeoutError = Object.assign(new Error('stress restore phase timed out'), {
      name: 'TimeoutError',
    });
    const abortRestore = () => restoreController.abort(abortReason(signal));
    const restoreTimeout = setTimeout(
      () => restoreController.abort(restoreTimeoutError),
      scenarioValue.restoreMs,
    );
    if (signal.aborted) abortRestore();
    else signal.addEventListener('abort', abortRestore, { once: true });
    try {
      await invokeTracked(
        (operationSignal) => dependencies.cycleWindow(operationSignal),
        restoreController.signal,
        (cleanupSignal) => dependencies.cycleWindow(cleanupSignal),
        () => {
          if (dependencies.invalidateLateOperation === undefined) {
            throw new Error('late window operation lacks terminal invalidation');
          }
          dependencies.invalidateLateOperation('window');
        },
      );
      throwIfAborted(restoreController.signal);
      await restoreHiddenPanes(
        dependencies,
        hiddenPaneIds,
        restoreController.signal,
        invokeTracked,
        invokeCleanup,
      );
      throwIfAborted(restoreController.signal);
      const contextLossSupported = await invokeTracked(
        (operationSignal) => dependencies.loseGraphicsContext(operationSignal),
        restoreController.signal,
        (cleanupSignal) => {
          if (dependencies.restoreGraphicsContext === undefined) {
            throw new Error('late graphics-context loss has no compensation');
          }
          return dependencies.restoreGraphicsContext(cleanupSignal);
        },
        () => {
          if (dependencies.invalidateLateOperation === undefined) {
            throw new Error('late graphics operation lacks terminal invalidation');
          }
          dependencies.invalidateLateOperation('graphics');
        },
      );
      await awaitPendingLateSettlements(pendingLateSettlements);
      const restoreElapsedMs = Math.max(0, dependencies.now() - restoreStartedAt);
      const restoreRemainingMs = Math.max(0, scenarioValue.restoreMs - restoreElapsedMs);
      if (restoreRemainingMs > 0) {
        await invokeBoundedOperation(
          (sleepSignal) => dependencies.sleep(restoreRemainingMs, sleepSignal),
          restoreController.signal,
          {
            timeoutMs: restoreRemainingMs + 1,
            timeoutMessage: 'stress restore phase timed out',
          },
        );
      }
      throwIfAborted(restoreController.signal);
      emitProgress(
        dependencies,
        scenarioIndex,
        scenarioValue,
        'restore',
        scenarioValue.restoreMs,
        scenarioValue.restoreMs,
      );

      result = {
        paneCount: scenarioValue.paneCount,
        startedAt,
        finishedAt: dependencies.now(),
        contextLossSupported,
        metrics: {
          beforeMeasurement,
          afterMeasurement,
        },
      };
    } finally {
      clearTimeout(restoreTimeout);
      signal.removeEventListener('abort', abortRestore);
      if (!restoreController.signal.aborted) restoreController.abort();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      emitProgress(dependencies, scenarioIndex, scenarioValue, 'cleanup', 0, 0);
    } catch (error) {
      recordCleanupError(error);
    }
    if (pendingLateSettlements.size > 0) {
      const lateResults = await Promise.allSettled([...pendingLateSettlements]);
      for (const lateResult of lateResults) {
        if (lateResult.status === 'rejected' && !cleanupErrors.includes(lateResult.reason)) {
          recordCleanupError(lateResult.reason);
        }
      }
    }
    try {
      await restoreHiddenPanes(dependencies, hiddenPaneIds, undefined, undefined, invokeCleanup);
    } catch (error) {
      recordCleanupError(error);
    }
    for (const resource of resources.reverse()) {
      try {
        await disposeResource(resource);
      } catch (error) {
        recordCleanupError(error);
      }
    }
    if (pendingCleanupSettlements.size > 0) {
      await Promise.allSettled([...pendingCleanupSettlements]);
    }
    lateCleanupClosed = true;
  }

  const combinedError = combineErrors(primaryError, cleanupErrors);
  if (combinedError !== undefined) throw combinedError;
  return result as StressScenarioResult;
}

export async function runStressPlan(
  dependencies: StressHarnessDependencies,
  options: StressRunOptions = {},
): Promise<StressRunResult> {
  if (!dependencies.authorized) {
    throw new Error('render diagnostics are not authorized');
  }

  const runController = new AbortController();
  const forwardAbort = () => runController.abort(abortReason(options.signal as AbortSignal));
  if (options.signal?.aborted) {
    runController.abort(abortReason(options.signal));
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const startedAt = dependencies.now();
  const scenarios: StressScenarioResult[] = [];
  try {
    throwIfAborted(runController.signal);
    for (let index = 0; index < STRESS_PLAN.length; index += 1) {
      scenarios.push(await runStressScenario(
        dependencies,
        runController.signal,
        index,
        STRESS_PLAN[index] as StressScenario,
      ));
    }
    return {
      startedAt,
      finishedAt: dependencies.now(),
      scenarios,
    };
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/*
 * The remainder of this patch intentionally replaces only the operation
 * invocation sites above. The resource creation closures below are retained
 * by the compiler as the canonical dependency boundary.
 */
