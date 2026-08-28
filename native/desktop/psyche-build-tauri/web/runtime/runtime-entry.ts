import { snapshotFrameSchedulerResources } from './frame-scheduler';
export {
  buildGraphicsDiagnosticsView,
  createGraphicsDiagnosticsStressController,
  formatDiagnosticsStressProgress,
  isGraphicsDiagnosticsStressCancellation,
  serializeGraphicsDiagnosticsSnapshot,
} from './diagnostics-surface';
export type {
  GraphicsDiagnosticsRow,
  GraphicsDiagnosticsScenarioSnapshot,
  GraphicsDiagnosticsSection,
  GraphicsDiagnosticsSnapshot,
  GraphicsDiagnosticsStressController,
  GraphicsDiagnosticsStressControllerOptions,
  GraphicsDiagnosticsStressHarness,
  GraphicsDiagnosticsTone,
  GraphicsDiagnosticsView,
} from './diagnostics-surface';
import {
  classifyGraphicsEvidence,
  collectRuntimeGraphicsReport,
  createRuntimeGraphicsStartupState,
  ensureRuntimeGraphicsStartupSummary,
  mergeRuntimeGraphicsReport,
  probeGraphicsEvidence,
  SOFTWARE_RENDERER_MARKERS,
  STRICT_WEBGL_CONTEXT_ATTRIBUTES,
} from './graphics-diagnostics';
import { snapshotPtyClientResources } from './pty-client';
import {
  snapshotTerminalPaneResources,
  type TerminalPaneResourceSnapshot,
} from './terminal-pane-controller';

export interface RuntimeResourceSnapshot extends TerminalPaneResourceSnapshot {
  ptyClients: number;
  frameCallbacks: number;
}

export function snapshotRuntimeResources(): RuntimeResourceSnapshot {
  const paneResources = snapshotTerminalPaneResources();
  const ptyResources = snapshotPtyClientResources();
  return {
    ...paneResources,
    ptyClients: ptyResources.ptyClients,
    timers: paneResources.timers + ptyResources.timers,
    ...snapshotFrameSchedulerResources(),
  };
}

export {
  classifyGraphicsEvidence,
  collectRuntimeGraphicsReport,
  createRuntimeGraphicsStartupState,
  ensureRuntimeGraphicsStartupSummary,
  mergeRuntimeGraphicsReport,
  probeGraphicsEvidence,
  SOFTWARE_RENDERER_MARKERS,
  STRICT_WEBGL_CONTEXT_ATTRIBUTES,
};
export type {
  GraphicsCanvas,
  GraphicsClassification,
  GraphicsDebugRendererInfo,
  GraphicsGpu,
  GraphicsGpuAdapter,
  GraphicsGpuAdapterInfo,
  GraphicsNavigator,
  GraphicsProbeDependencies,
  GraphicsProbeResult,
  GraphicsWebGlContext,
  RuntimeGraphicsAcceleration,
  RuntimeGraphicsBackend,
  RuntimeGraphicsFallbackReason,
  RuntimeGraphicsNativeFacts,
  RuntimeGraphicsProbe,
  RuntimeGraphicsReport,
  RuntimeGraphicsStartupDependencies,
  RuntimeGraphicsStartupState,
} from './graphics-diagnostics';
export { FrameScheduler } from './frame-scheduler';
export type {
  FrameRequest,
  FrameRequestCallback,
  FrameSchedulerCallback,
  FrameSchedulerErrorSink,
  FrameSchedulerSnapshot,
} from './frame-scheduler';
export {
  createPerformanceMetricsCollector,
  summarizeFrames,
  FRAME_SAMPLE_LIMIT,
} from './performance-metrics';
export type {
  FrameSummary,
  InteractionKind,
  PerformanceMetricsCollector,
  PerformanceMetricsCollectorOptions,
  PerformanceObserverEntries,
  PerformanceObserverEntryList,
  PerformanceObserverFactory,
  PerformanceObserverLike,
  PerformanceRendererSnapshot,
  PerformanceSchedulerSnapshot,
  RuntimePerformanceSnapshot,
} from './performance-metrics';
export {
  buildStressFocusOrder,
  buildStressGeometry,
  buildStressPlan,
  createDiagnosticBrowserPage,
  createLargeEditorDocument,
  runStressPlan,
  stressFocusId,
  STRESS_FOCUS_INTERVAL_MS,
} from './stress-harness';
export type {
  StressBrowserPage,
  StressEditorDocument,
  StressFixture,
  StressGeometry,
  StressHarnessDependencies,
  StressPhase,
  StressProgress,
  StressResource,
  StressRunOptions,
  StressRunResult,
  StressScenario,
  StressScenarioResult,
} from './stress-harness';
export { createTauriStressHarness } from './stress-runtime-adapter';
export type {
  TauriStressHarness,
  TauriStressRuntimeHost,
} from './stress-runtime-adapter';
export {
  createPtyClient,
  disposePtyClient,
  routePtyBatch,
} from './pty-client';
export type {
  PtyClientController,
  PtyClientOptions,
  PtyDataBatch,
} from './pty-client';
export { createTerminalPaneController } from './terminal-pane-controller';
export type {
  FitAddonAdapter,
  FitAddonFactory,
  RendererFallbackReason,
  RendererSnapshot,
  RendererState,
  TerminalAdapter,
  TerminalContainer,
  TerminalFactory,
  TerminalPaneController,
  TerminalPaneControllerOptions,
  TerminalPanePtyClient,
  TerminalPanePtyFactory,
  VisibilityState,
  WebglAddonAdapter,
  WebglAddonFactory,
} from './terminal-pane-controller';
export {
  computeVirtualWindow,
  computeVirtualGroup,
  shouldVirtualize,
  virtualizeItems,
  VIRTUAL_LIST_OVERSCAN,
  VIRTUAL_LIST_THRESHOLD,
} from './virtual-list';
export type {
  VirtualItem,
  VirtualGroup,
  VirtualItemsOptions,
  VirtualItemsResult,
  VirtualWindow,
  VirtualWindowOptions,
} from './virtual-list';

void ensureRuntimeGraphicsStartupSummary();
