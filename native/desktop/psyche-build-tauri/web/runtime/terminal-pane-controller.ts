import type { FrameScheduler } from './frame-scheduler';
import {
  createPtyClient,
  routePtyBatch,
  type PtyClientController,
  type PtyClientOptions,
  type PtyDataBatch,
} from './pty-client';

export type RendererState = 'initializing' | 'webgl' | 'recovering' | 'fallback' | 'disposed';
export type RendererFallbackReason =
  | 'webgl_unavailable'
  | 'webgl_setup_failed'
  | 'webgl_recovery_failed'
  | 'webgl_recovery_cooldown';

export interface VisibilityState {
  documentVisible: boolean;
  paneVisible: boolean;
  intersecting: boolean;
}

export interface RendererSnapshot {
  paneId: string;
  state: RendererState;
  fallbackReason: RendererFallbackReason | null;
  rendererTransitions: number;
  contextLosses: number;
  visibility: VisibilityState;
  effectiveVisible: boolean;
  queuedWrites: number;
  syntheticQueuedWrites: number;
  syntheticRetainedBytes: number;
  writeInProgress: boolean;
}

export interface TerminalDisposable {
  dispose(): void;
}

export interface TerminalContainer {
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
}

export interface TerminalAdapter {
  cols: number;
  rows: number;
  options?: Record<string, unknown>;
  buffer?: {
    active?: {
      baseY: number;
      cursorY: number;
      getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  loadAddon(addon: TerminalDisposable): void;
  open(container: TerminalContainer): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): TerminalDisposable;
  onBell?(listener: () => void): TerminalDisposable;
  focus(): void;
  blur?(): void;
  dispose(): void;
}

export interface FitAddonAdapter extends TerminalDisposable {
  fit(): void;
}

export interface WebglAddonAdapter extends TerminalDisposable {
  onContextLoss?(listener: () => void): TerminalDisposable | void;
}

export interface TerminalPanePtyClient extends PtyClientController {
  receive(batch: PtyDataBatch): boolean;
}

export type TerminalFactory = (options: Record<string, unknown>) => TerminalAdapter;
export type FitAddonFactory = (terminal: TerminalAdapter) => FitAddonAdapter | null;
export type WebglAddonFactory = () => WebglAddonAdapter | null;
export type TerminalPanePtyFactory = (options: PtyClientOptions) => TerminalPanePtyClient;

export interface TerminalPaneController extends PtyClientController {
  receive(batch: PtyDataBatch): boolean;
  setVisibility(state: VisibilityState): Promise<boolean>;
  scheduleFit(): void;
  focus(): void;
  blur(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  tail(lines: number): string;
  setTheme(theme: Record<string, unknown>): void;
  dimensions(): { cols: number; rows: number };
  rendererSnapshot(): RendererSnapshot;
  compatibilityTerminal(): TerminalAdapter;
}

interface ObserverAdapter {
  observe(target: TerminalContainer): void;
  disconnect(): void;
}

type OwnedTimer = {
  active: boolean;
  handle: ReturnType<typeof setTimeout>;
};

interface VisibilityDocument {
  visibilityState?: string;
  hidden?: boolean;
  addEventListener(name: 'visibilitychange', listener: () => void): void;
  removeEventListener(name: 'visibilitychange', listener: () => void): void;
}

export interface TerminalPaneControllerOptions {
  paneId: string;
  threadId: string;
  container: TerminalContainer;
  frameScheduler: FrameScheduler;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  initialVisibility?: VisibilityState;
  isSelected?: () => boolean;
  terminalOptions?: Record<string, unknown>;
  terminalFactory?: TerminalFactory;
  fitAddonFactory?: FitAddonFactory;
  webglAddonFactory?: WebglAddonFactory;
  ptyFactory?: TerminalPanePtyFactory;
  createResizeObserver?: (callback: () => void) => ObserverAdapter | null;
  createIntersectionObserver?: (
    callback: (entries: Array<{ isIntersecting: boolean }>) => void,
  ) => ObserverAdapter | null;
  documentTarget?: VisibilityDocument | null;
  onData?: (data: string) => void;
  onBell?: () => void;
  registerLinks?: (
    terminal: TerminalAdapter,
    container: TerminalContainer,
  ) => TerminalDisposable | void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  reportError?: (error: unknown, operation: string) => void;
}

type QueuedWrite = {
  source: 'pty' | 'synthetic';
  data: Uint8Array;
  complete: () => void;
};

const HIDDEN_DRAIN_MS = 100;
// A pane that stops intersecting because the canvas is being rebuilt around it
// is not hidden, it is mid-layout. Charging it the hidden cadence for that would
// make every rebuild cost a 100 ms stall, so a disappearance has to persist
// before it counts. Reappearing inside the window is free.
const INTERSECTION_HIDE_DEBOUNCE_MS = 250;
const MAX_SYNTHETIC_RETAINED_BYTES = 64 * 1024;
const WEBGL_RECOVERY_COOLDOWN_MS = 30_000;
const controllers = new Map<string, TerminalPaneController>();
const terminals = new Set<TerminalAdapter>();
const fitAddons = new Set<FitAddonAdapter>();
const webglAddons = new Set<WebglAddonAdapter>();
const resizeObservers = new Set<ObserverAdapter>();
const intersectionObservers = new Set<ObserverAdapter>();
const timers = new Set<OwnedTimer>();
const syntheticEncoder = new TextEncoder();

export interface TerminalPaneResourceSnapshot {
  paneControllers: number;
  terminals: number;
  fitAddons: number;
  webglAddons: number;
  resizeObservers: number;
  intersectionObservers: number;
  timers: number;
}

export function snapshotTerminalPaneResources(): TerminalPaneResourceSnapshot {
  return {
    paneControllers: controllers.size,
    terminals: terminals.size,
    fitAddons: fitAddons.size,
    webglAddons: webglAddons.size,
    resizeObservers: resizeObservers.size,
    intersectionObservers: intersectionObservers.size,
    timers: timers.size,
  };
}

function boundedByteSuffix(bytes: Uint8Array, limit: number): Uint8Array {
  if (limit <= 0 || bytes.byteLength === 0) return new Uint8Array();
  if (bytes.byteLength <= limit) return bytes.slice();
  let start = bytes.byteLength - limit;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.slice(start);
}

function syntheticBytes(data: string | Uint8Array, limit: number): Uint8Array {
  if (limit <= 0) return new Uint8Array();
  if (typeof data !== 'string') return boundedByteSuffix(data, limit);
  const tail = data.length > limit ? data.slice(-limit) : data;
  return boundedByteSuffix(syntheticEncoder.encode(tail), limit);
}

function coalescedSyntheticBytes(
  previous: Uint8Array | null,
  next: Uint8Array,
  limit: number,
): Uint8Array {
  if (!previous || previous.byteLength === 0) return boundedByteSuffix(next, limit);
  if (next.byteLength >= limit) return boundedByteSuffix(next, limit);
  const previousTail = boundedByteSuffix(previous, limit - next.byteLength);
  const combined = new Uint8Array(previousTail.byteLength + next.byteLength);
  combined.set(previousTail);
  combined.set(next, previousTail.byteLength);
  return combined;
}

function globalConstructor<T>(name: string): T | undefined {
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

function defaultTerminalFactory(options: Record<string, unknown>): TerminalAdapter {
  const Terminal = globalConstructor<new (terminalOptions: Record<string, unknown>) => TerminalAdapter>(
    'Terminal',
  );
  if (!Terminal) throw new Error('xterm Terminal is unavailable');
  return new Terminal(options);
}

function defaultFitAddonFactory(): FitAddonAdapter | null {
  const namespace = globalConstructor<{ FitAddon?: new () => FitAddonAdapter }>('FitAddon');
  return namespace?.FitAddon ? new namespace.FitAddon() : null;
}

function defaultWebglAddonFactory(): WebglAddonAdapter | null {
  const namespace = globalConstructor<{ WebglAddon?: new () => WebglAddonAdapter }>('WebglAddon');
  return namespace?.WebglAddon ? new namespace.WebglAddon() : null;
}

function defaultPtyFactory(options: PtyClientOptions): TerminalPanePtyClient {
  const client = createPtyClient(options);
  return {
    ...client,
    receive: routePtyBatch,
  };
}

function defaultResizeObserverFactory(callback: () => void): ObserverAdapter | null {
  const Observer = globalConstructor<new (listener: () => void) => ObserverAdapter>('ResizeObserver');
  return Observer ? new Observer(callback) : null;
}

function defaultIntersectionObserverFactory(
  callback: (entries: Array<{ isIntersecting: boolean }>) => void,
): ObserverAdapter | null {
  const Observer = globalConstructor<
    new (listener: (entries: Array<{ isIntersecting: boolean }>) => void) => ObserverAdapter
  >('IntersectionObserver');
  return Observer ? new Observer(callback) : null;
}

function defaultDocumentTarget(): VisibilityDocument | null {
  return globalConstructor<VisibilityDocument>('document') ?? null;
}

function defaultVisibility(target: VisibilityDocument | null): VisibilityState {
  return {
    documentVisible: !target?.hidden && target?.visibilityState !== 'hidden',
    paneVisible: true,
    intersecting: true,
  };
}

function isEffectivelyVisible(state: VisibilityState): boolean {
  return state.documentVisible && state.paneVisible && state.intersecting;
}

function disposeOnce(disposable: TerminalDisposable | null | undefined): boolean {
  try {
    disposable?.dispose();
    return true;
  } catch {
    // Disposal is best-effort so one addon cannot strand the rest of the pane.
    return false;
  }
}

function disposeTracked<T extends TerminalDisposable>(
  resources: Set<T>,
  disposable: T | null | undefined,
): void {
  if (!disposable) return;
  if (disposeOnce(disposable)) resources.delete(disposable);
}

export function createTerminalPaneController(
  options: TerminalPaneControllerOptions,
): TerminalPaneController {
  const existing = controllers.get(options.paneId);
  if (existing && existing.rendererSnapshot().state !== 'disposed') return existing;

  const documentTarget = options.documentTarget === undefined
    ? defaultDocumentTarget()
    : options.documentTarget;
  let visibility = options.initialVisibility ?? defaultVisibility(documentTarget);
  let rendererState: RendererState = 'initializing';
  let rendererFallbackReason: RendererFallbackReason | null = null;
  let rendererTransitions = 0;
  let contextLosses = 0;
  let disposed = false;
  let fitPending = true;
  let writeInProgress = false;
  let hiddenTimer: OwnedTimer | null = null;
  let intersectionHideTimer: OwnedTimer | null = null;
  let lastHiddenDrainAt = isEffectivelyVisible(visibility)
    ? Number.NEGATIVE_INFINITY
    : (options.now ?? Date.now)();
  let lastSentDimensions: { cols: number; rows: number } | null = null;
  let pendingDimensions: { cols: number; rows: number } | null = null;
  let resizeFlight: Promise<void> | null = null;
  const ptyWrites: QueuedWrite[] = [];
  let syntheticWrite: QueuedWrite | null = null;
  let activeWrite: QueuedWrite | null = null;
  const registrations: TerminalDisposable[] = [];
  const framePrefix = `terminal-pane:${options.paneId}:`;
  const renderKey = `${framePrefix}render`;
  const webglRecoveryKey = `${framePrefix}webgl-recover`;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const reportError = options.reportError ?? ((error, operation) => {
    console.warn(`terminal pane ${options.paneId} ${operation} failed`, error);
  });

  function scheduleOwnedTimer(callback: () => void, delay: number): OwnedTimer {
    const timer = {
      active: true,
      handle: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    timer.handle = setTimer(() => {
      timer.active = false;
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function clearOwnedTimer(timer: OwnedTimer): void {
    if (!timer.active) return;
    try {
      clearTimer(timer.handle);
      timer.active = false;
      timers.delete(timer);
    } catch {
      // Keep failed cancellation visible in the runtime resource snapshot.
    }
  }

  const terminal = (options.terminalFactory ?? defaultTerminalFactory)({
    scrollback: 10_000,
    ...options.terminalOptions,
  });
  terminals.add(terminal);
  let fitAddon: FitAddonAdapter | null = null;
  try {
    fitAddon = (options.fitAddonFactory ?? defaultFitAddonFactory)(terminal);
    if (fitAddon) {
      fitAddons.add(fitAddon);
      terminal.loadAddon(fitAddon);
    }
    terminal.open(options.container);
  } catch (error) {
    disposeTracked(fitAddons, fitAddon);
    disposeTracked(terminals, terminal);
    throw error;
  }

  let webglAddon: WebglAddonAdapter | null = null;
  let webglContextLossRegistration: TerminalDisposable | null = null;
  let lastSuccessfulRecoveryAt: number | null = null;

  function releaseWebglAddon(): void {
    const registration = webglContextLossRegistration;
    const addon = webglAddon;
    webglContextLossRegistration = null;
    webglAddon = null;
    disposeOnce(registration);
    disposeTracked(webglAddons, addon);
  }

  function setRendererFallback(reason: RendererFallbackReason): void {
    if (disposed) return;
    setRendererState('fallback');
    rendererFallbackReason = reason;
  }

  function setRendererState(nextState: RendererState): void {
    if (rendererState !== nextState) rendererTransitions += 1;
    rendererState = nextState;
  }

  function disposeWebglRecoveryAttempt(
    addon: WebglAddonAdapter | null,
    contextLossRegistration: TerminalDisposable | null,
  ): void {
    disposeOnce(contextLossRegistration);
    disposeTracked(webglAddons, addon);
  }

  function recoverWebgl(): void {
    if (disposed || rendererState !== 'recovering' || !canFit()) return;
    let addon: WebglAddonAdapter | null = null;
    let contextLossRegistration: TerminalDisposable | null = null;
    try {
      addon = (options.webglAddonFactory ?? defaultWebglAddonFactory)();
      if (addon) webglAddons.add(addon);
      if (disposed) {
        disposeWebglRecoveryAttempt(addon, contextLossRegistration);
        return;
      }
      if (!addon) {
        setRendererFallback('webgl_recovery_failed');
        return;
      }
      const recoveredAddon = addon;
      terminal.loadAddon(recoveredAddon);
      if (disposed) {
        disposeWebglRecoveryAttempt(recoveredAddon, contextLossRegistration);
        return;
      }
      contextLossRegistration = recoveredAddon.onContextLoss?.(
        () => handleWebglContextLoss(recoveredAddon),
      ) ?? null;
      if (disposed) {
        disposeWebglRecoveryAttempt(recoveredAddon, contextLossRegistration);
        return;
      }
      const recoveredAt = now();
      if (disposed) {
        disposeWebglRecoveryAttempt(recoveredAddon, contextLossRegistration);
        return;
      }
      webglAddon = recoveredAddon;
      webglContextLossRegistration = contextLossRegistration;
      setRendererState('webgl');
      rendererFallbackReason = null;
      lastSuccessfulRecoveryAt = recoveredAt;
      fitPending = true;
      scheduleVisibleDelivery();
    } catch (error) {
      disposeWebglRecoveryAttempt(addon, contextLossRegistration);
      setRendererFallback('webgl_recovery_failed');
      reportError(error, 'WebGL recovery');
    }
  }

  function scheduleWebglRecovery(): void {
    if (disposed || rendererState !== 'recovering' || !canFit()) return;
    options.frameScheduler.schedule(webglRecoveryKey, recoverWebgl);
  }

  function handleWebglContextLoss(failedAddon: WebglAddonAdapter): void {
    if (disposed || webglAddon !== failedAddon) return;
    contextLosses += 1;
    const recoveredInsideCooldown = lastSuccessfulRecoveryAt != null &&
      now() - lastSuccessfulRecoveryAt < WEBGL_RECOVERY_COOLDOWN_MS;
    if (disposed) return;
    releaseWebglAddon();
    if (disposed) return;
    if (recoveredInsideCooldown) {
      setRendererFallback('webgl_recovery_cooldown');
      return;
    }
    setRendererState('recovering');
    rendererFallbackReason = null;
    scheduleWebglRecovery();
  }

  try {
    webglAddon = (options.webglAddonFactory ?? defaultWebglAddonFactory)();
    if (webglAddon) {
      webglAddons.add(webglAddon);
      terminal.loadAddon(webglAddon);
      const initialAddon = webglAddon;
      webglContextLossRegistration = initialAddon.onContextLoss?.(
        () => handleWebglContextLoss(initialAddon),
      ) ?? null;
      setRendererState('webgl');
    } else {
      setRendererFallback('webgl_unavailable');
    }
  } catch (error) {
    releaseWebglAddon();
    setRendererFallback('webgl_setup_failed');
    reportError(error, 'WebGL setup');
  }

  registrations.push(terminal.onData((data) => options.onData?.(data)));
  if (terminal.onBell && options.onBell) {
    registrations.push(terminal.onBell(options.onBell));
  }
  const linkRegistration = options.registerLinks?.(terminal, options.container);
  if (linkRegistration) registrations.push(linkRegistration);

  function clearHiddenTimer(): void {
    if (hiddenTimer == null) return;
    clearOwnedTimer(hiddenTimer);
    hiddenTimer = null;
  }

  function clearIntersectionHideTimer(): void {
    if (intersectionHideTimer == null) return;
    clearOwnedTimer(intersectionHideTimer);
    intersectionHideTimer = null;
  }

  function canFit(): boolean {
    return isEffectivelyVisible(visibility) &&
      options.container.isConnected &&
      options.container.clientWidth > 0 &&
      options.container.clientHeight > 0;
  }

  function sendPendingResize(): void {
    if (disposed || resizeFlight || !pendingDimensions) return;
    const dimensions = pendingDimensions;
    pendingDimensions = null;
    if (
      lastSentDimensions?.cols === dimensions.cols &&
      lastSentDimensions.rows === dimensions.rows
    ) {
      return;
    }
    const flight = options.invoke('pty_resize', {
      threadId: options.threadId,
      thread_id: options.threadId,
      cols: dimensions.cols,
      rows: dimensions.rows,
    }).then(() => {
      if (!disposed) lastSentDimensions = dimensions;
    }).catch((error) => {
      reportError(error, 'PTY resize');
    }).then(() => undefined).finally(() => {
      if (resizeFlight === flight) resizeFlight = null;
      if (!disposed && pendingDimensions) sendPendingResize();
    });
    resizeFlight = flight;
  }

  function fitIfPossible(): void {
    if (!fitPending || !fitAddon || !canFit()) return;
    try {
      fitAddon.fit();
      // Cleared only once a fit has actually landed: a throw here used to leave
      // the pane permanently unfitted at whatever size it happened to hold.
      fitPending = false;
      const dimensions = { cols: terminal.cols, rows: terminal.rows };
      if (
        lastSentDimensions?.cols !== dimensions.cols ||
        lastSentDimensions.rows !== dimensions.rows
      ) {
        pendingDimensions = dimensions;
        sendPendingResize();
      }
    } catch (error) {
      reportError(error, 'fit');
    }
  }

  function completeWrite(write: QueuedWrite): void {
    if (!writeInProgress || activeWrite !== write) return;
    activeWrite = null;
    writeInProgress = false;
    write.complete();
    if (disposed) return;
    scheduleDelivery();
  }

  function deliverNextWrite(hidden: boolean): void {
    if (disposed || writeInProgress) return;
    const write = ptyWrites.shift() ?? syntheticWrite;
    if (!write) return;
    if (write === syntheticWrite) syntheticWrite = null;
    activeWrite = write;
    writeInProgress = true;
    if (hidden) lastHiddenDrainAt = now();
    try {
      terminal.write(write.data, () => completeWrite(write));
    } catch (error) {
      const shouldComplete = writeInProgress && activeWrite === write;
      activeWrite = null;
      writeInProgress = false;
      ptyWrites.length = 0;
      syntheticWrite = null;
      ptyClient.stopPtyDelivery();
      if (shouldComplete) {
        try {
          write.complete();
        } catch (completionError) {
          reportError(completionError, 'write completion');
        }
      }
      reportError(error, 'write');
    }
  }

  function hasQueuedWrites(): boolean {
    return ptyWrites.length > 0 || syntheticWrite != null;
  }

  function flushVisible(): void {
    if (disposed) return;
    if (!isEffectivelyVisible(visibility)) {
      scheduleHiddenDelivery();
      return;
    }
    fitIfPossible();
    deliverNextWrite(false);
  }

  function scheduleVisibleDelivery(): void {
    options.frameScheduler.schedule(renderKey, flushVisible);
  }

  function scheduleHiddenDelivery(): void {
    if (disposed || hiddenTimer != null || writeInProgress || !hasQueuedWrites()) return;
    const elapsed = now() - lastHiddenDrainAt;
    const delay = Math.max(0, HIDDEN_DRAIN_MS - elapsed);
    hiddenTimer = scheduleOwnedTimer(() => {
      hiddenTimer = null;
      if (disposed) return;
      if (isEffectivelyVisible(visibility)) {
        scheduleVisibleDelivery();
        return;
      }
      deliverNextWrite(true);
    }, delay);
  }

  function scheduleDelivery(): void {
    if (disposed || writeInProgress || !hasQueuedWrites()) return;
    if (isEffectivelyVisible(visibility)) {
      clearHiddenTimer();
      scheduleVisibleDelivery();
    } else {
      scheduleHiddenDelivery();
    }
  }

  function queuePtyWrite(data: Uint8Array, complete: () => void): void {
    if (disposed) return;
    ptyWrites.push({ source: 'pty', data, complete });
    scheduleDelivery();
  }

  function queueSyntheticWrite(
    data: string | Uint8Array,
    complete: () => void = () => undefined,
  ): void {
    if (disposed) return;
    const activeSyntheticBytes = activeWrite?.source === 'synthetic'
      ? activeWrite.data.byteLength
      : 0;
    const availableBytes = MAX_SYNTHETIC_RETAINED_BYTES - activeSyntheticBytes;
    const nextBytes = syntheticBytes(data, availableBytes);
    if (nextBytes.byteLength === 0) {
      complete();
      return;
    }
    const previous = syntheticWrite;
    syntheticWrite = {
      source: 'synthetic',
      data: coalescedSyntheticBytes(previous?.data ?? null, nextBytes, availableBytes),
      complete,
    };
    previous?.complete();
    scheduleDelivery();
  }

  const ptyClient = (options.ptyFactory ?? defaultPtyFactory)({
    threadId: options.threadId,
    invoke: options.invoke,
    visible: isEffectivelyVisible(visibility),
    write: queuePtyWrite,
  });

  function applyVisibility(next: VisibilityState): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    // Any authority asserting the pane intersects outranks a debounce still
    // waiting to decide that it does not.
    if (next.intersecting) clearIntersectionHideTimer();
    const wasVisible = isEffectivelyVisible(visibility);
    visibility = { ...next };
    const visibleNow = isEffectivelyVisible(visibility);
    if (!visibleNow && wasVisible) {
      lastHiddenDrainAt = now();
      options.frameScheduler.cancelPrefix(framePrefix);
      scheduleHiddenDelivery();
    } else if (visibleNow && !wasVisible) {
      clearHiddenTimer();
      fitPending = true;
      scheduleWebglRecovery();
      scheduleVisibleDelivery();
    } else if (visibleNow) {
      scheduleWebglRecovery();
      scheduleVisibleDelivery();
    }
    return ptyClient.setVisible(visibleNow);
  }

  const resizeObserver = (options.createResizeObserver ?? defaultResizeObserverFactory)(() => {
    if (disposed) return;
    fitPending = true;
    if (isEffectivelyVisible(visibility)) {
      scheduleWebglRecovery();
      scheduleVisibleDelivery();
    }
  });
  if (resizeObserver) resizeObservers.add(resizeObserver);
  resizeObserver?.observe(options.container);

  const intersectionObserver = (
    options.createIntersectionObserver ?? defaultIntersectionObserverFactory
  )((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry || disposed) return;
    if (entry.isIntersecting) {
      clearIntersectionHideTimer();
      if (visibility.intersecting) return;
      void applyVisibility({ ...visibility, intersecting: true }).catch(() => {});
      return;
    }
    if (!visibility.intersecting || intersectionHideTimer != null) return;
    intersectionHideTimer = scheduleOwnedTimer(() => {
      intersectionHideTimer = null;
      if (disposed || !visibility.intersecting) return;
      void applyVisibility({ ...visibility, intersecting: false }).catch(() => {});
    }, INTERSECTION_HIDE_DEBOUNCE_MS);
  });
  if (intersectionObserver) intersectionObservers.add(intersectionObserver);
  intersectionObserver?.observe(options.container);

  const handleDocumentVisibility = () => {
    if (!documentTarget || disposed) return;
    void applyVisibility({
      ...visibility,
      documentVisible: !documentTarget.hidden && documentTarget.visibilityState !== 'hidden',
    }).catch(() => {});
  };
  documentTarget?.addEventListener('visibilitychange', handleDocumentVisibility);

  const controller: TerminalPaneController = {
    threadId: options.threadId,
    receive(batch) {
      if (disposed || batch.threadId !== options.threadId) return false;
      return ptyClient.receive(batch);
    },
    setVisibility: applyVisibility,
    setVisible(nextVisible) {
      return applyVisibility({ ...visibility, paneVisible: nextVisible });
    },
    scheduleFit() {
      if (disposed) return;
      fitPending = true;
      if (isEffectivelyVisible(visibility)) {
        scheduleWebglRecovery();
        scheduleVisibleDelivery();
      }
    },
    focus() {
      if (disposed || (options.isSelected && !options.isSelected())) return;
      terminal.focus();
    },
    blur() {
      if (!disposed) terminal.blur?.();
    },
    write: queueSyntheticWrite,
    tail(lines) {
      const buffer = terminal.buffer?.active;
      if (!buffer || lines <= 0) return '';
      const result: string[] = [];
      for (let row = buffer.baseY + buffer.cursorY; row >= 0 && result.length < lines; row -= 1) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const text = line.translateToString(true);
        if (!text.trim() && result.length === 0) continue;
        result.push(text);
      }
      return result.reverse().join('\n');
    },
    setTheme(theme) {
      if (!disposed && terminal.options) terminal.options.theme = theme;
    },
    dimensions() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    rendererSnapshot() {
      return {
        paneId: options.paneId,
        state: rendererState,
        fallbackReason: rendererFallbackReason,
        rendererTransitions,
        contextLosses,
        visibility: { ...visibility },
        effectiveVisible: isEffectivelyVisible(visibility),
        queuedWrites: ptyWrites.length + (syntheticWrite ? 1 : 0),
        syntheticQueuedWrites: syntheticWrite ? 1 : 0,
        syntheticRetainedBytes:
          (activeWrite?.source === 'synthetic' ? activeWrite.data.byteLength : 0) +
          (syntheticWrite?.data.byteLength ?? 0),
        writeInProgress,
      };
    },
    compatibilityTerminal() {
      return terminal;
    },
    prepareForPtyStart: () => ptyClient.prepareForPtyStart(),
    restoreAfterFailedPtyStart: (attempt) => ptyClient.restoreAfterFailedPtyStart(attempt),
    adoptRunningPty: (attempt) => ptyClient.adoptRunningPty(attempt),
    markPtyStarted: (attempt) => ptyClient.markPtyStarted(attempt),
    markPtyExited: () => ptyClient.markPtyExited(),
    stopPtyDelivery: () => ptyClient.stopPtyDelivery(),
    dispose() {
      if (disposed) return;
      disposed = true;
      setRendererState('disposed');
      rendererFallbackReason = null;
      controllers.delete(options.paneId);
      options.frameScheduler.cancelPrefix(framePrefix);
      clearHiddenTimer();
      clearIntersectionHideTimer();
      ptyWrites.length = 0;
      syntheticWrite = null;
      activeWrite = null;
      writeInProgress = false;
      pendingDimensions = null;
      ptyClient.dispose();
      resizeObserver?.disconnect();
      if (resizeObserver) resizeObservers.delete(resizeObserver);
      intersectionObserver?.disconnect();
      if (intersectionObserver) intersectionObservers.delete(intersectionObserver);
      documentTarget?.removeEventListener('visibilitychange', handleDocumentVisibility);
      for (const registration of registrations.splice(0)) disposeOnce(registration);
      releaseWebglAddon();
      disposeTracked(fitAddons, fitAddon);
      disposeTracked(terminals, terminal);
    },
  };

  controllers.set(options.paneId, controller);
  controller.scheduleFit();
  return controller;
}
