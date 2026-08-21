export const FRAME_SAMPLE_LIMIT = 20_000;

type RecordLike = Record<string, unknown>;
export type InteractionKind = 'focus' | 'resize';

export interface FrameSummary {
  sampleCount: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
  over16_7: number;
  over33_4: number;
  over50: number;
  estimatedDroppedFrames: number;
}

function cumulativeDelta(value: number, baseline: number): number {
  return Math.max(0, value - baseline);
}

export interface RuntimePerformanceSnapshot {
  sampledAt: number;
  frames: FrameSummary;
  longTasks?: {
    count: number;
    totalMs: number;
    maxMs: number;
  };
  transport: {
    bytesPerSecond: number;
    batchesPerSecond: number;
    averageBatchBytes: number;
    p95BatchBytes: number;
    p95BatchIntervalMs: number;
    queueBytesHighWater: number;
    queueDepthHighWater: number;
    blockedProducersHighWater: number;
    backpressureCount: number;
    averageAckLatencyMs?: number;
    maxAckLatencyMs?: number;
  };
  renderer: {
    coalescedVisualUpdates: number;
    webglPanes: number;
    recoveringPanes: number;
    fallbackPanes: number;
    rendererTransitions: number;
    contextLosses: number;
  };
  interactions: {
    focusToNextPaintMs?: number;
    resizeToNextPaintMs?: number;
  };
  process?: {
    cpuPercent?: number;
    rssBytes?: number;
  };
}

export interface PerformanceSchedulerSnapshot {
  pendingCallbacks?: number;
  coalescedVisualUpdates?: number;
}

export interface PerformanceRendererSnapshot {
  paneId: string;
  rendererGeneration?: number;
  state?: string;
  rendererTransitions?: number;
  contextLosses?: number;
  webgl?: boolean;
  recovering?: boolean;
  fallback?: boolean;
}

export interface PerformanceObserverEntryList {
  getEntries(): Array<{ duration?: number; entryType?: string }>;
}

export type PerformanceObserverEntries =
  | PerformanceObserverEntryList
  | Array<{ duration?: number; entryType?: string }>;

export interface PerformanceObserverLike {
  observe(options: { entryTypes: string[] }): void;
  disconnect(): void;
}

export interface PerformanceVisibilityTarget {
  readonly hidden?: boolean;
  readonly visibilityState?: string;
  addEventListener(name: 'visibilitychange', listener: () => void): void;
  removeEventListener(name: 'visibilitychange', listener: () => void): void;
}

export type PerformanceObserverFactory = (
  callback: (list: PerformanceObserverEntries) => void,
) => PerformanceObserverLike;

export interface PerformanceMetricsCollectorOptions {
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
  createPerformanceObserver?: PerformanceObserverFactory;
  visibilityTarget?: PerformanceVisibilityTarget | null;
  schedulerSnapshot?: () => PerformanceSchedulerSnapshot;
  rendererSnapshots?: () => readonly PerformanceRendererSnapshot[];
  reportError?: (error: unknown, operation: string) => void;
}

export interface PerformanceMetricsCollector {
  start(): void;
  stop(): void;
  recordFrame(timestamp: number): void;
  recordLongTask(duration: number): void;
  recordInteractionStart(kind: InteractionKind, timestamp: number): void;
  recordInteractionPaint(kind: InteractionKind, timestamp: number): void;
  cancelInteraction(kind: InteractionKind): void;
  mergeNativeSnapshot(input: unknown): void;
  snapshot(): RuntimePerformanceSnapshot;
  reset(): void;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberFrom(source: RecordLike | undefined, keys: readonly string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = finiteNonNegative(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function numberArrayFrom(
  source: RecordLike | undefined,
  keys: readonly string[],
): number[] {
  if (!source) return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value
        .map(finiteNonNegative)
        .filter((entry): entry is number => entry !== undefined);
    }
    const single = finiteNonNegative(value);
    if (single !== undefined) return [single];
  }
  return [];
}

function defaultVisibilityTarget(): PerformanceVisibilityTarget | undefined {
  const candidate = (globalThis as unknown as { document?: unknown }).document;
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    return undefined;
  }
  return candidate as unknown as PerformanceVisibilityTarget;
}

function nearestRank(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function summarizeFrames(samples: readonly number[]): FrameSummary {
  const validSamples = samples
    .map(finiteNonNegative)
    .filter((sample): sample is number => sample !== undefined);
  if (validSamples.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maxMs: 0,
      over16_7: 0,
      over33_4: 0,
      over50: 0,
      estimatedDroppedFrames: 0,
    };
  }

  const total = validSamples.reduce((sum, sample) => sum + sample, 0);
  const maxMs = Math.max(...validSamples);
  return {
    sampleCount: validSamples.length,
    averageMs: total / validSamples.length,
    p95Ms: nearestRank(validSamples),
    maxMs,
    over16_7: validSamples.filter((sample) => sample > 16.7).length,
    over33_4: validSamples.filter((sample) => sample > 33.4).length,
    over50: validSamples.filter((sample) => sample > 50).length,
    estimatedDroppedFrames: validSamples.reduce(
      (sum, sample) => sum + Math.max(0, Math.round(sample / 16.7) - 1),
      0,
    ),
  };
}

class CircularSamples {
  private readonly values = new Array<number>(FRAME_SAMPLE_LIMIT);
  private next = 0;
  private size = 0;

  push(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.next] = value;
    this.next = (this.next + 1) % FRAME_SAMPLE_LIMIT;
    this.size = Math.min(FRAME_SAMPLE_LIMIT, this.size + 1);
  }

  pushRepeated(value: number, count: number): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(count) || count <= 0) return;
    const repeats = Math.floor(count);
    if (repeats === 0) return;
    const retained = Math.min(FRAME_SAMPLE_LIMIT, repeats);
    if (retained === FRAME_SAMPLE_LIMIT) {
      this.values.fill(value);
      this.next = 0;
      this.size = FRAME_SAMPLE_LIMIT;
      return;
    }
    for (let index = 0; index < retained; index += 1) this.push(value);
  }

  toArray(): number[] {
    if (this.size === 0) return [];
    const start = (this.next - this.size + FRAME_SAMPLE_LIMIT) % FRAME_SAMPLE_LIMIT;
    return Array.from({ length: this.size }, (_, index) =>
      this.values[(start + index) % FRAME_SAMPLE_LIMIT]!,
    );
  }

  clear(): void {
    this.next = 0;
    this.size = 0;
  }
}

const transportKeys = {
  emittedBytes: ['bytesEmitted'],
  emittedBatches: ['batchesEmitted'],
  bytes: [
    'bytes',
    'totalBytes',
    'bytesRead',
    'bytesReceived',
    'bytesWritten',
    'totalBytesRead',
    'totalBytesReceived',
  ],
  batches: [
    'batches',
    'batchCount',
    'totalBatches',
    'batchesRead',
    'batchesReceived',
  ],
  batchSizes: [
    'batchSizes',
    'batchBytes',
    'batchSizeSamples',
    'batchSizeBytes',
    'batchLengths',
  ],
  intervals: [
    'batchIntervalsMs',
    'batchIntervalMs',
    'batchIntervalSamplesMs',
    'batchIntervals',
    'intervalsMs',
  ],
  queueBytesCurrent: [
    'queueBytes',
    'queuedBytes',
    'pendingBytes',
  ],
  queueBytesHighWater: [
    'queueBytesHighWater',
    'pendingBytesHighWater',
  ],
  queueDepthCurrent: ['queueDepth', 'queuedBatches', 'pendingFragments'],
  queueDepthHighWater: ['queueDepthHighWater', 'pendingFragmentsHighWater'],
  blocked: ['blockedProducers', 'blockedProducerCount', 'blockedProducersHighWater'],
  backpressure: [
    'backpressureCount',
    'backpressure',
    'backpressureEvents',
    'pushWouldBlockCount',
  ],
  ackSamples: ['ackLatenciesMs', 'ackLatencySamplesMs', 'ackLatencyMs'],
  ackAverage: ['averageAckLatencyMs', 'avgAckLatencyMs', 'ackLatencyAverageMs'],
  ackMax: ['maxAckLatencyMs', 'ackLatencyMaxMs'],
} as const;

function transportSource(input: RecordLike): RecordLike {
  const transport = isRecord(input.transport) ? input.transport : input;
  const metrics = isRecord(transport.metrics) ? transport.metrics : undefined;
  const state = metrics && isRecord(metrics.state) ? metrics.state : undefined;
  if (!state) return transport;
  return { ...transport, ...metrics, ...state };
}

function paneFlag(pane: RecordLike, keys: readonly string[]): boolean {
  return keys.some((key) => pane[key] === true);
}

function paneState(pane: RecordLike): string {
  for (const key of ['state', 'rendererState', 'mode']) {
    if (typeof pane[key] === 'string') return (pane[key] as string).toLowerCase();
  }
  return '';
}

export function createPerformanceMetricsCollector(
  options: PerformanceMetricsCollectorOptions = {},
): PerformanceMetricsCollector {
  const frames = new CircularSamples();
  const batchSizes = new CircularSamples();
  const batchIntervals = new CircularSamples();
  const ackLatencies = new CircularSamples();
  const interactions = new Map<InteractionKind, number>();

  let previousFrameTimestamp: number | undefined;
  let latestSampledAt = 0;
  let previousTransport:
    | { sampledAt: number; bytes?: number; batches?: number; backpressure?: number }
    | undefined;
  let previousPtySampledAt: number | undefined;
  const previousPtyCounters = new Map<string, { bytes?: number; batches?: number }>();
  const previousPtyBackpressureCounters = new Map<string, number>();
  let bytesPerSecond = 0;
  let batchesPerSecond = 0;
  let averageBatchBytesOverride: number | undefined;
  // These totals are collector-lifetime deltas from native cumulative counters.
  let emittedBytesTotal = 0;
  let emittedBatchesTotal = 0;
  let hasEmittedBytesTotal = false;
  let longTaskCount = 0;
  let longTaskTotal = 0;
  let longTaskMax = 0;
  // High-water and backpressure values are cumulative native evidence.
  let queueBytesHighWater = 0;
  let queueDepthHighWater = 0;
  let blockedProducersHighWater = 0;
  let backpressureCount = 0;
  let backpressureInitialized = false;
  let ackAverage: number | undefined;
  let ackMax: number | undefined;
  let processCpu: number | undefined;
  let processRss: number | undefined;
  let coalescedVisualUpdates = 0;
  let webglPanes = 0;
  let recoveringPanes = 0;
  let fallbackPanes = 0;
  let rendererTransitions = 0;
  let contextLosses = 0;
  let coalescedVisualUpdatesBaseline = 0;
  let rendererCountersFromPanes = false;
  let rendererTransitionsBaseline = 0;
  let contextLossesBaseline = 0;
  const rendererPaneCounters = new Map<string, {
    rendererTransitions: number;
    contextLosses: number;
    rendererTransitionsBaseline: number;
    contextLossesBaseline: number;
  }>();
  let retiredRendererTransitions = 0;
  let retiredContextLosses = 0;
  let focusToNextPaintMs: number | undefined;
  let resizeToNextPaintMs: number | undefined;
  let running = false;
  let generation = 0;
  let frameHandle: number | null = null;
  let intervalHandle: unknown = null;
  let pollInFlight = false;
  let collectionEpoch = 0;
  let lastPollStartedAt: number | undefined;
  let performanceObserver: PerformanceObserverLike | null = null;
  const visibilityTarget = options.visibilityTarget ?? defaultVisibilityTarget();
  let visibilityListenerRegistered = false;
  const reportError = options.reportError ?? ((error, operation) => {
    console.warn(`performance metrics ${operation} failed`, error);
  });
  const now = options.now ?? (() =>
    typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function'
      ? globalThis.performance.now()
      : Date.now());
  type RequestFrameFunction = (callback: (timestamp: number) => void) => number;
  const requestFrame = options.requestFrame ?? ((callback: (timestamp: number) => void) =>
    typeof (globalThis as unknown as { requestAnimationFrame?: RequestFrameFunction })
      .requestAnimationFrame === 'function'
      ? (globalThis as unknown as { requestAnimationFrame: RequestFrameFunction })
        .requestAnimationFrame(callback)
      : setTimeout(() => callback(now()), 16) as unknown as number);
  const cancelFrame = options.cancelFrame ?? ((handle: number) => {
    const cancel = (globalThis as { cancelAnimationFrame?: (value: number) => void })
      .cancelAnimationFrame;
    if (typeof cancel === 'function') cancel(handle);
    else clearTimeout(handle);
  });
  const setIntervalFn = options.setInterval ?? ((callback: () => void, delay: number) =>
    setInterval(callback, delay));
  const clearIntervalFn = options.clearInterval ?? ((handle: unknown) =>
    clearInterval(handle as ReturnType<typeof setInterval>));

  const handleVisibilityChange = (): void => {
    previousFrameTimestamp = undefined;
    try {
      void visibilityTarget?.hidden;
      void visibilityTarget?.visibilityState;
    } catch (error) {
      reportError(error, 'visibilitychange');
    }
  };

  function registerVisibilityListener(): void {
    if (!visibilityTarget || visibilityListenerRegistered) return;
    try {
      visibilityTarget.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerRegistered = true;
    } catch (error) {
      reportError(error, 'visibilitychange.addEventListener');
    }
  }

  function removeVisibilityListener(): void {
    if (!visibilityTarget || !visibilityListenerRegistered) return;
    visibilityListenerRegistered = false;
    try {
      visibilityTarget.removeEventListener('visibilitychange', handleVisibilityChange);
    } catch (error) {
      reportError(error, 'visibilitychange.removeEventListener');
    }
  }

  function scheduleFrame(loopGeneration: number): void {
    if (!running || generation !== loopGeneration || frameHandle !== null) return;
    try {
      frameHandle = requestFrame((timestamp) => {
        frameHandle = null;
        if (!running || generation !== loopGeneration) return;
        recordFrame(timestamp);
        scheduleFrame(loopGeneration);
      });
    } catch (error) {
      reportError(error, 'requestAnimationFrame');
    }
  }

  function pollNativeMetrics(pollGeneration: number): void {
    if (!running || generation !== pollGeneration || pollInFlight) return;
    const pollEpoch = collectionEpoch;
    const sampledAt = now();
    if (
      lastPollStartedAt !== undefined &&
      sampledAt - lastPollStartedAt < 1_000
    ) return;
    lastPollStartedAt = sampledAt;
    pollInFlight = true;
    let ptyResult: Promise<unknown>;
    let processResult: Promise<unknown>;
    try {
      ptyResult = Promise.resolve(
        (options.invoke ?? defaultInvoke)('pty_transport_metrics', {
          threadId: null,
          thread_id: null,
        }),
      );
    } catch (error) {
      ptyResult = Promise.reject(error);
    }
    try {
      processResult = Promise.resolve(
        (options.invoke ?? defaultInvoke)('runtime_process_metrics', {}),
      );
    } catch (error) {
      processResult = Promise.reject(error);
    }

    void Promise.allSettled([ptyResult, processResult])
      .then((results) => {
        if (!running || generation !== pollGeneration || collectionEpoch !== pollEpoch) return;
        const [pty, process] = results;
        if (pty.status === 'rejected') reportError(pty.reason, 'pty_transport_metrics');
        if (process.status === 'rejected') reportError(process.reason, 'runtime_process_metrics');

        const input: RecordLike = { sampledAt };
        if (pty.status === 'fulfilled') input.ptySnapshots = pty.value;
        if (process.status === 'fulfilled') input.process = process.value;
        if (Object.prototype.hasOwnProperty.call(input, 'ptySnapshots') ||
            Object.prototype.hasOwnProperty.call(input, 'process')) {
          try {
            mergeNativeSnapshot(input);
          } catch (error) {
            reportError(error, 'native metrics merge');
          }
        }
      })
      .finally(() => {
        if (generation === pollGeneration && collectionEpoch === pollEpoch) {
          pollInFlight = false;
        }
      });
  }

  function start(): void {
    if (running) return;
    previousFrameTimestamp = undefined;
    interactions.clear();
    running = true;
    generation += 1;
    const loopGeneration = generation;
    registerVisibilityListener();
    scheduleFrame(loopGeneration);
    intervalHandle = setIntervalFn(() => pollNativeMetrics(loopGeneration), 1_000);
    if (options.createPerformanceObserver) {
      let observer: PerformanceObserverLike | null = null;
      try {
        const observerGeneration = generation;
        observer = options.createPerformanceObserver((list) => {
          try {
            if (!running || generation !== observerGeneration) return;
            const entries = Array.isArray(list) ? list : list.getEntries();
            for (const entry of entries) {
              if (entry.entryType === undefined || entry.entryType === 'longtask') {
                if (entry.duration !== undefined) recordLongTask(entry.duration);
              }
            }
          } catch (error) {
            reportError(error, 'PerformanceObserver callback');
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
        performanceObserver = observer;
      } catch (error) {
        try {
          observer?.disconnect();
        } catch (disconnectError) {
          reportError(disconnectError, 'PerformanceObserver.disconnect');
        }
        reportError(error, 'PerformanceObserver');
        performanceObserver = null;
      }
    }
  }

  function stop(): void {
    if (!running) return;
    running = false;
    generation += 1;
    previousFrameTimestamp = undefined;
    interactions.clear();
    removeVisibilityListener();
    if (frameHandle !== null) {
      try {
        cancelFrame(frameHandle);
      } catch (error) {
        reportError(error, 'cancelAnimationFrame');
      }
      frameHandle = null;
    }
    if (intervalHandle !== null) {
      try {
        clearIntervalFn(intervalHandle);
      } catch (error) {
        reportError(error, 'clearInterval');
      }
      intervalHandle = null;
    }
    pollInFlight = false;
    lastPollStartedAt = undefined;
    if (performanceObserver) {
      try {
        performanceObserver.disconnect();
      } catch (error) {
        reportError(error, 'PerformanceObserver.disconnect');
      }
      performanceObserver = null;
    }
  }

  function recordFrame(timestamp: number): void {
    const value = finiteNonNegative(timestamp);
    if (value === undefined) return;
    if (previousFrameTimestamp !== undefined) {
      if (value <= previousFrameTimestamp) return;
      frames.push(value - previousFrameTimestamp);
    }
    previousFrameTimestamp = value;
  }

  function recordLongTask(duration: number): void {
    const value = finiteNonNegative(duration);
    if (value === undefined) return;
    longTaskCount += 1;
    longTaskTotal += value;
    longTaskMax = Math.max(longTaskMax, value);
  }

  function recordInteractionStart(kind: InteractionKind, timestamp: number): void {
    const value = finiteNonNegative(timestamp);
    if (value !== undefined && (kind === 'focus' || kind === 'resize')) {
      interactions.set(kind, value);
    }
  }

  function recordInteractionPaint(kind: InteractionKind, timestamp: number): void {
    const value = finiteNonNegative(timestamp);
    const started = interactions.get(kind);
    if (value === undefined || started === undefined || value < started) return;
    const duration = value - started;
    if (kind === 'focus') focusToNextPaintMs = duration;
    if (kind === 'resize') resizeToNextPaintMs = duration;
    interactions.delete(kind);
  }

  function cancelInteraction(kind: InteractionKind): void {
    interactions.delete(kind);
  }

  function clearCurrentPtyTransportState(): void {
    batchSizes.clear();
    batchIntervals.clear();
    ackLatencies.clear();
    previousTransport = undefined;
    previousPtySampledAt = undefined;
    previousPtyCounters.clear();
    bytesPerSecond = 0;
    batchesPerSecond = 0;
    averageBatchBytesOverride = undefined;
    ackAverage = undefined;
    ackMax = undefined;
  }

  function updateRendererPaneState(
    panes: RecordLike[],
    paneSourcePresent: boolean,
    directTransitions: number | undefined,
    directLosses: number | undefined,
  ): void {
    const paneIds = panes.map((pane) =>
      typeof pane.paneId === 'string' && pane.paneId.length > 0 ? pane.paneId : undefined,
    );
    const paneKeys = panes.map((pane, index) => {
      const paneId = paneIds[index];
      if (paneId === undefined) return undefined;
      const rendererGeneration = finiteNonNegative(pane.rendererGeneration);
      return JSON.stringify([paneId, rendererGeneration ?? null]);
    });
    const hasPaneCounters = panes.some((pane) =>
      numberFrom(pane, ['rendererTransitions']) !== undefined ||
      numberFrom(pane, ['contextLosses', 'contextLoss']) !== undefined,
    );
    const keyedPaneCounters = paneSourcePresent &&
      paneIds.every((paneId) => paneId !== undefined) &&
      (hasPaneCounters || rendererCountersFromPanes);

    if (keyedPaneCounters) {
      rendererCountersFromPanes = true;
      const nextKeys = new Set<string>();
      for (const [index, pane] of panes.entries()) {
        const paneKey = paneKeys[index];
        if (paneKey === undefined) continue;
        nextKeys.add(paneKey);
        const previous = rendererPaneCounters.get(paneKey);
        const rendererTransitionsValue =
          numberFrom(pane, ['rendererTransitions']) ?? previous?.rendererTransitions ?? 0;
        const contextLossesValue =
          numberFrom(pane, ['contextLosses', 'contextLoss']) ?? previous?.contextLosses ?? 0;
        rendererPaneCounters.set(paneKey, {
          rendererTransitions: rendererTransitionsValue,
          contextLosses: contextLossesValue,
          rendererTransitionsBaseline: previous?.rendererTransitionsBaseline ?? 0,
          contextLossesBaseline: previous?.contextLossesBaseline ?? 0,
        });
      }
      for (const [paneKey, counters] of rendererPaneCounters) {
        if (nextKeys.has(paneKey)) continue;
        retiredRendererTransitions += cumulativeDelta(
          counters.rendererTransitions,
          counters.rendererTransitionsBaseline,
        );
        retiredContextLosses += cumulativeDelta(
          counters.contextLosses,
          counters.contextLossesBaseline,
        );
        rendererPaneCounters.delete(paneKey);
      }
      rendererTransitions = retiredRendererTransitions + [...rendererPaneCounters.values()].reduce(
        (sum, counters) => sum + cumulativeDelta(
          counters.rendererTransitions,
          counters.rendererTransitionsBaseline,
        ),
        0,
      );
      contextLosses = retiredContextLosses + [...rendererPaneCounters.values()].reduce(
        (sum, counters) => sum + cumulativeDelta(
          counters.contextLosses,
          counters.contextLossesBaseline,
        ),
        0,
      );
      return;
    }

    if (paneSourcePresent && rendererCountersFromPanes) {
      rendererCountersFromPanes = false;
      rendererPaneCounters.clear();
      retiredRendererTransitions = 0;
      retiredContextLosses = 0;
    }
    if (panes.length > 0) {
      rendererTransitions = Math.max(
        rendererTransitions,
        panes.reduce(
          (sum, pane) => sum + (numberFrom(pane, ['rendererTransitions']) ?? 0),
          0,
        ),
      );
      contextLosses = Math.max(
        contextLosses,
        panes.reduce(
          (sum, pane) => sum + (numberFrom(pane, ['contextLosses', 'contextLoss']) ?? 0),
          0,
        ),
      );
    }
    if (directTransitions !== undefined) {
      rendererTransitions = Math.max(rendererTransitions, directTransitions);
    }
    if (directLosses !== undefined) contextLosses = Math.max(contextLosses, directLosses);
  }

  function mergeOneNativeSnapshot(
    input: RecordLike,
    ptyDeltas?: { bytes?: number; batches?: number; backpressure?: number },
  ): void {
    const sampledAt = numberFrom(input, ['sampledAt', 'timestamp', 'time']);
    if (sampledAt !== undefined) latestSampledAt = sampledAt;

    const transport = transportSource(input);
    const emittedBytes = numberFrom(transport, transportKeys.emittedBytes);
    const emittedBatches = numberFrom(transport, transportKeys.emittedBatches);
    const hasEmittedCounters = emittedBytes !== undefined || emittedBatches !== undefined;
    const currentBytes = emittedBytes ?? numberFrom(transport, transportKeys.bytes);
    const currentBatches = emittedBatches ?? numberFrom(transport, transportKeys.batches);
    const backpressure = numberFrom(transport, transportKeys.backpressure);
    const sizes = hasEmittedCounters ? [] : numberArrayFrom(transport, transportKeys.batchSizes);
    const intervals = hasEmittedCounters ? [] : numberArrayFrom(transport, transportKeys.intervals);
    for (const size of sizes) batchSizes.push(size);
    for (const interval of intervals) batchIntervals.push(interval);
    const directAverageBatchBytes = numberFrom(transport, ['averageBatchBytes']);
    if (!hasEmittedCounters && directAverageBatchBytes !== undefined) {
      averageBatchBytesOverride = directAverageBatchBytes;
    }

    let elapsedMs: number | undefined;
    let emittedDeltaBytes: number | undefined;
    let emittedDeltaBatches: number | undefined;
    if (ptyDeltas !== undefined) {
      if (ptyDeltas.bytes !== undefined) bytesPerSecond = 0;
      if (ptyDeltas.batches !== undefined) batchesPerSecond = 0;
      if (sampledAt !== undefined && previousPtySampledAt !== undefined) {
        elapsedMs = sampledAt - previousPtySampledAt;
        if (elapsedMs > 0) {
          if (ptyDeltas.bytes !== undefined) {
            bytesPerSecond = (ptyDeltas.bytes * 1_000) / elapsedMs;
          }
          if (ptyDeltas.batches !== undefined) {
            batchesPerSecond = (ptyDeltas.batches * 1_000) / elapsedMs;
          }
        }
      }
      emittedDeltaBytes = ptyDeltas.bytes;
      emittedDeltaBatches = ptyDeltas.batches;
      if (sampledAt !== undefined) previousPtySampledAt = sampledAt;
    } else if (sampledAt !== undefined && previousTransport !== undefined) {
      elapsedMs = sampledAt - previousTransport.sampledAt;
      if (elapsedMs > 0) {
        if (currentBytes !== undefined && previousTransport.bytes !== undefined) {
          emittedDeltaBytes =
            currentBytes >= previousTransport.bytes
              ? currentBytes - previousTransport.bytes
              : undefined;
          bytesPerSecond =
            currentBytes >= previousTransport.bytes
              ? ((currentBytes - previousTransport.bytes) * 1_000) / elapsedMs
              : 0;
        } else if (sizes.length > 0) {
          bytesPerSecond = (sizes.reduce((sum, size) => sum + size, 0) * 1_000) / elapsedMs;
        }
        if (currentBatches !== undefined && previousTransport.batches !== undefined) {
          emittedDeltaBatches =
            currentBatches >= previousTransport.batches
              ? currentBatches - previousTransport.batches
              : undefined;
          batchesPerSecond =
            currentBatches >= previousTransport.batches
              ? ((currentBatches - previousTransport.batches) * 1_000) / elapsedMs
              : 0;
        } else if (sizes.length > 0) {
          batchesPerSecond = (sizes.length * 1_000) / elapsedMs;
        }
      }
    }
    if (hasEmittedCounters && emittedDeltaBatches !== undefined && emittedDeltaBatches > 0) {
      if (emittedDeltaBytes !== undefined) {
        // Native cumulative counters provide interval-aggregate distribution
        // estimates, not exact individual batch sizes.
        batchSizes.pushRepeated(emittedDeltaBytes / emittedDeltaBatches, emittedDeltaBatches);
      }
      if (elapsedMs !== undefined && elapsedMs > 0) {
        batchIntervals.pushRepeated(elapsedMs / emittedDeltaBatches, emittedDeltaBatches);
      }
    }
    if (emittedDeltaBytes !== undefined && emittedDeltaBytes > 0) {
      emittedBytesTotal += emittedDeltaBytes;
      hasEmittedBytesTotal = true;
    }
    if (emittedDeltaBatches !== undefined && emittedDeltaBatches > 0) {
      emittedBatchesTotal += emittedDeltaBatches;
    }
    if (ptyDeltas?.backpressure !== undefined) {
      backpressureCount += ptyDeltas.backpressure;
    } else if (backpressure !== undefined) {
      const previousBackpressure = previousTransport?.backpressure;
      if (previousBackpressure === undefined) {
        backpressureCount += backpressure;
      } else if (backpressure >= previousBackpressure) {
        backpressureCount += backpressure - previousBackpressure;
      }
    }
    if (
      ptyDeltas === undefined &&
      sampledAt !== undefined &&
      (currentBytes !== undefined || currentBatches !== undefined || backpressure !== undefined)
    ) {
      previousTransport = {
        sampledAt,
        bytes: currentBytes ?? previousTransport?.bytes,
        batches: currentBatches ?? previousTransport?.batches,
        backpressure: backpressure ?? previousTransport?.backpressure,
      };
    }

    const queueBytes =
      numberFrom(transport, transportKeys.queueBytesHighWater)
      ?? numberFrom(transport, transportKeys.queueBytesCurrent);
    const queueDepth =
      numberFrom(transport, transportKeys.queueDepthHighWater)
      ?? numberFrom(transport, transportKeys.queueDepthCurrent);
    const blocked = numberFrom(transport, transportKeys.blocked);
    if (queueBytes !== undefined) queueBytesHighWater = Math.max(queueBytesHighWater, queueBytes);
    if (queueDepth !== undefined) queueDepthHighWater = Math.max(queueDepthHighWater, queueDepth);
    if (blocked !== undefined) {
      blockedProducersHighWater = Math.max(blockedProducersHighWater, blocked);
    }
    const ackSamples = numberArrayFrom(transport, transportKeys.ackSamples);
    const acknowledged = numberFrom(transport, ['batchesAcknowledged']);
    const totalAckMicros = numberFrom(transport, ['totalAckLatencyMicros']);
    const maxAckMicros = numberFrom(transport, ['maxAckLatencyMicros']);
    const explicitAckAverage =
      numberFrom(transport, transportKeys.ackAverage)
      ?? (acknowledged !== undefined && acknowledged > 0 && totalAckMicros !== undefined
        ? totalAckMicros / acknowledged / 1_000
        : undefined);
    const explicitAckMax =
      numberFrom(transport, transportKeys.ackMax)
      ?? (acknowledged !== undefined && acknowledged > 0 && maxAckMicros !== undefined
        ? maxAckMicros / 1_000
        : undefined);
    if (ackSamples.length > 0) {
      for (const sample of ackSamples) ackLatencies.push(sample);
      const allAckLatencies = ackLatencies.toArray();
      ackAverage =
        allAckLatencies.reduce((sum, value) => sum + value, 0) / allAckLatencies.length;
      ackMax = Math.max(...allAckLatencies);
    }
    if (explicitAckAverage !== undefined) ackAverage = explicitAckAverage;
    if (explicitAckMax !== undefined) ackMax = explicitAckMax;

    const renderer = isRecord(input.renderer) ? input.renderer : input;
    const scheduler = isRecord(input.scheduler)
      ? input.scheduler
      : isRecord(input.schedulerSnapshot)
        ? input.schedulerSnapshot
        : undefined;
    const coalesced = numberFrom(scheduler, ['coalescedVisualUpdates'])
      ?? numberFrom(renderer, ['coalescedVisualUpdates']);
    if (coalesced !== undefined) {
      coalescedVisualUpdates = Math.max(coalescedVisualUpdates, coalesced);
    }

    const paneSource = renderer.panes ?? renderer.rendererSnapshots;
    const panes = Array.isArray(paneSource)
      ? paneSource.filter(isRecord)
      : isRecord(paneSource)
        ? Object.values(paneSource).filter(isRecord)
        : [];
    if (paneSource !== undefined) {
      webglPanes = panes.filter((pane) =>
        paneFlag(pane, ['webgl', 'webgl2', 'isWebgl']) || paneState(pane) === 'webgl' || paneState(pane) === 'webgl2',
      ).length;
      recoveringPanes = panes.filter((pane) =>
        paneFlag(pane, ['recovering', 'isRecovering']) || paneState(pane) === 'recovering',
      ).length;
      fallbackPanes = panes.filter((pane) =>
        paneFlag(pane, ['fallback', 'isFallback']) || paneState(pane) === 'fallback',
      ).length;
    }
    const directWebgl = numberFrom(renderer, ['webglPanes']);
    const directRecovering = numberFrom(renderer, ['recoveringPanes']);
    const directFallback = numberFrom(renderer, ['fallbackPanes']);
    const directTransitions = numberFrom(renderer, ['rendererTransitions']);
    const directLosses = numberFrom(renderer, ['contextLosses']);
    if (paneSource === undefined && directWebgl !== undefined) webglPanes = directWebgl;
    if (paneSource === undefined && directRecovering !== undefined) recoveringPanes = directRecovering;
    if (paneSource === undefined && directFallback !== undefined) fallbackPanes = directFallback;
    updateRendererPaneState(panes, paneSource !== undefined, directTransitions, directLosses);

    if (Object.prototype.hasOwnProperty.call(input, 'process')) {
      processCpu = undefined;
      processRss = undefined;
      const process = isRecord(input.process) ? input.process : undefined;
      const cpu = numberFrom(process, ['cpuPercent', 'cpu']);
      const rss = numberFrom(process, ['rssBytes', 'residentBytes', 'memoryBytes']);
      if (cpu !== undefined) processCpu = cpu;
      if (rss !== undefined) processRss = rss;
    }

    const longTasks = isRecord(input.longTasks) ? input.longTasks : undefined;
    const duration = numberFrom(longTasks, ['duration', 'durationMs']);
    if (duration !== undefined) recordLongTask(duration);
    const count = numberFrom(longTasks, ['count']);
    const total = numberFrom(longTasks, ['totalMs', 'totalDurationMs']);
    const max = numberFrom(longTasks, ['maxMs', 'maxDurationMs']);
    if (count !== undefined && total !== undefined) {
      longTaskCount += count;
      longTaskTotal += total;
      if (max !== undefined) longTaskMax = Math.max(longTaskMax, max);
    }
  }

  function mergeNativeSnapshot(input: unknown): void {
    if (Array.isArray(input)) {
      throw new TypeError(
        'mergeNativeSnapshot requires { sampledAt, ptySnapshots: rawNativeArray, process? }',
      );
    }
    if (!isRecord(input)) return;

    const nested = input.ptySnapshots;
    if (Array.isArray(nested)) {
      const sampledAt = numberFrom(input, ['sampledAt']);
      if (sampledAt === undefined) {
        throw new TypeError(
          'mergeNativeSnapshot requires { sampledAt, ptySnapshots: rawNativeArray, process? }',
        );
      }
      const entries = nested.filter(isRecord);
      const currentPtyIds = new Set(entries.map((entry, index) => ptyIdentity(entry, index)));
      for (const id of previousPtyCounters.keys()) {
        if (!currentPtyIds.has(id)) {
          previousPtyCounters.delete(id);
          previousPtyBackpressureCounters.delete(id);
        }
      }
      if (!backpressureInitialized) {
        backpressureCount = 0;
        for (const [index, entry] of entries.entries()) {
          const id = ptyIdentity(entry, index);
          const currentBackpressure = numberFrom(
            transportSource(entry),
            transportKeys.backpressure,
          );
          if (currentBackpressure !== undefined) {
            backpressureCount += currentBackpressure;
            previousPtyBackpressureCounters.set(id, currentBackpressure);
          }
        }
        backpressureInitialized = true;
      }
      const sameSample =
        entries.length > 0 &&
        entries.every((entry) => {
          const entrySampledAt = numberFrom(entry, ['sampledAt', 'timestamp', 'time']);
          return entrySampledAt === undefined || entrySampledAt === sampledAt;
        });
      if (sameSample) {
        const { deltas } = updatePtyCounters(
          entries,
          previousPtyCounters,
          0,
          previousPtyBackpressureCounters,
        );
        mergeOneNativeSnapshot({
          ...input,
          ...(sampledAt !== undefined ? { sampledAt } : {}),
          transport: aggregateTransportEntries(entries),
        }, deltas);
      } else {
        for (const [index, entry] of entries.entries()) {
          const { deltas } = updatePtyCounters(
            [entry],
            previousPtyCounters,
            index,
            previousPtyBackpressureCounters,
          );
          mergeOneNativeSnapshot(
            entry.sampledAt === undefined && sampledAt !== undefined
              ? { ...entry, sampledAt }
              : entry,
            deltas,
          );
        }
      }
      if (entries.length === 0) {
        mergeOneNativeSnapshot(input);
        clearCurrentPtyTransportState();
      }
      return;
    }
    mergeOneNativeSnapshot(input);
  }

  function sampleRuntimeState(): void {
    if (options.schedulerSnapshot) {
      try {
        const scheduler = options.schedulerSnapshot();
        const coalesced = numberFrom(scheduler as RecordLike, ['coalescedVisualUpdates']);
        if (coalesced !== undefined) {
          coalescedVisualUpdates = Math.max(coalescedVisualUpdates, coalesced);
        }
      } catch (error) {
        reportError(error, 'scheduler snapshot');
      }
    }
    if (options.rendererSnapshots) {
      try {
        const panes = options.rendererSnapshots();
        const nextWebglPanes = panes.filter((pane) =>
          pane.webgl === true || pane.state?.toLowerCase() === 'webgl' ||
          pane.state?.toLowerCase() === 'webgl2',
        ).length;
        const nextRecoveringPanes = panes.filter((pane) =>
          pane.recovering === true || pane.state?.toLowerCase() === 'recovering',
        ).length;
        const nextFallbackPanes = panes.filter((pane) =>
          pane.fallback === true || pane.state?.toLowerCase() === 'fallback',
        ).length;
        const nextRendererTransitions = panes.reduce(
          (sum, pane) => sum + (finiteNonNegative(pane.rendererTransitions) ?? 0),
          0,
        );
        const nextContextLosses = panes.reduce(
          (sum, pane) => sum + (finiteNonNegative(pane.contextLosses) ?? 0),
          0,
        );
        webglPanes = nextWebglPanes;
        recoveringPanes = nextRecoveringPanes;
        fallbackPanes = nextFallbackPanes;
        updateRendererPaneState(
          panes.map((pane) => pane as unknown as RecordLike),
          true,
          nextRendererTransitions,
          nextContextLosses,
        );
      } catch (error) {
        reportError(error, 'renderer snapshot');
      }
    }
  }

  function snapshot(): RuntimePerformanceSnapshot {
    sampleRuntimeState();
    const result: RuntimePerformanceSnapshot = {
      sampledAt: latestSampledAt,
      frames: summarizeFrames(frames.toArray()),
      transport: {
        bytesPerSecond,
        batchesPerSecond,
        averageBatchBytes:
          hasEmittedBytesTotal && emittedBatchesTotal > 0
            ? emittedBytesTotal / emittedBatchesTotal
            : (batchSizes.toArray().length > 0
              ? average(batchSizes.toArray())
              : (averageBatchBytesOverride ?? 0)),
        p95BatchBytes: nearestRank(batchSizes.toArray()),
        p95BatchIntervalMs: nearestRank(batchIntervals.toArray()),
        queueBytesHighWater,
        queueDepthHighWater,
        blockedProducersHighWater,
        backpressureCount,
      },
      renderer: {
        coalescedVisualUpdates: cumulativeDelta(
          coalescedVisualUpdates,
          coalescedVisualUpdatesBaseline,
        ),
        webglPanes,
        recoveringPanes,
        fallbackPanes,
        rendererTransitions: rendererCountersFromPanes
          ? rendererTransitions
          : cumulativeDelta(rendererTransitions, rendererTransitionsBaseline),
        contextLosses: rendererCountersFromPanes
          ? contextLosses
          : cumulativeDelta(contextLosses, contextLossesBaseline),
      },
      interactions: {},
    };
    if (longTaskCount > 0) {
      result.longTasks = {
        count: longTaskCount,
        totalMs: longTaskTotal,
        maxMs: longTaskMax,
      };
    }
    if (ackAverage !== undefined) result.transport.averageAckLatencyMs = ackAverage;
    if (ackMax !== undefined) result.transport.maxAckLatencyMs = ackMax;
    if (focusToNextPaintMs !== undefined) result.interactions.focusToNextPaintMs = focusToNextPaintMs;
    if (resizeToNextPaintMs !== undefined) result.interactions.resizeToNextPaintMs = resizeToNextPaintMs;
    if (processCpu !== undefined || processRss !== undefined) {
      result.process = {};
      if (processCpu !== undefined) result.process.cpuPercent = processCpu;
      if (processRss !== undefined) result.process.rssBytes = processRss;
    }
    return result;
  }

  function reset(): void {
    sampleRuntimeState();
    collectionEpoch += 1;
    coalescedVisualUpdatesBaseline = coalescedVisualUpdates;
    if (rendererCountersFromPanes) {
      retiredRendererTransitions = 0;
      retiredContextLosses = 0;
      for (const counters of rendererPaneCounters.values()) {
        counters.rendererTransitionsBaseline = counters.rendererTransitions;
        counters.contextLossesBaseline = counters.contextLosses;
      }
      rendererTransitionsBaseline = 0;
      contextLossesBaseline = 0;
    } else {
      rendererTransitionsBaseline = rendererTransitions;
      contextLossesBaseline = contextLosses;
    }
    frames.clear();
    batchSizes.clear();
    batchIntervals.clear();
    ackLatencies.clear();
    interactions.clear();
    previousFrameTimestamp = undefined;
    latestSampledAt = 0;
    previousTransport = undefined;
    previousPtySampledAt = undefined;
    previousPtyCounters.clear();
    previousPtyBackpressureCounters.clear();
    bytesPerSecond = 0;
    batchesPerSecond = 0;
    averageBatchBytesOverride = undefined;
    emittedBytesTotal = 0;
    emittedBatchesTotal = 0;
    hasEmittedBytesTotal = false;
    longTaskCount = 0;
    longTaskTotal = 0;
    longTaskMax = 0;
    queueBytesHighWater = 0;
    queueDepthHighWater = 0;
    blockedProducersHighWater = 0;
    backpressureCount = 0;
    backpressureInitialized = false;
    ackAverage = undefined;
    ackMax = undefined;
    processCpu = undefined;
    processRss = undefined;
    pollInFlight = false;
    lastPollStartedAt = undefined;
    if (!running) {
      webglPanes = 0;
      recoveringPanes = 0;
      fallbackPanes = 0;
    }
    focusToNextPaintMs = undefined;
    resizeToNextPaintMs = undefined;
  }

  return {
    start,
    stop,
    recordFrame,
    recordLongTask,
    recordInteractionStart,
    recordInteractionPaint,
    cancelInteraction,
    mergeNativeSnapshot,
    snapshot,
    reset,
  };
}

function defaultInvoke(_command: string, _args: Record<string, unknown>): Promise<unknown> {
  return Promise.reject(new Error('performance metrics invoke dependency is not configured'));
}

function ptyIdentity(entry: RecordLike, index: number): string {
  const source = transportSource(entry);
  for (const key of ['threadId', 'thread_id', 'ptyId', 'pty_id', 'paneId', 'pane_id', 'id']) {
    const value = entry[key] ?? source[key];
    if (typeof value === 'string' || typeof value === 'number') return `${key}:${value}`;
  }
  return `index:${index}`;
}

function updatePtyCounters(
  entries: readonly RecordLike[],
  previousPtyCounters: Map<string, { bytes?: number; batches?: number }>,
  indexOffset = 0,
  previousPtyBackpressureCounters: Map<string, number>,
): { deltas: { bytes?: number; batches?: number; backpressure?: number } } {
  let bytesDelta = 0;
  let batchesDelta = 0;
  let backpressureDelta = 0;
  let hasBytes = false;
  let hasBatches = false;
  let hasBackpressure = false;
  for (const [index, entry] of entries.entries()) {
    const id = ptyIdentity(entry, index + indexOffset);
    const source = transportSource(entry);
    const currentBytes =
      numberFrom(source, transportKeys.emittedBytes)
      ?? numberFrom(source, transportKeys.bytes);
    const currentBatches =
      numberFrom(source, transportKeys.emittedBatches)
      ?? numberFrom(source, transportKeys.batches);
    const currentBackpressure = numberFrom(source, transportKeys.backpressure);
    const previous = previousPtyCounters.get(id);
    const previousBackpressure = previousPtyBackpressureCounters.get(id);
    if (currentBytes !== undefined) {
      hasBytes = true;
      if (previous?.bytes !== undefined && currentBytes >= previous.bytes) {
        bytesDelta += currentBytes - previous.bytes;
      }
    }
    if (currentBatches !== undefined) {
      hasBatches = true;
      if (previous?.batches !== undefined && currentBatches >= previous.batches) {
        batchesDelta += currentBatches - previous.batches;
      }
    }
    if (currentBackpressure !== undefined) {
      hasBackpressure = true;
      if (previousBackpressure !== undefined && currentBackpressure >= previousBackpressure) {
        backpressureDelta += currentBackpressure - previousBackpressure;
      }
      // A lower native counter is a reset; its interval contributes zero.
      previousPtyBackpressureCounters.set(id, currentBackpressure);
    }
    previousPtyCounters.set(id, {
      bytes: currentBytes ?? previous?.bytes,
      batches: currentBatches ?? previous?.batches,
    });
  }
  return {
    deltas: {
      ...(hasBytes ? { bytes: bytesDelta } : {}),
      ...(hasBatches ? { batches: batchesDelta } : {}),
      ...(hasBackpressure ? { backpressure: backpressureDelta } : {}),
    },
  };
}

function aggregateTransportEntries(entries: readonly RecordLike[]): RecordLike {
  const aggregate: RecordLike = {};
  const sumKeys = [
    ...transportKeys.emittedBytes,
    ...transportKeys.emittedBatches,
    ...transportKeys.bytes,
    ...transportKeys.batches,
    ...transportKeys.backpressure,
    'batchesAcknowledged',
    'totalAckLatencyMicros',
  ];
  const maxKeys = [
    ...transportKeys.queueBytesCurrent,
    ...transportKeys.queueBytesHighWater,
    ...transportKeys.queueDepthCurrent,
    ...transportKeys.queueDepthHighWater,
    ...transportKeys.blocked,
    ...transportKeys.ackMax,
    'maxAckLatencyMicros',
  ];
  for (const entry of entries) {
    const source = transportSource(entry);
    for (const key of sumKeys) {
      const value = finiteNonNegative(source[key]);
      if (value !== undefined) aggregate[key] = (finiteNonNegative(aggregate[key]) ?? 0) + value;
    }
    for (const key of maxKeys) {
      const value = finiteNonNegative(source[key]);
      if (value !== undefined) aggregate[key] = Math.max(finiteNonNegative(aggregate[key]) ?? 0, value);
    }
    for (const key of [...transportKeys.batchSizes, ...transportKeys.intervals, ...transportKeys.ackSamples]) {
      const values = numberArrayFrom(source, [key]);
      if (values.length > 0) {
        const previous = Array.isArray(aggregate[key]) ? aggregate[key] as number[] : [];
        aggregate[key] = [...previous, ...values];
      }
    }
  }
  return aggregate;
}

function average(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}
