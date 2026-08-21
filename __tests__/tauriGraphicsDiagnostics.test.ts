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
  buildGraphicsDiagnosticsView as buildGraphicsDiagnosticsViewFromEntry,
  classifyGraphicsEvidence as classifyGraphicsEvidenceFromEntry,
  createPerformanceMetricsCollector as createPerformanceMetricsCollectorFromEntry,
  FRAME_SAMPLE_LIMIT as frameSampleLimitFromEntry,
  formatDiagnosticsStressProgress as formatDiagnosticsStressProgressFromEntry,
  mergeRuntimeGraphicsReport as mergeRuntimeGraphicsReportFromEntry,
  probeGraphicsEvidence as probeGraphicsEvidenceFromEntry,
  serializeGraphicsDiagnosticsSnapshot as serializeGraphicsDiagnosticsSnapshotFromEntry,
  summarizeFrames as summarizeFramesFromEntry,
} from '../native/desktop/psyche-build-tauri/web/runtime/runtime-entry';
import {
  FRAME_SAMPLE_LIMIT,
  createPerformanceMetricsCollector,
  summarizeFrames,
} from '../native/desktop/psyche-build-tauri/web/runtime/performance-metrics';
import {
  buildGraphicsDiagnosticsView,
  serializeGraphicsDiagnosticsSnapshot,
} from '../native/desktop/psyche-build-tauri/web/runtime/diagnostics-surface';

const runtimeEntryPath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts',
);
const runtimeBundlePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/runtime.bundle.js',
);
const webRoot = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web',
);

function functionSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const functionStart = asyncStart === -1 ? start : asyncStart;
  if (functionStart === -1) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', functionStart);
  let depth = 0;
  let quote: string | null = null;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(functionStart, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  name: string,
  dependencies: Record<string, unknown>,
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${functionSource(source, name)});`,
  )(...Object.values(dependencies)) as T;
}

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

  it('rejects unprefixed NVIDIA identifier pairs across WebGPU, raw WebGL, and ANGLE', () => {
    for (const adapter of [
      'NVIDIA 10DE 2684',
      'NVIDIA Controller 10DE 2684',
      'NVIDIA VGA Controller 10DE 2684',
      'NVIDIA Controller 10DE-2684',
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: adapter,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: adapter,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${adapter}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), adapter).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('rejects complete NVIDIA identifier sequences across WebGPU, raw WebGL, and ANGLE', () => {
    for (const adapter of [
      'NVIDIA 10DE 2684 1458',
      'NVIDIA Controller 10DE 2684 1458',
      'NVIDIA VGA Controller 10DE 2684 1458',
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: adapter,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: adapter,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${adapter}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), adapter).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('rejects mixed-prefixed NVIDIA identifier sequences across WebGPU, raw WebGL, and ANGLE', () => {
    for (const adapter of [
      'NVIDIA 10DE 0x2684',
      'NVIDIA Controller 10DE 0x2684',
      'NVIDIA VGA Controller 0x10DE 2684 0x1458',
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: adapter,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: adapter,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${adapter}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), adapter).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('strips unprefixed identifier pairs from named adapters without rejecting the product', () => {
    for (const adapter of [
      'NVIDIA GeForce RTX 4090 10DE 2684',
      'NVIDIA GeForce RTX 4090 10DE-2684',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter: 'NVIDIA GeForce RTX 4090',
        supportingProbe: 'webgpu',
      });
    }
  });

  it('preserves contextual alphanumeric models before contiguous identifier sequences', () => {
    for (const { value, adapter } of [
      { value: 'NVIDIA A100 10DE 20B0', adapter: 'NVIDIA A100' },
      { value: 'Intel A770 8086 56A0', adapter: 'Intel A770' },
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: value,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: value,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (${value.split(' ')[0]}, ${value}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), value).toMatchObject({
          acceleration: 'accelerated',
          adapter,
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
        });
      }
    }

    for (const probe of [
      {
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: 'NVIDIA ABCD 10DE 20B0',
        unsupportedFields: [],
      },
      {
        strictContext: 'webgl2' as const,
        renderer: 'NVIDIA ABCD 10DE 20B0',
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
      {
        strictContext: 'webgl2' as const,
        renderer: 'ANGLE (NVIDIA, NVIDIA ABCD 10DE 20B0, OpenGL)',
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
    ]) {
      expect(classifyGraphicsEvidence(probe)).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
    }
  });

  it('does not infer unknown shape-only models before GPU ID sequences across every graphics path', () => {
    const probes = [
      {
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: 'NVIDIA GPU A123 10DE 2684',
        unsupportedFields: [],
      },
      {
        strictContext: 'webgl2' as const,
        renderer: 'NVIDIA GPU A123 10DE 2684',
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
      {
        strictContext: 'webgl2' as const,
        renderer: 'ANGLE (NVIDIA, NVIDIA GPU A123 10DE 2684, OpenGL)',
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
    ];

    for (const probe of probes) {
      expect(classifyGraphicsEvidence(probe)).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
    }
  });

  it('strips complete multi-token device labels before validating named products across every graphics path', () => {
    const product = 'NVIDIA GeForce RTX 4090';
    const probes = [
      {
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: `${product} Device ID: 10DE 2684`,
        unsupportedFields: [],
      },
      {
        strictContext: 'webgl2' as const,
        renderer: `${product} Device ID: 10DE 2684`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
      {
        strictContext: 'webgl2' as const,
        renderer: `ANGLE (NVIDIA, ${product} Device ID: 10DE 2684, OpenGL)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
    ];

    for (const probe of probes) {
      expect(classifyGraphicsEvidence(probe)).toMatchObject({
        acceleration: 'accelerated',
        adapter: product,
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
      if (probe.renderer?.startsWith('ANGLE')) {
        expect(classifyGraphicsEvidence(probe).backend).toBe('OpenGL');
      }
    }
  });

  it('strips complete mixed identifier sequences from named adapters across every path', () => {
    const probes = [
      {
        probe: {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: 'NVIDIA H100 10DE 0x2684',
          unsupportedFields: [],
        },
        adapter: 'NVIDIA H100',
      },
      {
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'NVIDIA H100 10DE 0x2684',
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        adapter: 'NVIDIA H100',
      },
      {
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'ANGLE (NVIDIA, NVIDIA H100 10DE 0x2684, OpenGL)',
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        adapter: 'NVIDIA H100',
        backend: 'OpenGL',
      },
      {
        probe: {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: 'Intel Arc A770 8086 0x56A0',
          unsupportedFields: [],
        },
        adapter: 'Intel Arc A770',
      },
      {
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'ANGLE (Intel, Intel Arc A770 8086 0x56A0, Vulkan 1.3)',
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        adapter: 'Intel Arc A770',
        backend: 'Vulkan',
      },
      {
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'Intel Arc A770 8086 0x56A0',
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        adapter: 'Intel Arc A770',
      },
      {
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 10DE 0x2684 1458-1A2B Direct3D11 vs_5_0 ps_5_0, D3D11)',
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        adapter: 'NVIDIA GeForce RTX 4090',
      },
    ];

    for (const { probe, adapter, backend } of probes) {
      const classification = classifyGraphicsEvidence(probe);
      expect(classification).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
      if (backend) expect(classification.backend).toBe(backend);
    }
  });

  it('strips identifier sequences of any length from named adapters', () => {
    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'NVIDIA GeForce RTX 4090 10DE-2684 1458-1A2B',
      unsupportedFields: [],
    })).toMatchObject({
      acceleration: 'accelerated',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgpu',
    });
  });

  it('preserves legitimate single-token GPU model identifiers', () => {
    for (const adapter of ['Intel Arc A770', 'NVIDIA H100']) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }
  });

  it('strips ancillary device identifiers from named ANGLE and WebGPU adapters', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Direct3D',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'NVIDIA GeForce RTX 4090 (0x00002684)',
      unsupportedFields: [],
    })).toMatchObject({
      acceleration: 'accelerated',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgpu',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'NVIDIA GeForce RTX 4090 (0x00002684) OpenGL Engine',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'OpenGL',
      adapter: 'NVIDIA GeForce RTX 4090',
      supportingProbe: 'webgl2',
    });
  });

  it('strips complete device ID labels from named adapters across every adapter path', () => {
    const adapter = 'NVIDIA GeForce RTX 4090';
    const probes = [
      {
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: `${adapter} Device ID: 0x2684`,
        unsupportedFields: [],
      },
      {
        strictContext: 'webgl2' as const,
        renderer: `${adapter} Device ID: 0x2684 OpenGL Engine`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
      {
        strictContext: 'webgl2' as const,
        renderer: `ANGLE (NVIDIA, ${adapter} Device ID: 0x2684, OpenGL)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
    ];

    for (const probe of probes) {
      const classification = classifyGraphicsEvidence(probe);
      expect(classification).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
      if (!probe.webgpuAdapterAvailable) expect(classification.backend).toBe('OpenGL');
    }
  });

  it('removes generic trailing ANGLE version segments from adapter names', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'accelerated',
      backend: 'Metal',
      adapter: 'Apple M2',
      supportingProbe: 'webgl2',
    });
  });

  it('rejects vendor generic descriptors with ancillary identifiers on WebGPU, raw WebGL, and ANGLE paths', () => {
    const genericDescriptorValues = [
      'VGA',
      '3D',
      'Video',
      'Display',
      'Compatible',
      'Compatibility',
      'Controller',
    ].map((descriptor) => `NVIDIA ${descriptor} (0x00002684)`);

    for (const value of [
      ...genericDescriptorValues,
      'NVIDIA VGA Compatible Controller (0x00002684)',
      'NVIDIA 3D Video Display Controller (0x00002684)',
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: value,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: value,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), value).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
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

  it('does not treat backend and API family descriptors as product adapters', () => {
    const backendApiOnlyValues = [
      'WebGPU API',
      'WebGL Backend',
      'DirectX Runtime 12',
      'WebGPU',
      'WebGL',
      'WebGL2',
      'DirectX',
      'Direct3D',
      'D3D',
      'D3D11',
      'D3D12',
      'OpenGL',
      'Vulkan',
      'Metal',
      'ANGLE',
    ];

    for (const value of backendApiOnlyValues) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${value}, OpenGL)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });
    }

    for (const adapter of [
      'NVIDIA GeForce RTX 4090 WebGPU API',
      'Intel Arc A770 WebGL Backend',
      'AMD Radeon Pro 560X DirectX Runtime 12',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }
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

  it('rejects vendor-only, generic-only, and identifier-only evidence on every adapter path', () => {
    const ambiguousValues = [
      'NVIDIA',
      'Intel',
      'ANGLE Renderer',
      'Generic GPU',
      '0x10de 0x2484',
      'PCI 10de:2484',
      'DEV_2484',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects mixed vendor and hardware identifier syntax on every adapter path', () => {
    const mixedIdentifierValues = [
      'NVIDIA 10DE:2484',
      'NVIDIA VEN=10DE DEV=2484',
      'PCI\\VEN_10DE&DEV_2484&SUBSYS_00000000',
    ];

    for (const value of mixedIdentifierValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (NVIDIA, ${value}, D3D11)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects generic descriptors and backend versions on every adapter path', () => {
    const ambiguousValues = [
      'High Performance GPU',
      'Vulkan API 1.3',
      'NVIDIA Windows Display Driver',
      'NVIDIA High Performance',
      'Intel Integrated GPU',
      'AMD Discrete Desktop',
      'Default Vulkan API',
      'Linux macOS Windows',
      'Vulkan Runtime 1.3',
      'NVIDIA Windows Display Driver Version 555',
      'High Performance GPU Mode',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (NVIDIA, ${value}, Vulkan 1.3)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });

      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });
    }
  });

  it('requires a meaningful product token after removing the full generic descriptor vocabulary', () => {
    const genericVocabularyValues = [
      'Runtime',
      'Version',
      'Mode',
      'Implementation',
      'Engine',
      'Platform',
      'System',
      'Native',
      'Hardware',
      'Acceleration',
      'Accelerated',
      'Rendering',
      'Render',
      'Direct',
      'Compatibility',
      'Compatible',
      'Standard',
      'Basic',
      'Generic',
      'Default',
      'High',
      'Low',
      'Power',
      'Performance',
      'API',
      'Driver',
      'Display',
      'Windows',
      'macOS',
      'Linux',
      'Android',
      'iOS',
    ];

    for (const value of genericVocabularyValues) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });
    }

    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'NVIDIA GeForce RTX 4090',
      unsupportedFields: [],
    })).toMatchObject({
      acceleration: 'accelerated',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11, D3D11)',
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'software',
      adapter: 'Microsoft Basic Render Driver',
      fallbackReason: 'software_renderer_detected',
    });
  });

  it('preserves meaningful products alongside generic descriptors', () => {
    for (const adapter of [
      'NVIDIA GeForce RTX 4090 High Performance',
      'Intel Arc A770 Discrete GPU',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }
  });

  it('requires product evidence after the final entity suffix across WebGPU, raw WebGL, and ANGLE', () => {
    const cases = [
      {
        name: 'WebGPU entity-only evidence',
        probe: {
          webgpuAdapterAvailable: true,
          webgpuAdapter: 'Acme Corporation',
          unsupportedFields: [],
        },
      },
      {
        name: 'raw WebGL entity-only evidence',
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'Acme Corporation',
          unsupportedFields: [],
          webgpuAdapterAvailable: false,
        },
      },
      {
        name: 'ANGLE entity-only evidence',
        probe: {
          strictContext: 'webgl2' as const,
          renderer: 'ANGLE (Google, Acme Corporation, OpenGL)',
          unsupportedFields: [],
          webgpuAdapterAvailable: false,
        },
      },
    ];

    for (const { name, probe } of cases) {
      expect(classifyGraphicsEvidence(probe), name).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
        unsupportedFields: [],
      });
    }

    for (const adapter of [
      'Acme Corporation TurboChip X1',
      'Qualcomm Technologies Inc Adreno 740',
      'Advanced Micro Devices Inc Radeon RX 7900 XTX',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }

    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'RadeonRX7900XTX',
      unsupportedFields: [],
    })).toMatchObject({
      acceleration: 'accelerated',
      adapter: 'RadeonRX7900XTX',
      supportingProbe: 'webgpu',
    });
  });

  it('rejects lone unknown words and concatenated entity-only names across every adapter path', () => {
    const ambiguousValues = ['Acme', 'AcmeCorporation', 'AcmeLLC'];
    const probes = [
      (adapter: string) => ({
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      }),
      (renderer: string) => ({
        strictContext: 'webgl2' as const,
        renderer,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      }),
      (adapter: string) => ({
        strictContext: 'webgl2' as const,
        renderer: `ANGLE (Google, ${adapter}, OpenGL)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      }),
    ];

    for (const value of ambiguousValues) {
      for (const createProbe of probes) {
        const probe = createProbe(value);
        expect(classifyGraphicsEvidence(probe), value).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('rejects lone graphics product-family words across every adapter path', () => {
    const probes = [
      (adapter: string) => ({
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      }),
      (renderer: string) => ({
        strictContext: 'webgl2' as const,
        renderer,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      }),
      (adapter: string) => ({
        strictContext: 'webgl2' as const,
        renderer: `ANGLE (Google, ${adapter}, OpenGL)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      }),
    ];

    for (const value of ['GeForce', 'Radeon', 'Arc']) {
      for (const createProbe of probes) {
        const probe = createProbe(value);
        expect(classifyGraphicsEvidence(probe), value).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('rejects concrete generic and compact identifier examples on raw WebGL, ANGLE, and WebGPU paths', () => {
    const ambiguousValues = [
      'NVIDIA Driver',
      'NVIDIA Corporation',
      'NVIDIA VendorID 10DE',
      'NVIDIA VendorID10DE',
      'NVIDIA DeviceID2484',
      'NVIDIA VEN10DE',
      'NVIDIA DEV2484',
      'NVIDIA VEN10DE DEV2484',
      'NVIDIA SUBSYS00000000',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects NVIDIA backend/frontend descriptors and labeled identifiers on raw WebGL, ANGLE, and WebGPU paths', () => {
    const ambiguousValues = [
      'NVIDIA Backend',
      'NVIDIA Frontend',
      ...['VID', 'PID', 'DID', 'LUID', 'UUID'].flatMap((label) => [
        `NVIDIA ${label}10DE`,
        `NVIDIA ${label}_10DE`,
        `NVIDIA ${label}=10DE`,
        `NVIDIA ${label}:10DE`,
        `NVIDIA ${label}-10DE`,
        `NVIDIA ${label} 10DE`,
      ]),
      'NVIDIA VID_10DE PID_2484',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects compact and punctuated identifier labels without matching embedded vendor-name text', () => {
    const ambiguousValues = [
      'NVIDIA VID/10DE',
      'NVIDIA UUID{550e8400-e29b-41d4-a716-446655440000}',
      'NVIDIA PCI10DE',
      'NVIDIA Vendor ID({10DE})',
      'NVIDIA Device ID::2484',
      'NVIDIA SUBSYS.00000000',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }

    for (const adapter of [
      'NVIDIA GeForce RTX 4090',
      'NVIDIA PCIe 4.0 GeForce RTX 4090',
      'Intel Arc A770',
      'AMD Radeon Pro 560X',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }
  });

  it('rejects compact and separated vendor/device identifier labels across graphics paths', () => {
    const ambiguousValues = [
      'NVIDIA VendorIdentifier10DE',
      'NVIDIA DeviceIdentifier2484',
      'NVIDIA Vendor Identifier 10DE',
      'NVIDIA Device Identifier 2484',
    ];

    for (const value of ambiguousValues) {
      const probes = [
        {
          strictContext: 'webgl2' as const,
          renderer: value,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: value,
          unsupportedFields: [],
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), value).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }

    const product = 'NVIDIA GeForce RTX 4090';
    for (const label of [
      'VendorIdentifier10DE',
      'DeviceIdentifier2484',
      'Vendor Identifier 10DE',
      'Device Identifier 2484',
    ]) {
      for (const probe of [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: `${product} ${label}`,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `${product} ${label} OpenGL Engine`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${product} ${label}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ]) {
        expect(classifyGraphicsEvidence(probe), label).toMatchObject({
          acceleration: 'accelerated',
          adapter: product,
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
        });
      }
    }
  });

  it('rejects vendor and generic adapters with embedded UUIDs across WebGPU, raw WebGL, and ANGLE', () => {
    for (const value of [
      'NVIDIA {550e8400-e29b-41d4-a716-446655440000}',
      'Generic GPU {550e8400-e29b-41d4-a716-446655440000}',
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: value,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: value,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (Google, ${value}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), value).toEqual({
          acceleration: 'unknown',
          fallbackReason: 'renderer_masked_or_ambiguous',
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
          unsupportedFields: [],
        });
      }
    }
  });

  it('strips embedded and labeled UUIDs from named products across WebGPU, raw WebGL, and ANGLE', () => {
    const product = 'NVIDIA GeForce RTX 4090';
    for (const value of [
      `${product} {550e8400-e29b-41d4-a716-446655440000}`,
      `${product} UUID: {550e8400-e29b-41d4-a716-446655440000}`,
    ]) {
      const probes = [
        {
          webgpuAdapterAvailable: true as const,
          webgpuAdapter: value,
          unsupportedFields: [],
        },
        {
          strictContext: 'webgl2' as const,
          renderer: value,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
        {
          strictContext: 'webgl2' as const,
          renderer: `ANGLE (NVIDIA, ${value}, OpenGL)`,
          unsupportedFields: [],
          webgpuAdapterAvailable: false as const,
        },
      ];

      for (const probe of probes) {
        expect(classifyGraphicsEvidence(probe), value).toMatchObject({
          acceleration: 'accelerated',
          adapter: product,
          supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
        });
      }
    }
  });

  it('strips both IDs from AMD Radeon RX 7900 XTX identifier sequences across every path', () => {
    const value = 'AMD Radeon RX 7900 XTX 1002 744C';
    const probes = [
      {
        webgpuAdapterAvailable: true as const,
        webgpuAdapter: value,
        unsupportedFields: [],
      },
      {
        strictContext: 'webgl2' as const,
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
      {
        strictContext: 'webgl2' as const,
        renderer: `ANGLE (AMD, ${value}, Vulkan 1.3)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false as const,
      },
    ];

    for (const probe of probes) {
      expect(classifyGraphicsEvidence(probe), value).toMatchObject({
        acceleration: 'accelerated',
        adapter: 'AMD Radeon RX 7900 XTX',
        supportingProbe: probe.webgpuAdapterAvailable ? 'webgpu' : 'webgl2',
      });
    }
  });

  it('rejects organization-only and implementation-only names on raw WebGL, ANGLE, and WebGPU paths', () => {
    for (const value of ['Google LLC', 'NVIDIA Display Driver']) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects expanded AMD entity-only evidence on raw WebGL, ANGLE, and WebGPU paths', () => {
    const value = 'Advanced Micro Devices, Inc.';

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: value,
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'unknown',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: `ANGLE (AMD, ${value}, OpenGL)`,
      unsupportedFields: [],
      webgpuAdapterAvailable: false,
    })).toMatchObject({
      acceleration: 'unknown',
      supportingProbe: 'webgl2',
    });

    expect(classifyGraphicsEvidence({
      webgpuAdapterAvailable: true,
      webgpuAdapter: value,
      unsupportedFields: [],
    })).toMatchObject({
      acceleration: 'unknown',
      supportingProbe: 'webgpu',
    });
  });

  it('rejects known vendor entity aliases without product tokens', () => {
    for (const value of [
      'Advanced Micro Devices, Inc.',
      'ATI Technologies',
      'NVIDIA Corporation',
      'Intel Corporation',
      'Apple Inc.',
      'Google Inc.',
      'Google LLC',
      'Qualcomm Technologies',
      'ARM Ltd.',
      'ARM Limited',
      'Imagination Technologies',
      'Microsoft Corporation',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });
    }
  });

  it('rejects concatenated descriptor identifiers and bare UUIDs on WebGPU, raw WebGL, and ANGLE paths', () => {
    const ambiguousValues = [
      'WebGPUBackend',
      'VulkanRuntime',
      'NVIDIADriver',
      '550e8400-e29b-41d4-a716-446655440000',
      '{550e8400-e29b-41d4-a716-446655440000}',
      '550E8400-E29B-41D4-A716-446655440000',
    ];

    for (const value of ambiguousValues) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${value}, Vulkan 1.3)`,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
      });

      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
      });
    }
  });

  it('preserves concatenated named product identifiers', () => {
    for (const adapter of [
      'GeForceRTX4090',
      'RadeonRX7900XTX',
      'IntelArcA770',
      'AppleM3',
      'MaliG715',
      'Adreno740',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
      });
    }
  });

  it('keeps expanded vendor entities when followed by a meaningful product', () => {
    for (const adapter of [
      'Advanced Micro Devices, Inc. Radeon RX 7900 XTX',
      'ANGLE (AMD, Advanced Micro Devices, Inc. Radeon RX 7900 XTX, Vulkan 1.3)',
    ]) {
      const evidence = adapter.startsWith('ANGLE')
        ? {
            strictContext: 'webgl2' as const,
            renderer: adapter,
            unsupportedFields: [],
            webgpuAdapterAvailable: false,
          }
        : {
            webgpuAdapterAvailable: true,
            webgpuAdapter: adapter,
            unsupportedFields: [],
          };

      expect(classifyGraphicsEvidence(evidence)).toMatchObject({
        acceleration: 'accelerated',
      });
    }
  });

  it('rejects vendor plus numeric identifiers on raw WebGL, ANGLE, and WebGPU paths', () => {
    for (const value of ['NVIDIA 0x10de', 'NVIDIA 123456']) {
      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: value,
        unsupportedFields: [],
        webgpuAdapterAvailable: false,
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgl2',
        unsupportedFields: [],
      });

      expect(classifyGraphicsEvidence({
        strictContext: 'webgl2',
        renderer: `ANGLE (Google, ${value}, OpenGL)`,
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
        webgpuAdapter: value,
        unsupportedFields: [],
      })).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
        supportingProbe: 'webgpu',
        unsupportedFields: [],
      });
    }
  });

  it('rejects the complete vendor and generic-only token sets', () => {
    for (const vendor of [
      'NVIDIA',
      'AMD',
      'ATI',
      'Intel',
      'Apple',
      'Microsoft',
      'Google',
      'Qualcomm',
      'ARM',
      'Imagination',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: vendor,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
      });
    }

    for (const generic of [
      'ANGLE Renderer',
      'Generic GPU',
      'Generic Renderer',
      'GPU',
      'Renderer',
      'Graphics Adapter',
      'Default Adapter',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: generic,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'unknown',
        fallbackReason: 'renderer_masked_or_ambiguous',
      });
    }
  });

  it('preserves named products that contain vendor names', () => {
    for (const adapter of [
      'Apple M3',
      'NVIDIA GeForce RTX 4090',
      'NVIDIA GeForce RTX 4090 Backend',
      'NVIDIA Corporation GeForce RTX 4090',
      'Intel Arc A770',
      'Intel Arc A770 Frontend',
      'Intel UHD Graphics 630',
      'AMD Radeon Pro 560X',
      'Qualcomm Adreno 740',
      'Qualcomm Technologies, Inc. Adreno 740',
      'ARM Mali-G715',
    ]) {
      expect(classifyGraphicsEvidence({
        webgpuAdapterAvailable: true,
        webgpuAdapter: adapter,
        unsupportedFields: [],
      })).toMatchObject({
        acceleration: 'accelerated',
        adapter,
        supportingProbe: 'webgpu',
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
      acceleration: 'software',
      adapter: 'Microsoft Basic Render Driver',
      supportingProbe: 'webgl2',
      fallbackReason: 'software_renderer_detected',
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

  it('does not promote WebGPU software markers over strict WebGL hardware evidence', async () => {
    for (const webgpuDevice of [
      'SwiftShader',
      'llvmpipe',
      'Microsoft Basic Render Driver',
    ]) {
      const canvas = createCanvasHarness((kind, attributes) => {
        if (kind === 'webgl2' && attributes?.failIfMajorPerformanceCaveat) {
          return new FakeWebGlContext(
            'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090, Direct3D11)',
          );
        }
        return null;
      });

      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({
              info: {
                description: 'NVIDIA GeForce RTX 4090',
                device: webgpuDevice,
              },
            }),
          },
        },
        createCanvas: canvas.createCanvas,
      });

      expect(probe).toMatchObject({
        webgpuAdapterAvailable: true,
        webgpuAdapter: webgpuDevice,
        webgpuAdapterInfoSource: 'adapter.info',
        strictContext: 'webgl2',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090, Direct3D11)',
        unsupportedFields: [],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'conflicting_reliable_evidence',
        unsupportedFields: [],
      });
    }
  });

  it('preserves software device evidence when the WebGPU description is hardware', async () => {
    for (const webgpuDevice of [
      'SwiftShader',
      'llvmpipe',
      'Microsoft Basic Render Driver',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({
              info: {
                description: 'NVIDIA GeForce RTX 4090',
                device: webgpuDevice,
              },
            }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        webgpuAdapter: webgpuDevice,
        webgpuAdapterInfoSource: 'adapter.info',
        unsupportedFields: ['webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'software',
        adapter: webgpuDevice,
        supportingProbe: 'webgpu',
        fallbackReason: 'software_renderer_detected',
        unsupportedFields: ['webgl.context'],
      });
    }
  });

  it('preserves software markers from every WebGPU adapter-info text field', async () => {
    for (const field of ['vendor', 'architecture', 'device', 'description'] as const) {
      const info = {
        description: 'NVIDIA GeForce RTX 4090',
        device: 'NVIDIA GeForce RTX 4090',
        vendor: 'NVIDIA',
        architecture: 'Ada Lovelace',
        [field]: 'SwiftShader',
      };

      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe.webgpuAdapter).toBe('SwiftShader');
      expect(classifyGraphicsEvidence(probe)).toMatchObject({
        acceleration: 'software',
        adapter: 'SwiftShader',
        supportingProbe: 'webgpu',
        fallbackReason: 'software_renderer_detected',
      });
    }
  });

  it('classifies different reliable software adapters as software', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Vulkan 1.3 llvmpipe, Vulkan)',
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'SwiftShader',
      webgpuAdapterInfoSource: 'adapter.info',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'software',
      backend: 'Vulkan',
      adapter: 'llvmpipe',
      supportingProbe: 'webgl2',
      fallbackReason: 'software_renderer_detected',
      unsupportedFields: [],
    });

    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Vulkan 1.3 SwiftShader, Vulkan)',
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Microsoft Basic Render Driver',
      webgpuAdapterInfoSource: 'adapter.info',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'software',
      backend: 'Vulkan',
      adapter: 'SwiftShader',
      supportingProbe: 'webgl2',
      fallbackReason: 'software_renderer_detected',
      unsupportedFields: [],
    });
  });

  it('omits the backend when reliable software evidence disagrees', () => {
    expect(classifyGraphicsEvidence({
      strictContext: 'webgl2',
      renderer: 'ANGLE (Google, Vulkan 1.3 SwiftShader, Vulkan)',
      webgpuAdapterAvailable: true,
      webgpuAdapter: 'Microsoft Basic Render Driver Direct3D11',
      webgpuAdapterInfoSource: 'adapter.info',
      unsupportedFields: [],
    })).toEqual({
      acceleration: 'software',
      adapter: 'SwiftShader',
      supportingProbe: 'webgl2',
      fallbackReason: 'software_renderer_detected',
      unsupportedFields: [],
    });
  });

  it('uses the first software marker deterministically across WebGPU adapter fields', async () => {
    const probe = await probeGraphicsEvidence({
      navigatorTarget: {
        gpu: {
          requestAdapter: async () => ({
            info: {
              description: 'SwiftShader',
              device: 'llvmpipe',
              vendor: 'Microsoft Basic Render Driver',
              architecture: 'software rasterizer',
            },
          }),
        },
      },
      createCanvas: () => null,
    });

    expect(probe.webgpuAdapter).toBe('SwiftShader');
    expect(classifyGraphicsEvidence(probe)).toMatchObject({
      acceleration: 'software',
      adapter: 'SwiftShader',
      supportingProbe: 'webgpu',
      fallbackReason: 'software_renderer_detected',
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

  it('filters ambiguous WebGPU descriptions before they become adapter evidence', async () => {
    for (const description of [
      'NVIDIA',
      'Intel',
      'ANGLE Renderer',
      'Generic GPU',
      '0x10de 0x2484',
      'PCI 10de:2484',
      'DEV_2484',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info: { description } }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'webgpu_adapter_info_unavailable',
        supportingProbe: 'webgpu',
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
    }
  });

  it('filters generic descriptor and backend/version WebGPU descriptions', async () => {
    for (const description of [
      'High Performance GPU',
      'WebGPU API',
      'WebGL Backend',
      'DirectX Runtime 12',
      'Vulkan API 1.3',
      'NVIDIA Windows Display Driver',
      'Intel Integrated GPU',
      'AMD Discrete Desktop',
      'Vulkan Runtime 1.3',
      'NVIDIA Windows Display Driver Version 555',
      'High Performance GPU Mode',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info: { description } }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'webgpu_adapter_info_unavailable',
        supportingProbe: 'webgpu',
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
    }
  });

  it('filters mixed vendor and hardware identifier WebGPU descriptions', async () => {
    for (const description of [
      'NVIDIA 10DE:2484',
      'NVIDIA VEN=10DE DEV=2484',
      'PCI\\VEN_10DE&DEV_2484&SUBSYS_00000000',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info: { description } }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'webgpu_adapter_info_unavailable',
        supportingProbe: 'webgpu',
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
    }
  });

  it('filters concrete generic and compact identifier WebGPU descriptions', async () => {
    for (const description of [
      'NVIDIA Driver',
      'NVIDIA Corporation',
      'NVIDIA VendorID 10DE',
      'NVIDIA VendorID10DE',
      'NVIDIA DeviceID2484',
      'NVIDIA VEN10DE',
      'NVIDIA DEV2484',
      'NVIDIA VEN10DE DEV2484',
      'NVIDIA SUBSYS00000000',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info: { description } }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'webgpu_adapter_info_unavailable',
        supportingProbe: 'webgpu',
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
    }
  });

  it('filters punctuated and braced compact identifier WebGPU descriptions', async () => {
    for (const description of [
      'NVIDIA VID/10DE',
      'NVIDIA UUID{550e8400-e29b-41d4-a716-446655440000}',
      'NVIDIA PCI10DE',
    ]) {
      const probe = await probeGraphicsEvidence({
        navigatorTarget: {
          gpu: {
            requestAdapter: async () => ({ info: { description } }),
          },
        },
        createCanvas: () => null,
      });

      expect(probe).toEqual({
        webgpuAdapterAvailable: true,
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
      expect(classifyGraphicsEvidence(probe)).toEqual({
        acceleration: 'unknown',
        fallbackReason: 'webgpu_adapter_info_unavailable',
        supportingProbe: 'webgpu',
        unsupportedFields: ['webgpu.adapterInfo', 'webgl.context'],
      });
    }
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
    expect(createPerformanceMetricsCollectorFromEntry).toBe(createPerformanceMetricsCollector);
    expect(summarizeFramesFromEntry).toBe(summarizeFrames);
    expect(frameSampleLimitFromEntry).toBe(FRAME_SAMPLE_LIMIT);
    expect(buildGraphicsDiagnosticsViewFromEntry).toBe(buildGraphicsDiagnosticsView);
    expect(serializeGraphicsDiagnosticsSnapshotFromEntry)
      .toBe(serializeGraphicsDiagnosticsSnapshot);
    expect(formatDiagnosticsStressProgressFromEntry).toBeTypeOf('function');
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
    expect(runtimeEntry).toContain('createPerformanceMetricsCollector');
    expect(runtimeEntry).toContain('summarizeFrames');
    expect(runtimeEntry).toContain('FRAME_SAMPLE_LIMIT');
    expect(runtimeEntry).toContain('buildGraphicsDiagnosticsView');
    expect(runtimeEntry).toContain('serializeGraphicsDiagnosticsSnapshot');
    expect(runtimeEntry).toContain('formatDiagnosticsStressProgress');

    expect(runtimeBundle).toContain('[psyche:graphics]');
    expect(runtimeBundle).toContain('runtime_diagnostics');
    expect(runtimeBundle).toContain('failIfMajorPerformanceCaveat');
    expect(runtimeBundle).toContain('createPerformanceMetricsCollector');
    expect(runtimeBundle).toContain('summarizeFrames');
    expect(runtimeBundle).toContain('FRAME_SAMPLE_LIMIT');
    expect(runtimeBundle).toContain('buildGraphicsDiagnosticsView');
    expect(runtimeBundle).toContain('serializeGraphicsDiagnosticsSnapshot');
    expect(runtimeBundle).toContain('formatDiagnosticsStressProgress');
  });
});

describe('in-app graphics diagnostics surface', () => {
  const metrics = {
    sampledAt: 12_345,
    frames: {
      sampleCount: 120,
      averageMs: 16.2,
      p95Ms: 22.4,
      maxMs: 48.1,
      over16_7: 18,
      over33_4: 3,
      over50: 0,
      estimatedDroppedFrames: 4,
    },
    longTasks: {
      count: 2,
      totalMs: 84.5,
      maxMs: 51.25,
    },
    transport: {
      bytesPerSecond: 1_500_000,
      batchesPerSecond: 240,
      averageBatchBytes: 6_250,
      p95BatchBytes: 8_192,
      p95BatchIntervalMs: 5.5,
      queueBytesHighWater: 65_536,
      queueDepthHighWater: 8,
      blockedProducersHighWater: 2,
      backpressureCount: 3,
      averageAckLatencyMs: 1.25,
      maxAckLatencyMs: 4.75,
    },
    renderer: {
      coalescedVisualUpdates: 9,
      webglPanes: 5,
      recoveringPanes: 1,
      fallbackPanes: 2,
      rendererTransitions: 4,
      contextLosses: 1,
    },
    interactions: {
      focusToNextPaintMs: 18.5,
      resizeToNextPaintMs: 27.75,
    },
    process: {
      cpuPercent: 42.5,
      rssBytes: 536_870_912,
    },
  };

  it('renders every present graphics and Task 3 metric field without unsupported placeholders', () => {
    const view = buildGraphicsDiagnosticsView({
      graphics: {
        os: 'macos',
        arch: 'aarch64',
        engine: 'WKWebView',
        engineVersion: '18.6',
        acceleration: 'software',
        backend: 'Vulkan',
        adapter: 'SwiftShader',
        supportingProbe: 'webgl2',
        fallbackReason: 'software_renderer_detected',
        unsupportedFields: ['webgpu.adapterInfo'],
      },
      metrics,
    });

    expect(view.softwareFallback).toBe(true);
    expect(view.sections.map((section) => section.title)).toEqual([
      'Graphics',
      'Frame cadence',
      'Throughput',
      'IPC batching and distribution',
      'Queue and backpressure',
      'Renderer lifecycle',
      'Long tasks',
      'Interactions',
      'Process',
    ]);
    const rows = view.sections.flatMap((section) => section.rows);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Acceleration', value: 'Software fallback', tone: 'danger' }),
      expect.objectContaining({ label: 'Engine', value: 'WKWebView' }),
      expect.objectContaining({ label: 'Engine version', value: '18.6' }),
      expect.objectContaining({ label: 'Backend', value: 'Vulkan' }),
      expect.objectContaining({ label: 'Adapter', value: 'SwiftShader' }),
      expect.objectContaining({ label: 'Fallback reason', value: 'software renderer detected', tone: 'danger' }),
      expect.objectContaining({ label: 'Sample clock', value: '12345.00 ms' }),
      expect.objectContaining({ label: 'Frame p95', value: '22.40 ms' }),
      expect.objectContaining({ label: 'Bytes / second', value: '1.43 MiB/s' }),
      expect.objectContaining({ label: 'Batch p95', value: '8.00 KiB' }),
      expect.objectContaining({ label: 'Queue bytes high-water', value: '64.00 KiB' }),
      expect.objectContaining({ label: 'Fallback panes', value: '2', tone: 'danger' }),
      expect.objectContaining({ label: 'Long-task total', value: '84.50 ms' }),
      expect.objectContaining({ label: 'Focus to next paint', value: '18.50 ms' }),
      expect.objectContaining({ label: 'Process CPU', value: '42.50%' }),
      expect.objectContaining({ label: 'Process RSS', value: '512.00 MiB' }),
    ]));
    expect(rows.map((row) => row.label)).not.toContain('Unsupported fields');
    expect(rows.map((row) => row.value)).not.toContain('--');
  });

  it('omits optional graphics and metrics rows when their source fields are absent', () => {
    const view = buildGraphicsDiagnosticsView({
      graphics: {
        os: 'linux',
        arch: 'x86_64',
        engine: 'WebKitGTK',
        acceleration: 'accelerated',
        unsupportedFields: [],
      },
      metrics: {
        ...metrics,
        longTasks: undefined,
        transport: {
          ...metrics.transport,
          averageAckLatencyMs: undefined,
          maxAckLatencyMs: undefined,
        },
        interactions: {},
        process: undefined,
      },
    });

    const labels = view.sections.flatMap((section) => section.rows.map((row) => row.label));
    expect(view.softwareFallback).toBe(false);
    expect(labels).toContain('Acceleration');
    expect(labels).toContain('Engine');
    expect(labels).not.toContain('Engine version');
    expect(labels).not.toContain('Backend');
    expect(labels).not.toContain('Adapter');
    expect(labels).not.toContain('Fallback reason');
    expect(labels).not.toContain('Average acknowledgement');
    expect(labels).not.toContain('Maximum acknowledgement');
    expect(view.sections.map((section) => section.title)).not.toContain('Long tasks');
    expect(view.sections.map((section) => section.title)).not.toContain('Interactions');
    expect(view.sections.map((section) => section.title)).not.toContain('Process');
  });

  it('copies stable JSON from the raw graphics, metrics, and stress interfaces', () => {
    const progress = {
      scenarioIndex: 2,
      paneCount: 12 as const,
      phase: 'measure' as const,
      elapsedMs: 12_500,
      phaseDurationMs: 30_000,
    };
    const first = {
      graphics: {
        os: 'macos',
        arch: 'aarch64',
        engine: 'WKWebView',
        acceleration: 'accelerated' as const,
        backend: 'Metal' as const,
        adapter: 'Apple M3 Pro',
        unsupportedFields: [],
      },
      metrics,
      scenario: {
        state: 'running' as const,
        progress,
      },
    };
    const reordered = {
      scenario: {
        progress: {
          phaseDurationMs: 30_000,
          elapsedMs: 12_500,
          phase: 'measure' as const,
          paneCount: 12 as const,
          scenarioIndex: 2,
        },
        state: 'running' as const,
      },
      metrics: {
        process: metrics.process,
        interactions: metrics.interactions,
        renderer: metrics.renderer,
        transport: metrics.transport,
        longTasks: metrics.longTasks,
        frames: metrics.frames,
        sampledAt: metrics.sampledAt,
      },
      graphics: {
        unsupportedFields: [],
        adapter: 'Apple M3 Pro',
        backend: 'Metal' as const,
        acceleration: 'accelerated' as const,
        engine: 'WKWebView',
        arch: 'aarch64',
        os: 'macos',
      },
    };

    const json = serializeGraphicsDiagnosticsSnapshot(first);
    expect(json).toBe(serializeGraphicsDiagnosticsSnapshot(reordered));
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(first);
  });

  it('ships a hidden development-only titlebar action and accessible inert right panel', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');

    expect(html).toMatch(
      /id="graphics-diagnostics-toggle"[\s\S]*type="button"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-expanded="false"[\s\S]*aria-controls="graphics-diagnostics-panel"[\s\S]*hidden[\s\S]*disabled/,
    );
    expect(html).toMatch(
      /id="graphics-diagnostics-shell"[\s\S]*hidden[\s\S]*inert[\s\S]*id="graphics-diagnostics-panel"[\s\S]*role="dialog"[\s\S]*aria-modal="false"[\s\S]*aria-labelledby="graphics-diagnostics-title"/,
    );
    expect(html).toMatch(
      /id="graphics-diagnostics-progress-text"[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/,
    );
    expect(html).toMatch(
      /id="graphics-diagnostics-progress"[\s\S]*aria-label="Stress scenario phase progress"/,
    );
    expect(html).toMatch(
      /id="graphics-diagnostics-scenario"[\s\S]*hidden[\s\S]*inert[\s\S]*id="graphics-diagnostics-progress"[\s\S]*id="graphics-diagnostics-run"[\s\S]*id="graphics-diagnostics-cancel"/,
    );
    expect(html).toContain('id="graphics-diagnostics-copy"');
    expect(html).toContain('id="graphics-diagnostics-refresh"');
    expect(html).toContain('id="graphics-diagnostics-close"');
  });

  it('wires debug availability, live production metrics, deterministic copy, and accessible actions', () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const styles = readFileSync(resolve(webRoot, 'styles.css'), 'utf8');

    expect(main).toContain('async function installGraphicsDiagnosticsSurface()');
    expect(main).toContain('if (!report || report.debugBuild !== true) return null;');
    expect(main).toContain('ptyRuntime.ensureRuntimeGraphicsStartupSummary()');
    expect(main).toContain('ptyRuntime.createPerformanceMetricsCollector({');
    expect(main).toContain('ptyRuntime.buildGraphicsDiagnosticsView(');
    expect(main).toContain('ptyRuntime.serializeGraphicsDiagnosticsSnapshot(');
    expect(main).toContain('clipboardManager.writeText(json)');
    expect(main).toContain('reportGraphicsDiagnosticsFailure(');
    expect(main).toContain('clearGraphicsDiagnosticsFailure(');
    expect(main).toContain('graphicsDiagnosticsShellEl.inert = false;');
    expect(main).toContain('graphicsDiagnosticsShellEl.inert = true;');
    expect(main).toContain('beginCompositorTransition(graphicsDiagnosticsPanelEl)');
    expect(main).toContain('await installGraphicsDiagnosticsSurface();');
    expect(main).toContain('if (handleGraphicsDiagnosticsKeydown(event)) return;');
    expect(main).not.toContain(
      'document.addEventListener("keydown", handleGraphicsDiagnosticsKeydown, true);',
    );

    expect(styles).toMatch(
      /\.graphics-diagnostics-shell\s*\{[^}]*transition:\s*opacity\s+var\(--transition-fast\);/s,
    );
    expect(styles).toMatch(
      /\.graphics-diagnostics-panel\s*\{[^}]*transition-property:\s*transform,\s*opacity;[^}]*transition-duration:\s*var\(--transition-med\),\s*var\(--transition-fast\);/s,
    );
    expect(styles).not.toMatch(
      /\.graphics-diagnostics-[^{]+\{[^}]*(?:transition|animation)[^}]*(?:width|right|left|grid-template|flex-basis)/s,
    );
    expect(styles).toMatch(
      /\.graphics-diagnostics-status\[data-level="error"\]\s*\{[^}]*color:\s*#fecaca;/s,
    );
  });

  it('opens and closes with inert state, compositor hints, and focus restoration', () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const classes = new Set<string>();
    const toggle = {
      hidden: false,
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
      focus: vi.fn(),
    };
    const shell = {
      hidden: true,
      inert: true,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    };
    const panel = {};
    const close = { focus: vi.fn() };
    const transitions: unknown[] = [];
    const announcements: string[] = [];
    let closeTimer: () => void = () => undefined;
    const setOpen = compileFunction<(open: boolean) => boolean>(
      main,
      'setGraphicsDiagnosticsOpen',
      {
        graphicsDiagnosticsToggleEl: toggle,
        graphicsDiagnosticsShellEl: shell,
        graphicsDiagnosticsPanelEl: panel,
        graphicsDiagnosticsCloseEl: close,
        graphicsDiagnosticsOpen: false,
        graphicsDiagnosticsCloseTimer: 0,
        clearTimeout: vi.fn(),
        setTimeout: (callback: () => void) => {
          closeTimer = callback;
          return 1;
        },
        beginCompositorTransition: (element: unknown) => transitions.push(element),
        renderGraphicsDiagnosticsSurface: vi.fn(),
        window: { requestAnimationFrame: (callback: () => void) => callback() },
        toast: (message: string) => announcements.push(message),
      },
    );

    expect(setOpen(true)).toBe(true);
    expect(shell.hidden).toBe(false);
    expect(shell.inert).toBe(false);
    expect(classes.has('is-open')).toBe(true);
    expect(toggle.attributes.get('aria-expanded')).toBe('true');
    expect(close.focus).toHaveBeenCalledTimes(1);

    expect(setOpen(false)).toBe(true);
    expect(shell.inert).toBe(true);
    expect(classes.has('is-open')).toBe(false);
    expect(toggle.attributes.get('aria-expanded')).toBe('false');
    expect(toggle.focus).toHaveBeenCalledTimes(1);
    closeTimer();
    expect(shell.hidden).toBe(true);
    expect(transitions).toEqual([shell, panel, shell, panel]);
    expect(announcements).toEqual([
      'Graphics diagnostics opened',
      'Graphics diagnostics closed',
    ]);
  });

  it('records real production focus and resize interactions on their next paints', async () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const collector = createPerformanceMetricsCollector();
    const pendingFrames = new Map<number, (timestamp: number) => void>();
    const interactionState = {
      sequence: 0,
      focus: null,
      resize: null,
    };
    let nextFrame = 1;
    let now = 100;
    const windowFixture = {
      requestAnimationFrame(callback: (timestamp: number) => void) {
        const handle = nextFrame;
        nextFrame += 1;
        pendingFrames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle: number) {
        pendingFrames.delete(handle);
      },
    };
    const begin = compileFunction<(kind: 'focus' | 'resize') => number | null>(
      main,
      'beginGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        performance: { now: () => now },
        window: windowFixture,
      },
    );
    const cancel = compileFunction<(kind: 'focus' | 'resize', token: number | null) => void>(
      main,
      'cancelGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        window: windowFixture,
        clearGraphicsDiagnosticsFailure: vi.fn(),
        reportGraphicsDiagnosticsFailure: vi.fn(),
      },
    );
    const complete = compileFunction<
      (kind: 'focus' | 'resize', token: number | null, signal?: AbortSignal) => void
    >(
      main,
      'completeGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        window: windowFixture,
        cancelGraphicsDiagnosticsInteraction: cancel,
        clearGraphicsDiagnosticsFailure: vi.fn(),
        reportGraphicsDiagnosticsFailure: vi.fn(),
      },
    );
    const focus = compileFunction<(id: string, signal: AbortSignal) => Promise<void>>(
      main,
      'focusDiagnosticsStressSurface',
      {
        diagnosticsAbortReason: (signal: AbortSignal) => signal.reason,
        canvasSurfaceById: () => ({ id: 'editor', kind: 'files', hidden: false }),
        focusCanvasSurface: () => true,
        fileEditor: { focus: vi.fn() },
        awaitDiagnosticsOperation: vi.fn(),
        focusThread: vi.fn(),
        beginGraphicsDiagnosticsInteraction: begin,
        completeGraphicsDiagnosticsInteraction: complete,
        cancelGraphicsDiagnosticsInteraction: cancel,
      },
    );
    const layout = { root: { type: 'leaf', id: 'pane-1' } };
    const resize = compileFunction<
      (step: number, geometry: { sidebarWidth: number; splitRatios: number[] }) => void
    >(
      main,
      'applyDiagnosticsStressGeometry',
      {
        diagnosticsStressContext: { layoutKey: 'layout' },
        paneLayouts: new Map([['layout', layout]]),
        document: {
          documentElement: {
            style: { setProperty: vi.fn() },
          },
        },
        diagnosticsSplitIds: () => [],
        PsychePanes: { resizeSplit: vi.fn() },
        applyProjectedSplitRatios: () => true,
        renderPaneWorkspace: vi.fn(),
        beginGraphicsDiagnosticsInteraction: begin,
        completeGraphicsDiagnosticsInteraction: complete,
        cancelGraphicsDiagnosticsInteraction: cancel,
      },
    );
    const flush = (timestamp: number) => {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      callbacks.forEach((callback) => callback(timestamp));
    };

    await focus('editor', new AbortController().signal);
    expect(collector.snapshot().interactions).toEqual({});
    flush(140);

    now = 200;
    resize(0, { sidebarWidth: 320, splitRatios: [0.5] });
    expect(collector.snapshot().interactions).toEqual({ focusToNextPaintMs: 40 });
    flush(272);

    expect(collector.snapshot().interactions).toEqual({
      focusToNextPaintMs: 40,
      resizeToNextPaintMs: 72,
    });
    expect(pendingFrames.size).toBe(0);
  });

  it('correlates only the latest interaction and clears failed production records', async () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const collector = createPerformanceMetricsCollector();
    const pendingFrames = new Map<number, (timestamp: number) => void>();
    const interactionState = {
      sequence: 0,
      focus: null,
      resize: null,
    };
    let nextFrame = 1;
    let now = 100;
    const windowFixture = {
      requestAnimationFrame(callback: (timestamp: number) => void) {
        const handle = nextFrame;
        nextFrame += 1;
        pendingFrames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle: number) {
        pendingFrames.delete(handle);
      },
    };
    const begin = compileFunction<(kind: 'focus' | 'resize') => number | null>(
      main,
      'beginGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        performance: { now: () => now },
        window: windowFixture,
      },
    );
    const cancel = compileFunction<(kind: 'focus' | 'resize', token: number | null) => void>(
      main,
      'cancelGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        window: windowFixture,
      },
    );
    const complete = compileFunction<
      (kind: 'focus' | 'resize', token: number | null, signal?: AbortSignal) => void
    >(
      main,
      'completeGraphicsDiagnosticsInteraction',
      {
        graphicsDiagnosticsCollector: collector,
        graphicsDiagnosticsInteractions: interactionState,
        window: windowFixture,
        cancelGraphicsDiagnosticsInteraction: cancel,
        clearGraphicsDiagnosticsFailure: vi.fn(),
        reportGraphicsDiagnosticsFailure: vi.fn(),
      },
    );

    const first = begin('focus');
    complete('focus', first);
    now = 120;
    const second = begin('focus');
    complete('focus', second);
    expect(pendingFrames.size).toBe(1);
    [...pendingFrames.values()][0]?.(150);
    pendingFrames.clear();
    expect(collector.snapshot().interactions).toEqual({ focusToNextPaintMs: 30 });

    collector.reset();
    const failedFocus = compileFunction<(id: string, signal: AbortSignal) => Promise<void>>(
      main,
      'focusDiagnosticsStressSurface',
      {
        diagnosticsAbortReason: (signal: AbortSignal) => signal.reason,
        canvasSurfaceById: () => ({ id: 'editor', kind: 'files', hidden: false }),
        focusCanvasSurface: () => false,
        fileEditor: { focus: vi.fn() },
        awaitDiagnosticsOperation: vi.fn(),
        focusThread: vi.fn(),
        beginGraphicsDiagnosticsInteraction: begin,
        completeGraphicsDiagnosticsInteraction: complete,
        cancelGraphicsDiagnosticsInteraction: cancel,
      },
    );
    now = 200;
    await expect(failedFocus('editor', new AbortController().signal))
      .rejects.toThrow('failed to focus diagnostics editor');
    expect(pendingFrames.size).toBe(0);
    expect(collector.snapshot().interactions).toEqual({});

    const layout = { root: { type: 'leaf', id: 'pane-1' } };
    const resize = compileFunction<
      (
        step: number,
        geometry: { sidebarWidth: number; splitRatios: number[] },
        signal: AbortSignal,
      ) => void
    >(
      main,
      'applyDiagnosticsStressGeometry',
      {
        diagnosticsStressContext: { layoutKey: 'layout' },
        paneLayouts: new Map([['layout', layout]]),
        document: {
          documentElement: {
            style: { setProperty: vi.fn() },
          },
        },
        diagnosticsSplitIds: () => [],
        PsychePanes: { resizeSplit: vi.fn() },
        applyProjectedSplitRatios: () => true,
        renderPaneWorkspace: vi.fn(),
        beginGraphicsDiagnosticsInteraction: begin,
        completeGraphicsDiagnosticsInteraction: complete,
        cancelGraphicsDiagnosticsInteraction: cancel,
        diagnosticsAbortReason: (signal: AbortSignal) => signal.reason,
      },
    );
    const resizeController = new AbortController();
    resize(0, { sidebarWidth: 320, splitRatios: [0.5] }, resizeController.signal);
    expect(pendingFrames.size).toBe(1);
    resizeController.abort(new DOMException('cancelled', 'AbortError'));
    expect(pendingFrames.size).toBe(0);
    expect(collector.snapshot().interactions).toEqual({});
  });

  it('surfaces collection failures and clears the panel error after recovery', () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const failures = new Map<string, string>();
    const status = {
      textContent: '',
      dataset: {} as Record<string, string>,
    };
    const update = compileFunction<() => void>(
      main,
      'updateGraphicsDiagnosticsStatus',
      {
        graphicsDiagnosticsFailures: failures,
        graphicsDiagnosticsStatusEl: status,
        graphicsDiagnosticsHasEvidence: true,
      },
    );
    const alerts: string[] = [];
    const report = compileFunction<(key: string, message: string, error?: unknown) => void>(
      main,
      'reportGraphicsDiagnosticsFailure',
      {
        graphicsDiagnosticsFailures: failures,
        updateGraphicsDiagnosticsStatus: update,
        showStatusError: (message: string) => alerts.push(message),
        console: { warn: vi.fn() },
      },
    );
    const clear = compileFunction<(key: string) => void>(
      main,
      'clearGraphicsDiagnosticsFailure',
      {
        graphicsDiagnosticsFailures: failures,
        updateGraphicsDiagnosticsStatus: update,
      },
    );

    report('collection', 'Graphics diagnostics collection failed.', new Error('sample failed'));
    expect(status.textContent).toBe('Graphics diagnostics collection failed.');
    expect(status.dataset.level).toBe('error');
    expect(alerts).toEqual(['Graphics diagnostics collection failed.']);

    clear('collection');
    expect(status.textContent).toBe('Live diagnostics are updating.');
    expect(status.dataset.level).toBeUndefined();
  });

  it('routes snapshot, availability, and markup failures through diagnostics status', async () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const failures: Array<[string, string]> = [];
    const reportFailure = (key: string, message: string) => {
      failures.push([key, message]);
    };
    const clearFailure = vi.fn();
    const snapshot = compileFunction<() => Record<string, unknown>>(
      main,
      'graphicsDiagnosticsSnapshot',
      {
        graphicsDiagnosticsReport: null,
        graphicsDiagnosticsCollector: {
          snapshot() {
            throw new Error('metrics unavailable');
          },
        },
        runtimeDiagnosticsReport: null,
        runtimeStressHarness: null,
        reportGraphicsDiagnosticsFailure: reportFailure,
        clearGraphicsDiagnosticsFailure: clearFailure,
      },
    );

    expect(snapshot()).toEqual({});
    expect(failures.at(-1)).toEqual([
      'collection',
      'Graphics diagnostics metrics collection failed: Error: metrics unavailable',
    ]);

    const installUnavailable = compileFunction<() => Promise<unknown>>(
      main,
      'installGraphicsDiagnosticsSurface',
      {
        runtimeDiagnosticsReport: null,
        invoke: async () => {
          throw new Error('diagnostics command failed');
        },
        reportGraphicsDiagnosticsFailure: reportFailure,
      },
    );
    await expect(installUnavailable()).resolves.toBeNull();
    expect(failures.at(-1)).toEqual([
      'availability',
      'Graphics diagnostics availability check failed: Error: diagnostics command failed',
    ]);

    const installWithoutMarkup = compileFunction<() => Promise<unknown>>(
      main,
      'installGraphicsDiagnosticsSurface',
      {
        runtimeDiagnosticsReport: { debugBuild: true },
        graphicsDiagnosticsToggleEl: null,
        graphicsDiagnosticsShellEl: null,
        graphicsDiagnosticsPanelEl: null,
        graphicsDiagnosticsCloseEl: null,
        graphicsDiagnosticsContentEl: null,
        graphicsDiagnosticsRefreshEl: null,
        graphicsDiagnosticsCopyEl: null,
        graphicsDiagnosticsScenarioEl: null,
        graphicsDiagnosticsRunEl: null,
        graphicsDiagnosticsCancelEl: null,
        reportGraphicsDiagnosticsFailure: reportFailure,
      },
    );
    await expect(installWithoutMarkup()).resolves.toBeNull();
    expect(failures.at(-1)).toEqual([
      'markup',
      'Graphics diagnostics panel markup is incomplete.',
    ]);

    const element = {
      hidden: true,
      inert: true,
      disabled: true,
      addEventListener: vi.fn(),
    };
    const installWithoutAccessibleStatus = compileFunction<() => Promise<unknown>>(
      main,
      'installGraphicsDiagnosticsSurface',
      {
        runtimeDiagnosticsReport: { debugBuild: true, stressAuthorized: false },
        graphicsDiagnosticsToggleEl: element,
        graphicsDiagnosticsShellEl: element,
        graphicsDiagnosticsPanelEl: element,
        graphicsDiagnosticsCloseEl: element,
        graphicsDiagnosticsContentEl: element,
        graphicsDiagnosticsRefreshEl: element,
        graphicsDiagnosticsCopyEl: element,
        graphicsDiagnosticsScenarioEl: element,
        graphicsDiagnosticsRunEl: element,
        graphicsDiagnosticsCancelEl: element,
        graphicsDiagnosticsStatusEl: null,
        graphicsDiagnosticsProgressEl: element,
        graphicsDiagnosticsProgressTextEl: element,
        graphicsDiagnosticsFallbackEl: element,
        reportGraphicsDiagnosticsFailure: reportFailure,
      },
    );
    await expect(installWithoutAccessibleStatus()).resolves.toBeNull();
    expect(failures.at(-1)).toEqual([
      'markup',
      'Graphics diagnostics panel markup is incomplete.',
    ]);
  });

  it('reports action failures and clears them after a successful retry', async () => {
    const main = readFileSync(resolve(webRoot, 'main.js'), 'utf8');
    const reportFailure = vi.fn();
    const clearFailure = vi.fn();
    let shouldFail = true;
    const copy = compileFunction<() => Promise<boolean>>(
      main,
      'copyGraphicsDiagnosticsJson',
      {
        clipboardManager: {
          writeText: vi.fn(async () => {
            if (shouldFail) throw new Error('permission denied');
          }),
        },
        ptyRuntime: {
          serializeGraphicsDiagnosticsSnapshot: () => '{"graphics":{}}\n',
        },
        graphicsDiagnosticsSnapshot: () => ({ graphics: {} }),
        toast: vi.fn(),
        reportGraphicsDiagnosticsFailure: reportFailure,
        clearGraphicsDiagnosticsFailure: clearFailure,
      },
    );

    await expect(copy()).resolves.toBe(false);
    expect(reportFailure).toHaveBeenCalledWith(
      'copy',
      'Graphics diagnostics copy failed: Error: permission denied',
      expect.any(Error),
    );

    shouldFail = false;
    await expect(copy()).resolves.toBe(true);
    expect(clearFailure).toHaveBeenCalledWith('copy');
  });
});
