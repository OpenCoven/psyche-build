import { describe, expect, it } from 'vitest';
import {
  SLICE4_ACCELERATION_VALUES,
  SLICE4_FALLBACK_REASONS,
  SLICE4_FRAME_SAMPLE_RETENTION,
  SLICE4_METRICS_MAX_POLL_INTERVAL_MS,
  SLICE4_METRICS_MIN_POLL_INTERVAL_MS,
  SLICE4_METRICS_POLL_INTERVAL_MS,
  SLICE4_METRICS_WINDOW_MAX_SAMPLES,
  SLICE4_METRIC_KEYS,
  SLICE4_MERGE_LIMITS,
  SLICE4_SOFTWARE_RENDERER_MARKERS_VERSION,
  SLICE4_UNSUPPORTED_FIELD_ORDER,
  boundedMetricsWindow,
  classifyRenderer,
  mergeSlice4Reports,
  type Slice4BrowserReportV1,
  type Slice4MetricSampleV1,
  type Slice4NativeReportV1,
} from '../src/gpu/slice4ReportMerge.js';

const NATIVE_REPORT: Slice4NativeReportV1 = {
  schemaVersion: 1,
  source: 'native',
  os: 'macos',
  arch: 'arm64',
  engine: 'WKWebView',
  engineVersion: '617.1',
  debugBuild: true,
  stressAuthorized: true,
  process: {
    cpuPercent: 12.5,
    rssMb: 512,
    sampledAt: '2026-08-28T00:00:00Z',
  },
};

const BROWSER_REPORT: Slice4BrowserReportV1 = {
  schemaVersion: 1,
  source: 'browser',
  probe: 'webgl2',
  strict: true,
  rendererIdentityAvailable: true,
  renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
};

function browserWith(overrides: Partial<Slice4BrowserReportV1>): Slice4BrowserReportV1 {
  const base: Record<string, unknown> = { ...BROWSER_REPORT };
  const overridesRecord = overrides as Record<string, unknown>;
  for (const key of Object.keys(overridesRecord)) {
    if (overridesRecord[key] === undefined) {
      delete base[key];
    } else {
      base[key] = overridesRecord[key];
    }
  }
  return base as unknown as Slice4BrowserReportV1;
}

describe('slice 4 report merge — module constants', () => {
  it('pins schema version, retention, and polling cadence bounds', () => {
    expect(SLICE4_MERGE_LIMITS.schemaVersion).toBe(1);
    expect(SLICE4_FRAME_SAMPLE_RETENTION).toBe(20_000);
    expect(SLICE4_METRICS_WINDOW_MAX_SAMPLES).toBe(SLICE4_FRAME_SAMPLE_RETENTION);
    expect(SLICE4_METRICS_POLL_INTERVAL_MS).toBe(1_000);
    expect(SLICE4_METRICS_MIN_POLL_INTERVAL_MS).toBe(SLICE4_METRICS_POLL_INTERVAL_MS);
    expect(SLICE4_METRICS_MAX_POLL_INTERVAL_MS).toBeGreaterThan(
      SLICE4_METRICS_MIN_POLL_INTERVAL_MS,
    );
  });

  it('uses a closed acceleration vocabulary shared with the verification matrix', () => {
    expect([...SLICE4_ACCELERATION_VALUES]).toEqual([
      'accelerated',
      'software',
      'unknown',
      'unavailable',
    ]);
  });

  it('versions the software-marker list', () => {
    expect(SLICE4_SOFTWARE_RENDERER_MARKERS_VERSION).toBe(1);
    expect(SLICE4_UNSUPPORTED_FIELD_ORDER).toEqual(['adapter', 'backend']);
  });
});

describe('slice 4 report merge — classification table', () => {
  it('classifies hardware ANGLE Metal renderer evidence as accelerated', () => {
    const result = classifyRenderer(
      browserWith({
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'accelerated',
        backend: 'Metal',
        adapter: 'Apple M3',
        supportingProbe: 'webgl2',
        softwareMarkers: [],
        unsupportedFields: [],
      },
    });
  });

  it('classifies hardware Direct3D renderer evidence as accelerated', () => {
    const result = classifyRenderer(
      browserWith({
        probe: 'webgl',
        renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'accelerated',
        backend: 'Direct3D',
        adapter: 'Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0',
        supportingProbe: 'webgl',
      },
    });
  });

  it('classifies hardware OpenGL renderer evidence as accelerated', () => {
    const result = classifyRenderer(
      browserWith({
        probe: 'webgpu',
        renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'accelerated',
        backend: 'OpenGL',
        adapter: 'Mesa Intel(R) UHD Graphics (CML GT2)',
        supportingProbe: 'webgpu',
      },
    });
  });

  it('classifies hardware Vulkan renderer evidence as accelerated', () => {
    const result = classifyRenderer(
      browserWith({
        renderer: 'ANGLE (AMD, AMD RADV VEGA10 (LLVM 15.0.7), Vulkan 1.3.239)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'accelerated',
        backend: 'Vulkan',
        adapter: 'AMD RADV VEGA10 (LLVM 15.0.7)',
      },
    });
  });

  it('classifies SwiftShader renderer evidence as software even with a strict context', () => {
    const result = classifyRenderer(
      browserWith({
        renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) () Vulkan 1.3.0))',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'software',
        backend: 'Vulkan',
        softwareMarkers: ['swiftshader'],
      },
    });
  });

  it('classifies llvmpipe renderer evidence as software', () => {
    const result = classifyRenderer(
      browserWith({
        renderer: 'ANGLE (Unknown, llvmpipe (LLVM 15.0.7, 256 bit), OpenGL 4.5)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'software',
        backend: 'OpenGL',
        adapter: 'llvmpipe (LLVM 15.0.7, 256 bit)',
        softwareMarkers: ['llvmpipe'],
      },
    });
  });

  it('classifies Microsoft Basic Render Driver evidence as software', () => {
    const result = classifyRenderer(
      browserWith({
        renderer: 'ANGLE (Unknown, Microsoft Basic Render Driver () Direct3D11, D3D11)',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'software',
        backend: 'Direct3D',
        softwareMarkers: ['microsoft basic render driver'],
      },
    });
  });

  it('matches software markers case-insensitively and reports them in marker-list order', () => {
    const result = classifyRenderer(
      browserWith({ renderer: 'SWIFTSHADER device plus llvmpipe' }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'software',
        softwareMarkers: ['swiftshader', 'llvmpipe'],
      },
    });
  });

  it('classifies a masked renderer under strict context as unknown, not accelerated', () => {
    const result = classifyRenderer(
      browserWith({ rendererIdentityAvailable: false, renderer: undefined }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.maskedStrict,
        softwareMarkers: [],
        unsupportedFields: ['adapter', 'backend'],
      },
    });
  });

  it('classifies an ordinary non-strict context with readable identity as unknown', () => {
    const result = classifyRenderer(browserWith({ strict: false }));
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.ordinaryContext,
      },
    });
  });

  it('classifies masked evidence without strict context as unknown', () => {
    const result = classifyRenderer(
      browserWith({ strict: false, rendererIdentityAvailable: false, renderer: undefined }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.maskedNonStrict,
      },
    });
  });

  it('classifies conflicting identity evidence as unknown', () => {
    const conflictingAvailability = classifyRenderer(
      browserWith({ rendererIdentityAvailable: false }),
    );
    expect(conflictingAvailability).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.conflictingAvailability,
      },
    });
    const missingString = classifyRenderer(
      browserWith({ rendererIdentityAvailable: true, renderer: undefined }),
    );
    expect(missingString).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.conflictingAvailability,
      },
    });
  });

  it('classifies a missing usable probe path as unavailable', () => {
    const result = classifyRenderer(
      browserWith({ probe: 'none', strict: false, rendererIdentityAvailable: false, renderer: undefined }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unavailable',
        fallbackReason: SLICE4_FALLBACK_REASONS.unavailable,
        softwareMarkers: [],
        unsupportedFields: ['adapter', 'backend'],
      },
    });
  });

  it('classifies a renderer identity reported without a usable probe path as unknown', () => {
    const result = classifyRenderer(
      browserWith({ probe: 'none', strict: false, rendererIdentityAvailable: false }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.conflictingProbe,
      },
    });
  });

  it('omits an unrecognizable backend token instead of guessing it', () => {
    const result = classifyRenderer(
      browserWith({ renderer: 'Mesa Intel(R) UHD Graphics 620' }),
    );
    expect(result).toMatchObject({
      ok: true,
      classification: {
        acceleration: 'accelerated',
        adapter: 'Mesa Intel(R) UHD Graphics 620',
        unsupportedFields: ['backend'],
      },
    });
    expect(result.ok && 'backend' in result.classification).toBe(false);
  });

  it('rejects malformed browser evidence with a typed reason', () => {
    expect(
      classifyRenderer({ ...BROWSER_REPORT, extra: true } as unknown as Slice4BrowserReportV1),
    ).toMatchObject({
      ok: false,
      reason: 'unknown-field',
    });
    expect(
      classifyRenderer({ ...BROWSER_REPORT, schemaVersion: 2 } as unknown as Slice4BrowserReportV1),
    ).toMatchObject({
      ok: false,
      reason: 'schema-version',
    });
    expect(classifyRenderer({ ...BROWSER_REPORT, renderer: ' '.repeat(600) })).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
  });
});

describe('slice 4 report merge — deterministic merge', () => {
  it('merges native and browser evidence deterministically', () => {
    const first = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    const second = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(JSON.stringify(first.report)).toBe(JSON.stringify(second.report));
    expect(first.report).toEqual({
      schemaVersion: 1,
      os: 'macos',
      arch: 'arm64',
      engine: 'WKWebView',
      engineVersion: '617.1',
      debugBuild: true,
      stressAuthorized: true,
      acceleration: 'accelerated',
      backend: 'Metal',
      adapter: 'Apple M3',
      supportingProbe: 'webgl2',
      softwareMarkers: [],
      unsupportedFields: [],
      process: NATIVE_REPORT.process,
    });
  });

  it('emits the merged report in a canonical key order', () => {
    const result = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.report)).toEqual([
      'schemaVersion',
      'os',
      'arch',
      'engine',
      'engineVersion',
      'debugBuild',
      'stressAuthorized',
      'acceleration',
      'backend',
      'adapter',
      'supportingProbe',
      'softwareMarkers',
      'unsupportedFields',
      'process',
    ]);
  });

  it('is independent of input key order', () => {
    const shuffledNative = {
      process: NATIVE_REPORT.process,
      stressAuthorized: NATIVE_REPORT.stressAuthorized,
      debugBuild: NATIVE_REPORT.debugBuild,
      engineVersion: NATIVE_REPORT.engineVersion,
      engine: NATIVE_REPORT.engine,
      arch: NATIVE_REPORT.arch,
      os: NATIVE_REPORT.os,
      source: NATIVE_REPORT.source,
      schemaVersion: NATIVE_REPORT.schemaVersion,
    };
    const canonical = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    const shuffled = mergeSlice4Reports({ native: shuffledNative, browser: BROWSER_REPORT });
    expect(shuffled.ok).toBe(true);
    expect(canonical.ok).toBe(true);
    if (!shuffled.ok || !canonical.ok) {
      return;
    }
    expect(JSON.stringify(shuffled.report)).toBe(JSON.stringify(canonical.report));
  });

  it('returns deeply frozen reports and classifications', () => {
    const merged = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(Object.isFrozen(merged.report)).toBe(true);
    expect(Object.isFrozen(merged.report.softwareMarkers)).toBe(true);
    expect(Object.isFrozen(merged.report.unsupportedFields)).toBe(true);
    expect(Object.isFrozen(merged.report.process)).toBe(true);

    const classified = classifyRenderer(BROWSER_REPORT);
    expect(classified.ok).toBe(true);
    if (classified.ok) {
      expect(Object.isFrozen(classified.classification)).toBe(true);
      expect(Object.isFrozen(classified.classification.softwareMarkers)).toBe(true);
    }
  });
});

describe('slice 4 report merge — omission, not placeholder', () => {
  it('omits engineVersion and process when the native report did not observe them', () => {
    const native: Record<string, unknown> = { ...NATIVE_REPORT };
    delete native.engineVersion;
    delete native.process;
    const result = mergeSlice4Reports({
      native: native as unknown as Slice4NativeReportV1,
      browser: BROWSER_REPORT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect('engineVersion' in result.report).toBe(false);
    expect('process' in result.report).toBe(false);
    expect(JSON.stringify(result.report)).not.toContain('engineVersion');
    expect(JSON.stringify(result.report)).not.toContain(':null');
  });

  it('omits masked graphics fields and names them in unsupportedFields', () => {
    const maskedBrowser = browserWith({ rendererIdentityAvailable: false, renderer: undefined });
    const result = mergeSlice4Reports({
      native: { ...NATIVE_REPORT, engineVersion: undefined, process: undefined },
      browser: maskedBrowser,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect('engineVersion' in result.report).toBe(false);
    expect('backend' in result.report).toBe(false);
    expect('adapter' in result.report).toBe(false);
    expect('supportingProbe' in result.report).toBe(false);
    expect(result.report.acceleration).toBe('unknown');
    expect(result.report.unsupportedFields).toEqual(['adapter', 'backend']);
    expect(JSON.stringify(result.report)).not.toContain(':null');
  });

  it('carries native engineVersion and process when observed', () => {
    const result = mergeSlice4Reports({ native: NATIVE_REPORT, browser: BROWSER_REPORT });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.report.engineVersion).toBe('617.1');
    expect(result.report.process).toEqual(NATIVE_REPORT.process);
  });
});

describe('slice 4 report merge — typed rejection', () => {
  it('rejects unknown fields at every level', () => {
    const rootResult = mergeSlice4Reports({
      native: NATIVE_REPORT,
      browser: BROWSER_REPORT,
      extra: true,
    } as unknown as { native: Slice4NativeReportV1; browser: Slice4BrowserReportV1 });
    expect(rootResult).toMatchObject({ ok: false, reason: 'unknown-field' });

    const nativeResult = mergeSlice4Reports({
      native: { ...NATIVE_REPORT, driverGuess: 'NVIDIA' } as unknown as Slice4NativeReportV1,
      browser: BROWSER_REPORT,
    });
    expect(nativeResult).toMatchObject({ ok: false, reason: 'unknown-field' });
    if (!nativeResult.ok) {
      expect(nativeResult.errors.join('\n')).toContain('native.driverGuess');
    }

    const browserResult = mergeSlice4Reports({
      native: NATIVE_REPORT,
      browser: { ...BROWSER_REPORT, userAgentGuess: 'Mozilla/5.0' } as unknown as Slice4BrowserReportV1,
    });
    expect(browserResult).toMatchObject({ ok: false, reason: 'unknown-field' });

    const processResult = mergeSlice4Reports({
      native: {
        ...NATIVE_REPORT,
        process: { ...NATIVE_REPORT.process, hostname: 'worker-1' },
      } as unknown as Slice4NativeReportV1,
      browser: BROWSER_REPORT,
    });
    expect(processResult).toMatchObject({ ok: false, reason: 'unknown-field' });
    if (!processResult.ok) {
      expect(processResult.errors.join('\n')).toContain('native.process.hostname');
    }
  });

  it('rejects wrong schema versions and wrong source discriminators', () => {
    expect(
      mergeSlice4Reports({
        native: { ...NATIVE_REPORT, schemaVersion: 2 } as unknown as Slice4NativeReportV1,
        browser: BROWSER_REPORT,
      }),
    ).toMatchObject({ ok: false, reason: 'schema-version' });
    expect(
      mergeSlice4Reports({
        native: { ...NATIVE_REPORT, source: 'browser' } as unknown as Slice4NativeReportV1,
        browser: BROWSER_REPORT,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-field' });
  });

  it('never returns a partially merged report', () => {
    const result = mergeSlice4Reports({
      native: { ...NATIVE_REPORT, os: 'plan9' } as unknown as Slice4NativeReportV1,
      browser: BROWSER_REPORT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok || 'report' in result).toBe(false);
  });

  it('bounds the rejection error list explicitly', () => {
    const noisyNative: Record<string, unknown> = { ...NATIVE_REPORT };
    for (let index = 0; index < 40; index += 1) {
      noisyNative[`unknown${index}`] = index;
    }
    const result = mergeSlice4Reports({
      native: noisyNative as unknown as Slice4NativeReportV1,
      browser: BROWSER_REPORT,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-field' });
    if (!result.ok) {
      expect(result.errors.length).toBe(SLICE4_MERGE_LIMITS.errorsMax + 1);
      expect(result.errors[result.errors.length - 1]).toBe(
        'additional errors suppressed (bounded error list)',
      );
    }
  });
});

describe('slice 4 report merge — bounded metrics window', () => {
  const sample = (key: Slice4MetricSampleV1['key'], value: number): Slice4MetricSampleV1 => ({
    key,
    value,
  });

  it('accepts a bounded window and reports the retention bound', () => {
    const result = boundedMetricsWindow(
      [sample('frame.deltaMs', 16.7), sample('pty.queueHighWater', 3)],
      { pollIntervalMs: SLICE4_METRICS_POLL_INTERVAL_MS },
    );
    expect(result).toMatchObject({
      ok: true,
      window: {
        retention: SLICE4_FRAME_SAMPLE_RETENTION,
        pollIntervalMs: SLICE4_METRICS_POLL_INTERVAL_MS,
      },
    });
    if (result.ok) {
      expect(result.window.samples).toEqual([
        { key: 'frame.deltaMs', value: 16.7 },
        { key: 'pty.queueHighWater', value: 3 },
      ]);
      expect(Object.isFrozen(result.window)).toBe(true);
      expect(Object.isFrozen(result.window.samples)).toBe(true);
    }
  });

  it('accepts a full retention-sized ring', () => {
    const fullRing = Array.from({ length: SLICE4_METRICS_WINDOW_MAX_SAMPLES }, () =>
      sample('frame.deltaMs', 16.7),
    );
    const result = boundedMetricsWindow(fullRing);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.samples.length).toBe(SLICE4_METRICS_WINDOW_MAX_SAMPLES);
      expect('pollIntervalMs' in result.window).toBe(false);
    }
  });

  it('rejects oversize windows instead of silently truncating them', () => {
    const oversize = Array.from({ length: SLICE4_METRICS_WINDOW_MAX_SAMPLES + 1 }, () =>
      sample('frame.deltaMs', 16.7),
    );
    const result = boundedMetricsWindow(oversize);
    expect(result).toMatchObject({ ok: false, reason: 'oversize' });
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('ring-buffer');
      expect('window' in result).toBe(false);
    }
  });

  it('enforces the polling-cadence bounds', () => {
    expect(
      boundedMetricsWindow([], { pollIntervalMs: SLICE4_METRICS_MIN_POLL_INTERVAL_MS }),
    ).toMatchObject({ ok: true });
    expect(
      boundedMetricsWindow([], { pollIntervalMs: SLICE4_METRICS_MAX_POLL_INTERVAL_MS }),
    ).toMatchObject({ ok: true });
    expect(
      boundedMetricsWindow([], { pollIntervalMs: SLICE4_METRICS_MIN_POLL_INTERVAL_MS - 1 }),
    ).toMatchObject({ ok: false, reason: 'cadence-below-minimum' });
    expect(boundedMetricsWindow([], { pollIntervalMs: 0 })).toMatchObject({
      ok: false,
      reason: 'cadence-below-minimum',
    });
    expect(
      boundedMetricsWindow([], { pollIntervalMs: SLICE4_METRICS_MAX_POLL_INTERVAL_MS + 1 }),
    ).toMatchObject({ ok: false, reason: 'cadence-above-maximum' });
    expect(boundedMetricsWindow([], { pollIntervalMs: 16.7 })).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
    expect(
      boundedMetricsWindow([], { pollIntervalMs: 1_000, extra: true } as { pollIntervalMs: number }),
    ).toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('rejects malformed samples with typed reasons and bounded errors', () => {
    expect(boundedMetricsWindow('not-an-array')).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
    expect(
      boundedMetricsWindow([{ key: 'frame.bogus', value: 1 } as unknown as Slice4MetricSampleV1]),
    ).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
    expect(boundedMetricsWindow([{ key: 'frame.deltaMs', value: -1 }])).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
    expect(boundedMetricsWindow([{ key: 'frame.deltaMs', value: Number.NaN }])).toMatchObject({
      ok: false,
      reason: 'invalid-field',
    });
    expect(
      boundedMetricsWindow([{ key: 'frame.deltaMs', value: SLICE4_MERGE_LIMITS.metricValueMax + 1 }]),
    ).toMatchObject({ ok: false, reason: 'invalid-field' });
    const noteSample = { key: 'frame.deltaMs', value: 1, note: 'extra' } as unknown as Slice4MetricSampleV1;
    expect(boundedMetricsWindow([noteSample])).toMatchObject({
      ok: false,
      reason: 'unknown-field',
    });
    const noteResult = boundedMetricsWindow([noteSample]);
    if (!noteResult.ok) {
      expect(noteResult.errors.join('\n')).toContain('samples[0].note');
    }
  });

  it('keeps windows independent of the caller-provided array', () => {
    const input: Slice4MetricSampleV1[] = [sample('frame.deltaMs', 16.7)];
    const result = boundedMetricsWindow(input);
    expect(result.ok).toBe(true);
    input.push(sample('frame.deltaMs', 999));
    if (result.ok) {
      expect(result.window.samples).toEqual([{ key: 'frame.deltaMs', value: 16.7 }]);
    }
  });

  it('only accepts keys from the closed metric-key list', () => {
    for (const key of SLICE4_METRIC_KEYS) {
      expect(boundedMetricsWindow([sample(key, 1)])).toMatchObject({ ok: true });
    }
  });
});
