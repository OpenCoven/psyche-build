import type { FrameScheduler } from './frame-scheduler';
import {
  createPtyClient,
  routePtyBatch,
  type PtyClientController,
  type PtyClientOptions,
  type PtyDataBatch,
} from './pty-client';

export type RendererState = 'initializing' | 'webgl' | 'recovering' | 'fallback' | 'disposed';

export interface VisibilityState {
  documentVisible: boolean;
  paneVisible: boolean;
  intersecting: boolean;
}

export interface RendererSnapshot {
  state: RendererState;
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
const MAX_SYNTHETIC_RETAINED_BYTES = 64 * 1024;
const controllers = new Map<string, TerminalPaneController>();
const syntheticEncoder = new TextEncoder();

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

function disposeOnce(disposable: TerminalDisposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch {
    // Disposal is best-effort so one addon cannot strand the rest of the pane.
  }
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
  let disposed = false;
  let fitPending = true;
  let writeInProgress = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
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
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const reportError = options.reportError ?? ((error, operation) => {
    console.warn(`terminal pane ${options.paneId} ${operation} failed`, error);
  });

  const terminal = (options.terminalFactory ?? defaultTerminalFactory)({
    scrollback: 10_000,
    ...options.terminalOptions,
  });
  const fitAddon = (options.fitAddonFactory ?? defaultFitAddonFactory)(terminal);
  if (fitAddon) terminal.loadAddon(fitAddon);
  terminal.open(options.container);

  let webglAddon: WebglAddonAdapter | null = null;
  let webglContextLossRegistration: TerminalDisposable | null = null;
  try {
    webglAddon = (options.webglAddonFactory ?? defaultWebglAddonFactory)();
    if (webglAddon) {
      terminal.loadAddon(webglAddon);
      webglContextLossRegistration = webglAddon.onContextLoss?.(() => undefined) ?? null;
      rendererState = 'webgl';
    } else {
      rendererState = 'fallback';
    }
  } catch (error) {
    disposeOnce(webglContextLossRegistration);
    disposeOnce(webglAddon);
    webglContextLossRegistration = null;
    webglAddon = null;
    rendererState = 'fallback';
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
    clearTimer(hiddenTimer);
    hiddenTimer = null;
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
      if (pendingDimensions) sendPendingResize();
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
    fitPending = false;
    try {
      fitAddon.fit();
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
    hiddenTimer = setTimer(() => {
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
      scheduleVisibleDelivery();
    } else if (visibleNow) {
      scheduleVisibleDelivery();
    }
    return ptyClient.setVisible(visibleNow);
  }

  const resizeObserver = (options.createResizeObserver ?? defaultResizeObserverFactory)(() => {
    if (disposed) return;
    fitPending = true;
    if (isEffectivelyVisible(visibility)) scheduleVisibleDelivery();
  });
  resizeObserver?.observe(options.container);

  const intersectionObserver = (
    options.createIntersectionObserver ?? defaultIntersectionObserverFactory
  )((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry || disposed) return;
    void applyVisibility({ ...visibility, intersecting: entry.isIntersecting }).catch(() => {});
  });
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
      if (isEffectivelyVisible(visibility)) scheduleVisibleDelivery();
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
        state: rendererState,
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
      rendererState = 'disposed';
      controllers.delete(options.paneId);
      options.frameScheduler.cancelPrefix(framePrefix);
      clearHiddenTimer();
      ptyWrites.length = 0;
      syntheticWrite = null;
      activeWrite = null;
      writeInProgress = false;
      pendingDimensions = null;
      ptyClient.dispose();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      documentTarget?.removeEventListener('visibilitychange', handleDocumentVisibility);
      for (const registration of registrations.splice(0)) disposeOnce(registration);
      disposeOnce(webglContextLossRegistration);
      disposeOnce(webglAddon);
      disposeOnce(fitAddon);
      disposeOnce(terminal);
    },
  };

  controllers.set(options.paneId, controller);
  controller.scheduleFit();
  return controller;
}
