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
      'NVIDIA GeForce Graphics',
      'NVIDIA GeForce Driver',
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
