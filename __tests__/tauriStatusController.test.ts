import { describe, expect, it } from 'vitest';

import { createStatusController } from '../native/macos/psyche-build-tauri/web/status/status-controller.mjs';
import type { StatusControllerSample } from '../native/macos/psyche-build-tauri/web/status/status-controller.mjs';

type Listener = (event: FakeEvent) => void;

type FakeEvent = {
  type: string;
  target: FakeDocument | FakeElement;
  currentTarget: FakeDocument | FakeElement | null;
  key?: string;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  [key: string]: unknown;
};

function dataAttributeKey(name: string) {
  return name
    .slice(5)
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function classNames(node: FakeElement) {
  return node.className.split(/\s+/).filter(Boolean);
}

function matchesSelector(node: FakeElement, selector: string) {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('.')) {
    return classNames(node).includes(trimmed.slice(1));
  }
  if (trimmed.startsWith('#')) {
    return node.id === trimmed.slice(1);
  }
  const attributeMatch = trimmed.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (!attributeMatch) return false;

  const [, rawName, expectedValue] = attributeMatch;
  if (rawName.startsWith('data-')) {
    const value = node.dataset[dataAttributeKey(rawName)];
    return expectedValue === undefined ? typeof value === 'string' : value === expectedValue;
  }

  const value = node.attributes.get(rawName);
  return expectedValue === undefined ? value != null : value === expectedValue;
}

function descendantMatches(root: FakeElement, selector: string) {
  const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
  const matches: FakeElement[] = [];
  const visit = (node: FakeElement) => {
    for (const child of node.childNodes) {
      if (selectors.some((part) => matchesSelector(child, part))) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

class FakeEventTarget {
  listeners = new Map<string, Set<Listener>>();

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }

  listenerCount(name: string) {
    return this.listeners.get(name)?.size ?? 0;
  }

  protected createEvent(
    type: string,
    target: FakeDocument | FakeElement,
    init: Record<string, unknown> = {},
  ): FakeEvent {
    return {
      type,
      target,
      currentTarget: null,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() {
        this.defaultPrevented = true;
        const handler = init.preventDefault;
        if (typeof handler === 'function') handler();
      },
      stopPropagation() {
        this.cancelBubble = true;
      },
      ...init,
    } as FakeEvent;
  }

  invoke(type: string, event: FakeEvent, currentTarget: FakeDocument | FakeElement) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      event.currentTarget = currentTarget;
      listener(event);
      if (event.cancelBubble) break;
    }
  }
}

class FakeDocument extends FakeEventTarget {
  roots: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  hidden = false;
  visibilityState: 'hidden' | 'visible' = 'visible';

  createElement(tagName: string) {
    return new FakeElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string) {
    return this.createElement(tagName);
  }

  appendChild(node: FakeElement) {
    node.parentNode = this;
    node.parentElement = null;
    this.roots.push(node);
    return node;
  }

  getElementById(id: string) {
    return this.querySelector(`#${id}`);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    return this.roots.flatMap((root) => {
      const matches: FakeElement[] = [];
      if (matchesSelector(root, selector)) matches.push(root);
      matches.push(...descendantMatches(root, selector));
      return matches;
    });
  }

  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = this.createEvent(type, this, init);
    this.invoke(type, event, this);
    return event;
  }
}

class FakeElement extends FakeEventTarget {
  ownerDocument: FakeDocument;
  tagName: string;
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  childNodes: FakeElement[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  parentElement: FakeElement | null = null;
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  title = '';
  clientWidth = 0;
  offsetWidth = 0;
  rectWidth = 0;
  focusCalls = 0;
  private ownText = '';

  constructor(ownerDocument: FakeDocument, tagName: string) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return `${this.ownText}${this.childNodes.map((child) => child.textContent).join('')}`;
  }

  set textContent(value: string) {
    this.ownText = String(value);
    this.childNodes = [];
  }

  append(...nodes: Array<FakeElement | string>) {
    nodes.forEach((node) => {
      if (typeof node === 'string') {
        this.ownText += node;
        return;
      }
      this.appendChild(node);
    });
  }

  appendChild(node: FakeElement) {
    node.remove();
    node.parentNode = this;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode || !(this.parentNode instanceof FakeElement)) {
      if (this.parentNode instanceof FakeDocument) {
        this.parentNode.roots = this.parentNode.roots.filter((node) => node !== this);
      }
      this.parentNode = null;
      this.parentElement = null;
      return;
    }

    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode = null;
    this.parentElement = null;
  }

  focus() {
    this.focusCalls += 1;
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect() {
    return { width: this.rectWidth };
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) {
      this.dataset[dataAttributeKey(name)] = value;
    }
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    return descendantMatches(this, selector);
  }

  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = this.createEvent(type, this, init);
    let current: FakeElement | FakeDocument | null = this;
    while (current) {
      current.invoke(type, event, current);
      if (event.cancelBubble) break;
      current = current instanceof FakeElement ? current.parentNode : null;
    }
    return event;
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnectCount = 0;
  callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown) {
    this.observed.push(target);
  }

  disconnect() {
    this.disconnectCount += 1;
    this.observed = [];
  }
}

function buildSample(overrides: Record<string, unknown> = {}): StatusControllerSample {
  const context = {
    activeThreadId: null,
    threads: [],
    covenSessions: [],
    ...(overrides.context as Record<string, unknown> | undefined),
  };
  const nativeSnapshot = overrides.nativeSnapshot === undefined
    ? null
    : overrides.nativeSnapshot;
  const frame = {
    fps: null,
    renderLatencyMs: null,
    droppedFrames: null,
    ...(overrides.frame as Record<string, unknown> | undefined),
  };

  return {
    sampledAt: 1_700_000_000_000,
    context,
    summary: {
      agents: [],
      shells: [],
      tasks: [],
      counts: {
        agents: 0,
        shells: 0,
        running: 0,
        waiting: 0,
        failed: 0,
      },
      ...(overrides.summary as Record<string, unknown> | undefined),
    },
    scopeState: {
      focusedAvailable: false,
      scopeName: 'workspace' as const,
      activeThreadId: null,
      ...(overrides.scopeState as Record<string, unknown> | undefined),
    },
    nativeSnapshot,
    nativeHealth: {
      status: 'ready',
      reconnects: 0,
      latencyMs: 5,
      lastSuccessAt: 1_700_000_000_000,
      error: '',
      ...(overrides.nativeHealth as Record<string, unknown> | undefined),
    },
    activity: {
      workspace: {
        bytesPerSecond: 0,
        linesPerSecond: 0,
        operationsPerSecond: 0,
        errors: 0,
      },
      threads: [],
      ...(overrides.activity as Record<string, unknown> | undefined),
    },
    frame,
    covenHealth: {
      phase: 'idle',
      reconnects: 0,
      latencyMs: null,
      refreshedAt: null,
      error: '',
      ...(overrides.covenHealth as Record<string, unknown> | undefined),
    },
  } as StatusControllerSample;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function buildNativeSnapshot(overrides: Record<string, unknown> = {}) {
  const input = { ...overrides };
  const workspace = {
    cpuPercent: 12,
    memoryBytes: 256 * 1024 * 1024,
    ...(overrides.workspace as Record<string, unknown> | undefined),
  };
  delete input.workspace;
  return {
    sampledAtMs: 1_700_000_000_000,
    workspace,
    usedMemoryBytes: 512 * 1024 * 1024,
    totalMemoryBytes: 1024 * 1024 * 1024,
    memoryPressurePercent: 50,
    processes: [],
    ...input,
  };
}

function createHarness(options: {
  hidden?: boolean;
  barWidth?: number;
  copyText?: (text: string) => Promise<void>;
  fetchMetrics?: (scope?: { threadId?: string }) => Promise<unknown>;
  getContext?: () => {
    activeThreadId?: string | null;
    threads?: unknown[];
    covenSessions?: unknown[];
  };
  nativePollTimeoutMs?: number;
  nowMs?: number;
  performanceMs?: number;
} = {}) {
  FakeResizeObserver.instances = [];
  const doc = new FakeDocument();
  const hidden = options.hidden ?? false;
  doc.hidden = hidden;
  doc.visibilityState = hidden ? 'hidden' : 'visible';

  const footer = doc.createElement('div');
  footer.id = 'footer-stack';
  doc.appendChild(footer);

  const detail = doc.createElement('section');
  detail.id = 'status-detail';
  detail.hidden = true;
  const detailTitle = doc.createElement('h2');
  detailTitle.id = 'status-detail-title';
  const detailBody = doc.createElement('div');
  detailBody.id = 'status-detail-body';
  const detailScopeWorkspace = doc.createElement('button');
  detailScopeWorkspace.id = 'status-detail-scope-workspace';
  const detailScopeFocused = doc.createElement('button');
  detailScopeFocused.id = 'status-detail-scope-focused';
  const pin = doc.createElement('button');
  pin.id = 'status-detail-pin';
  const copy = doc.createElement('button');
  copy.id = 'status-detail-copy';
  const close = doc.createElement('button');
  close.id = 'status-detail-close';
  detail.append(detailTitle, detailBody, detailScopeWorkspace, detailScopeFocused, pin, copy, close);

  const bar = doc.createElement('div');
  bar.id = 'status-bar';
  bar.rectWidth = options.barWidth ?? 640;
  const metrics = doc.createElement('div');
  metrics.id = 'status-metrics';
  const trailing = doc.createElement('div');
  trailing.rectWidth = 140;
  const barScopeWorkspace = doc.createElement('button');
  barScopeWorkspace.id = 'status-scope-workspace';
  const barScopeFocused = doc.createElement('button');
  barScopeFocused.id = 'status-scope-focused';
  const more = doc.createElement('button');
  more.id = 'status-more-button';
  more.rectWidth = 60;
  trailing.append(barScopeWorkspace, barScopeFocused, more);
  bar.append(metrics, trailing);

  const moreMenu = doc.createElement('div');
  moreMenu.id = 'status-more-menu';
  moreMenu.hidden = true;
  const live = doc.createElement('div');
  live.id = 'status-live';
  const alert = doc.createElement('div');
  alert.id = 'status-alert';
  footer.append(detail, bar, moreMenu, live, alert);

  const storageState = new Map<string, string>();
  const timers = new Map<number, { callback: () => void; delay: number; dueAt: number }>();
  const frames = new Map<number, (at: number) => void>();
  let nextTimerId = 1;
  let nextFrameId = 1;
  const copyText = options.copyText ?? (async () => {});
  const fetchMetrics = options.fetchMetrics ?? (() => new Promise(() => {}));
  let nowMs = options.nowMs ?? 1_700_000_000_000;
  let performanceMs = options.performanceMs ?? 0;

  const advanceClock = async (milliseconds: number) => {
    const target = nowMs + milliseconds;
    while (true) {
      let nextTimerIdToRun: number | null = null;
      let nextTimerDueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of timers) {
        if (timer.dueAt < nextTimerDueAt) {
          nextTimerDueAt = timer.dueAt;
          nextTimerIdToRun = id;
        }
      }
      if (nextTimerIdToRun == null || nextTimerDueAt > target) break;

      const step = nextTimerDueAt - nowMs;
      nowMs = nextTimerDueAt;
      performanceMs += step;
      const timer = timers.get(nextTimerIdToRun);
      timers.delete(nextTimerIdToRun);
      timer?.callback();
      await flushMicrotasks();
    }

    const remaining = target - nowMs;
    nowMs = target;
    performanceMs += remaining;
    await flushMicrotasks();
  };

  const controller = createStatusController({
    document: doc,
    elements: {
      bar,
      metrics,
      detail,
      detailTitle,
      detailBody,
      more,
      moreMenu,
      live,
      alert,
      pin,
      copy,
      close,
      trailing,
      scopeButtons: [
        barScopeWorkspace,
        barScopeFocused,
        detailScopeWorkspace,
        detailScopeFocused,
      ],
    },
    storage: {
      getItem(key: string) {
        return storageState.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storageState.set(key, value);
      },
    },
    copyText,
    nativePollTimeoutMs: options.nativePollTimeoutMs,
    fetchMetrics,
    getContext: options.getContext ?? (() => ({
      activeThreadId: null,
      threads: [],
      covenSessions: [],
    })),
    now: () => nowMs,
    requestFrame: (callback: (at: number) => void) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id: number) => {
      frames.delete(id);
    },
    setTimer: (callback: () => void, delay: number) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, {
        callback,
        delay,
        dueAt: nowMs + Math.max(0, delay),
      });
      return id;
    },
    clearTimer: (id: number) => {
      timers.delete(id);
    },
    performance: {
      now: () => performanceMs,
    },
    ResizeObserver: FakeResizeObserver,
  });

  return {
    controller,
    doc,
    elements: {
      alert,
      bar,
      close,
      copy,
      detail,
      detailBody,
      live,
      metrics,
      more,
      moreMenu,
      pin,
    },
    frames,
    readStoredPreferences() {
      const raw = storageState.get('psyche.tauri.status.v1');
      return raw ? JSON.parse(raw) : null;
    },
    timers,
    clock: {
      advance: advanceClock,
      now: () => nowMs,
      performance: () => performanceMs,
    },
    resizeObserver: FakeResizeObserver.instances[0],
  };
}

function classTexts(root: FakeElement, className: string) {
  return root.querySelectorAll(`.${className}`).map((node) => node.textContent);
}

function findCellByLabel(root: FakeElement, cellClassName: string, label: string) {
  return root.querySelectorAll(`.${cellClassName}`)
    .find((node) => node.querySelector('.status-cell-label')?.textContent === label) ?? null;
}

function sparklineData(cell: FakeElement | null) {
  const sparkline = cell?.querySelector('.status-sparkline');
  const path = sparkline instanceof FakeElement ? sparkline.childNodes[0] : null;
  return path instanceof FakeElement ? path.attributes.get('d') ?? null : null;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('tauri status controller', () => {
  it('keeps lifecycle-owned handlers, timers, observers, and frame callbacks idempotent across restart', () => {
    const { controller, doc, elements, frames, timers, resizeObserver } = createHarness();

    controller.start();
    controller.start();

    expect(elements.more.listenerCount('click')).toBe(1);
    expect(doc.listenerCount('keydown')).toBe(1);
    expect(timers.size).toBe(2);
    expect(frames.size).toBe(1);
    expect(resizeObserver.observed).toEqual([elements.bar]);

    elements.more.dispatch('click');
    expect(elements.moreMenu.hidden).toBe(false);

    controller.stop();
    controller.stop();

    expect(elements.more.listenerCount('click')).toBe(0);
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(resizeObserver.disconnectCount).toBe(1);

    elements.moreMenu.hidden = true;
    elements.more.setAttribute('aria-expanded', 'false');

    controller.start();
    expect(elements.more.listenerCount('click')).toBe(1);
    expect(doc.listenerCount('keydown')).toBe(1);
    expect(timers.size).toBe(2);
    expect(frames.size).toBe(1);

    elements.more.dispatch('click');
    expect(elements.moreMenu.hidden).toBe(false);

    elements.moreMenu.hidden = true;
    elements.more.setAttribute('aria-expanded', 'false');
    controller.toggleMetric('connection');
    expect(elements.detail.hidden).toBe(false);
    let prevented = 0;
    doc.dispatch('keydown', {
      key: 'Escape',
      preventDefault() {
        prevented += 1;
      },
    });
    expect(prevented).toBe(1);
    expect(elements.detail.hidden).toBe(true);

    controller.stop();
  });

  it('announces pin and unpin in the polite live region and clears stale alerts', () => {
    const { controller, elements } = createHarness({ hidden: true });

    controller.render(buildSample());
    controller.start();
    controller.toggleMetric('agents');

    elements.alert.textContent = 'stale';
    elements.pin.dispatch('click');
    expect(elements.live.textContent).toBe('Pinned Agents');
    expect(elements.alert.textContent).toBe('');

    elements.alert.textContent = 'stale again';
    elements.pin.dispatch('click');
    expect(elements.live.textContent).toBe('Unpinned Agents');
    expect(elements.alert.textContent).toBe('');

    controller.stop();
  });

  it('preserves prior health fields when render receives partial health updates', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });

    controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot(),
      nativeHealth: {
        status: 'ready',
        reconnects: 2,
        latencyMs: 18,
        lastSuccessAt: 1_700_000_020_000,
        error: 'offline',
      },
      covenHealth: {
        phase: 'error',
        reconnects: 3,
        latencyMs: 24,
        refreshedAt: 1_700_000_025_000,
        error: 'timeout',
      },
    }));

    controller.render({
      sampledAt: 1_700_000_030_000,
      nativeHealth: {
        status: 'degraded',
      },
      covenHealth: {
        phase: 'ready',
      },
    } as StatusControllerSample);
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta');
    const tasks = classTexts(elements.detailBody, 'status-row-task');

    expect(meta[0]).toContain('Reconnects 2');
    expect(meta[0]).toContain('Last refresh');
    expect(tasks).toContain('offline');
    expect(meta[1]).toContain('Reconnects 3');
    expect(meta[1]).not.toContain('Last refresh');
  });

  it('does not invent a Coven refresh timestamp when discovery fails before any success', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });

    controller.render(buildSample());
    controller.noteCovenSample({
      phase: 'unavailable',
      sampledAt: 1_700_000_010_000,
      error: {
        code: 'coven_unavailable',
        message: 'Discovery failed',
      },
    });
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta')[1] ?? '';
    const errors = classTexts(elements.detailBody, 'status-row-task');

    expect(meta).toContain('Reconnects 0');
    expect(meta).not.toContain('Last refresh');
    expect(errors[0]).toBe('Discovery failed (coven_unavailable)');
  });

  it('does not invent a Coven refresh timestamp when render receives an initial error sample', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });

    controller.render(buildSample({
      covenHealth: {
        phase: 'error',
        reconnects: 0,
        latencyMs: 24,
        refreshedAt: 1_700_000_010_000,
        error: 'Discovery failed',
      },
    }));
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta')[1] ?? '';
    const errors = classTexts(elements.detailBody, 'status-row-task');

    expect(meta).toContain('Reconnects 0');
    expect(meta).not.toContain('Last refresh');
    expect(meta).not.toContain(new Date(1_700_000_010_000).toLocaleTimeString());
    expect(errors[0]).toBe('Discovery failed');
  });

  it('preserves the last successful Coven refresh when render receives a later failure sample', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });

    controller.render(buildSample({
      nativeHealth: {
        lastSuccessAt: 1_700_000_030_000,
      },
      covenHealth: {
        phase: 'ready',
        refreshedAt: 1_700_000_010_000,
        latencyMs: 12,
      },
    }));
    controller.render({
      sampledAt: 1_700_000_020_000,
      covenHealth: {
        phase: 'error',
        refreshedAt: 1_700_000_020_000,
        error: 'Discovery timed out',
      },
    });
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta')[1] ?? '';
    const errors = classTexts(elements.detailBody, 'status-row-task');

    expect(controller.render()?.labels.connection).toBe('Degraded');
    expect(meta).toContain(`Last refresh ${new Date(1_700_000_010_000).toLocaleTimeString()}`);
    expect(meta).not.toContain(new Date(1_700_000_020_000).toLocaleTimeString());
    expect(errors[0]).toBe('Discovery timed out');
  });

  it('preserves the last successful Coven refresh when a later discovery attempt fails', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });

    controller.render(buildSample({
      nativeHealth: {
        lastSuccessAt: 1_700_000_030_000,
      },
    }));
    controller.noteCovenSample({
      phase: 'ready',
      refreshedAt: 1_700_000_010_000,
      latencyMs: 12,
    });
    controller.noteCovenSample({
      phase: 'error',
      sampledAt: 1_700_000_020_000,
      error: {
        code: 'status_failed',
        message: 'Discovery timed out',
      },
    });
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta')[1] ?? '';
    const errors = classTexts(elements.detailBody, 'status-row-task');

    expect(controller.render()?.labels.connection).toBe('Degraded');
    expect(meta).toContain(`Last refresh ${new Date(1_700_000_010_000).toLocaleTimeString()}`);
    expect(meta).not.toContain(new Date(1_700_000_020_000).toLocaleTimeString());
    expect(errors[0]).toBe('Discovery timed out (status_failed)');
  });

  it('clears Coven discovery errors, updates refresh time, and increments reconnects on recovery', () => {
    const { controller, elements } = createHarness({
      hidden: true,
      nowMs: 1_700_000_040_000,
    });

    controller.render(buildSample({
      nativeHealth: {
        lastSuccessAt: 1_700_000_040_000,
      },
    }));
    controller.noteCovenSample({
      phase: 'ready',
      refreshedAt: 1_700_000_010_000,
    });
    controller.noteCovenSample({
      phase: 'error',
      sampledAt: 1_700_000_020_000,
      formattedError: 'Discovery timed out (status_failed)',
    });
    controller.noteCovenSample({
      phase: 'ready',
      refreshedAt: 1_700_000_030_000,
      latencyMs: 8,
    });
    controller.toggleMetric('connection');

    const meta = classTexts(elements.detailBody, 'status-row-meta')[1] ?? '';
    const errors = classTexts(elements.detailBody, 'status-row-task');

    expect(controller.render()?.labels.connection).toBe('Connected');
    expect(meta).toContain('Reconnects 1');
    expect(meta).toContain(`Last refresh ${new Date(1_700_000_030_000).toLocaleTimeString()}`);
    expect(errors).toEqual([]);
  });

  it('clears stale copy alerts on success and preserves explicit copy failures', async () => {
    const success = createHarness({
      hidden: true,
      copyText: async () => {},
    });
    success.controller.render(buildSample());
    success.controller.start();
    success.elements.alert.textContent = 'old error';
    success.elements.copy.dispatch('click');
    await flushMicrotasks();
    expect(success.elements.live.textContent).toBe('Diagnostics copied');
    expect(success.elements.alert.textContent).toBe('');
    success.controller.stop();

    const failure = createHarness({
      hidden: true,
      copyText: async () => {
        throw new Error('Clipboard unavailable');
      },
    });
    failure.controller.render(buildSample());
    failure.controller.start();
    failure.elements.copy.dispatch('click');
    await flushMicrotasks();
    expect(failure.elements.alert.textContent).toBe(
      'Unable to copy diagnostics: Clipboard unavailable',
    );
    failure.controller.stop();
  });

  it('uses approved compact Tasks wording and excludes blocked counts from the collapsed metric', () => {
    const { controller, elements } = createHarness({ hidden: true });

    const withFailure = controller.render(buildSample({
      summary: {
        tasks: [
          { id: 'run-1', name: 'Run 1', status: 'running', runtimeMs: 4_000, threadId: 'run-1' },
          { id: 'run-2', name: 'Run 2', status: 'running', runtimeMs: 6_000, threadId: 'run-2' },
          { id: 'wait-1', name: 'Wait 1', status: 'waiting', runtimeMs: 1_000, threadId: 'wait-1' },
          { id: 'blocked-1', name: 'Blocked 1', status: 'blocked', runtimeMs: 2_000, threadId: 'blocked-1' },
          { id: 'fail-1', name: 'Fail 1', status: 'failed', runtimeMs: 3_000, threadId: 'fail-1' },
        ],
        counts: {
          agents: 0,
          shells: 0,
          running: 2,
          waiting: 1,
          failed: 1,
        },
      },
    }));

    expect(withFailure?.labels.tasks).toBe('2 Run  1 Wait  1 Fail');
    expect(
      elements.metrics.querySelector('[data-metric="tasks"]')?.querySelector('.status-metric-value')?.textContent,
    ).toBe('2 Run  1 Wait  1 Fail');

    const withoutFailure = controller.render(buildSample({
      summary: {
        tasks: [
          { id: 'run-1', name: 'Run 1', status: 'running', runtimeMs: 4_000, threadId: 'run-1' },
          { id: 'blocked-1', name: 'Blocked 1', status: 'blocked', runtimeMs: 2_000, threadId: 'blocked-1' },
        ],
        counts: {
          agents: 0,
          shells: 0,
          running: 1,
          waiting: 0,
          failed: 0,
        },
      },
    }));

    expect(withoutFailure?.labels.tasks).toBe('1 Run  0 Wait');
    expect(withoutFailure?.labels.tasks).not.toContain('Block');
    expect(withoutFailure?.labels.tasks).not.toContain('Fail');
  });

  it('shows overflow rows with live compact values and marks unavailable metrics without fabricating zeros', () => {
    const hiddenByWidth = createHarness({
      hidden: true,
      barWidth: 300,
    });
    hiddenByWidth.controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot({
        workspace: {
          cpuPercent: 55,
          memoryBytes: 512 * 1024 * 1024,
        },
      }),
      frame: {
        fps: 48,
        renderLatencyMs: 21,
        droppedFrames: 0,
      },
      summary: {
        counts: {
          agents: 1,
          shells: 0,
          running: 2,
          waiting: 1,
          failed: 1,
        },
      },
    }));
    hiddenByWidth.elements.more.dispatch('click');

    const hiddenTasksOpen = hiddenByWidth.elements.moreMenu.querySelector('[data-focus-key="more-open:tasks"]');
    expect(hiddenTasksOpen?.querySelector('.status-more-open-label')?.textContent).toBe('Tasks');
    expect(hiddenTasksOpen?.querySelector('.status-more-open-value')?.textContent).toBe('2 Run  1 Wait  1 Fail');
    expect(hiddenTasksOpen?.title).toBeTruthy();
    expect(
      hiddenByWidth.elements.moreMenu.querySelector('[data-focus-key="more-open:tasks"]')
        ?.parentElement?.querySelector('.status-more-meta')?.textContent,
    ).toContain('hidden by width');

    const unavailable = createHarness({ hidden: true });
    unavailable.controller.render(buildSample({
      nativeSnapshot: null,
      frame: {
        fps: null,
        renderLatencyMs: null,
        droppedFrames: null,
      },
    }));
    unavailable.elements.more.dispatch('click');

    const unavailablePerfOpen = unavailable.elements.moreMenu.querySelector('[data-focus-key="more-open:performance"]');
    expect(unavailablePerfOpen?.disabled).toBe(true);
    expect(unavailablePerfOpen?.querySelector('.status-more-open-label')?.textContent).toBe('Perf');
    expect(unavailablePerfOpen?.querySelector('.status-more-open-value')?.textContent).toBe('Unavailable');
    expect(unavailablePerfOpen?.parentElement?.querySelector('.status-more-meta')?.textContent).toContain('unavailable');
  });

  it('moves focus into the detail panel from More and restores it to More for overflowed metrics', () => {
    const { controller, doc, elements } = createHarness({
      hidden: true,
      barWidth: 300,
    });

    controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot({
        workspace: {
          cpuPercent: 55,
          memoryBytes: 512 * 1024 * 1024,
        },
      }),
      frame: {
        fps: 48,
        renderLatencyMs: 21,
        droppedFrames: 0,
      },
      summary: {
        counts: {
          agents: 1,
          shells: 0,
          running: 2,
          waiting: 1,
          failed: 1,
        },
      },
    }));
    controller.start();

    expect(controller.render()?.overflowed).toContain('tasks');
    expect(elements.metrics.querySelector('[data-metric="tasks"]')).toBeNull();

    elements.more.dispatch('click');
    const tasksOpen = elements.moreMenu.querySelector('[data-focus-key="more-open:tasks"]');
    expect(tasksOpen).not.toBeNull();
    tasksOpen?.focus();
    tasksOpen?.dispatch('click');

    const rebuiltTasksOpen = elements.moreMenu.querySelector('[data-focus-key="more-open:tasks"]');
    expect(elements.moreMenu.hidden).toBe(true);
    expect(doc.activeElement).toBe(elements.close);
    expect(doc.activeElement).not.toBe(rebuiltTasksOpen);

    elements.close.dispatch('click');
    expect(doc.activeElement).toBe(elements.more);

    controller.stop();
  });

  it('keeps pinning and visibility preferences in sync from the More menu', () => {
    const { controller, elements, readStoredPreferences } = createHarness({ hidden: true });

    controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot(),
    }));
    controller.start();

    elements.more.dispatch('click');
    let checkbox = elements.moreMenu.querySelector('[data-focus-key="more-show:performance"]');
    expect(checkbox?.checked).toBe(true);
    if (!checkbox) throw new Error('missing More visibility checkbox');
    checkbox.checked = false;
    checkbox.dispatch('change');

    let stored = readStoredPreferences();
    expect(stored?.visible).not.toContain('performance');
    expect(stored?.pinned).not.toContain('performance');

    const performanceOpen = elements.moreMenu.querySelector('[data-focus-key="more-open:performance"]');
    expect(performanceOpen).not.toBeNull();
    performanceOpen?.focus();
    performanceOpen?.dispatch('click');
    elements.pin.dispatch('click');

    stored = readStoredPreferences();
    expect(stored?.visible).toContain('performance');
    expect(stored?.pinned).toContain('performance');

    elements.more.dispatch('click');
    checkbox = elements.moreMenu.querySelector('[data-focus-key="more-show:performance"]');
    expect(checkbox?.checked).toBe(true);
    if (!checkbox) throw new Error('missing refreshed More visibility checkbox');
    checkbox.checked = false;
    checkbox.dispatch('change');

    stored = readStoredPreferences();
    expect(stored?.visible).not.toContain('performance');
    expect(stored?.pinned).not.toContain('performance');
    expect(elements.pin.textContent).toBe('Pin metric');

    const refreshedCheckbox = elements.moreMenu.querySelector('[data-focus-key="more-show:performance"]');
    const meta = refreshedCheckbox?.parentElement?.parentElement
      ?.querySelector('.status-more-meta')?.textContent ?? '';
    expect(meta).not.toContain('pinned');

    controller.stop();
  });

  it('times out hung native polls, keeps one controller poll active, and ignores late completions', async () => {
    const firstSnapshot = buildNativeSnapshot({
      sampledAtMs: 1_700_000_000_000,
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
    });
    const recoveredSnapshot = buildNativeSnapshot({
      sampledAtMs: 1_700_000_011_000,
      workspace: {
        cpuPercent: 77,
        memoryBytes: 768 * 1024 * 1024,
      },
      usedMemoryBytes: 800 * 1024 * 1024,
      memoryPressurePercent: 78,
    });
    const lateSnapshot = buildNativeSnapshot({
      sampledAtMs: 1_700_000_012_000,
      workspace: {
        cpuPercent: 3,
        memoryBytes: 64 * 1024 * 1024,
      },
    });
    const hanging = createDeferred<unknown>();
    let fetchCount = 0;
    const fetchMetrics = () => {
      fetchCount += 1;
      if (fetchCount === 1) return Promise.resolve(firstSnapshot);
      if (fetchCount === 2) return hanging.promise;
      if (fetchCount === 3) return Promise.resolve(recoveredSnapshot);
      return Promise.resolve(lateSnapshot);
    };
    const { controller, clock } = createHarness({ fetchMetrics });

    controller.start();
    await flushMicrotasks();
    await clock.advance(0);
    expect(fetchCount).toBe(1);
    expect(controller.render()?.labels.connection).toBe('Connected');

    await clock.advance(1_000);
    expect(fetchCount).toBe(2);

    const pending = controller.refresh();
    const queued = controller.refresh();
    expect(queued).toBe(pending);
    expect(fetchCount).toBe(2);

    await clock.advance(10_000);
    const timedOutView = await pending;
    expect(timedOutView?.labels.connection).toBe('Degraded');
    expect(fetchCount).toBe(3);

    await flushMicrotasks();
    const recoveredView = controller.render();
    expect(recoveredView?.labels.connection).toBe('Connected');
    expect(recoveredView?.labels.performance).toBe('77% 768M');

    hanging.resolve(lateSnapshot);
    await flushMicrotasks();
    expect(controller.render()?.labels.performance).toBe('77% 768M');

    controller.stop();
  });

  it('settles a stopped in-flight poll without mutating health state and ignores late completion after restart', async () => {
    const baselineSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
    });
    const hanging = createDeferred<unknown>();
    const recoveredSnapshot = buildNativeSnapshot({
      sampledAtMs: 1_700_000_010_000,
      workspace: {
        cpuPercent: 66,
        memoryBytes: 768 * 1024 * 1024,
      },
    });
    const lateSnapshot = buildNativeSnapshot({
      sampledAtMs: 1_700_000_020_000,
      workspace: {
        cpuPercent: 3,
        memoryBytes: 64 * 1024 * 1024,
      },
    });
    let fetchCount = 0;
    const fetchMetrics = () => {
      fetchCount += 1;
      if (fetchCount === 1) return hanging.promise;
      return Promise.resolve(recoveredSnapshot);
    };
    const { controller, timers } = createHarness({
      hidden: true,
      fetchMetrics,
    });

    controller.render(buildSample({
      nativeSnapshot: baselineSnapshot,
      nativeHealth: {
        status: 'ready',
        reconnects: 1,
        latencyMs: 5,
        lastSuccessAt: 1_700_000_000_000,
        error: '',
      },
    }));
    controller.start();

    const pending = controller.refresh();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(fetchCount).toBe(1);

    controller.stop();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(timers.size).toBe(0);

    const stoppedView = await pending;
    expect(stoppedView?.labels.connection).toBe('Connected');
    expect(stoppedView?.labels.performance).toBe('12% 256M');
    expect(controller.render()?.labels.performance).toBe('12% 256M');

    controller.start();
    const restarted = controller.refresh();
    hanging.resolve(lateSnapshot);
    await flushMicrotasks();

    const restartedView = await restarted;
    expect(restartedView?.labels.performance).toBe('66% 768M');
    expect(controller.render()?.labels.performance).toBe('66% 768M');

    controller.stop();
  });

  it('omits workspace native metrics after switching to focused until focused metrics arrive', async () => {
    const focused = createDeferred<unknown>();
    const currentContext = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const workspaceSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 82,
        memoryBytes: 700 * 1024 * 1024,
      },
    });
    const focusedSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 17,
        memoryBytes: 64 * 1024 * 1024,
      },
    });
    const fetchScopes: Array<{ threadId?: string } | undefined> = [];
    const { controller } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: (scope?: { threadId?: string }) => {
        fetchScopes.push(scope ? { ...scope } : undefined);
        return focused.promise;
      },
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: workspaceSnapshot,
    }));
    expect(controller.render()?.labels.performance).toBe('82% 700M');

    const pendingFocused = controller.setScope('focused');
    await flushMicrotasks();

    const pendingView = controller.render();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }]);
    expect(pendingView?.effectiveScope).toBe('focused');
    expect(pendingView?.labels.performance).toBeNull();
    expect(pendingView?.visibleMetrics).not.toContain('performance');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('cpuPercent');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('memoryBytes');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('memoryPressurePercent');

    focused.resolve(focusedSnapshot);
    const focusedView = await pendingFocused;
    expect(focusedView?.labels.performance).toBe('17% 64M');
    expect(controller.render()?.diagnostics.metrics.cpuPercent).toBe(17);
  });

  it('rebases a focused refresh to the new pane before the next native metrics response arrives', async () => {
    const deferredFocused = createDeferred<unknown>();
    const threadA = {
      id: 'thread-a',
      name: 'Thread A',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    const threadB = {
      id: 'thread-b',
      name: 'Thread B',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    let currentContext = {
      activeThreadId: 'thread-a',
      threads: [threadA, threadB],
      covenSessions: [],
    };
    const focusedSnapshotA = buildNativeSnapshot({
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
      processes: [{
        threadId: 'thread-a',
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
        processName: 'zsh',
        pid: 11,
      }],
    });
    const focusedSnapshotB = buildNativeSnapshot({
      workspace: {
        cpuPercent: 33,
        memoryBytes: 128 * 1024 * 1024,
      },
      processes: [{
        threadId: 'thread-b',
        cpuPercent: 33,
        memoryBytes: 128 * 1024 * 1024,
        processName: 'bash',
        pid: 22,
      }],
    });
    const rawActivity = {
      workspace: {
        bytesPerSecond: 65,
        linesPerSecond: 13,
        operationsPerSecond: 0,
        errors: 0,
      },
      threads: [
        {
          threadId: 'thread-a',
          bytesPerSecond: 20,
          linesPerSecond: 4,
        },
        {
          threadId: 'thread-b',
          bytesPerSecond: 45,
          linesPerSecond: 9,
        },
      ],
    };
    const fetchScopes: Array<{ threadId?: string } | undefined> = [];
    const { controller, elements } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: (scope?: { threadId?: string }) => {
        fetchScopes.push(scope ? { ...scope } : undefined);
        if (scope?.threadId === 'thread-b') {
          return deferredFocused.promise;
        }
        return Promise.resolve(focusedSnapshotA);
      },
    });

    await controller.setScope('focused');
    controller.render(buildSample({
      context: currentContext,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-a',
      },
      nativeSnapshot: focusedSnapshotA,
      activity: rawActivity,
    }));
    controller.toggleMetric('shells');

    expect(controller.render()?.labels.performance).toBe('12% 256M');
    expect(controller.render()?.labels.activity).toBe('4 l/s');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread A']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['12% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['256 MB']);
    expect(classTexts(elements.detailBody, 'status-row-task')).toContain('4 lines/s');
    expect(classTexts(elements.detailBody, 'status-row-meta')).toEqual(['zsh · PID 11']);

    currentContext = {
      ...currentContext,
      activeThreadId: 'thread-b',
    };
    const pending = controller.refresh();
    await flushMicrotasks();

    const pendingView = controller.render();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }, { threadId: 'thread-b' }]);
    expect(pendingView?.effectiveScope).toBe('focused');
    expect(pendingView?.labels.performance).toBeNull();
    expect(pendingView?.visibleMetrics).not.toContain('performance');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('cpuPercent');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('memoryBytes');
    expect(pendingView?.diagnostics.metrics).not.toHaveProperty('memoryPressurePercent');
    expect(pendingView?.labels.activity).toBe('9 l/s');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['CPU --']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['MEM --']);
    expect(classTexts(elements.detailBody, 'status-row-task')).toEqual(['9 lines/s']);
    expect(classTexts(elements.detailBody, 'status-row-meta')).toEqual([]);
    expect(elements.detailBody.textContent).not.toContain('Thread A');
    expect(elements.detailBody.textContent).not.toContain('12% CPU');
    expect(elements.detailBody.textContent).not.toContain('256 MB');
    expect(elements.detailBody.textContent).not.toContain('PID 11');
    expect(elements.detailBody.textContent).not.toContain('zsh');

    deferredFocused.resolve(focusedSnapshotB);
    const focusedView = await pending;
    expect(focusedView?.labels.performance).toBe('33% 128M');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['33% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['128 MB']);
    expect(classTexts(elements.detailBody, 'status-row-meta')).toEqual(['bash · PID 22']);
  });

  it('rebases a reused in-flight focused refresh before queuing the replacement poll', async () => {
    const inflightFocusedA = createDeferred<unknown>();
    const deferredFocusedB = createDeferred<unknown>();
    const threadA = {
      id: 'thread-a',
      name: 'Thread A',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    const threadB = {
      id: 'thread-b',
      name: 'Thread B',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    let currentContext = {
      activeThreadId: 'thread-a',
      threads: [threadA, threadB],
      covenSessions: [],
    };
    const focusedSnapshotA = buildNativeSnapshot({
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
      processes: [{
        threadId: 'thread-a',
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
        processName: 'zsh',
        pid: 11,
      }],
    });
    const lateFocusedSnapshotA = buildNativeSnapshot({
      workspace: {
        cpuPercent: 91,
        memoryBytes: 900 * 1024 * 1024,
      },
      processes: [{
        threadId: 'thread-a',
        cpuPercent: 91,
        memoryBytes: 900 * 1024 * 1024,
        processName: 'python',
        pid: 99,
      }],
    });
    const focusedSnapshotB = buildNativeSnapshot({
      workspace: {
        cpuPercent: 33,
        memoryBytes: 128 * 1024 * 1024,
      },
      processes: [{
        threadId: 'thread-b',
        cpuPercent: 33,
        memoryBytes: 128 * 1024 * 1024,
        processName: 'bash',
        pid: 22,
      }],
    });
    const rawActivity = {
      workspace: {
        bytesPerSecond: 65,
        linesPerSecond: 13,
        operationsPerSecond: 0,
        errors: 0,
      },
      threads: [
        {
          threadId: 'thread-a',
          bytesPerSecond: 20,
          linesPerSecond: 4,
        },
        {
          threadId: 'thread-b',
          bytesPerSecond: 45,
          linesPerSecond: 9,
        },
      ],
    };
    const fetchScopes: Array<{ threadId?: string } | undefined> = [];
    let fetchCount = 0;
    const { controller, elements } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: (scope?: { threadId?: string }) => {
        fetchScopes.push(scope ? { ...scope } : undefined);
        fetchCount += 1;
        if (fetchCount === 1) return Promise.resolve(focusedSnapshotA);
        if (fetchCount === 2) return inflightFocusedA.promise;
        return deferredFocusedB.promise;
      },
    });

    await controller.setScope('focused');
    controller.render(buildSample({
      context: currentContext,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-a',
      },
      nativeSnapshot: focusedSnapshotA,
      activity: rawActivity,
    }));
    controller.toggleMetric('shells');

    const pending = controller.refresh();
    await flushMicrotasks();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }, { threadId: 'thread-a' }]);

    currentContext = {
      ...currentContext,
      activeThreadId: 'thread-b',
    };
    const reused = controller.refresh();
    expect(reused).toBe(pending);

    const rebasedView = controller.render();
    expect(rebasedView?.effectiveScope).toBe('focused');
    expect(rebasedView?.labels.performance).toBeNull();
    expect(rebasedView?.labels.activity).toBe('9 l/s');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['CPU --']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['MEM --']);
    expect(classTexts(elements.detailBody, 'status-row-task')).toEqual(['9 lines/s']);
    expect(classTexts(elements.detailBody, 'status-row-meta')).toEqual([]);
    expect(elements.detailBody.textContent).not.toContain('Thread A');
    expect(elements.detailBody.textContent).not.toContain('PID 11');

    inflightFocusedA.resolve(lateFocusedSnapshotA);
    const discardedView = await pending;
    await flushMicrotasks();

    expect(discardedView?.labels.performance).toBeNull();
    expect(fetchScopes).toEqual([
      { threadId: 'thread-a' },
      { threadId: 'thread-a' },
      { threadId: 'thread-b' },
    ]);
    expect(controller.render()?.labels.performance).toBeNull();
    expect(controller.render()?.labels.activity).toBe('9 l/s');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(elements.detailBody.textContent).not.toContain('python');
    expect(elements.detailBody.textContent).not.toContain('PID 99');
    expect(elements.detailBody.textContent).not.toContain('900 MB');

    deferredFocusedB.resolve(focusedSnapshotB);
    await flushMicrotasks();

    expect(controller.render()?.labels.performance).toBe('33% 128M');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['33% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['128 MB']);
    expect(classTexts(elements.detailBody, 'status-row-meta')).toEqual(['bash · PID 22']);
  });

  it('discards focused results after a mid-poll scope switch and immediately refreshes the new scope', async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    let currentContext = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'thread-b',
          name: 'Thread B',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const fetchScopes: Array<{ threadId?: string } | undefined> = [];
    let fetchCount = 0;
    const fetchMetrics = (scope?: { threadId?: string }) => {
      fetchScopes.push(scope ? { ...scope } : undefined);
      fetchCount += 1;
      return fetchCount === 1 ? first.promise : second.promise;
    };
    const { controller } = createHarness({
      hidden: true,
      fetchMetrics,
      getContext: () => currentContext,
    });

    controller.render(buildSample({
      context: currentContext,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-a',
      },
      nativeSnapshot: buildNativeSnapshot({
        workspace: {
          cpuPercent: 12,
          memoryBytes: 256 * 1024 * 1024,
        },
      }),
    }));
    controller.start();

    const pendingFocused = controller.setScope('focused');
    await flushMicrotasks();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }]);

    currentContext = {
      ...currentContext,
      activeThreadId: 'thread-b',
    };
    const queuedWorkspace = controller.setScope('workspace');
    expect(queuedWorkspace).toBe(pendingFocused);
    expect(controller.render()?.effectiveScope).toBe('workspace');
    expect(controller.render()?.labels.performance).toBeNull();

    first.resolve(buildNativeSnapshot({
      workspace: {
        cpuPercent: 5,
        memoryBytes: 128 * 1024 * 1024,
      },
    }));

    const discardedView = await pendingFocused;
    await flushMicrotasks();

    expect(discardedView?.labels.performance).toBeNull();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }, undefined]);
    expect(controller.render()?.labels.performance).toBeNull();

    second.resolve(buildNativeSnapshot({
      workspace: {
        cpuPercent: 88,
        memoryBytes: 900 * 1024 * 1024,
      },
    }));
    await flushMicrotasks();

    expect(controller.render()?.effectiveScope).toBe('workspace');
    expect(controller.render()?.labels.performance).toBe('88% 900M');

    controller.stop();
  });

  it('updates workspace counts immediately when threads are added or removed before native metrics return', async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const shellA = {
      id: 'shell-a',
      name: 'Shell A',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    const shellB = {
      id: 'shell-b',
      name: 'Shell B',
      kind: 'shell',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    const agentC = {
      id: 'agent-c',
      name: 'Agent C',
      kind: 'coven-attach',
      status: 'running',
      processBacked: true,
      startedAt: 0,
    };
    const workspaceSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 44,
        memoryBytes: 512 * 1024 * 1024,
      },
    });
    let currentContext = {
      activeThreadId: 'shell-a',
      threads: [shellA],
      covenSessions: [],
    };
    let fetchCount = 0;
    const { controller } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: () => {
        fetchCount += 1;
        return fetchCount === 1 ? first.promise : second.promise;
      },
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: workspaceSnapshot,
      activity: {
        workspace: {
          bytesPerSecond: 52,
          linesPerSecond: 13,
          operationsPerSecond: 2,
          errors: 0,
        },
        threads: [{
          threadId: 'shell-a',
          bytesPerSecond: 52,
          linesPerSecond: 13,
        }],
      },
    }));

    currentContext = {
      activeThreadId: 'shell-a',
      threads: [shellA, shellB, agentC],
      covenSessions: [],
    };
    const pending = controller.refresh();

    expect(controller.render()?.effectiveScope).toBe('workspace');
    expect(controller.render()?.labels.agents).toBe('1');
    expect(controller.render()?.labels.shells).toBe('2');
    expect(controller.render()?.labels.tasks).toBe('3 Run  0 Wait');
    expect(controller.render()?.labels.activity).toBe('13 l/s');

    currentContext = {
      activeThreadId: 'shell-a',
      threads: [shellA],
      covenSessions: [],
    };
    const queued = controller.refresh();

    expect(queued).toBe(pending);
    expect(controller.render()?.labels.agents).toBe('0');
    expect(controller.render()?.labels.shells).toBe('1');
    expect(controller.render()?.labels.tasks).toBe('1 Run  0 Wait');
    expect(controller.render()?.labels.activity).toBe('13 l/s');

    first.resolve(workspaceSnapshot);
    await pending;
    await flushMicrotasks();
    expect(fetchCount).toBe(2);

    second.resolve(workspaceSnapshot);
    await flushMicrotasks();

    expect(controller.render()?.labels.agents).toBe('0');
    expect(controller.render()?.labels.shells).toBe('1');
    expect(controller.render()?.labels.tasks).toBe('1 Run  0 Wait');
  });

  it('keeps timed-out superseded focused polls from rendering stale snapshots while global health recovers on workspace success', async () => {
    const focused = createDeferred<unknown>();
    const workspace = createDeferred<unknown>();
    const context = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const fetchScopes: Array<{ threadId?: string } | undefined> = [];
    let fetchCount = 0;
    const fetchMetrics = (scope?: { threadId?: string }) => {
      fetchScopes.push(scope ? { ...scope } : undefined);
      fetchCount += 1;
      return fetchCount === 1 ? focused.promise : workspace.promise;
    };
    const { controller, clock, elements } = createHarness({
      hidden: true,
      fetchMetrics,
      getContext: () => context,
    });

    controller.render(buildSample({
      context,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-a',
      },
      nativeSnapshot: buildNativeSnapshot({
        workspace: {
          cpuPercent: 12,
          memoryBytes: 256 * 1024 * 1024,
        },
      }),
    }));
    controller.start();

    const pendingFocused = controller.setScope('focused');
    await flushMicrotasks();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }]);

    const queuedWorkspace = controller.setScope('workspace');
    expect(queuedWorkspace).toBe(pendingFocused);
    expect(controller.render()?.labels.performance).toBeNull();

    await clock.advance(9_999);
    expect(controller.render()?.labels.connection).toBe('Connected');

    await clock.advance(1);
    const timedOutView = await pendingFocused;

    expect(timedOutView?.labels.performance).toBeNull();
    expect(fetchScopes).toEqual([{ threadId: 'thread-a' }, undefined]);
    expect(controller.render()?.labels.performance).toBeNull();
    expect(controller.render()?.labels.connection).toBe('Degraded');

    controller.toggleMetric('connection');
    expect(classTexts(elements.detailBody, 'status-row-state')[0]).toBe('degraded');
    expect(classTexts(elements.detailBody, 'status-row-task')[0]).toBe('Native metrics timed out after 10s');

    workspace.resolve(buildNativeSnapshot({
      sampledAtMs: clock.now(),
      workspace: {
        cpuPercent: 88,
        memoryBytes: 900 * 1024 * 1024,
      },
    }));
    await flushMicrotasks();

    expect(controller.render()?.labels.connection).toBe('Connected');
    expect(controller.render()?.labels.performance).toBe('88% 900M');
    expect(classTexts(elements.detailBody, 'status-row-state')[0]).toBe('ready');
    expect(classTexts(elements.detailBody, 'status-row-task')).toEqual([]);

    controller.stop();
  });

  it('never reuses focused A native metrics under focused B and keeps B unavailable until B succeeds', async () => {
    let currentContext = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'thread-b',
          name: 'Thread B',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const focusedASnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
      processes: [
        {
          threadId: 'thread-a',
          cpuPercent: 12,
          memoryBytes: 256 * 1024 * 1024,
          processName: 'zsh-a',
          pid: 11,
        },
      ],
    });
    const focusedBSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 34,
        memoryBytes: 128 * 1024 * 1024,
      },
      processes: [
        {
          threadId: 'thread-b',
          cpuPercent: 34,
          memoryBytes: 128 * 1024 * 1024,
          processName: 'zsh-b',
          pid: 22,
        },
      ],
    });
    let fetchCount = 0;
    const { controller, elements } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: (scope?: { threadId?: string }) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          expect(scope).toEqual({ threadId: 'thread-a' });
          return Promise.resolve(focusedASnapshot);
        }
        if (fetchCount === 2) {
          expect(scope).toEqual({ threadId: 'thread-b' });
          return Promise.reject(new Error('Native metrics unavailable for Thread B'));
        }
        expect(scope).toEqual({ threadId: 'thread-b' });
        return Promise.resolve(focusedBSnapshot);
      },
    });

    controller.render(buildSample({
      context: currentContext,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-a',
      },
      nativeSnapshot: focusedASnapshot,
    }));
    await controller.setScope('focused');
    expect(controller.render()?.labels.performance).toBe('12% 256M');

    controller.toggleMetric('shells');
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['12% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['256 MB']);

    currentContext = {
      ...currentContext,
      activeThreadId: 'thread-b',
    };
    const switchedView = controller.render(buildSample({
      context: currentContext,
      scopeState: {
        focusedAvailable: true,
        scopeName: 'focused',
        activeThreadId: 'thread-b',
      },
      nativeSnapshot: null,
    }));
    expect(switchedView?.effectiveScope).toBe('focused');
    expect(switchedView?.labels.performance).toBeNull();
    expect(switchedView?.diagnostics.metrics).not.toHaveProperty('cpuPercent');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Thread B']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['CPU --']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['MEM --']);
    expect(elements.detailBody.textContent).not.toContain('zsh-a');
    expect(elements.detailBody.textContent).not.toContain('PID 11');

    await controller.refresh();
    expect(controller.render()?.labels.performance).toBeNull();
    expect(controller.render()?.diagnostics.metrics).not.toHaveProperty('cpuPercent');
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['CPU --']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['MEM --']);

    const recoveredView = await controller.refresh();
    expect(recoveredView?.labels.performance).toBe('34% 128M');
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['34% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['128 MB']);
    expect(elements.detailBody.textContent).toContain('zsh-b');
    expect(elements.detailBody.textContent).toContain('PID 22');
  });

  it('reuses only the workspace native cache when switching back from focused', async () => {
    const currentContext = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const workspaceSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 82,
        memoryBytes: 700 * 1024 * 1024,
      },
    });
    const focusedSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 17,
        memoryBytes: 64 * 1024 * 1024,
      },
    });
    const refreshedWorkspaceSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 90,
        memoryBytes: 900 * 1024 * 1024,
      },
    });
    const pendingWorkspace = createDeferred<unknown>();
    let fetchCount = 0;
    const { controller } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: (scope?: { threadId?: string }) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          expect(scope).toEqual({ threadId: 'thread-a' });
          return Promise.resolve(focusedSnapshot);
        }
        expect(scope).toBeUndefined();
        return pendingWorkspace.promise;
      },
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: workspaceSnapshot,
    }));
    expect(controller.render()?.labels.performance).toBe('82% 700M');

    await controller.setScope('focused');
    expect(controller.render()?.effectiveScope).toBe('focused');
    expect(controller.render()?.labels.performance).toBe('17% 64M');

    const pendingWorkspaceRefresh = controller.setScope('workspace');
    const workspaceView = controller.render();
    expect(workspaceView?.effectiveScope).toBe('workspace');
    expect(workspaceView?.labels.performance).toBe('82% 700M');
    expect(workspaceView?.diagnostics.metrics.cpuPercent).toBe(82);
    expect(workspaceView?.labels.performance).not.toBe('17% 64M');

    pendingWorkspace.resolve(refreshedWorkspaceSnapshot);
    const refreshedView = await pendingWorkspaceRefresh;
    expect(refreshedView?.labels.performance).toBe('90% 900M');
    expect(controller.render()?.labels.performance).toBe('90% 900M');
  });

  it('degrades at 10s stale age and disconnects at 30s even while a native poll stays hung', async () => {
    const hanging = createDeferred<unknown>();
    let fetchCount = 0;
    const fetchMetrics = () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve(buildNativeSnapshot({
          sampledAtMs: 1_700_000_000_000,
        }));
      }
      return hanging.promise;
    };
    const { controller, clock } = createHarness({
      fetchMetrics,
      nativePollTimeoutMs: 60_000,
    });

    controller.start();
    await flushMicrotasks();
    await clock.advance(0);
    await clock.advance(1_000);

    await clock.advance(8_999);
    expect(controller.render()?.labels.connection).toBe('Connected');

    await clock.advance(1);
    expect(controller.render()?.labels.connection).toBe('Degraded');

    await clock.advance(20_000);
    expect(controller.render()?.labels.connection).toBe('Disconnected');

    controller.stop();
  });

  it('renders connection state copy and indicator affordances without making healthy text semantic-colored', () => {
    const { controller, elements } = createHarness({ hidden: true });

    controller.render(buildSample());

    const readyMetric = elements.metrics.querySelector('[data-metric="connection"]');
    const readyValue = readyMetric?.querySelector('.status-metric-value');
    expect(readyValue?.dataset.connectionState).toBe('connected');
    expect(readyValue?.querySelector('.status-connection-indicator')).not.toBeNull();
    expect(readyValue?.querySelector('.status-connection-text')?.textContent).toBe('Connected');

    controller.render(buildSample({
      nativeHealth: {
        status: 'starting',
        reconnects: 0,
        latencyMs: null,
        lastSuccessAt: null,
        error: '',
      },
    }));
    const connectingValue = elements.metrics
      .querySelector('[data-metric="connection"]')
      ?.querySelector('.status-metric-value');
    expect(connectingValue?.dataset.connectionState).toBe('connecting');
    expect(connectingValue?.querySelector('.status-connection-text')?.textContent).toBe('Connecting');

    controller.render(buildSample({
      nativeHealth: {
        status: 'ready',
        reconnects: 0,
        latencyMs: 9,
        lastSuccessAt: 1_700_000_000_000,
      },
      covenHealth: {
        phase: 'error',
        reconnects: 1,
        latencyMs: 25,
        refreshedAt: 1_700_000_000_000,
        error: 'timeout',
      },
    }));
    const degradedMetric = elements.metrics.querySelector('[data-metric="connection"]');
    const degradedValue = degradedMetric?.querySelector('.status-metric-value');
    expect(degradedValue?.dataset.connectionState).toBe('degraded');
    expect(degradedValue?.querySelector('.status-connection-text')?.textContent).toBe('Degraded');

    controller.render(buildSample({
      nativeHealth: {
        status: 'ready',
        reconnects: 2,
        latencyMs: null,
        lastSuccessAt: 1_699_999_960_000,
        error: 'offline',
      },
    }));
    const disconnectedMetric = elements.metrics.querySelector('[data-metric="connection"]');
    const disconnectedValue = disconnectedMetric?.querySelector('.status-metric-value');
    expect(disconnectedValue?.dataset.connectionState).toBe('disconnected');
    expect(disconnectedValue?.querySelector('.status-connection-text')?.textContent).toBe('Disconnected');
  });

  it('renders stale age and last refresh, and never substitutes unavailable age with zero', () => {
    const stale = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });
    stale.controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot(),
      nativeHealth: {
        reconnects: 1,
        latencyMs: 22,
        lastSuccessAt: 1_700_000_017_655,
        error: 'Native metrics timed out after 10s',
      },
    }));
    stale.controller.toggleMetric('connection');

    const staleMeta = classTexts(stale.elements.detailBody, 'status-row-meta')[0] ?? '';
    expect(staleMeta).toContain('Reconnects 1');
    expect(staleMeta).toContain('Stale 12s');
    expect(staleMeta).toContain('Last refresh');
    expect(staleMeta).not.toContain('Stale 0s');

    const unavailable = createHarness({
      hidden: true,
      nowMs: 1_700_000_030_000,
    });
    const nativeFailureHistorySample: StatusControllerSample = {
      sampledAt: 1_700_000_030_000,
      nativeHealth: {
        reconnects: 0,
        latencyMs: 18,
        lastSuccessAt: null,
        failureAt: [
          1_700_000_001_000,
          1_700_000_005_000,
          1_700_000_010_000,
          1_700_000_015_000,
          1_700_000_020_000,
        ],
        error: 'Native metrics timed out after 10s',
      },
    };
    unavailable.controller.render(nativeFailureHistorySample);
    unavailable.controller.toggleMetric('connection');

    const unavailableMeta = classTexts(unavailable.elements.detailBody, 'status-row-meta')[0] ?? '';
    expect(unavailableMeta).toContain('Stale age unavailable');
    expect(unavailableMeta).toContain('Last refresh unavailable');
    expect(unavailableMeta).not.toContain('Stale 0s');
  });

  it('hides FPS until a real frame interval exists and shows zero dropped frames once sampled', () => {
    const { controller, elements } = createHarness({ hidden: true });
    const nativeSnapshot = {
      workspace: {
        cpuPercent: 12,
        memoryBytes: 256 * 1024 * 1024,
      },
      usedMemoryBytes: 512 * 1024 * 1024,
      totalMemoryBytes: 1024 * 1024 * 1024,
      memoryPressurePercent: 50,
      processes: [],
    };

    const unavailableView = controller.render(buildSample({
      nativeSnapshot,
      frame: {
        fps: null,
        renderLatencyMs: null,
        droppedFrames: null,
      },
    }));

    expect(unavailableView?.visibleMetrics).not.toContain('fps');
    expect(elements.metrics.querySelector('[data-metric="fps"]')).toBeNull();

    controller.toggleMetric('performance');
    expect(classTexts(elements.detailBody, 'status-cell-label')).toEqual(['CPU', 'Memory']);
    expect(classTexts(elements.detailBody, 'status-cell-value')).not.toContain('0 FPS');

    const sampledView = controller.render(buildSample({
      nativeSnapshot,
      frame: {
        fps: 60,
        renderLatencyMs: 16.7,
        droppedFrames: 0,
      },
    }));

    expect(sampledView?.visibleMetrics).toContain('fps');
    expect(elements.metrics.querySelector('[data-metric="fps"]')).not.toBeNull();
    expect(classTexts(elements.detailBody, 'status-cell-label')).toContain('Frame rate');
    expect(classTexts(elements.detailBody, 'status-cell-label')).toContain('Dropped');
    expect(classTexts(elements.detailBody, 'status-cell-value')).toContain('60 FPS');
    expect(classTexts(elements.detailBody, 'status-cell-value')).toContain('0');
  });

  it('scopes focused compact metrics, panels, and diagnostics to the active pane while workspace still aggregates', async () => {
    const focusedThreadId = 'focus-shell';
    const focusedProcess = {
      threadId: focusedThreadId,
      cpuPercent: 17,
      memoryBytes: 64 * 1024 * 1024,
      processName: 'zsh',
      pid: 11,
    };
    const backgroundShellProcess = {
      threadId: 'background-shell',
      cpuPercent: 41,
      memoryBytes: 96 * 1024 * 1024,
      processName: 'bash',
      pid: 12,
    };
    const workspaceSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 82,
        memoryBytes: 700 * 1024 * 1024,
      },
      processes: [
        focusedProcess,
        backgroundShellProcess,
      ],
    });
    const focusedSnapshot = buildNativeSnapshot({
      workspace: {
        cpuPercent: 17,
        memoryBytes: 64 * 1024 * 1024,
      },
      processes: [focusedProcess],
    });
    let currentContext = {
      activeThreadId: focusedThreadId,
      threads: [
        {
          id: focusedThreadId,
          name: 'Focused Shell',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'background-shell',
          name: 'Background Shell',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'background-task',
          name: 'Background Task',
          kind: 'exec',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'background-agent',
          name: 'Background Agent',
          kind: 'coven-attach',
          status: 'running',
          processBacked: true,
          covenSessionId: 'attached-session',
          startedAt: 0,
        },
      ],
      covenSessions: [
        {
          id: 'attached-session',
          title: 'Attached session',
          status: 'waiting',
          currentTask: 'Remote attached task',
          createdAt: 0,
        },
        {
          id: 'workspace-remote',
          title: 'Workspace Remote',
          status: 'running',
          currentTask: 'Workspace only',
          createdAt: 0,
        },
      ],
      agentToolCalls: 7,
    };
    const { controller, elements, clock } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: async (scope?: { threadId?: string }) => (
        scope?.threadId === focusedThreadId ? focusedSnapshot : workspaceSnapshot
      ),
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: workspaceSnapshot,
      nativeHealth: {
        lastSuccessAt: clock.now(),
      },
    }));

    await clock.advance(1_000);
    controller.notePtyData(focusedThreadId, 'focus\n'.repeat(4), clock.now());
    controller.notePtyData('background-shell', 'bg\n'.repeat(11), clock.now());
    for (let count = 0; count < 7; count += 1) {
      controller.noteOperation({ name: 'shell_exec', ok: false });
    }
    await controller.setScope('focused');

    const focusedView = controller.render();
    expect(focusedView?.effectiveScope).toBe('focused');
    expect(focusedView?.labels.agents).toBe('0');
    expect(focusedView?.labels.shells).toBe('1');
    expect(focusedView?.labels.tasks).toBe('1 Run  0 Wait');
    expect(focusedView?.labels.activity).toBe('4 l/s');

    controller.toggleMetric('agents');
    expect(elements.detailBody.textContent).toContain('No active agents.');

    controller.toggleMetric('shells');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Focused Shell']);
    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['17% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['64 MB']);
    expect(elements.detailBody.textContent).not.toContain('Background Shell');

    controller.toggleMetric('tasks');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual(['Focused Shell']);
    expect(elements.detailBody.textContent).not.toContain('Background Task');
    expect(elements.detailBody.textContent).not.toContain('Workspace Remote');

    controller.toggleMetric('activity');
    expect(classTexts(elements.detailBody, 'status-cell-label')).toEqual(['Lines', 'Bytes']);
    expect(elements.detailBody.textContent).not.toContain('Ops');
    expect(elements.detailBody.textContent).not.toContain('Errors');
    expect(elements.detailBody.textContent).not.toContain('Agent tools');

    const focusedDiagnostics = controller.render()?.diagnostics;
    expect(focusedDiagnostics?.scope).toBe('focused');
    expect(focusedDiagnostics?.metrics).toMatchObject({
      outputLinesPerSecond: 4,
      outputBytesPerSecond: 24,
    });
    expect('operationsPerSecond' in (focusedDiagnostics?.metrics ?? {})).toBe(false);
    expect('errors' in (focusedDiagnostics?.metrics ?? {})).toBe(false);
    expect(focusedDiagnostics?.trends?.operationsPerSecond).toBeUndefined();
    expect(focusedDiagnostics?.trends?.errors).toBeUndefined();

    await clock.advance(1_000);
    controller.notePtyData(focusedThreadId, 'focus\n'.repeat(4), clock.now());
    controller.notePtyData('background-shell', 'bg\n'.repeat(11), clock.now());
    for (let count = 0; count < 7; count += 1) {
      controller.noteOperation({ name: 'shell_exec', ok: false });
    }
    await controller.setScope('workspace');

    const workspaceView = controller.render();
    expect(workspaceView?.effectiveScope).toBe('workspace');
    expect(workspaceView?.labels.agents).toBe('2');
    expect(workspaceView?.labels.shells).toBe('2');
    expect(workspaceView?.labels.tasks).toBe('5 Run  0 Wait');
    expect(workspaceView?.labels.activity).toBe('15 l/s');

    controller.toggleMetric('agents');
    expect(classTexts(elements.detailBody, 'status-row-name')).toEqual([
      'Background Agent',
      'Workspace Remote',
    ]);

    controller.toggleMetric('activity');
    expect(classTexts(elements.detailBody, 'status-cell-label')).toEqual([
      'Lines',
      'Bytes',
      'Ops',
      'Errors',
      'Agent tools',
    ]);

    const workspaceDiagnostics = controller.render()?.diagnostics;
    expect(workspaceDiagnostics?.metrics).toMatchObject({
      outputLinesPerSecond: 15,
      outputBytesPerSecond: 57,
      operationsPerSecond: 7,
      errors: 7,
    });
    expect(workspaceDiagnostics?.trends?.operationsPerSecond).toEqual([7]);
    expect(workspaceDiagnostics?.trends?.errors).toEqual([7]);
  });

  it('resets activity trends, severity, and spikes across scope and focused-thread changes', async () => {
    let currentContext = {
      activeThreadId: 'thread-a',
      threads: [
        {
          id: 'thread-a',
          name: 'Thread A',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
        {
          id: 'thread-b',
          name: 'Thread B',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 0,
        },
      ],
      covenSessions: [],
    };
    const { controller, elements, clock } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: async (scope?: { threadId?: string }) => buildNativeSnapshot({
        sampledAtMs: clock.now(),
        workspace: {
          cpuPercent: scope?.threadId === 'thread-b' ? 22 : 18,
          memoryBytes: 64 * 1024 * 1024,
        },
      }),
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: buildNativeSnapshot({
        sampledAtMs: clock.now(),
      }),
      nativeHealth: {
        lastSuccessAt: clock.now(),
      },
    }));

    for (let count = 0; count < 5; count += 1) {
      await clock.advance(1_000);
      controller.notePtyData('thread-a', 'low\n'.repeat(10), clock.now());
      await controller.refresh();
    }
    for (let count = 0; count < 3; count += 1) {
      await clock.advance(1_000);
      controller.notePtyData('thread-a', 'high\n'.repeat(1_500), clock.now());
      await controller.refresh();
    }

    const workspaceView = controller.render();
    expect(workspaceView?.metricSeverity.activity).toBe('warn');
    expect(workspaceView?.diagnostics.trends?.outputLinesPerSecond).toEqual([
      10,
      10,
      10,
      10,
      10,
      1_500,
      1_500,
      1_500,
    ]);

    controller.toggleMetric('activity');
    expect(elements.detailBody.textContent).not.toContain('No recent activity spikes.');

    await clock.advance(1_000);
    controller.notePtyData('thread-a', 'focus\n'.repeat(5), clock.now());
    await controller.setScope('focused');

    let focusedView = controller.render();
    expect(focusedView?.effectiveScope).toBe('focused');
    expect(focusedView?.metricSeverity.activity).toBe('neutral');
    expect(focusedView?.diagnostics.trends?.outputLinesPerSecond).toEqual([5]);
    expect(elements.detailBody.textContent).toContain('No recent activity spikes.');

    currentContext = {
      ...currentContext,
      activeThreadId: 'thread-b',
    };
    await clock.advance(1_000);
    controller.notePtyData('thread-b', 'next\n'.repeat(9), clock.now());
    await controller.refresh();

    focusedView = controller.render();
    expect(focusedView?.diagnostics.trends?.outputLinesPerSecond).toEqual([9]);
    expect(focusedView?.metricSeverity.activity).toBe('neutral');
  });

  it('prunes exited and removed pane activity after fresh context updates', async () => {
    const shellId = 'shell-1';
    const process = {
      threadId: shellId,
      cpuPercent: 21,
      memoryBytes: 64 * 1024 * 1024,
      processName: 'zsh',
      pid: 21,
    };
    let currentContext: {
      activeThreadId: string | null;
      threads: Array<{
        id: string;
        name: string;
        kind: string;
        status: string;
        processBacked: boolean;
        startedAt: number;
        finishedAt?: number;
        exitCode?: number | null;
      }>;
      covenSessions: unknown[];
    } = {
      activeThreadId: shellId,
      threads: [{
        id: shellId,
        name: 'Shell 1',
        kind: 'shell',
        status: 'running',
        processBacked: true,
        startedAt: 0,
      }],
      covenSessions: [],
    };
    const { controller, elements, clock } = createHarness({
      hidden: true,
      getContext: () => currentContext,
      fetchMetrics: async () => buildNativeSnapshot({
        sampledAtMs: clock.now(),
        workspace: {
          cpuPercent: 21,
          memoryBytes: 64 * 1024 * 1024,
        },
        processes: currentContext.threads.some((thread) => thread.id === shellId && thread.status === 'running')
          ? [process]
          : [],
      }),
    });

    controller.render(buildSample({
      context: currentContext,
      nativeSnapshot: buildNativeSnapshot({
        sampledAtMs: clock.now(),
        processes: [process],
      }),
      nativeHealth: {
        lastSuccessAt: clock.now(),
      },
    }));

    await clock.advance(1_000);
    controller.notePtyData(shellId, 'line\n'.repeat(8), clock.now());
    await controller.refresh();

    expect(controller.render()?.labels.shells).toBe('1');
    expect(controller.render()?.labels.activity).toBe('8 l/s');

    currentContext = {
      activeThreadId: null,
      threads: [{
        id: shellId,
        name: 'Shell 1',
        kind: 'shell',
        status: 'exited',
        processBacked: true,
        startedAt: 0,
        finishedAt: clock.now(),
        exitCode: 0,
      }],
      covenSessions: [],
    };
    await clock.advance(1_000);
    await controller.refresh();

    expect(controller.render()?.labels.shells).toBe('0');
    expect(controller.render()?.labels.activity).toBe('idle');
    controller.toggleMetric('shells');
    expect(elements.detailBody.textContent).toContain('No active shells.');

    currentContext = {
      activeThreadId: null,
      threads: [],
      covenSessions: [],
    };
    await clock.advance(1_000);
    await controller.refresh();

    expect(controller.render()?.labels.shells).toBe('0');
    expect(controller.render()?.diagnostics.metrics.outputLinesPerSecond).toBe(0);
  });

  it('renders Agent tools only for finite structured counts', () => {
    const { controller, elements } = createHarness({ hidden: true });

    controller.render(buildSample({
      context: {
        agentToolCalls: 7,
      },
    }));
    controller.toggleMetric('activity');
    expect(classTexts(elements.detailBody, 'status-cell-label')).toContain('Agent tools');
    expect(classTexts(elements.detailBody, 'status-cell-value')).toContain('7');

    controller.render(buildSample({
      context: {
        agentToolCalls: '7',
      },
    }));
    expect(classTexts(elements.detailBody, 'status-cell-label')).not.toContain('Agent tools');
  });

  it('renders Errors activity with its own peak metadata, diagnostics, and sparkline trend', async () => {
    const { controller, elements, clock } = createHarness({
      hidden: true,
      fetchMetrics: async () => buildNativeSnapshot({
        sampledAtMs: clock.now(),
      }),
    });

    controller.render(buildSample({
      nativeSnapshot: buildNativeSnapshot({
        sampledAtMs: clock.now(),
      }),
      nativeHealth: {
        lastSuccessAt: clock.now(),
      },
    }));
    controller.toggleMetric('activity');

    controller.notePtyData('shell', `${'line\n'.repeat(5)}`, clock.now());
    await controller.refresh();

    await clock.advance(1_000);
    controller.notePtyData('shell', `${'line\n'.repeat(12)}`, clock.now());
    for (let count = 0; count < 4; count += 1) {
      controller.noteOperation({ name: 'shell_exec', ok: false });
    }
    await controller.refresh();

    await clock.advance(1_000);
    controller.notePtyData('shell', `${'line\n'.repeat(18)}`, clock.now());
    controller.noteOperation({ name: 'shell_exec', ok: false });
    await controller.refresh();

    const linesCell = findCellByLabel(elements.detailBody, 'status-activity-cell', 'Lines');
    const errorsCell = findCellByLabel(elements.detailBody, 'status-activity-cell', 'Errors');
    const diagnostics = controller.render()?.diagnostics;

    expect(errorsCell?.querySelector('.status-cell-meta')?.textContent).toBe('Peak 4 failures / sample');
    expect(sparklineData(errorsCell)).not.toBe(sparklineData(linesCell));
    expect(diagnostics?.peaks).toMatchObject({ errors: 4 });
    expect(diagnostics?.trends?.errors).toEqual([0, 4, 1]);
  });

  it('renders shell CPU, memory, and output fields independently without NaN placeholders', () => {
    const { controller, elements } = createHarness({ hidden: true });
    const shellSummary = {
      shells: [{
        id: 'shell-1',
        name: 'Shell 1',
        status: 'running' as const,
        runtimeMs: 4_000,
        threadId: 'shell-1',
      }],
      counts: {
        agents: 0,
        shells: 1,
        running: 1,
        waiting: 0,
        failed: 0,
      },
    };

    controller.render(buildSample({
      summary: shellSummary,
      nativeSnapshot: buildNativeSnapshot({
        processes: [{
          threadId: 'shell-1',
          memoryBytes: 128 * 1024 * 1024,
          processName: 'zsh',
          pid: 42,
        }],
      }),
      activity: {
        workspace: {
          bytesPerSecond: 0,
          linesPerSecond: 0,
          operationsPerSecond: 0,
          errors: 0,
        },
        threads: [{
          threadId: 'shell-1',
          bytesPerSecond: 512,
          linesPerSecond: Number.NaN,
        }],
      },
    }));
    controller.toggleMetric('shells');

    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['CPU --']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['128 MB']);
    expect(classTexts(elements.detailBody, 'status-row-task')).not.toContain('0 lines/s');
    expect(elements.detailBody.textContent).not.toContain('NaN% CPU');

    controller.render(buildSample({
      summary: shellSummary,
      nativeSnapshot: buildNativeSnapshot({
        processes: [{
          threadId: 'shell-1',
          cpuPercent: 34.2,
          processName: 'zsh',
          pid: 42,
        }],
      }),
      activity: {
        workspace: {
          bytesPerSecond: 0,
          linesPerSecond: 0,
          operationsPerSecond: 0,
          errors: 0,
        },
        threads: [{
          threadId: 'shell-1',
          bytesPerSecond: 512,
          linesPerSecond: 7,
        }],
      },
    }));

    expect(classTexts(elements.detailBody, 'status-row-state')).toEqual(['34% CPU']);
    expect(classTexts(elements.detailBody, 'status-row-runtime')).toEqual(['MEM --']);
    expect(classTexts(elements.detailBody, 'status-row-task')).toContain('7 lines/s');
  });
});
