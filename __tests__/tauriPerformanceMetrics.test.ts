import { describe, expect, it, vi } from 'vitest';
import {
  FRAME_SAMPLE_LIMIT,
  createPerformanceMetricsCollector,
  summarizeFrames,
} from '../native/desktop/psyche-build-tauri/web/runtime/performance-metrics';

describe('bounded performance metrics', () => {
  it('summarizes frame samples with nearest-rank p95 and fixed thresholds', () => {
    expect(summarizeFrames([10, 20, 30, 40, 60])).toEqual({
      sampleCount: 5,
      averageMs: 32,
      p95Ms: 60,
      maxMs: 60,
      over16_7: 4,
      over33_4: 2,
      over50: 1,
      estimatedDroppedFrames: 5,
    });
  });

  it('returns a zero-valued summary for empty samples', () => {
    expect(summarizeFrames([])).toEqual({
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maxMs: 0,
      over16_7: 0,
      over33_4: 0,
      over50: 0,
      estimatedDroppedFrames: 0,
    });
  });

  it('uses nearest-rank p95 and normalizes non-finite frame samples', () => {
    expect(summarizeFrames([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({
      sampleCount: 10,
      p95Ms: 10,
    });
    expect(summarizeFrames([10, Number.NaN, Number.POSITIVE_INFINITY, -1])).toEqual({
      sampleCount: 1,
      averageMs: 10,
      p95Ms: 10,
      maxMs: 10,
      over16_7: 0,
      over33_4: 0,
      over50: 0,
      estimatedDroppedFrames: 0,
    });
  });

  it('retains frames in a fixed circular buffer', () => {
    const collector = createPerformanceMetricsCollector();
    collector.recordFrame(0);
    for (let index = 1; index <= FRAME_SAMPLE_LIMIT + 25; index += 1) {
      collector.recordFrame(index);
    }

    const snapshot = collector.snapshot();
    expect(snapshot.frames.sampleCount).toBe(FRAME_SAMPLE_LIMIT);
    expect(snapshot.frames.averageMs).toBe(1);
    expect(snapshot.frames.maxMs).toBe(1);
  });

  it('ignores malformed or backward frame timestamps without replacing the baseline', () => {
    const collector = createPerformanceMetricsCollector();
    collector.recordFrame(100);
    collector.recordFrame(116);
    collector.recordFrame(116);
    collector.recordFrame(90);
    collector.recordFrame(Number.NaN);
    collector.recordFrame(Number.POSITIVE_INFINITY);
    collector.recordFrame(132);

    expect(collector.snapshot().frames).toMatchObject({
      sampleCount: 2,
      averageMs: 16,
      maxMs: 16,
    });
  });

  it('aggregates transport, renderer, process, and interaction metrics', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      transport: {
        bytes: 0,
        batches: 0,
        batchSizes: [1_024, 1_024],
        batchIntervalsMs: [100, 300],
        queueBytes: 4_096,
        queueDepth: 3,
        blockedProducers: 1,
        backpressureCount: 1,
      },
      renderer: {
        coalescedVisualUpdates: 4,
        panes: [
          { webgl: true },
          { webgl: true },
          { webgl: true },
          { webgl: true },
          { fallback: true },
        ],
        contextLosses: 1,
      },
      process: { rssBytes: 64 * 1024 * 1024 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      transport: {
        bytes: 4_096,
        batches: 4,
        batchSizes: [512, 512, 1_024, 2_048],
        batchIntervalsMs: [100, 200, 300, 300],
        queueBytes: 8_192,
        queueDepth: 6,
        blockedProducers: 2,
        backpressureCount: 3,
        averageAckLatencyMs: 2,
        maxAckLatencyMs: 7,
      },
      renderer: {
        coalescedVisualUpdates: 9,
        panes: [
          { webgl: true },
          { webgl: true },
          { webgl: true },
          { webgl: true },
          { fallback: true },
        ],
        contextLosses: 2,
      },
    });
    collector.recordInteractionStart('focus', 100);
    collector.recordInteractionPaint('focus', 140);
    collector.recordInteractionStart('resize', 200);
    collector.recordInteractionPaint('resize', 272);

    const snapshot = collector.snapshot();
    expect(snapshot.transport).toMatchObject({
      bytesPerSecond: 4_096,
      batchesPerSecond: 4,
      averageBatchBytes: 1_024,
      p95BatchBytes: 2_048,
      p95BatchIntervalMs: 300,
      queueBytesHighWater: 8_192,
      queueDepthHighWater: 6,
      blockedProducersHighWater: 2,
      backpressureCount: 3,
      averageAckLatencyMs: 2,
      maxAckLatencyMs: 7,
    });
    expect(snapshot.renderer).toEqual({
      coalescedVisualUpdates: 9,
      webglPanes: 4,
      recoveringPanes: 0,
      fallbackPanes: 1,
      contextLosses: 2,
    });
    expect(snapshot.interactions).toEqual({
      focusToNextPaintMs: 40,
      resizeToNextPaintMs: 72,
    });
    expect(snapshot.process).toEqual({ rssBytes: 64 * 1024 * 1024 });
    expect(snapshot.process).not.toHaveProperty('cpuPercent');
  });

  it('handles counter restarts without producing negative rates', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      transport: { bytes: 4_096, batches: 4 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      transport: { bytes: 100, batches: 1 },
    });

    expect(collector.snapshot().transport.bytesPerSecond).toBe(0);
    expect(collector.snapshot().transport.batchesPerSecond).toBe(0);
  });

  it('aggregates simultaneous PTY snapshots deterministically', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        { queuedBytes: 1_024, metrics: { state: { bytesEmitted: 0, batchesEmitted: 0 } } },
        { queuedBytes: 2_048, metrics: { state: { bytesEmitted: 0, batchesEmitted: 0 } } },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        { queuedBytes: 4_096, metrics: { state: { bytesEmitted: 2_048, batchesEmitted: 2 } } },
        { queuedBytes: 8_192, metrics: { state: { bytesEmitted: 2_048, batchesEmitted: 2 } } },
      ],
    });

    expect(collector.snapshot().transport).toMatchObject({
      bytesPerSecond: 4_096,
      batchesPerSecond: 4,
      queueBytesHighWater: 8_192,
    });
  });

  it('calculates PTY counter deltas independently so one reset cannot mask another PTY growth', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        { threadId: 'resetting', metrics: { state: { bytesEmitted: 100 } } },
        { threadId: 'growing', metrics: { state: { bytesEmitted: 100 } } },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        { threadId: 'resetting', metrics: { state: { bytesEmitted: 10 } } },
        { threadId: 'growing', metrics: { state: { bytesEmitted: 200 } } },
      ],
    });

    expect(collector.snapshot().transport.bytesPerSecond).toBe(100);
  });

  it('requires timestamped wrappers for raw native PTY arrays and maps cumulative queue high-water metrics', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        {
          threadId: 'native-pty',
          pendingBytes: 2,
          pendingFragments: 1,
          queuedBytes: 3,
          queueDepth: 1,
          prepared: false,
          inFlightBatches: 1,
          inFlightBytes: 4,
          lastAckedSequence: 1,
          blockedProducers: 0,
          visibility: 'visible',
          effectiveCadenceMicros: 0,
          draining: false,
          cancelled: false,
          workerRunning: true,
          metrics: {
            state: {
              bytesEmitted: 100,
              batchesEmitted: 2,
              batchesAcknowledged: 1,
              totalAckLatencyMicros: 2_000,
              maxAckLatencyMicros: 3_000,
              pushWouldBlockCount: 1,
              pendingBytesHighWater: 12_000,
              pendingFragmentsHighWater: 9,
              inFlightBatchesHighWater: 3,
              inFlightBytesHighWater: 500,
            },
          },
        },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        {
          threadId: 'native-pty',
          pendingBytes: 4,
          pendingFragments: 2,
          queuedBytes: 5,
          queueDepth: 2,
          prepared: false,
          inFlightBatches: 1,
          inFlightBytes: 4,
          lastAckedSequence: 2,
          blockedProducers: 0,
          visibility: 'visible',
          effectiveCadenceMicros: 0,
          draining: false,
          cancelled: false,
          workerRunning: true,
          metrics: {
            state: {
              bytesEmitted: 4_196,
              batchesEmitted: 6,
              batchesAcknowledged: 2,
              totalAckLatencyMicros: 6_000,
              maxAckLatencyMicros: 7_000,
              pushWouldBlockCount: 3,
              pendingBytesHighWater: 15_000,
              pendingFragmentsHighWater: 12,
              inFlightBatchesHighWater: 4,
              inFlightBytesHighWater: 700,
            },
          },
        },
      ],
    });

    expect(collector.snapshot().transport).toMatchObject({
      bytesPerSecond: 4_096,
      batchesPerSecond: 4,
      queueBytesHighWater: 15_000,
      queueDepthHighWater: 12,
      backpressureCount: 3,
      averageAckLatencyMs: 3,
      maxAckLatencyMs: 7,
    });
  });

  it('uses emitted counters for throughput and batch evidence in actual native snapshots', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        {
          threadId: 'native-pty',
          pendingBytes: 0,
          pendingFragments: 0,
          queuedBytes: 0,
          queueDepth: 0,
          prepared: true,
          inFlightBatches: 0,
          inFlightBytes: 0,
          lastAckedSequence: 0,
          blockedProducers: 0,
          visibility: 'visible',
          effectiveCadenceMicros: 0,
          draining: false,
          cancelled: false,
          workerRunning: true,
          metrics: {
            state: {
              bytesAccepted: 10_000,
              fragmentsAccepted: 100,
              bytesEmitted: 0,
              batchesEmitted: 0,
            },
          },
        },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        {
          threadId: 'native-pty',
          pendingBytes: 0,
          pendingFragments: 0,
          queuedBytes: 0,
          queueDepth: 0,
          prepared: true,
          inFlightBatches: 0,
          inFlightBytes: 0,
          lastAckedSequence: 0,
          blockedProducers: 0,
          visibility: 'visible',
          effectiveCadenceMicros: 0,
          draining: false,
          cancelled: false,
          workerRunning: true,
          metrics: {
            state: {
              bytesAccepted: 30_000,
              fragmentsAccepted: 300,
              bytesEmitted: 400,
              batchesEmitted: 2,
            },
          },
        },
      ],
    });

    expect(collector.snapshot().transport).toMatchObject({
      bytesPerSecond: 400,
      batchesPerSecond: 2,
      averageBatchBytes: 200,
      p95BatchBytes: 200,
      p95BatchIntervalMs: 500,
    });
  });

  it('weights emitted interval aggregates by their emitted batch counts', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 0,
      transport: { bytesEmitted: 0, batchesEmitted: 0 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      transport: { bytesEmitted: 100, batchesEmitted: 1 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      transport: { bytesEmitted: 1_100, batchesEmitted: 101 },
    });

    expect(collector.snapshot().transport).toMatchObject({
      averageBatchBytes: 1_100 / 101,
      p95BatchBytes: 10,
      p95BatchIntervalMs: 10,
    });
  });

  it('keeps retired PTY backpressure history while counting later monotonic growth', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        { threadId: 'first', metrics: { state: { pushWouldBlockCount: 10 } } },
        { threadId: 'second', metrics: { state: { pushWouldBlockCount: 5 } } },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        { threadId: 'second', metrics: { state: { pushWouldBlockCount: 6 } } },
      ],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(16);
  });

  it('baselines a reused PTY backpressure counter after retirement', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [{ threadId: 'reused', metrics: { state: { pushWouldBlockCount: 10 } } }],
    });
    collector.mergeNativeSnapshot({ sampledAt: 2_000, ptySnapshots: [] });
    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      ptySnapshots: [{ threadId: 'reused', metrics: { state: { pushWouldBlockCount: 1 } } }],
    });
    expect(collector.snapshot().transport.backpressureCount).toBe(10);

    collector.mergeNativeSnapshot({
      sampledAt: 4_000,
      ptySnapshots: [{ threadId: 'reused', metrics: { state: { pushWouldBlockCount: 2 } } }],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(11);
  });

  it('initializes backpressure from all current PTY counters on the first snapshot', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        { threadId: 'first', metrics: { state: { pushWouldBlockCount: 4 } } },
        { threadId: 'second', metrics: { state: { pushWouldBlockCount: 7 } } },
      ],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(11);
  });

  it('baselines new PTYs while counting deltas for existing PTYs', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [{ threadId: 'existing', metrics: { state: { pushWouldBlockCount: 4 } } }],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        { threadId: 'existing', metrics: { state: { pushWouldBlockCount: 7 } } },
        { threadId: 'new', metrics: { state: { pushWouldBlockCount: 20 } } },
      ],
    });
    expect(collector.snapshot().transport.backpressureCount).toBe(7);

    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      ptySnapshots: [
        { threadId: 'existing', metrics: { state: { pushWouldBlockCount: 9 } } },
        { threadId: 'new', metrics: { state: { pushWouldBlockCount: 25 } } },
      ],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(14);
  });

  it('does not double-count a reused PTY after more than 1024 retirements', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        { threadId: 'reused', metrics: { state: { pushWouldBlockCount: 10 } } },
        ...Array.from({ length: 1_024 }, (_, index) => ({
          threadId: `retired-${index}`,
          metrics: { state: { pushWouldBlockCount: 0 } },
        })),
      ],
    });
    collector.mergeNativeSnapshot({ sampledAt: 2_000, ptySnapshots: [] });
    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      ptySnapshots: [{ threadId: 'reused', metrics: { state: { pushWouldBlockCount: 11 } } }],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(10);
  });

  it('treats a PTY backpressure counter reset as a zero-delta interval', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [{ threadId: 'resetting', metrics: { state: { pushWouldBlockCount: 10 } } }],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [{ threadId: 'resetting', metrics: { state: { pushWouldBlockCount: 2 } } }],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      ptySnapshots: [{ threadId: 'resetting', metrics: { state: { pushWouldBlockCount: 3 } } }],
    });

    expect(collector.snapshot().transport.backpressureCount).toBe(11);
  });

  it('rejects bare timestamp-less native PTY arrays', () => {
    const collector = createPerformanceMetricsCollector();

    expect(() =>
      collector.mergeNativeSnapshot([
        {
          threadId: 'native-pty',
          metrics: { state: { bytesEmitted: 100, batchesEmitted: 1 } },
        },
      ]),
    ).toThrow(/sampledAt.*ptySnapshots/);
  });

  it('treats process presence as authoritative while absence preserves the prior process fields', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      process: { cpuPercent: 12, rssBytes: 64 * 1024 * 1024 },
    });
    collector.mergeNativeSnapshot({ sampledAt: 2_000 });
    expect(collector.snapshot().process).toEqual({
      cpuPercent: 12,
      rssBytes: 64 * 1024 * 1024,
    });

    collector.mergeNativeSnapshot({ sampledAt: 3_000, process: { rssBytes: 96 * 1024 * 1024 } });
    expect(collector.snapshot().process).toEqual({ rssBytes: 96 * 1024 * 1024 });

    collector.mergeNativeSnapshot({ sampledAt: 4_000, process: null });
    expect(collector.snapshot()).not.toHaveProperty('process');

    collector.mergeNativeSnapshot({ sampledAt: 5_000, process: { cpuPercent: 18 } });
    collector.mergeNativeSnapshot({ sampledAt: 6_000, process: {} });
    expect(collector.snapshot()).not.toHaveProperty('process');
  });

  it('forgets PTYs that disappear from an authoritative snapshot', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [{ threadId: 'gone', metrics: { state: { bytesEmitted: 100 } } }],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [{ threadId: 'gone', metrics: { state: { bytesEmitted: 200 } } }],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      ptySnapshots: [],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 4_000,
      ptySnapshots: [{ threadId: 'gone', metrics: { state: { bytesEmitted: 200 } } }],
    });

    expect(collector.snapshot().transport.bytesPerSecond).toBe(0);
  });

  it('clears current transport evidence when an authoritative PTY snapshot is empty', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      ptySnapshots: [
        {
          threadId: 'pty',
          queuedBytes: 4_096,
          queuedBatches: 3,
          blockedProducers: 1,
          backpressureCount: 2,
          batchSizes: [100, 200],
          batchIntervalsMs: [10, 20],
          ackLatenciesMs: [5],
          metrics: { state: { bytesEmitted: 100, batchesEmitted: 2 } },
        },
      ],
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      ptySnapshots: [
        {
          threadId: 'pty',
          queuedBytes: 8_192,
          queuedBatches: 6,
          blockedProducers: 2,
          backpressureCount: 4,
          batchSizes: [300],
          batchIntervalsMs: [30],
          ackLatenciesMs: [7],
          metrics: { state: { bytesEmitted: 200, batchesEmitted: 4 } },
        },
      ],
    });

    collector.mergeNativeSnapshot({ sampledAt: 3_000, ptySnapshots: [] });

    expect(collector.snapshot().transport).toMatchObject({
      bytesPerSecond: 0,
      batchesPerSecond: 0,
      averageBatchBytes: 50,
      p95BatchBytes: 0,
      p95BatchIntervalMs: 0,
      queueBytesHighWater: 8_192,
      queueDepthHighWater: 6,
      blockedProducersHighWater: 2,
      backpressureCount: 4,
    });
    expect(collector.snapshot().transport).not.toHaveProperty('averageAckLatencyMs');
    expect(collector.snapshot().transport).not.toHaveProperty('maxAckLatencyMs');
  });

  it('uses current renderer pane counts and clears them for an empty snapshot', () => {
    const collector = createPerformanceMetricsCollector();
    collector.mergeNativeSnapshot({
      renderer: {
        panes: [
          { webgl: true },
          { recovering: true },
          { fallback: true },
        ],
      },
    });
    expect(collector.snapshot().renderer).toMatchObject({
      webglPanes: 1,
      recoveringPanes: 1,
      fallbackPanes: 1,
    });

    collector.mergeNativeSnapshot({ renderer: { panes: [] } });

    expect(collector.snapshot().renderer).toMatchObject({
      webglPanes: 0,
      recoveringPanes: 0,
      fallbackPanes: 0,
    });
  });

  it('resets all collected state', () => {
    const collector = createPerformanceMetricsCollector();
    collector.recordFrame(0);
    collector.recordFrame(20);
    collector.recordLongTask(30);
    collector.recordInteractionStart('focus', 100);
    collector.mergeNativeSnapshot({
      sampledAt: 1_000,
      process: { cpuPercent: 12 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 2_000,
      transport: { bytesEmitted: 0, batchesEmitted: 0 },
    });
    collector.mergeNativeSnapshot({
      sampledAt: 3_000,
      transport: { bytesEmitted: 100, batchesEmitted: 1, pushWouldBlockCount: 3 },
    });
    collector.reset();

    expect(collector.snapshot()).toEqual({
      sampledAt: 0,
      frames: {
        sampleCount: 0,
        averageMs: 0,
        p95Ms: 0,
        maxMs: 0,
        over16_7: 0,
        over33_4: 0,
        over50: 0,
        estimatedDroppedFrames: 0,
      },
      transport: {
        bytesPerSecond: 0,
        batchesPerSecond: 0,
        averageBatchBytes: 0,
        p95BatchBytes: 0,
        p95BatchIntervalMs: 0,
        queueBytesHighWater: 0,
        queueDepthHighWater: 0,
        blockedProducersHighWater: 0,
        backpressureCount: 0,
      },
      renderer: {
        coalescedVisualUpdates: 0,
        webglPanes: 0,
        recoveringPanes: 0,
        fallbackPanes: 0,
        contextLosses: 0,
      },
      interactions: {},
    });
  });

  describe('live performance collection', () => {
    it('polls native metrics at the interval cadence without invoking from rAF', async () => {
      let intervalCallback: (() => void) | undefined;
      const frameCallbacks: Array<(timestamp: number) => void> = [];
      let clock = 0;
      const invoke = vi.fn(async (command: string) => command === 'pty_transport_metrics' ? [] : null);
      const collector = createPerformanceMetricsCollector({
        invoke,
        requestFrame: (callback) => {
          frameCallbacks.push(callback);
          return frameCallbacks.length;
        },
        cancelFrame: vi.fn(),
        setInterval: (callback) => {
          intervalCallback = callback;
          return 1;
        },
        clearInterval: vi.fn(),
        now: () => clock,
      });

      collector.start();
      frameCallbacks.shift()?.(16);
      expect(invoke).not.toHaveBeenCalled();
      intervalCallback?.();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenNthCalledWith(
        1,
        'pty_transport_metrics',
        { threadId: null, thread_id: null },
      );
      expect(invoke).toHaveBeenNthCalledWith(2, 'runtime_process_metrics', {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock = 999;
      intervalCallback?.();
      expect(invoke).toHaveBeenCalledTimes(2);
      clock = 1_000;
      intervalCallback?.();
      expect(invoke).toHaveBeenCalledTimes(4);
      collector.stop();
    });

    it('skips overlapping native polls and rejects stale results after stop', async () => {
      let intervalCallback: (() => void) | undefined;
      let resolvePty!: (value: unknown) => void;
      let resolveProcess!: (value: unknown) => void;
      const invoke = vi.fn((command: string) => new Promise((resolve) => {
        if (command === 'pty_transport_metrics') resolvePty = resolve;
        else resolveProcess = resolve;
      }));
      const reportError = vi.fn();
      const collector = createPerformanceMetricsCollector({
        invoke,
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
        setInterval: (callback) => {
          intervalCallback = callback;
          return 1;
        },
        clearInterval: vi.fn(),
        now: () => 1_000,
        reportError,
      });

      collector.start();
      intervalCallback?.();
      intervalCallback?.();
      expect(invoke).toHaveBeenCalledTimes(2);
      collector.stop();
      resolvePty([]);
      resolveProcess(null);
      await Promise.resolve();
      await Promise.resolve();
      expect(collector.snapshot().sampledAt).toBe(0);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('reports observer failures while continuing collection without long tasks', () => {
      const reportError = vi.fn();
      const collector = createPerformanceMetricsCollector({
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
        setInterval: () => 1,
        clearInterval: vi.fn(),
        createPerformanceObserver: () => {
          throw new Error('observer unavailable');
        },
        reportError,
      });

      collector.start();
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'PerformanceObserver');
      expect(collector.snapshot()).not.toHaveProperty('longTasks');
      collector.stop();
    });

    it('samples scheduler and renderer providers when taking a snapshot', () => {
      const collector = createPerformanceMetricsCollector({
        schedulerSnapshot: () => ({ pendingCallbacks: 2, coalescedVisualUpdates: 4 }),
        rendererSnapshots: () => [
          { state: 'webgl', contextLosses: 2 },
          { state: 'recovering', contextLosses: 1 },
          { state: 'fallback', contextLosses: 0 },
        ],
      });

      expect(collector.snapshot().renderer).toMatchObject({
        coalescedVisualUpdates: 4,
        webglPanes: 1,
        recoveringPanes: 1,
        fallbackPanes: 1,
        contextLosses: 3,
      });
    });
  });
});
