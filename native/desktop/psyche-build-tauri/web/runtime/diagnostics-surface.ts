import type { RuntimeGraphicsReport } from './graphics-diagnostics';
import type { RuntimePerformanceSnapshot } from './performance-metrics';
import type {
  StressProgress,
  StressRunOptions,
  StressRunResult,
} from './stress-harness';

export type GraphicsDiagnosticsTone = 'danger';

export interface GraphicsDiagnosticsRow {
  key: string;
  label: string;
  value: string;
  tone?: GraphicsDiagnosticsTone;
}

export interface GraphicsDiagnosticsSection {
  key: string;
  title: string;
  rows: GraphicsDiagnosticsRow[];
}

export interface GraphicsDiagnosticsScenarioSnapshot {
  state: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  progress?: StressProgress;
  result?: StressRunResult;
  error?: string;
}

export interface GraphicsDiagnosticsSnapshot {
  graphics?: RuntimeGraphicsReport;
  metrics?: RuntimePerformanceSnapshot;
  scenario?: GraphicsDiagnosticsScenarioSnapshot;
}

export interface GraphicsDiagnosticsView {
  softwareFallback: boolean;
  sections: GraphicsDiagnosticsSection[];
}

export interface GraphicsDiagnosticsStressHarness {
  run(options?: StressRunOptions): Promise<StressRunResult>;
  cancel(reason?: unknown): boolean;
}

export interface GraphicsDiagnosticsStressController {
  run(options?: StressRunOptions): Promise<StressRunResult>;
  cancel(reason?: unknown): boolean;
  running(): boolean;
  snapshot(): GraphicsDiagnosticsScenarioSnapshot;
  updateProgress(progress: StressProgress): void;
}

export interface GraphicsDiagnosticsStressControllerOptions {
  harness: GraphicsDiagnosticsStressHarness;
  isCancellation?: (error: unknown) => boolean;
  onStateChange?: (
    snapshot: GraphicsDiagnosticsScenarioSnapshot,
    error?: unknown,
    previous?: GraphicsDiagnosticsScenarioSnapshot,
  ) => void;
}

function errorProperty(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function aggregateErrorMembers(error: object): unknown[] {
  const aggregate = typeof AggregateError !== 'undefined' && error instanceof AggregateError;
  if (!aggregate && errorProperty(error, 'name') !== 'AggregateError') return [];
  const errors = errorProperty(error, 'errors');
  if (!errors || typeof errors !== 'object') return [];
  try {
    return Array.from(errors as Iterable<unknown>);
  } catch {
    return [];
  }
}

function nestedStressErrors(error: object): unknown[] {
  const nested = aggregateErrorMembers(error);
  const cause = errorProperty(error, 'cause');
  if (cause !== undefined && !nested.includes(cause)) nested.push(cause);
  return nested;
}

function isStressCancellation(
  error: unknown,
  ancestors: Set<object>,
): boolean {
  if (!error || typeof error !== 'object') return false;
  if (ancestors.has(error)) return false;
  ancestors.add(error);
  const nested = nestedStressErrors(error);
  const cancelled = nested.length === 0
    ? errorProperty(error, 'name') === 'AbortError'
    : nested.every((entry) => isStressCancellation(entry, ancestors));
  ancestors.delete(error);
  return cancelled;
}

export function isGraphicsDiagnosticsStressCancellation(error: unknown): boolean {
  return isStressCancellation(error, new Set<object>());
}

function errorText(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[unprintable error]';
  }
}

function formatStressErrorLines(error: unknown, ancestors: Set<object>): string[] {
  if (!error || typeof error !== 'object') return [errorText(error)];
  if (ancestors.has(error)) return ['[circular error]'];
  ancestors.add(error);
  const lines = [errorText(error)];
  const members = aggregateErrorMembers(error);
  members.forEach((member, index) => {
    const child = formatStressErrorLines(member, ancestors);
    lines.push(`  [${index + 1}] ${child[0]}`);
    for (const line of child.slice(1)) lines.push(`  ${line}`);
  });
  const cause = errorProperty(error, 'cause');
  if (cause !== undefined && !members.includes(cause)) {
    const child = formatStressErrorLines(cause, ancestors);
    lines.push(`  Caused by: ${child[0]}`);
    for (const line of child.slice(1)) lines.push(`  ${line}`);
  }
  ancestors.delete(error);
  return lines;
}

function formatStressError(error: unknown): string {
  return formatStressErrorLines(error, new Set<object>()).join('\n');
}

function copyScenarioSnapshot(
  snapshot: GraphicsDiagnosticsScenarioSnapshot,
): GraphicsDiagnosticsScenarioSnapshot {
  return {
    state: snapshot.state,
    ...(snapshot.progress ? { progress: { ...snapshot.progress } } : {}),
    ...(snapshot.result ? { result: snapshot.result } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

export function createGraphicsDiagnosticsStressController(
  options: GraphicsDiagnosticsStressControllerOptions,
): GraphicsDiagnosticsStressController {
  let state: GraphicsDiagnosticsScenarioSnapshot = { state: 'idle' };
  let activeRun: Promise<StressRunResult> | null = null;
  let active = false;
  const isCancellation =
    options.isCancellation ?? isGraphicsDiagnosticsStressCancellation;

  const snapshot = (): GraphicsDiagnosticsScenarioSnapshot => copyScenarioSnapshot(state);
  const publish = (
    next: GraphicsDiagnosticsScenarioSnapshot,
    error?: unknown,
  ): void => {
    const previous = snapshot();
    state = next;
    options.onStateChange?.(snapshot(), error, previous);
  };

  const run = (runOptions: StressRunOptions = {}): Promise<StressRunResult> => {
    if (active) {
      const error = new Error('render diagnostics are already running');
      options.onStateChange?.(snapshot(), error, snapshot());
      return Promise.reject(error);
    }
    active = true;
    publish({ state: 'running' });
    let harnessRun: Promise<StressRunResult>;
    try {
      harnessRun = options.harness.run(runOptions);
    } catch (error) {
      harnessRun = Promise.reject(error);
    }
    const operation = Promise.resolve(harnessRun)
      .then((result) => {
        publish({
          state: 'completed',
          ...(state.progress ? { progress: state.progress } : {}),
          result,
        });
        return result;
      })
      .catch((error: unknown) => {
        if (isCancellation(error)) {
          publish({
            state: 'cancelled',
            ...(state.progress ? { progress: state.progress } : {}),
          }, error);
        } else {
          publish({
            state: 'failed',
            ...(state.progress ? { progress: state.progress } : {}),
            error: formatStressError(error),
          }, error);
        }
        throw error;
      });
    activeRun = operation.finally(() => {
      active = false;
      activeRun = null;
    });
    return activeRun;
  };

  return Object.freeze({
    run,
    cancel(reason?: unknown) {
      if (!active) return false;
      const cancelled = options.harness.cancel(reason);
      if (cancelled) {
        publish({
          state: 'cancelling',
          ...(state.progress ? { progress: state.progress } : {}),
        });
      }
      return cancelled;
    },
    running() {
      return active;
    },
    snapshot,
    updateProgress(progress: StressProgress) {
      if (!active) return;
      publish({
        state: state.state === 'cancelling' ? 'cancelling' : 'running',
        progress: { ...progress },
      });
    },
  });
}

function row(
  key: string,
  label: string,
  value: string,
  tone?: GraphicsDiagnosticsTone,
): GraphicsDiagnosticsRow {
  return tone ? { key, label, value, tone } : { key, label, value };
}

function fixed(value: number, digits = 2): string {
  return `${value.toFixed(digits)}`;
}

function milliseconds(value: number): string {
  return `${fixed(value)} ms`;
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const;
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${fixed(amount)} ${units[unitIndex]}`;
}

function titleCaseIdentifier(value: string): string {
  return value.replaceAll('_', ' ');
}

function accelerationValue(report: RuntimeGraphicsReport): string {
  if (report.acceleration === 'software') return 'Software fallback';
  return report.acceleration.charAt(0).toUpperCase() + report.acceleration.slice(1);
}

function graphicsSection(report: RuntimeGraphicsReport): GraphicsDiagnosticsSection {
  const software = report.acceleration === 'software';
  const rows = [
    row(
      'acceleration',
      'Acceleration',
      accelerationValue(report),
      software ? 'danger' : undefined,
    ),
    row('engine', 'Engine', report.engine),
  ];
  if (report.engineVersion) {
    rows.push(row('engine-version', 'Engine version', report.engineVersion));
  }
  if (report.backend) rows.push(row('backend', 'Backend', report.backend));
  if (report.adapter) rows.push(row('adapter', 'Adapter', report.adapter));
  if (report.fallbackReason) {
    rows.push(row(
      'fallback-reason',
      'Fallback reason',
      titleCaseIdentifier(report.fallbackReason),
      software ? 'danger' : undefined,
    ));
  }
  if (report.supportingProbe) {
    rows.push(row('supporting-probe', 'Supporting probe', report.supportingProbe));
  }
  rows.push(row('os', 'Operating system', report.os));
  rows.push(row('architecture', 'Architecture', report.arch));
  return { key: 'graphics', title: 'Graphics', rows };
}

function metricSections(
  metrics: RuntimePerformanceSnapshot,
): GraphicsDiagnosticsSection[] {
  const sections: GraphicsDiagnosticsSection[] = [
    {
      key: 'frames',
      title: 'Frame cadence',
      rows: [
        row('sampled-at', 'Sample clock', milliseconds(metrics.sampledAt)),
        row('frame-samples', 'Frame samples', String(metrics.frames.sampleCount)),
        row('frame-average', 'Frame average', milliseconds(metrics.frames.averageMs)),
        row('frame-p95', 'Frame p95', milliseconds(metrics.frames.p95Ms)),
        row('frame-max', 'Frame maximum', milliseconds(metrics.frames.maxMs)),
        row('frame-over-16-7', 'Frames over 16.7 ms', String(metrics.frames.over16_7)),
        row('frame-over-33-4', 'Frames over 33.4 ms', String(metrics.frames.over33_4)),
        row('frame-over-50', 'Frames over 50 ms', String(metrics.frames.over50)),
        row(
          'estimated-dropped-frames',
          'Estimated dropped frames',
          String(metrics.frames.estimatedDroppedFrames),
        ),
      ],
    },
    {
      key: 'throughput',
      title: 'Throughput',
      rows: [
        row(
          'bytes-per-second',
          'Bytes / second',
          `${bytes(metrics.transport.bytesPerSecond)}/s`,
        ),
        row(
          'batches-per-second',
          'Batches / second',
          fixed(metrics.transport.batchesPerSecond),
        ),
      ],
    },
    {
      key: 'batching',
      title: 'IPC batching and distribution',
      rows: [
        row(
          'average-batch-bytes',
          'Average batch',
          bytes(metrics.transport.averageBatchBytes),
        ),
        row('p95-batch-bytes', 'Batch p95', bytes(metrics.transport.p95BatchBytes)),
        row(
          'p95-batch-interval',
          'Batch interval p95',
          milliseconds(metrics.transport.p95BatchIntervalMs),
        ),
      ],
    },
    {
      key: 'queue',
      title: 'Queue and backpressure',
      rows: [
        row(
          'queue-bytes-high-water',
          'Queue bytes high-water',
          bytes(metrics.transport.queueBytesHighWater),
        ),
        row(
          'queue-depth-high-water',
          'Queue depth high-water',
          String(metrics.transport.queueDepthHighWater),
        ),
        row(
          'blocked-producers-high-water',
          'Blocked producers high-water',
          String(metrics.transport.blockedProducersHighWater),
        ),
        row(
          'backpressure-count',
          'Backpressure events',
          String(metrics.transport.backpressureCount),
        ),
      ],
    },
    {
      key: 'renderer',
      title: 'Renderer lifecycle',
      rows: [
        row(
          'coalesced-visual-updates',
          'Coalesced visual updates',
          String(metrics.renderer.coalescedVisualUpdates),
        ),
        row('webgl-panes', 'WebGL panes', String(metrics.renderer.webglPanes)),
        row('recovering-panes', 'Recovering panes', String(metrics.renderer.recoveringPanes)),
        row(
          'fallback-panes',
          'Fallback panes',
          String(metrics.renderer.fallbackPanes),
          metrics.renderer.fallbackPanes > 0 ? 'danger' : undefined,
        ),
        row(
          'renderer-transitions',
          'Renderer transitions',
          String(metrics.renderer.rendererTransitions),
        ),
        row('context-losses', 'Context losses', String(metrics.renderer.contextLosses)),
      ],
    },
  ];

  if (metrics.transport.averageAckLatencyMs !== undefined) {
    sections[2]?.rows.push(row(
      'average-acknowledgement',
      'Average acknowledgement',
      milliseconds(metrics.transport.averageAckLatencyMs),
    ));
  }
  if (metrics.transport.maxAckLatencyMs !== undefined) {
    sections[2]?.rows.push(row(
      'maximum-acknowledgement',
      'Maximum acknowledgement',
      milliseconds(metrics.transport.maxAckLatencyMs),
    ));
  }
  if (metrics.longTasks) {
    sections.push({
      key: 'long-tasks',
      title: 'Long tasks',
      rows: [
        row('long-task-count', 'Long-task count', String(metrics.longTasks.count)),
        row('long-task-total', 'Long-task total', milliseconds(metrics.longTasks.totalMs)),
        row('long-task-max', 'Long-task maximum', milliseconds(metrics.longTasks.maxMs)),
      ],
    });
  }

  const interactionRows: GraphicsDiagnosticsRow[] = [];
  if (metrics.interactions.focusToNextPaintMs !== undefined) {
    interactionRows.push(row(
      'focus-to-next-paint',
      'Focus to next paint',
      milliseconds(metrics.interactions.focusToNextPaintMs),
    ));
  }
  if (metrics.interactions.resizeToNextPaintMs !== undefined) {
    interactionRows.push(row(
      'resize-to-next-paint',
      'Resize to next paint',
      milliseconds(metrics.interactions.resizeToNextPaintMs),
    ));
  }
  if (interactionRows.length > 0) {
    sections.push({ key: 'interactions', title: 'Interactions', rows: interactionRows });
  }

  const processRows: GraphicsDiagnosticsRow[] = [];
  if (metrics.process?.cpuPercent !== undefined) {
    processRows.push(row(
      'process-cpu',
      'Process CPU',
      `${fixed(metrics.process.cpuPercent)}%`,
    ));
  }
  if (metrics.process?.rssBytes !== undefined) {
    processRows.push(row(
      'process-rss',
      'Process RSS',
      bytes(metrics.process.rssBytes),
    ));
  }
  if (processRows.length > 0) {
    sections.push({ key: 'process', title: 'Process', rows: processRows });
  }

  return sections;
}

export function buildGraphicsDiagnosticsView(
  snapshot: GraphicsDiagnosticsSnapshot,
): GraphicsDiagnosticsView {
  const sections: GraphicsDiagnosticsSection[] = [];
  if (snapshot.graphics) sections.push(graphicsSection(snapshot.graphics));
  if (snapshot.metrics) sections.push(...metricSections(snapshot.metrics));
  return {
    softwareFallback: snapshot.graphics?.acceleration === 'software',
    sections,
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = stableJsonValue(entry);
    }
    return result;
  }
  return value;
}

export function serializeGraphicsDiagnosticsSnapshot(
  snapshot: GraphicsDiagnosticsSnapshot,
): string {
  return `${JSON.stringify(stableJsonValue(snapshot), null, 2)}\n`;
}

const progressPhaseLabels = {
  setup: 'Setting up',
  warmup: 'Warming up',
  measure: 'Measuring',
  restore: 'Restoring',
  cleanup: 'Cleaning up',
} as const;

export function formatDiagnosticsStressProgress(
  progress: StressProgress,
  scenarioCount = 4,
): string {
  const prefix = [
    `Scenario ${progress.scenarioIndex + 1} of ${scenarioCount}`,
    `${progress.paneCount} panes`,
    progressPhaseLabels[progress.phase],
  ].join(' · ');
  if (progress.phaseDurationMs <= 0) return prefix;
  return `${prefix} · ${fixed(progress.elapsedMs / 1_000, 1)} of ` +
    `${fixed(progress.phaseDurationMs / 1_000, 1)} seconds`;
}
