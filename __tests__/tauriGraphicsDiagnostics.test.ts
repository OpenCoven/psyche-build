import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  STRICT_WEBGL_CONTEXT_ATTRIBUTES,
  classifyGraphicsEvidence,
  createRuntimeGraphicsStartupState,
  ensureRuntimeGraphicsStartupSummary,
  mergeRuntimeGraphicsReport,
  probeGraphicsEvidence,
  type GraphicsWebGlContext,
} from '../native/desktop/psyche-build-tauri/web/runtime/graphics-diagnostics';
import {
  classifyGraphicsEvidence as classifyGraphicsEvidenceFromEntry,
  mergeRuntimeGraphicsReport as mergeRuntimeGraphicsReportFromEntry,
  probeGraphicsEvidence as probeGraphicsEvidenceFromEntry,
} from '../native/desktop/psyche-build-tauri/web/runtime/runtime-entry';

const runtimeEntryPath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts',
);
const runtimeBundlePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/runtime.bundle.js',
);

class FakeWebGlContext {
  constructor(
    private readonly renderer: string | null,
    private readonly debugRendererInfoAvailable = true,
  ) {}

  getExtension(name: string) {
    expect(name).toBe('WEBGL_debug_renderer_info');
    return this.debugRendererInfoAvailable ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null;
  }

  getParameter(parameter: number) {
    expect(parameter).toBe(0x9246);
    return this.renderer;
  }
}

function createCanvasHarness(
  respond: (
    kind: 'webgl2' | 'webgl',
    attributes?: typeof STRICT_WEBGL_CONTEXT_ATTRIBUTES,
  ) => GraphicsWebGlContext | null,
) {
  const requests: Array<{
    kind: 'webgl2' | 'webgl';
    attributes: typeof STRICT_WEBGL_CONTEXT_ATTRIBUTES | undefined;
  }> = [];

  return {
    requests,
    createCanvas: () => ({
      getContext(kind: 'webgl2' | 'webgl', attributes?: typeof STRICT_WEBGL_CONTEXT_ATTRIBUTES) {
        requests.push({ kind, attributes });
        return respond(kind, attributes);
      },
    }),
  };
}

describe('graphics evidence classification', () => {
  it('classifies hardware ANGLE renderers across Direct3D, Metal, Vulkan, and OpenGL', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Direct3D',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Apple, Apple M3, Metal)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Metal',
      adapter: 'Apple M3',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Intel, Intel Arc A770, Vulkan 1.3.281)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Vulkan',
      adapter: 'Intel Arc A770',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl',
      renderer: 'AMD Radeon Pro 560X OpenGL Engine',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'OpenGL',
      adapter: 'AMD Radeon Pro 560X',
      supportingProbe: 'webgl',
    });
  });

  it('never upgrades known software implementations to accelerated', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Vulkan 1.3 SwiftShader)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      backend: 'Vulkan',
      adapter: 'SwiftShader',
      fallbackReason: 'software_renderer_detected',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl',
      renderer: 'llvmpipe (LLVM 18.1.8, 256 bits)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      adapter: 'llvmpipe',
      fallbackReason: 'software_renderer_detected',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl',
      renderer: 'softpipe',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      adapter: 'softpipe',
      fallbackReason: 'software_renderer_detected',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      backend: 'Direct3D',
      adapter: 'Microsoft Basic Render Driver',
      fallbackReason: 'software_renderer_detected',
    });
  });

  it('treats Apple Software Renderer as software even with Apple hardware hints', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl',
      renderer: 'Apple Software Renderer',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      adapter: 'Apple Software Renderer',
      supportingProbe: 'webgl',
      fallbackReason: 'software_renderer_detected',
    });
  });

  it('omits a backend when strict WebGL renderer evidence does not name one', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'NVIDIA GeForce RTX 4090',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'accelerated',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });
  });

  it('classifies numbered Direct3D ANGLE renderers and strips shader suffixes', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Direct3D',
      adapter: 'NVIDIA GeForce GTX 1660 Ti',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER Direct3D12 vs_5_1 ps_5_1)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Direct3D',
      adapter: 'NVIDIA GeForce RTX 4080 SUPER',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });
  });

  it('keeps masked ANGLE adapters unknown even when OpenGL is named as the backend', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Generic Renderer, OpenGL)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });
  });

  it('does not treat identifier-only WebGPU or ANGLE values as hardware adapters', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, 0x10de, OpenGL)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: '0x10de',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgpu',
      unsupportedFields: [],
    });
  });

  it('does not treat backend-only names as hardware adapters', () => {
    for (const adapter of ['Metal', 'Vulkan', 'OpenGL', 'Direct3D', 'D3D11', 'ANGLE Vulkan Renderer']) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: adapter,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });
    }

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Metal, Metal)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, ANGLE Vulkan Renderer, Vulkan 1.3)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
    });
  });

  it('does not treat identifier-only formats as hardware adapters', () => {
    const identifiers = [
      'PCI: 10de:2484',
      'VEN_10DE&DEV_2484',
      'Vendor ID: 0x10de',
      '123456',
      '0x10de',
    ];

    for (const adapter of identifiers) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${adapter}, Vulkan 1.3)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: adapter,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });
    }
  });

  it('stays conservative for masked, strict-failure, conflicting, absent-version, and unrecognized cases', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'WebKit WebGL',
      unsupportedFields: ['webgl.renderer', 'webgl.renderer'],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
      unsupportedFields: ['webgl.renderer'],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'OpenGL',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      fallbackContext: 'webgl2',
      renderer: 'ANGLE (Apple, Apple M3, Metal)',
      unsupportedFields: ['webgl.strictContext'],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'unknown',
      backend: 'Metal',
      adapter: 'Apple M3',
      supportingProbe: 'webgl2',
      fallbackReason: 'strict_webgl_context_failed',
      unsupportedFields: ['webgl.strictContext'],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Vulkan 1.3 SwiftShader)',
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Apple M3 Pro',
      webgpuAdapterInfoSource: 'adapter.info',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'conflicting_reliable_evidence',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11, D3D11)',
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Vulkan SwiftShader',
      webgpuAdapterInfoSource: 'adapter.info',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'conflicting_reliable_evidence',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'Acme Renderer 1.0',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'renderer_unrecognized',
      supportingProbe: 'webgl2',
      unsupportedFields: [],
    });

    expect(mergeRuntimeGraphicsReport(
      { os: 'macos', arch: 'aarch64', engine: 'WKWebView' },
      {
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        unsupportedFields: ['webgl.renderer', 'webgl.renderer'],
      },
    )).toEqual({
      os: 'macos',
      arch: 'aarch64',
      engine: 'WKWebView',
      acceleration: 'unknown',
      fallbackReason: 'renderer_masked_or_ambiguous',
      unsupportedFields: ['webgl.renderer'],
    });
  });

  it('reports unavailable only when no usable graphics API exists', () => {
    expect(classifyGraphicsEvidence({
      unsupportedFields: ['webgpu', 'webgl.context'],
      webgpuAdapterAvailable: false,
    })).toEqual({
      acceleration: 'unavailable',
      fallbackReason: 'no_usable_graphics_api',
      unsupportedFields: ['webgpu', 'webgl.context'],
    });
  });
});

describe('graphics probes', () => {
  it('attempts WebGPU first and uses adapter.info when available', async () => {
    const calls: string[] = [];
    const canvas = createCanvasHarness((kind, attributes) => {
      calls.push(`${kind}:${attributes?.failIfMajorPerformanceCaveat ? 'strict' : 'fallback'}`);
      if (kind === 'webgl2' && attributes?.failIfMajorPerformanceCaveat) {
        return new FakeWebGlContext('ANGLE (Apple, Apple M3 Pro, Metal)');
      }
      return null;
    });

    const result = await probeGraphicsEvidence({
      navigatorTarget: {
        gpu: {
          requestAdapter: vi.fn(async () => {
            calls.push('webgpu');
            return { info: { description: 'Apple M3 Pro' } };
          }),
        },
      },
      createCanvas: canvas.createCanvas,
    });

    expect(calls[0]).toBe('webgpu');
    expect(canvas.requests).toEqual([
      { kind: 'webgl2', attributes: STRICT_WEBGL_CONTEXT_ATTRIBUTES },
    ]);
    expect(result).toEqual({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Apple M3 Pro',
      webgpuAdapterInfoSource: 'adapter.info',
      strictContext: 'webgl2',
      renderer: 'ANGLE (Apple, Apple M3 Pro, Metal)',
      unsupportedFields: [],
    });
  });

  it('falls back to requestAdapterInfo and uses ordinary contexts only after strict failures', async () => {
    const canvas = createCanvasHarness((kind, attributes) => {
      if (attributes?.failIfMajorPerformanceCaveat) return null;
      if (kind === 'webgl') return new FakeWebGlContext(null, false);
      return null;
    });

    const requestAdapterInfo = vi.fn(async () => ({ description: 'Intel Arc A770' }));
    const result = await probeGraphicsEvidence({
      navigatorTarget: {
        gpu: {
          requestAdapter: async () => ({ requestAdapterInfo }),
        },
      },
      createCanvas: canvas.createCanvas,
    });

    expect(requestAdapterInfo).toHaveBeenCalledTimes(1);
    expect(canvas.requests).toEqual([
      { kind: 'webgl2', attributes: STRICT_WEBGL_CONTEXT_ATTRIBUTES },
      { kind: 'webgl', attributes: STRICT_WEBGL_CONTEXT_ATTRIBUTES },
      { kind: 'webgl2', attributes: undefined },
      { kind: 'webgl', attributes: undefined },
    ]);
    expect(result).toEqual({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Intel Arc A770',
      webgpuAdapterInfoSource: 'requestAdapterInfo',
      fallbackContext: 'webgl',
      unsupportedFields: ['webgl.strictContext', 'webgl.debugRendererInfo', 'webgl.renderer'],
    });
  });

  it('does not promote identifier-only WebGPU descriptions or devices to adapter evidence', async () => {
    const result = await probeGraphicsEvidence({
      navigatorTarget: {
        gpu: {
          requestAdapter: async () => ({
            info: { description: '0x10de', device: '0x2484' },
          }),
        },
      },
      createCanvas: () => null,
    });

    expect(result).toEqual({
      webgpuAdapterAvailable: true,
      unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
    });
    expect(classifyGraphicsEvidence(result)).toEqual({
      acceleration: 'unknown',
      fallbackReason: 'webgpu_adapter_info_unavailable',
      supportingProbe: 'webgpu',
      unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
    });
  });

  it('records renderer access failures without discarding the usable strict context', async () => {
    const canvas = createCanvasHarness((kind, attributes) => {
      if (kind !== 'webgl2' || !attributes?.failIfMajorPerformanceCaveat) return null;
      return {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => {
          throw new Error('renderer access denied');
        },
      };
    });

    await expect(probeGraphicsEvidence({
      navigatorTarget: {},
      createCanvas: canvas.createCanvas,
    })).resolves.toEqual({
      webgpuAdapterAvailable: false,
      strictContext: 'webgl2',
      unsupportedFields: ['webgpu', 'webgl.renderer'],
    });
  });
});

describe('runtime graphics startup wiring', () => {
  it('re-exports the typed classifier, probe, and merge helpers from runtime-entry', () => {
    expect(classifyGraphicsEvidenceFromEntry).toBe(classifyGraphicsEvidence);
    expect(probeGraphicsEvidenceFromEntry).toBe(probeGraphicsEvidence);
    expect(mergeRuntimeGraphicsReportFromEntry).toBe(mergeRuntimeGraphicsReport);
  });

  it('logs one structured startup summary per startup state', async () => {
    const startupState = createRuntimeGraphicsStartupState();
    const log = vi.fn();
    const invoke = vi.fn(async () => ({
      os: 'macos',
      arch: 'aarch64',
      engine: 'WKWebView',
      engineVersion: undefined,
      debugBuild: true,
      stressAuthorized: false,
    }));

    const canvas = createCanvasHarness((kind, attributes) => {
      if (kind === 'webgl2' && attributes?.failIfMajorPerformanceCaveat) {
        return new FakeWebGlContext('ANGLE (Apple, Apple M3 Pro, Metal)');
      }
      return null;
    });

    const first = ensureRuntimeGraphicsStartupSummary({
      invoke,
      log,
      navigatorTarget: {},
      createCanvas: canvas.createCanvas,
    }, startupState);
    const second = ensureRuntimeGraphicsStartupSummary({
      invoke,
      log,
      navigatorTarget: {},
      createCanvas: canvas.createCanvas,
    }, startupState);

    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[psyche:graphics]', {
      os: 'macos',
      arch: 'aarch64',
      engine: 'WKWebView',
      acceleration: 'accelerated',
      backend: 'Metal',
      adapter: 'Apple M3 Pro',
      supportingProbe: 'webgl2',
      unsupportedFields: ['webgpu'],
    });
    expect(firstReport).toEqual(secondReport);
  });

  it('reports startup collection failures without rejecting application startup', async () => {
    const startupState = createRuntimeGraphicsStartupState();
    const failure = new Error('runtime diagnostics unavailable');
    const reportError = vi.fn();

    await expect(ensureRuntimeGraphicsStartupSummary({
      invoke: async () => {
        throw failure;
      },
      reportError,
      navigatorTarget: {},
      createCanvas: () => null,
    }, startupState)).resolves.toBeNull();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure, 'collect runtime graphics report');
  });

  it('reports malformed native runtime facts instead of failing silently', async () => {
    const startupState = createRuntimeGraphicsStartupState();
    const reportError = vi.fn();

    await expect(ensureRuntimeGraphicsStartupSummary({
      invoke: async () => ({ os: 'macos' }),
      reportError,
      navigatorTarget: {},
      createCanvas: () => null,
    }, startupState)).resolves.toBeNull();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'runtime_diagnostics returned invalid runtime graphics facts',
      }),
      'collect runtime graphics report',
    );
  });

  it('keeps the runtime source and committed bundle wired to the startup summary', () => {
    const runtimeEntry = readFileSync(runtimeEntryPath, 'utf8');
    const runtimeBundle = readFileSync(runtimeBundlePath, 'utf8');

    expect(runtimeEntry).toContain('export {');
    expect(runtimeEntry).toContain('classifyGraphicsEvidence');
    expect(runtimeEntry).toContain('probeGraphicsEvidence');
    expect(runtimeEntry).toContain('mergeRuntimeGraphicsReport');
    expect(runtimeEntry).toContain('ensureRuntimeGraphicsStartupSummary');
    expect(runtimeEntry).toContain('void ensureRuntimeGraphicsStartupSummary();');

    expect(runtimeBundle).toContain('[psyche:graphics]');
    expect(runtimeBundle).toContain('runtime_diagnostics');
    expect(runtimeBundle).toContain('failIfMajorPerformanceCaveat');
  });
});
