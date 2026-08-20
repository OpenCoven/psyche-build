export type StressFixture = 'steady' | 'burst' | 'rewrite';
export type StressPhase = 'setup' | 'warmup' | 'measure' | 'restore' | 'cleanup';

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
  dispose(): void | Promise<void>;
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
  createTerminal(index: number, fixture: StressFixture): Promise<StressResource>;
  createEditor(document: StressEditorDocument): Promise<StressResource>;
  createBrowser(page: StressBrowserPage): Promise<StressResource>;
  focus(id: string): Promise<void>;
  resize(step: number, geometry: StressGeometry): void;
  setVisible(id: string, visible: boolean): Promise<void>;
  cycleWindow(): Promise<void>;
  loseGraphicsContext(): Promise<boolean>;
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
window.losePsycheDiagnosticsContext = function () {
  const extension = gl && gl.getExtension('WEBGL_lose_context');
  if (!extension) return false;
  extension.loseContext();
  return true;
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
): Promise<void> {
  const phaseController = new AbortController();
  const abortPhase = () => phaseController.abort(abortReason(signal));
  signal.addEventListener('abort', abortPhase, { once: true });
  let frameHandle: number | null = null;
  let frameStep = 0;
  let frameError: unknown;
  let frameActive = true;

  const requestGeometryFrame = () => {
    if (!frameActive || phaseController.signal.aborted) return;
    frameHandle = dependencies.requestFrame(() => {
      frameHandle = null;
      if (!frameActive || phaseController.signal.aborted) return;
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
        frameStep += 1;
        requestGeometryFrame();
      } catch (error) {
        frameError = error;
        phaseController.abort(error);
      }
    });
  };

  emitProgress(dependencies, scenarioIndex, scenarioValue, phase, 0, durationMs);
  try {
    requestGeometryFrame();
    const phaseStartedAt = dependencies.now();
    let focusStep = 0;
    while (true) {
      const elapsedBeforeSleep = Math.max(0, dependencies.now() - phaseStartedAt);
      const remainingMs = durationMs - elapsedBeforeSleep;
      if (remainingMs <= 0) break;
      const nextFocusAt = Math.min(
        durationMs,
        (focusStep + 1) * STRESS_FOCUS_INTERVAL_MS,
      );
      const delayMs = Math.min(
        remainingMs,
        Math.max(0, nextFocusAt - elapsedBeforeSleep),
      );
      if (delayMs > 0) {
        await dependencies.sleep(delayMs, phaseController.signal);
      }
      throwIfAborted(phaseController.signal);
      if (frameError !== undefined) throw frameError;
      const elapsedBeforeFocus = Math.max(0, dependencies.now() - phaseStartedAt);
      if (elapsedBeforeFocus >= durationMs) break;
      await dependencies.focus(stressFocusId(focusOrder, focusStep));
      focusStep += 1;
      const elapsedMs = Math.min(
        durationMs,
        Math.max(0, dependencies.now() - phaseStartedAt),
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
  } finally {
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
): Promise<void> {
  const errors: unknown[] = [];
  for (const id of [...hiddenPaneIds]) {
    try {
      await dependencies.setVisible(id, true);
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
  let primaryError: unknown;
  let result: StressScenarioResult | undefined;
  const startedAt = dependencies.now();

  emitProgress(dependencies, scenarioIndex, scenarioValue, 'setup', 0, 0);
  try {
    throwIfAborted(signal);
    for (let index = 0; index < scenarioValue.paneCount; index += 1) {
      const terminal = await dependencies.createTerminal(
        index,
        scenarioValue.fixtures[index] as StressFixture,
      );
      resources.push(terminal);
      terminalIds.push(terminal.id);
      throwIfAborted(signal);
    }

    const editor = await dependencies.createEditor(
      createLargeEditorDocument(scenarioValue.paneCount),
    );
    resources.push(editor);
    throwIfAborted(signal);

    const browser = await dependencies.createBrowser(
      createDiagnosticBrowserPage(scenarioValue.paneCount),
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
    );

    const hiddenStart = Math.ceil(terminalIds.length / 2);
    for (const id of terminalIds.slice(hiddenStart)) {
      hiddenPaneIds.add(id);
      await dependencies.setVisible(id, false);
    }

    dependencies.resetMetrics();
    const beforeMeasurement = dependencies.snapshotMetrics();
    await runActivePhase(
      dependencies,
      signal,
      scenarioIndex,
      scenarioValue,
      'measure',
      scenarioValue.measureMs,
      focusOrder,
    );
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
    await dependencies.cycleWindow();
    await restoreHiddenPanes(dependencies, hiddenPaneIds);
    const contextLossSupported = await dependencies.loseGraphicsContext();
    const restoreElapsedMs = Math.max(0, dependencies.now() - restoreStartedAt);
    const restoreRemainingMs = Math.max(0, scenarioValue.restoreMs - restoreElapsedMs);
    if (restoreRemainingMs > 0) {
      await dependencies.sleep(restoreRemainingMs, signal);
    }
    throwIfAborted(signal);
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
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      emitProgress(dependencies, scenarioIndex, scenarioValue, 'cleanup', 0, 0);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await restoreHiddenPanes(dependencies, hiddenPaneIds);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const resource of resources.reverse()) {
      try {
        await resource.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
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
