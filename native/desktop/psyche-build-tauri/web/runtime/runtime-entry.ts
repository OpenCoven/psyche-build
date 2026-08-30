import { snapshotFrameSchedulerResources } from './frame-scheduler';
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

export { FrameScheduler } from './frame-scheduler';
export type {
  FrameRequest,
  FrameRequestCallback,
  FrameSchedulerCallback,
  FrameSchedulerErrorSink,
  FrameSchedulerSnapshot,
} from './frame-scheduler';
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
