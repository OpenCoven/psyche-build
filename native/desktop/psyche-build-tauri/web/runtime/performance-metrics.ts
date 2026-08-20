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

export interface PerformanceMetricsCollector {
  recordFrame(timestamp: number): void;
  recordLongTask(duration: number): void;
  recordInteractionStart(kind: InteractionKind, timestamp: number): void;
  recordInteractionPaint(kind: InteractionKind, timestamp: number): void;
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
  bytes: [
    'bytes',
    'totalBytes',
    'bytesRead',
    'bytesReceived',
    'bytesWritten',
    'bytesAccepted',
    'bytesEmitted',
    'totalBytesRead',
    'totalBytesReceived',
  ],
  batches: [
    'batches',
    'batchCount',
    'totalBatches',
    'batchesRead',
    'batchesReceived',
    'batchesEmitted',
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
  queueBytes: [
    'queueBytes',
    'queuedBytes',
    'pendingBytes',
    'queueBytesHighWater',
    'pendingBytesHighWater',
  ],
  queueDepth: ['queueDepth', 'queuedBatches', 'queueDepthHighWater'],
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

export function createPerformanceMetricsCollector(): PerformanceMetricsCollector {
  const frames = new CircularSamples();
  const batchSizes = new CircularSamples();
  const batchIntervals = new CircularSamples();
  const ackLatencies = new CircularSamples();
  const interactions = new Map<InteractionKind, number>();

  let previousFrameTimestamp: number | undefined;
  let latestSampledAt = 0;
  let previousTransport:
    | { sampledAt: number; bytes?: number; batches?: number }
    | undefined;
  let previousPtySampledAt: number | undefined;
  const previousPtyCounters = new Map<string, { bytes?: number; batches?: number }>();
  let bytesPerSecond = 0;
  let batchesPerSecond = 0;
  let averageBatchBytesOverride: number | undefined;
  let longTaskCount = 0;
  let longTaskTotal = 0;
  let longTaskMax = 0;
  // High-water and backpressure values are cumulative native evidence.
  let queueBytesHighWater = 0;
  let queueDepthHighWater = 0;
  let blockedProducersHighWater = 0;
  let backpressureCount = 0;
  let ackAverage: number | undefined;
  let ackMax: number | undefined;
  let processCpu: number | undefined;
  let processRss: number | undefined;
  let coalescedVisualUpdates = 0;
  let webglPanes = 0;
  let recoveringPanes = 0;
  let fallbackPanes = 0;
  let contextLosses = 0;
  let focusToNextPaintMs: number | undefined;
  let resizeToNextPaintMs: number | undefined;

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

  function mergeOneNativeSnapshot(
    input: RecordLike,
    ptyDeltas?: { bytes?: number; batches?: number },
  ): void {
    const sampledAt = numberFrom(input, ['sampledAt', 'timestamp', 'time']);
    if (sampledAt !== undefined) latestSampledAt = sampledAt;

    const transport = transportSource(input);
    const currentBytes = numberFrom(transport, transportKeys.bytes);
    const currentBatches = numberFrom(transport, transportKeys.batches);
    const sizes = numberArrayFrom(transport, transportKeys.batchSizes);
    const intervals = numberArrayFrom(transport, transportKeys.intervals);
    for (const size of sizes) batchSizes.push(size);
    for (const interval of intervals) batchIntervals.push(interval);
    const emittedBytes = numberFrom(transport, ['bytesEmitted']);
    const emittedBatches = numberFrom(transport, ['batchesEmitted']);
    const directAverageBatchBytes = numberFrom(transport, ['averageBatchBytes']);
    if (directAverageBatchBytes !== undefined) {
      averageBatchBytesOverride = directAverageBatchBytes;
    } else if (emittedBytes !== undefined && emittedBatches !== undefined && emittedBatches > 0) {
      averageBatchBytesOverride = emittedBytes / emittedBatches;
    }

    if (ptyDeltas !== undefined) {
      if (ptyDeltas.bytes !== undefined) bytesPerSecond = 0;
      if (ptyDeltas.batches !== undefined) batchesPerSecond = 0;
      if (sampledAt !== undefined && previousPtySampledAt !== undefined) {
        const elapsedMs = sampledAt - previousPtySampledAt;
        if (elapsedMs > 0) {
          if (ptyDeltas.bytes !== undefined) {
            bytesPerSecond = (ptyDeltas.bytes * 1_000) / elapsedMs;
          }
          if (ptyDeltas.batches !== undefined) {
            batchesPerSecond = (ptyDeltas.batches * 1_000) / elapsedMs;
          }
        }
      }
      if (sampledAt !== undefined) previousPtySampledAt = sampledAt;
    } else if (sampledAt !== undefined && previousTransport !== undefined) {
      const elapsedMs = sampledAt - previousTransport.sampledAt;
      if (elapsedMs > 0) {
        if (currentBytes !== undefined && previousTransport.bytes !== undefined) {
          bytesPerSecond =
            currentBytes >= previousTransport.bytes
              ? ((currentBytes - previousTransport.bytes) * 1_000) / elapsedMs
              : 0;
        } else if (sizes.length > 0) {
          bytesPerSecond = (sizes.reduce((sum, size) => sum + size, 0) * 1_000) / elapsedMs;
        }
        if (currentBatches !== undefined && previousTransport.batches !== undefined) {
          batchesPerSecond =
            currentBatches >= previousTransport.batches
              ? ((currentBatches - previousTransport.batches) * 1_000) / elapsedMs
              : 0;
        } else if (sizes.length > 0) {
          batchesPerSecond = (sizes.length * 1_000) / elapsedMs;
        }
      }
    }
    if (
      ptyDeltas === undefined &&
      sampledAt !== undefined &&
      (currentBytes !== undefined || currentBatches !== undefined)
    ) {
      previousTransport = {
        sampledAt,
        bytes: currentBytes ?? previousTransport?.bytes,
        batches: currentBatches ?? previousTransport?.batches,
      };
    }

    const queueBytes = numberFrom(transport, transportKeys.queueBytes);
    const queueDepth = numberFrom(transport, transportKeys.queueDepth);
    const blocked = numberFrom(transport, transportKeys.blocked);
    const backpressure = numberFrom(transport, transportKeys.backpressure);
    if (queueBytes !== undefined) queueBytesHighWater = Math.max(queueBytesHighWater, queueBytes);
    if (queueDepth !== undefined) queueDepthHighWater = Math.max(queueDepthHighWater, queueDepth);
    if (blocked !== undefined) {
      blockedProducersHighWater = Math.max(blockedProducersHighWater, blocked);
    }
    if (backpressure !== undefined) backpressureCount = backpressure;

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
    if (coalesced !== undefined) coalescedVisualUpdates = Math.max(coalescedVisualUpdates, coalesced);

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
      if (panes.length > 0) {
        contextLosses = Math.max(
          contextLosses,
          panes.reduce(
            (sum, pane) => sum + (numberFrom(pane, ['contextLosses', 'contextLoss']) ?? 0),
            0,
          ),
        );
      }
    }
    const directWebgl = numberFrom(renderer, ['webglPanes']);
    const directRecovering = numberFrom(renderer, ['recoveringPanes']);
    const directFallback = numberFrom(renderer, ['fallbackPanes']);
    const directLosses = numberFrom(renderer, ['contextLosses']);
    if (paneSource === undefined && directWebgl !== undefined) webglPanes = directWebgl;
    if (paneSource === undefined && directRecovering !== undefined) recoveringPanes = directRecovering;
    if (paneSource === undefined && directFallback !== undefined) fallbackPanes = directFallback;
    if (directLosses !== undefined) contextLosses = Math.max(contextLosses, directLosses);

    const process = isRecord(input.process) ? input.process : input;
    const cpu = numberFrom(process, ['cpuPercent', 'cpu']);
    const rss = numberFrom(process, ['rssBytes', 'residentBytes', 'memoryBytes']);
    if (cpu !== undefined) processCpu = cpu;
    if (rss !== undefined) processRss = rss;

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
      for (const entry of input) mergeNativeSnapshot(entry);
      return;
    }
    if (!isRecord(input)) return;

    const nested = input.ptySnapshots ?? input.pty ?? input.ptys ?? input.snapshots;
    if (Array.isArray(nested)) {
      const entries = nested.filter(isRecord);
      const sampledAt = numberFrom(input, ['sampledAt', 'timestamp', 'time']);
      const currentPtyIds = new Set(entries.map((entry, index) => ptyIdentity(entry, index)));
      for (const id of previousPtyCounters.keys()) {
        if (!currentPtyIds.has(id)) previousPtyCounters.delete(id);
      }
      const sameSample =
        entries.length > 0 &&
        entries.every((entry) => {
          const entrySampledAt = numberFrom(entry, ['sampledAt', 'timestamp', 'time']);
          return entrySampledAt === undefined || entrySampledAt === sampledAt;
        });
      if (sameSample) {
        const { deltas } = updatePtyCounters(entries, previousPtyCounters);
        mergeOneNativeSnapshot({
          ...input,
          ...(sampledAt !== undefined ? { sampledAt } : {}),
          transport: aggregateTransportEntries(entries),
        }, deltas);
      } else {
        for (const [index, entry] of entries.entries()) {
          const { deltas } = updatePtyCounters([entry], previousPtyCounters, index);
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

  function snapshot(): RuntimePerformanceSnapshot {
    const result: RuntimePerformanceSnapshot = {
      sampledAt: latestSampledAt,
      frames: summarizeFrames(frames.toArray()),
      transport: {
        bytesPerSecond,
        batchesPerSecond,
        averageBatchBytes:
          batchSizes.toArray().length > 0
            ? average(batchSizes.toArray())
            : (averageBatchBytesOverride ?? 0),
        p95BatchBytes: nearestRank(batchSizes.toArray()),
        p95BatchIntervalMs: nearestRank(batchIntervals.toArray()),
        queueBytesHighWater,
        queueDepthHighWater,
        blockedProducersHighWater,
        backpressureCount,
      },
      renderer: {
        coalescedVisualUpdates,
        webglPanes,
        recoveringPanes,
        fallbackPanes,
        contextLosses,
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
    bytesPerSecond = 0;
    batchesPerSecond = 0;
    averageBatchBytesOverride = undefined;
    longTaskCount = 0;
    longTaskTotal = 0;
    longTaskMax = 0;
    queueBytesHighWater = 0;
    queueDepthHighWater = 0;
    blockedProducersHighWater = 0;
    backpressureCount = 0;
    ackAverage = undefined;
    ackMax = undefined;
    processCpu = undefined;
    processRss = undefined;
    coalescedVisualUpdates = 0;
    webglPanes = 0;
    recoveringPanes = 0;
    fallbackPanes = 0;
    contextLosses = 0;
    focusToNextPaintMs = undefined;
    resizeToNextPaintMs = undefined;
  }

  return {
    recordFrame,
    recordLongTask,
    recordInteractionStart,
    recordInteractionPaint,
    mergeNativeSnapshot,
    snapshot,
    reset,
  };
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
): { deltas: { bytes?: number; batches?: number } } {
  let bytesDelta = 0;
  let batchesDelta = 0;
  let hasBytes = false;
  let hasBatches = false;
  for (const [index, entry] of entries.entries()) {
    const id = ptyIdentity(entry, index + indexOffset);
    const source = transportSource(entry);
    const currentBytes = numberFrom(source, transportKeys.bytes);
    const currentBatches = numberFrom(source, transportKeys.batches);
    const previous = previousPtyCounters.get(id);
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
    previousPtyCounters.set(id, {
      bytes: currentBytes ?? previous?.bytes,
      batches: currentBatches ?? previous?.batches,
    });
  }
  return {
    deltas: {
      ...(hasBytes ? { bytes: bytesDelta } : {}),
      ...(hasBatches ? { batches: batchesDelta } : {}),
    },
  };
}

function aggregateTransportEntries(entries: readonly RecordLike[]): RecordLike {
  const aggregate: RecordLike = {};
  const sumKeys = [
    ...transportKeys.bytes,
    ...transportKeys.batches,
    ...transportKeys.backpressure,
    'batchesAcknowledged',
    'totalAckLatencyMicros',
  ];
  const maxKeys = [
    ...transportKeys.queueBytes,
    ...transportKeys.queueDepth,
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
