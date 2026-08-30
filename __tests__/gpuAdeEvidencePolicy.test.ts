import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADE_ACCELERATION_EVIDENCE,
  ADE_EVIDENCE_COLLECTORS,
  ADE_EVIDENCE_FIELDS,
  ADE_EVIDENCE_POLICY_VERSION,
  ADE_HARDWARE_BACKEND_TOKENS,
  ADE_RENDERER_CLASSIFICATION_REASONS,
  ADE_SOFTWARE_RENDER_MARKERS,
  classifyRenderer,
  detectHardwareBackendTokens,
  detectSoftwareMarkers,
  mergeEvidenceReports,
  resolveEvidenceConflict,
  type AdeEvidenceReportV1,
  type AdeRendererProbeFacts,
} from '../src/gpu/adeEvidencePolicy.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const charterDoc = readFileSync(resolve(root, 'docs', 'gpu', 'ADE-EPIC-CHARTER.md'), 'utf8');

describe('ade evidence policy vocabulary', () => {
  it('pins the policy version to v1', () => {
    expect(ADE_EVIDENCE_POLICY_VERSION).toBe(1);
  });

  it('pins the acceleration-evidence vocabulary to exactly the four required values', () => {
    expect([...ADE_ACCELERATION_EVIDENCE]).toEqual([
      'accelerated',
      'software',
      'unknown',
      'unavailable',
    ]);
  });

  it('pins the reportable evidence fields in canonical order', () => {
    expect([...ADE_EVIDENCE_FIELDS]).toEqual([
      'webviewEngine',
      'webviewVersion',
      'gpuBackend',
      'gpuAdapter',
    ]);
  });

  it('pins the two evidence collectors', () => {
    expect([...ADE_EVIDENCE_COLLECTORS]).toEqual(['native', 'browser']);
  });

  it('pins the tested software-renderer marker list to the design values', () => {
    expect([...ADE_SOFTWARE_RENDER_MARKERS]).toEqual([
      'swiftshader',
      'llvmpipe',
      'softpipe',
      'software rasterizer',
      'microsoft basic render driver',
    ]);
  });

  it('pins the hardware-backend token list', () => {
    expect([...ADE_HARDWARE_BACKEND_TOKENS]).toEqual(['metal', 'direct3d', 'vulkan', 'opengl']);
  });

  it('exposes a closed reason vocabulary for renderer classifications', () => {
    expect([...ADE_RENDERER_CLASSIFICATION_REASONS]).toEqual([
      'no-usable-context',
      'conflicting-renderer-evidence',
      'software-renderer-markers',
      'strict-context-with-clean-renderer-evidence',
      'webgpu-adapter-with-clean-renderer-evidence',
      'renderer-evidence-masked',
      'probe-unsupported',
    ]);
  });
});

describe('detectSoftwareMarkers', () => {
  it('returns no markers for absent, empty, or whitespace-only input', () => {
    expect(detectSoftwareMarkers(undefined)).toEqual([]);
    expect(detectSoftwareMarkers('')).toEqual([]);
    expect(detectSoftwareMarkers('   ')).toEqual([]);
  });

  it('matches markers case-insensitively as substrings', () => {
    expect(detectSoftwareMarkers('ANGLE (SwiftShader Community Build)')).toEqual(['swiftshader']);
    expect(detectSoftwareMarkers('Mesa llvmpipe (LLVM 17)')).toEqual(['llvmpipe']);
    expect(detectSoftwareMarkers('Microsoft Basic Render Driver')).toEqual([
      'microsoft basic render driver',
    ]);
  });

  it('returns markers in canonical list order and deduplicated', () => {
    const haystack = 'softpipe, SWIFTSHADER, llvmpipe, softpipe again';
    expect(detectSoftwareMarkers(haystack)).toEqual(['swiftshader', 'llvmpipe', 'softpipe']);
  });

  it('returns no markers for clean hardware renderer strings', () => {
    expect(detectSoftwareMarkers('ANGLE Metal Renderer: Apple M2 Pro')).toEqual([]);
  });
});

describe('detectHardwareBackendTokens', () => {
  it('returns no tokens for absent or empty input', () => {
    expect(detectHardwareBackendTokens(undefined)).toEqual([]);
    expect(detectHardwareBackendTokens('')).toEqual([]);
  });

  it('matches backend tokens case-insensitively in canonical order', () => {
    expect(detectHardwareBackendTokens('ANGLE (Direct3D11 vs_5_0)')).toEqual(['direct3d']);
    expect(detectHardwareBackendTokens('Metal, then Vulkan, then METAL again')).toEqual([
      'metal',
      'vulkan',
    ]);
  });
});

describe('classifyRenderer', () => {
  it('classifies unavailable only when both context probes conclusively failed', () => {
    const facts: AdeRendererProbeFacts = {
      strictContextCreated: false,
      webgpuAdapterObtained: false,
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'unavailable',
      reason: 'no-usable-context',
    });
  });

  it('classifies conflicting probe strings as unknown, symmetrically', () => {
    const softwareRenderer: AdeRendererProbeFacts = {
      strictContextCreated: true,
      rendererString: 'SwiftShader',
      adapterString: 'ANGLE Metal Renderer: Apple M2',
    };
    const hardwareRenderer: AdeRendererProbeFacts = {
      strictContextCreated: true,
      rendererString: 'ANGLE Metal Renderer: Apple M2',
      adapterString: 'llvmpipe (LLVM 17)',
    };
    expect(classifyRenderer(softwareRenderer)).toEqual({
      acceleration: 'unknown',
      reason: 'conflicting-renderer-evidence',
    });
    expect(classifyRenderer(hardwareRenderer)).toEqual({
      acceleration: 'unknown',
      reason: 'conflicting-renderer-evidence',
    });
  });

  it('never promotes software renderers to accelerated, even with a strict context', () => {
    const facts: AdeRendererProbeFacts = {
      strictContextCreated: true,
      rendererString: 'ANGLE (Google, SwiftShader, OpenGL)',
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'software',
      reason: 'software-renderer-markers',
    });
  });

  it('classifies accelerated only with a strict context plus renderer evidence', () => {
    const facts: AdeRendererProbeFacts = {
      strictContextCreated: true,
      rendererString: 'ANGLE Metal Renderer: Apple M2',
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'accelerated',
      reason: 'strict-context-with-clean-renderer-evidence',
    });
  });

  it('classifies accelerated from a WebGPU adapter with clean adapter evidence', () => {
    const facts: AdeRendererProbeFacts = {
      webgpuAdapterObtained: true,
      adapterString: 'NVIDIA GeForce RTX 4070 (vulkan)',
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'accelerated',
      reason: 'webgpu-adapter-with-clean-renderer-evidence',
    });
  });

  it('classifies unknown when context evidence exists but renderer data is masked', () => {
    expect(classifyRenderer({ strictContextCreated: true })).toEqual({
      acceleration: 'unknown',
      reason: 'renderer-evidence-masked',
    });
  });

  it('classifies unknown when the probe produced no verdict at all', () => {
    expect(classifyRenderer({})).toEqual({ acceleration: 'unknown', reason: 'probe-unsupported' });
    expect(classifyRenderer({ rendererString: 'ANGLE Metal Renderer: Apple M2' })).toEqual({
      acceleration: 'unknown',
      reason: 'probe-unsupported',
    });
  });

  it('treats whitespace-only renderer strings as not observed', () => {
    expect(classifyRenderer({ strictContextCreated: true, rendererString: '   ' })).toEqual({
      acceleration: 'unknown',
      reason: 'renderer-evidence-masked',
    });
  });

  it('does not treat a marker and a backend token in one string as a conflict', () => {
    const facts: AdeRendererProbeFacts = {
      strictContextCreated: true,
      rendererString: 'llvmpipe (OpenGL via Gallium)',
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'software',
      reason: 'software-renderer-markers',
    });
  });

  it('does not classify unavailable when only one probe failed', () => {
    const facts: AdeRendererProbeFacts = {
      strictContextCreated: false,
      webgpuAdapterObtained: true,
      adapterString: 'ANGLE Metal Renderer: Apple M2',
    };
    expect(classifyRenderer(facts)).toEqual({
      acceleration: 'accelerated',
      reason: 'webgpu-adapter-with-clean-renderer-evidence',
    });
  });
});

describe('resolveEvidenceConflict', () => {
  it('keeps agreement from two affirmative classifications', () => {
    expect(resolveEvidenceConflict('accelerated', 'accelerated')).toBe('accelerated');
    expect(resolveEvidenceConflict('software', 'software')).toBe('software');
  });

  it('classifies conflicting affirmative claims as unknown and never picks a winner', () => {
    expect(resolveEvidenceConflict('accelerated', 'software')).toBe('unknown');
    expect(resolveEvidenceConflict('software', 'accelerated')).toBe('unknown');
    expect(resolveEvidenceConflict('accelerated', 'unavailable')).toBe('unknown');
    expect(resolveEvidenceConflict('unavailable', 'software')).toBe('unknown');
  });

  it('lets an affirmative classification stand against unknown or missing evidence', () => {
    expect(resolveEvidenceConflict('accelerated', 'unknown')).toBe('accelerated');
    expect(resolveEvidenceConflict('unknown', 'accelerated')).toBe('accelerated');
    expect(resolveEvidenceConflict('software', undefined)).toBe('software');
    expect(resolveEvidenceConflict(undefined, 'software')).toBe('software');
  });

  it('classifies unknown when no collector classified', () => {
    expect(resolveEvidenceConflict(undefined, undefined)).toBe('unknown');
    expect(resolveEvidenceConflict('unknown', undefined)).toBe('unknown');
    expect(resolveEvidenceConflict(undefined, 'unknown')).toBe('unknown');
    expect(resolveEvidenceConflict('unknown', 'unknown')).toBe('unknown');
  });
});

const NATIVE_REPORT: AdeEvidenceReportV1 = Object.freeze({
  collector: 'native',
  acceleration: 'accelerated',
  webviewEngine: 'WKWebView',
  webviewVersion: '18.4',
  gpuBackend: 'Metal',
}) as unknown as AdeEvidenceReportV1;

const BROWSER_REPORT: AdeEvidenceReportV1 = Object.freeze({
  collector: 'browser',
  acceleration: 'accelerated',
  webviewEngine: 'WKWebView',
  gpuAdapter: 'Apple M2 Pro',
}) as unknown as AdeEvidenceReportV1;

describe('mergeEvidenceReports', () => {
  it('merges complementary observed fields from both collectors', () => {
    const merged = mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT);
    expect(merged).toEqual({
      policyVersion: 1,
      acceleration: 'accelerated',
      webviewEngine: 'WKWebView',
      webviewVersion: '18.4',
      gpuBackend: 'Metal',
      gpuAdapter: 'Apple M2 Pro',
      omittedFields: [],
      conflictedFields: [],
    });
  });

  it('classifies conflicting collector classifications as unknown in the merge', () => {
    const native: AdeEvidenceReportV1 = { collector: 'native', acceleration: 'accelerated' };
    const browser: AdeEvidenceReportV1 = { collector: 'browser', acceleration: 'software' };
    const merged = mergeEvidenceReports(native, browser);
    expect(merged.acceleration).toBe('unknown');
  });

  it('omits a field conflicting across collectors and names it in both lists', () => {
    const native: AdeEvidenceReportV1 = {
      collector: 'native',
      gpuAdapter: 'Apple M2',
      gpuBackend: 'Metal',
    };
    const browser: AdeEvidenceReportV1 = {
      collector: 'browser',
      gpuAdapter: 'Microsoft Basic Render Driver',
      gpuBackend: 'Metal',
    };
    const merged = mergeEvidenceReports(native, browser);
    expect(merged.gpuAdapter).toBeUndefined();
    expect('gpuAdapter' in merged).toBe(false);
    expect(merged.omittedFields).toEqual(['webviewEngine', 'webviewVersion', 'gpuAdapter']);
    expect(merged.conflictedFields).toEqual(['gpuAdapter']);
    expect(merged.gpuBackend).toBe('Metal');
  });

  it('keeps a field supplied by exactly one collector', () => {
    const merged = mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT);
    expect(merged.webviewVersion).toBe('18.4');
    expect(merged.gpuAdapter).toBe('Apple M2 Pro');
  });

  it('omits a field either collector declared unsupported, even when the other supplied it', () => {
    const native: AdeEvidenceReportV1 = {
      collector: 'native',
      acceleration: 'accelerated',
      webviewEngine: 'WKWebView',
      unsupportedFields: ['gpuAdapter'],
    };
    const browser: AdeEvidenceReportV1 = {
      collector: 'browser',
      acceleration: 'unknown',
      gpuAdapter: 'Apple M2',
    };
    const merged = mergeEvidenceReports(native, browser);
    expect('gpuAdapter' in merged).toBe(false);
    expect(merged.omittedFields).toEqual(['webviewVersion', 'gpuBackend', 'gpuAdapter']);
    expect(merged.conflictedFields).toEqual([]);
  });

  it('treats empty and whitespace-only values as not supplied', () => {
    const native: AdeEvidenceReportV1 = {
      collector: 'native',
      acceleration: 'unknown',
      gpuAdapter: '   ',
    };
    const browser: AdeEvidenceReportV1 = {
      collector: 'browser',
      acceleration: 'unknown',
      gpuAdapter: '',
    };
    const merged = mergeEvidenceReports(native, browser);
    expect('gpuAdapter' in merged).toBe(false);
    expect(merged.omittedFields).toEqual(['webviewEngine', 'webviewVersion', 'gpuBackend', 'gpuAdapter']);
  });

  it('lists omitted fields in canonical order regardless of collector order', () => {
    const native: AdeEvidenceReportV1 = { collector: 'native', acceleration: 'unknown' };
    const browser: AdeEvidenceReportV1 = {
      collector: 'browser',
      acceleration: 'unknown',
      unsupportedFields: ['gpuAdapter', 'gpuBackend', 'webviewVersion'],
    };
    const merged = mergeEvidenceReports(native, browser);
    expect(merged.omittedFields).toEqual(['webviewEngine', 'webviewVersion', 'gpuBackend', 'gpuAdapter']);
    expect(merged.conflictedFields).toEqual([]);
  });

  it('never introduces fields of its own into the merged report', () => {
    const merged = mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT);
    for (const key of Object.keys(merged)) {
      expect([
        'policyVersion',
        'acceleration',
        'webviewEngine',
        'webviewVersion',
        'gpuBackend',
        'gpuAdapter',
        'omittedFields',
        'conflictedFields',
      ]).toContain(key);
    }
  });

  it('is deterministic for identical inputs and does not mutate its inputs', () => {
    const first = mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT);
    const second = mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT);
    expect(second).toEqual(first);
    expect(NATIVE_REPORT.collector).toBe('native');
    expect(BROWSER_REPORT.collector).toBe('browser');
    // The frozen inputs guarantee no silent mutation: any write would throw.
    expect(Object.isFrozen(NATIVE_REPORT)).toBe(true);
    expect(Object.isFrozen(BROWSER_REPORT)).toBe(true);
  });

  it('keeps the merge symmetric in its collector arguments for fields', () => {
    expect(mergeEvidenceReports(NATIVE_REPORT, BROWSER_REPORT)).toEqual(
      mergeEvidenceReports(BROWSER_REPORT, NATIVE_REPORT),
    );
  });
});

describe('evidence policy documentation contract', () => {
  it('keeps the charter aligned with the implemented vocabulary and policy rules', () => {
    const lowered = charterDoc.toLowerCase();
    for (const value of ADE_ACCELERATION_EVIDENCE) {
      expect(lowered).toContain(value);
    }
    expect(lowered).toContain('never drop or reorder raw pty bytes');
    expect(lowered).toContain('never weaken csp');
    expect(lowered).toContain('never guess acceleration');
    expect(lowered).toContain('gpu-disabling');
    expect(lowered).toContain('unobserved physical-platform');
    expect(charterDoc).toContain('src/gpu/adeEvidencePolicy.ts');
  });
});
