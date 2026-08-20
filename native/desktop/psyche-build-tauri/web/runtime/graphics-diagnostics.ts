export type RuntimeGraphicsAcceleration =
  | 'accelerated'
  | 'software'
  | 'unknown'
  | 'unavailable';
export type RuntimeGraphicsBackend = 'Metal' | 'Direct3D' | 'Vulkan' | 'OpenGL';
export type RuntimeGraphicsProbe = 'webgpu' | 'webgl2' | 'webgl';
export type RuntimeGraphicsFallbackReason =
  | 'conflicting_reliable_evidence'
  | 'no_usable_graphics_api'
  | 'renderer_masked_or_ambiguous'
  | 'renderer_unrecognized'
  | 'software_renderer_detected'
  | 'strict_webgl_context_failed'
  | 'webgpu_adapter_info_unavailable';

export interface RuntimeGraphicsReport {
  os: string;
  arch: string;
  engine: string;
  engineVersion?: string;
  acceleration: RuntimeGraphicsAcceleration;
  backend?: RuntimeGraphicsBackend;
  adapter?: string;
  supportingProbe?: RuntimeGraphicsProbe;
  fallbackReason?: RuntimeGraphicsFallbackReason;
  unsupportedFields: string[];
}

export interface RuntimeGraphicsNativeFacts {
  os: string;
  arch: string;
  engine: string;
  engineVersion?: string;
}

export interface GraphicsProbeResult {
  webgpuAdapterAvailable: boolean;
  webgpuAdapter?: string;
  webgpuAdapterInfoSource?: 'adapter.info' | 'requestAdapterInfo';
  strictContext?: Exclude<RuntimeGraphicsProbe, 'webgpu'>;
  fallbackContext?: Exclude<RuntimeGraphicsProbe, 'webgpu'>;
  renderer?: string;
  unsupportedFields: string[];
}

export interface GraphicsClassification {
  acceleration: RuntimeGraphicsAcceleration;
  backend?: RuntimeGraphicsBackend;
  adapter?: string;
  supportingProbe?: RuntimeGraphicsProbe;
  fallbackReason?: RuntimeGraphicsFallbackReason;
  unsupportedFields: string[];
}

export interface GraphicsGpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

export interface GraphicsGpuAdapter {
  info?: GraphicsGpuAdapterInfo;
  requestAdapterInfo?(): Promise<GraphicsGpuAdapterInfo>;
}

export interface GraphicsGpu {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<GraphicsGpuAdapter | null>;
}

export interface GraphicsNavigator {
  gpu?: GraphicsGpu;
}

export interface GraphicsDebugRendererInfo {
  UNMASKED_RENDERER_WEBGL: number;
}

export interface GraphicsWebGlContext {
  getExtension(name: 'WEBGL_debug_renderer_info'): GraphicsDebugRendererInfo | null;
  getParameter(parameter: number): unknown;
}

export interface GraphicsCanvas {
  getContext(
    kind: 'webgl2' | 'webgl',
    attributes?: typeof STRICT_WEBGL_CONTEXT_ATTRIBUTES,
  ): GraphicsWebGlContext | null;
}

export interface GraphicsProbeDependencies {
  navigatorTarget?: GraphicsNavigator | null;
  createCanvas?: () => GraphicsCanvas | null;
}

export interface RuntimeGraphicsStartupDependencies extends GraphicsProbeDependencies {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  log?: (label: '[psyche:graphics]', report: RuntimeGraphicsReport) => void;
  reportError?: (error: unknown, operation: 'collect runtime graphics report') => void;
}

export interface RuntimeGraphicsStartupState {
  inFlight: Promise<RuntimeGraphicsReport | null> | null;
}

type EvidenceCategory = 'hardware' | 'software' | 'ambiguous';

type ParsedEvidence = {
  source: RuntimeGraphicsProbe;
  category: EvidenceCategory;
  backend?: RuntimeGraphicsBackend;
  adapter?: string;
  reason?: RuntimeGraphicsFallbackReason;
};

const SOFTWARE_MARKER_DEFINITIONS = [
  ['apple software renderer', 'Apple Software Renderer'],
  ['swiftshader', 'SwiftShader'],
  ['llvmpipe', 'llvmpipe'],
  ['softpipe', 'softpipe'],
  ['microsoft basic render driver', 'Microsoft Basic Render Driver'],
  ['software rasterizer', 'software rasterizer'],
] as const;

const MASKED_RENDERERS = new Set([
  'angle',
  'generic renderer',
  'opengl',
  'renderer',
  'unknown',
  'webkit webgl',
]);

const OPENGL_HARDWARE_HINTS = [
  'adreno',
  'amd',
  'apple',
  'arc',
  'geforce',
  'intel',
  'iris',
  'mali',
  'nvidia',
  'quadro',
  'radeon',
  'rtx',
  'vega',
] as const;

const SOFTWARE_RENDERER_MARKER_VERSION = 2;
const sharedStartupState: RuntimeGraphicsStartupState = createRuntimeGraphicsStartupState();
const genericAdapterPattern = /^(adapter|gpu|graphics)$/i;
const identifierOnlyPattern = /^(0x)?[0-9a-f-]+$/i;
const DIRECT3D_BACKEND_PATTERN = /\b(?:direct3d(?:11|12)?|d3d(?:11|12)?)\b/i;

export const SOFTWARE_RENDERER_MARKERS = Object.freeze({
  version: SOFTWARE_RENDERER_MARKER_VERSION,
  markers: SOFTWARE_MARKER_DEFINITIONS.map(([, label]) => label),
});

export const STRICT_WEBGL_CONTEXT_ATTRIBUTES = Object.freeze({
  failIfMajorPerformanceCaveat: true,
  powerPreference: 'high-performance' as const,
});

export function createRuntimeGraphicsStartupState(): RuntimeGraphicsStartupState {
  return { inFlight: null };
}

export async function probeGraphicsEvidence(
  deps: GraphicsProbeDependencies = {},
): Promise<GraphicsProbeResult> {
  const unsupportedFields = new Set<string>();
  const webgpuEvidence = await probeWebGpu(deps, unsupportedFields);
  const webglEvidence = probeWebGl(deps, unsupportedFields);

  return compactProbeResult({
    webgpuAdapterAvailable: webgpuEvidence.webgpuAdapterAvailable,
    webgpuAdapter: webgpuEvidence.webgpuAdapter,
    webgpuAdapterInfoSource: webgpuEvidence.webgpuAdapterInfoSource,
    strictContext: webglEvidence.strictContext,
    fallbackContext: webglEvidence.fallbackContext,
    renderer: webglEvidence.renderer,
    unsupportedFields: [...unsupportedFields],
  });
}

export function classifyGraphicsEvidence(probe: GraphicsProbeResult): GraphicsClassification {
  const unsupportedFields = uniqueStrings(probe.unsupportedFields);
  const webgpuEvidence = classifyWebGpuEvidence(probe);
  const webglEvidence = classifyWebGlEvidence(probe);
  const reliable = [webgpuEvidence, webglEvidence].filter(isReliableEvidence);

  if (reliable.length > 1 && hasConflictingReliableEvidence(reliable[0], reliable[1])) {
    return {
      acceleration: 'unknown',
      fallbackReason: 'conflicting_reliable_evidence',
      unsupportedFields,
    };
  }

  if (reliable.length > 0) {
    return finalizeReliableEvidence(selectPreferredReliableEvidence(reliable), unsupportedFields);
  }

  const ambiguous = selectPreferredAmbiguousEvidence([webglEvidence, webgpuEvidence]);
  if (ambiguous) {
    return compactClassification({
      acceleration: 'unknown',
      backend: ambiguous.backend,
      adapter: ambiguous.adapter,
      supportingProbe: ambiguous.source,
      fallbackReason: ambiguous.reason ?? defaultAmbiguousReason(probe),
      unsupportedFields,
    });
  }

  return {
    acceleration: 'unavailable',
    fallbackReason: 'no_usable_graphics_api',
    unsupportedFields,
  };
}

export function mergeRuntimeGraphicsReport(
  nativeFacts: RuntimeGraphicsNativeFacts,
  classification: GraphicsClassification,
): RuntimeGraphicsReport {
  const report: RuntimeGraphicsReport = {
    os: normalizeRequiredString(nativeFacts.os),
    arch: normalizeRequiredString(nativeFacts.arch),
    engine: normalizeRequiredString(nativeFacts.engine),
    acceleration: classification.acceleration,
    unsupportedFields: uniqueStrings(classification.unsupportedFields),
  };

  const engineVersion = normalizeString(nativeFacts.engineVersion);
  const backend = classification.backend;
  const adapter = normalizeString(classification.adapter);
  const supportingProbe = classification.supportingProbe;
  const fallbackReason = classification.fallbackReason;

  if (engineVersion) report.engineVersion = engineVersion;
  if (backend) report.backend = backend;
  if (adapter) report.adapter = adapter;
  if (supportingProbe) report.supportingProbe = supportingProbe;
  if (fallbackReason) report.fallbackReason = fallbackReason;

  return report;
}

export async function collectRuntimeGraphicsReport(
  deps: RuntimeGraphicsStartupDependencies = {},
): Promise<RuntimeGraphicsReport | null> {
  const invoke = deps.invoke ?? defaultInvoke();
  if (!invoke) return null;

  try {
    const [nativeFacts, probe] = await Promise.all([
      readNativeRuntimeGraphicsFacts(invoke),
      probeGraphicsEvidence(deps),
    ]);
    if (!nativeFacts) {
      throw new Error('runtime_diagnostics returned invalid runtime graphics facts');
    }
    return mergeRuntimeGraphicsReport(nativeFacts, classifyGraphicsEvidence(probe));
  } catch (error) {
    (deps.reportError ?? defaultReportError)(error, 'collect runtime graphics report');
    return null;
  }
}

export function ensureRuntimeGraphicsStartupSummary(
  deps: RuntimeGraphicsStartupDependencies = {},
  startupState: RuntimeGraphicsStartupState = sharedStartupState,
): Promise<RuntimeGraphicsReport | null> {
  if (!startupState.inFlight) {
    startupState.inFlight = collectRuntimeGraphicsReport(deps).then((report) => {
      if (report) (deps.log ?? defaultLog)('[psyche:graphics]', report);
      return report;
    });
  }

  return startupState.inFlight;
}

function compactProbeResult(result: GraphicsProbeResult): GraphicsProbeResult {
  const compact: GraphicsProbeResult = {
    webgpuAdapterAvailable: result.webgpuAdapterAvailable,
    unsupportedFields: uniqueStrings(result.unsupportedFields),
  };

  if (result.webgpuAdapter) compact.webgpuAdapter = result.webgpuAdapter;
  if (result.webgpuAdapterInfoSource) compact.webgpuAdapterInfoSource = result.webgpuAdapterInfoSource;
  if (result.strictContext) compact.strictContext = result.strictContext;
  if (result.fallbackContext) compact.fallbackContext = result.fallbackContext;
  if (result.renderer) compact.renderer = result.renderer;

  return compact;
}

function compactClassification(classification: GraphicsClassification): GraphicsClassification {
  const compact: GraphicsClassification = {
    acceleration: classification.acceleration,
    unsupportedFields: uniqueStrings(classification.unsupportedFields),
  };

  if (classification.backend) compact.backend = classification.backend;
  if (classification.adapter) compact.adapter = classification.adapter;
  if (classification.supportingProbe) compact.supportingProbe = classification.supportingProbe;
  if (classification.fallbackReason) compact.fallbackReason = classification.fallbackReason;

  return compact;
}

function normalizeRequiredString(value: unknown): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error('Missing required runtime graphics field');
  return normalized;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function lowerCase(value: string): string {
  return value.toLowerCase();
}

function softwareMarkerFor(text: string): string | undefined {
  const normalized = lowerCase(text);
  return SOFTWARE_MARKER_DEFINITIONS.find(([needle]) => normalized.includes(needle))?.[1];
}

function parseExplicitBackend(text: string): RuntimeGraphicsBackend | undefined {
  if (/\bmetal\b/i.test(text)) return 'Metal';
  if (DIRECT3D_BACKEND_PATTERN.test(text)) return 'Direct3D';
  if (/\bvulkan\b/i.test(text)) return 'Vulkan';
  if (/\bopengl\b/i.test(text)) return 'OpenGL';
  return undefined;
}

function isMaskedRenderer(text: string): boolean {
  const normalized = lowerCase(text);
  return MASKED_RENDERERS.has(normalized)
    || normalized === 'google inc. (generic)'
    || normalized === 'google inc. (google)'
    || normalized === 'webkit webgl';
}

function normalizeAdapterString(value: string): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  if (genericAdapterPattern.test(normalized)) return undefined;
  return normalized;
}

function stripAngleAdapterTokens(
  value: string,
  backend: RuntimeGraphicsBackend | undefined,
): string | undefined {
  let candidate = value.trim();
  if (backend === 'Direct3D') {
    candidate = candidate
      .replace(/\s*(?:Direct3D|D3D)\d+(?:[^,)]*)$/i, '')
      .trim();
  } else if (backend === 'Metal') {
    candidate = candidate.replace(/^ANGLE Metal Renderer:\s*/i, '').trim();
  } else if (backend === 'Vulkan') {
    candidate = candidate.replace(/^Vulkan(?:\s+[0-9.]+)?\s*/i, '').trim();
  }

  return normalizeAdapterString(candidate);
}

function stripOpenGlAdapterTokens(value: string): string | undefined {
  return normalizeAdapterString(
    value
      .replace(/\s+OpenGL Engine$/i, '')
      .replace(/\s+OpenGL(?:\s+ES)?(?:[^)]*)$/i, '')
      .trim(),
  );
}

function hasExplicitOpenGlHardwareHint(text: string): boolean {
  const normalized = lowerCase(text);
  return normalized.includes('/pcie/')
    || OPENGL_HARDWARE_HINTS.some((hint) => normalized.includes(hint));
}

function normalizeWebGpuAdapterInfo(info: GraphicsGpuAdapterInfo | undefined): string | undefined {
  const description = normalizeString(info?.description);
  if (description) return description;

  const device = normalizeString(info?.device);
  if (device && !identifierOnlyPattern.test(device)) return device;
  return undefined;
}

async function probeWebGpu(
  deps: GraphicsProbeDependencies,
  unsupportedFields: Set<string>,
): Promise<Pick<GraphicsProbeResult, 'webgpuAdapterAvailable' | 'webgpuAdapter' | 'webgpuAdapterInfoSource'>> {
  const navigatorTarget = deps.navigatorTarget ?? defaultNavigatorTarget();
  const gpu = navigatorTarget?.gpu;
  if (!gpu) {
    unsupportedFields.add('webgpu');
    return { webgpuAdapterAvailable: false };
  }

  let adapter: GraphicsGpuAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    unsupportedFields.add('webgpu');
    return { webgpuAdapterAvailable: false };
  }

  if (!adapter) return { webgpuAdapterAvailable: false };

  let webgpuAdapter = normalizeWebGpuAdapterInfo(adapter.info);
  let webgpuAdapterInfoSource: 'adapter.info' | 'requestAdapterInfo' | undefined;
  if (webgpuAdapter) {
    webgpuAdapterInfoSource = 'adapter.info';
  } else if (typeof adapter.requestAdapterInfo === 'function') {
    try {
      webgpuAdapter = normalizeWebGpuAdapterInfo(await adapter.requestAdapterInfo());
      if (webgpuAdapter) {
        webgpuAdapterInfoSource = 'requestAdapterInfo';
      } else {
        unsupportedFields.add('webgpu.adapterInfo');
      }
    } catch {
      unsupportedFields.add('webgpu.adapterInfo');
    }
  } else {
    unsupportedFields.add('webgpu.adapterInfo');
  }

  return compactProbeResult({
    webgpuAdapterAvailable: true,
    webgpuAdapter,
    webgpuAdapterInfoSource,
    unsupportedFields: [],
  });
}

function probeWebGl(
  deps: GraphicsProbeDependencies,
  unsupportedFields: Set<string>,
): Pick<GraphicsProbeResult, 'strictContext' | 'fallbackContext' | 'renderer'> {
  const strictWebgl2 = tryCreateContext(deps, 'webgl2', STRICT_WEBGL_CONTEXT_ATTRIBUTES);
  if (strictWebgl2) {
    return {
      strictContext: 'webgl2',
      renderer: readWebGlRenderer(strictWebgl2, unsupportedFields),
    };
  }

  const strictWebgl = tryCreateContext(deps, 'webgl', STRICT_WEBGL_CONTEXT_ATTRIBUTES);
  if (strictWebgl) {
    return {
      strictContext: 'webgl',
      renderer: readWebGlRenderer(strictWebgl, unsupportedFields),
    };
  }

  const fallbackWebgl2 = tryCreateContext(deps, 'webgl2');
  if (fallbackWebgl2) {
    unsupportedFields.add('webgl.strictContext');
    return {
      fallbackContext: 'webgl2',
      renderer: readWebGlRenderer(fallbackWebgl2, unsupportedFields),
    };
  }

  const fallbackWebgl = tryCreateContext(deps, 'webgl');
  if (fallbackWebgl) {
    unsupportedFields.add('webgl.strictContext');
    return {
      fallbackContext: 'webgl',
      renderer: readWebGlRenderer(fallbackWebgl, unsupportedFields),
    };
  }

  unsupportedFields.add('webgl.context');
  return {};
}

function tryCreateContext(
  deps: GraphicsProbeDependencies,
  kind: 'webgl2' | 'webgl',
  attributes?: typeof STRICT_WEBGL_CONTEXT_ATTRIBUTES,
): GraphicsWebGlContext | null {
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas;
  try {
    return createCanvas()?.getContext(kind, attributes) ?? null;
  } catch {
    return null;
  }
}

function readWebGlRenderer(
  context: GraphicsWebGlContext,
  unsupportedFields: Set<string>,
): string | undefined {
  let debugRendererInfo: GraphicsDebugRendererInfo | null = null;
  try {
    debugRendererInfo = context.getExtension('WEBGL_debug_renderer_info');
  } catch {
    unsupportedFields.add('webgl.debugRendererInfo');
    unsupportedFields.add('webgl.renderer');
    return undefined;
  }

  if (!debugRendererInfo) {
    unsupportedFields.add('webgl.debugRendererInfo');
    unsupportedFields.add('webgl.renderer');
    return undefined;
  }

  let renderer: string | undefined;
  try {
    renderer = normalizeString(context.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL));
  } catch {
    unsupportedFields.add('webgl.renderer');
    return undefined;
  }
  if (!renderer) {
    unsupportedFields.add('webgl.renderer');
    return undefined;
  }

  if (isMaskedRenderer(renderer)) unsupportedFields.add('webgl.renderer');
  return renderer;
}

function classifyWebGpuEvidence(probe: GraphicsProbeResult): ParsedEvidence | null {
  if (!probe.webgpuAdapterAvailable) return null;
  if (!probe.webgpuAdapter) {
    return {
      source: 'webgpu',
      category: 'ambiguous',
      reason: 'webgpu_adapter_info_unavailable',
    };
  }

  const softwareMarker = softwareMarkerFor(probe.webgpuAdapter);
  if (softwareMarker) {
    return {
      source: 'webgpu',
      category: 'software',
      backend: parseExplicitBackend(probe.webgpuAdapter),
      adapter: softwareMarker,
    };
  }

  if (isMaskedRenderer(probe.webgpuAdapter)) {
    return {
      source: 'webgpu',
      category: 'ambiguous',
      reason: 'renderer_masked_or_ambiguous',
    };
  }

  const adapter = normalizeAdapterString(probe.webgpuAdapter);
  if (!adapter) {
    return {
      source: 'webgpu',
      category: 'ambiguous',
      reason: 'renderer_masked_or_ambiguous',
    };
  }

  return {
    source: 'webgpu',
    category: 'hardware',
    backend: parseExplicitBackend(adapter),
    adapter,
  };
}

function classifyWebGlEvidence(probe: GraphicsProbeResult): ParsedEvidence | null {
  const source = probe.strictContext ?? probe.fallbackContext;
  if (!source) return null;
  if (!probe.renderer) {
    return {
      source,
      category: 'ambiguous',
      reason: probe.strictContext ? 'renderer_masked_or_ambiguous' : 'strict_webgl_context_failed',
    };
  }

  const parsed = parseWebGlRenderer(probe.renderer, source);
  if (probe.strictContext) return parsed;

  if (parsed.category === 'software') return parsed;
  return {
    source,
    category: 'ambiguous',
    backend: parsed.backend,
    adapter: parsed.adapter,
    reason: 'strict_webgl_context_failed',
  };
}

function parseWebGlRenderer(renderer: string, source: Exclude<RuntimeGraphicsProbe, 'webgpu'>): ParsedEvidence {
  const angleMatch = renderer.match(/^ANGLE\s*\((.*)\)$/i);
  if (angleMatch) {
    const backend = parseExplicitBackend(renderer);
    const segments = angleMatch[1]
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const softwareMarker = softwareMarkerFor(renderer);
    const adapter = normalizeAdapterString(
      stripAngleAdapterTokens(segments[1] ?? '', backend) ?? softwareMarker ?? '',
    );

    if (softwareMarker) {
      return {
        source,
        category: 'software',
        backend,
        adapter: softwareMarker,
      };
    }

    if (isMaskedRenderer(renderer)) {
      return {
        source,
        category: 'ambiguous',
        reason: 'renderer_masked_or_ambiguous',
      };
    }

    if (!backend || !adapter) {
      return {
        source,
        category: 'ambiguous',
        backend,
        adapter,
        reason: backend ? 'renderer_masked_or_ambiguous' : 'renderer_unrecognized',
      };
    }

    return {
      source,
      category: 'hardware',
      backend,
      adapter,
    };
  }

  const softwareMarker = softwareMarkerFor(renderer);
  if (softwareMarker) {
    return {
      source,
      category: 'software',
      backend: parseExplicitBackend(renderer),
      adapter: softwareMarker,
    };
  }

  if (isMaskedRenderer(renderer)) {
    return {
      source,
      category: 'ambiguous',
      reason: 'renderer_masked_or_ambiguous',
    };
  }

  if (!hasExplicitOpenGlHardwareHint(renderer)) {
    return {
      source,
      category: 'ambiguous',
      reason: 'renderer_unrecognized',
    };
  }

  const adapter = stripOpenGlAdapterTokens(renderer);
  if (!adapter) {
    return {
      source,
      category: 'ambiguous',
      reason: 'renderer_unrecognized',
    };
  }

  return {
    source,
    category: 'hardware',
    backend: parseExplicitBackend(renderer),
    adapter,
  };
}

function isReliableEvidence(evidence: ParsedEvidence | null): evidence is ParsedEvidence {
  return evidence?.category === 'hardware' || evidence?.category === 'software';
}

function hasConflictingReliableEvidence(first: ParsedEvidence, second: ParsedEvidence): boolean {
  if (first.category !== second.category) return true;
  if (first.backend && second.backend && first.backend !== second.backend) return true;

  if (first.adapter && second.adapter) {
    const firstAdapter = lowerCase(first.adapter);
    const secondAdapter = lowerCase(second.adapter);
    if (
      firstAdapter !== secondAdapter
      && !firstAdapter.includes(secondAdapter)
      && !secondAdapter.includes(firstAdapter)
    ) {
      return true;
    }
  }

  return false;
}

function selectPreferredReliableEvidence(evidence: ParsedEvidence[]): ParsedEvidence {
  return [...evidence].sort((left, right) => reliabilityScore(right) - reliabilityScore(left))[0];
}

function reliabilityScore(evidence: ParsedEvidence): number {
  let score = evidence.category === 'software' ? 100 : 50;
  if (evidence.backend) score += 10;
  if (evidence.adapter) score += 5;
  if (evidence.source === 'webgl2') score += 4;
  if (evidence.source === 'webgl') score += 3;
  if (evidence.source === 'webgpu') score += 2;
  return score;
}

function finalizeReliableEvidence(
  evidence: ParsedEvidence,
  unsupportedFields: string[],
): GraphicsClassification {
  return compactClassification({
    acceleration: evidence.category === 'hardware' ? 'accelerated' : 'software',
    backend: evidence.backend,
    adapter: evidence.adapter,
    supportingProbe: evidence.source,
    fallbackReason: evidence.category === 'software' ? 'software_renderer_detected' : undefined,
    unsupportedFields,
  });
}

function selectPreferredAmbiguousEvidence(
  evidence: Array<ParsedEvidence | null>,
): ParsedEvidence | null {
  return evidence
    .filter((candidate): candidate is ParsedEvidence => candidate?.category === 'ambiguous')
    .sort((left, right) => ambiguousScore(right) - ambiguousScore(left))[0] ?? null;
}

function ambiguousScore(evidence: ParsedEvidence): number {
  let score = 0;
  if (evidence.backend) score += 10;
  if (evidence.adapter) score += 5;
  if (evidence.source === 'webgl2') score += 4;
  if (evidence.source === 'webgl') score += 3;
  if (evidence.source === 'webgpu') score += 2;
  if (evidence.reason === 'strict_webgl_context_failed') score += 1;
  return score;
}

function defaultAmbiguousReason(probe: GraphicsProbeResult): RuntimeGraphicsFallbackReason {
  if (probe.fallbackContext) return 'strict_webgl_context_failed';
  if (probe.webgpuAdapterAvailable && !probe.webgpuAdapter) return 'webgpu_adapter_info_unavailable';
  return 'renderer_masked_or_ambiguous';
}

async function readNativeRuntimeGraphicsFacts(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<RuntimeGraphicsNativeFacts | null> {
  const report = await invoke('runtime_diagnostics');
  if (!report || typeof report !== 'object') return null;
  const nativeReport = report as Record<string, unknown>;
  const os = normalizeString(nativeReport.os);
  const arch = normalizeString(nativeReport.arch);
  const engine = normalizeString(nativeReport.engine);
  if (!os || !arch || !engine) return null;
  const engineVersion = normalizeString(nativeReport.engineVersion);
  return engineVersion ? { os, arch, engine, engineVersion } : { os, arch, engine };
}

function defaultNavigatorTarget(): GraphicsNavigator | null {
  const candidate = (globalThis as { navigator?: GraphicsNavigator }).navigator;
  return candidate ?? null;
}

function defaultCreateCanvas(): GraphicsCanvas | null {
  const documentTarget = (globalThis as {
    document?: { createElement(name: 'canvas'): GraphicsCanvas };
  }).document;
  return documentTarget?.createElement('canvas') ?? null;
}

function defaultInvoke():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  return (globalThis as {
    __TAURI__?: {
      core?: {
        invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }).__TAURI__?.core?.invoke;
}

function defaultLog(label: '[psyche:graphics]', report: RuntimeGraphicsReport): void {
  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    console.info(label, report);
  }
}

function defaultReportError(error: unknown, operation: 'collect runtime graphics report'): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[psyche:graphics] ${operation} failed`, error);
  }
}
