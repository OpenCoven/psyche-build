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
    unavailable.controller.render(buildSample({
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
    }));
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
});
