import { describe, expect, it } from 'vitest';
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
      averageBatchBytes: 0,
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
});
