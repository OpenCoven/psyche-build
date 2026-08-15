import {
  DEFAULT_METRIC_ORDER,
  METRICS,
  chooseVisibleMetrics,
  createActivityTracker,
  createFrameSampler,
  evaluateSeverity,
  flushActivity,
  formatLiveDiagnostics,
  median,
  normalizePreferences,
  noteOperation as noteOperationMetric,
  notePtyChunk,
  pushTrend,
  samplingDelay,
  sparklinePath,
  summarizeWorkspace,
} from './status-model.mjs';
import {
  VIRTUAL_LIST_OVERSCAN,
  shouldVirtualize,
  virtualizeItems,
} from '../runtime/virtual-list.ts';

const STORAGE_KEY = 'psyche.tauri.status.v1';
const SPARKLINE_WIDTH = 72;
const SPARKLINE_HEIGHT = 18;
const FIVE_MINUTES_MS = 5 * 60_000;
const FAILURE_DEGRADED_WINDOW_MS = 10_000;
const FAILURE_DEGRADED_COUNT = 2;
const FAILURE_DISCONNECTED_WINDOW_MS = 30_000;
const FAILURE_DISCONNECTED_COUNT = 5;
const DEFAULT_NATIVE_POLL_TIMEOUT_MS = 10_000;
const STOP_POLL_SENTINEL = Symbol('status-controller-stop-poll');
const METRIC_WIDTH_FALLBACKS = Object.freeze({
  connection: 116,
  agents: 62,
  shells: 62,
  tasks: 128,
  performance: 72,
  fps: 56,
  activity: 82,
});
const PANEL_TITLES = Object.freeze({
  connection: 'Connection',
  agents: 'Agents',
  shells: 'Shells',
  tasks: 'Tasks',
  performance: 'Performance',
  activity: 'Activity',
});
const TONE_RANK = Object.freeze({ neutral: 0, warn: 1, danger: 2 });
const STATUS_DETAIL_ROW_HEIGHT = 68;

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parentNodeOf(node) {
  return node?.parentNode ?? node?.parentElement ?? null;
}

function nodeAttachedToDocument(doc, node) {
  let current = node && typeof node === 'object' ? node : null;

  while (current) {
    if (current === doc) return true;
    current = parentNodeOf(current);
  }

  return false;
}

function nodeHiddenFromView(doc, node) {
  let current = node && typeof node === 'object' ? node : null;

  while (current) {
    if (current === doc) return false;
    if (current.hidden === true) return true;
    current = parentNodeOf(current);
  }

  return true;
}

function canFocusNode(doc, node) {
  return Boolean(
    node
    && typeof node.focus === 'function'
    && node.disabled !== true
    && nodeAttachedToDocument(doc, node)
    && !nodeHiddenFromView(doc, node),
  );
}

function findMatchingNode(start, boundary, predicate) {
  let node = start && typeof start === 'object' ? start : null;

  while (node) {
    if (predicate(node)) return node;
    if (node === boundary) break;
    node = parentNodeOf(node);
  }

  return null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value) {
  const numeric = finiteNumber(value);
  if (numeric != null) return numeric;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstMeaningfulString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function formatError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;

  const input = asObject(error);
  const nested = input.error != null && input.error !== error
    ? formatError(input.error)
    : '';
  const message = firstMeaningfulString(
    input.formattedError,
    input.formatted,
    input.message,
    nested,
  );
  const code = firstMeaningfulString(
    input.code,
    input.name === 'Error' ? '' : input.name,
  );

  if (message && code && !message.includes(code)) {
    return `${message} (${code})`;
  }
  if (message) return message;
  if (code) return code;
  return String(error);
}

function maxTone(...tones) {
  return tones.reduce((best, tone) => (
    (TONE_RANK[tone] ?? 0) > (TONE_RANK[best] ?? 0) ? tone : best
  ), 'neutral');
}

function metricDisplayName(id) {
  return PANEL_TITLES[METRICS[id]?.panel] ?? METRICS[id]?.label ?? 'Metric';
}

function metricAnnouncementLabel(id) {
  return METRICS[id]?.label ?? 'Metric';
}

function metricCandidates(preferences, severity, availableMetrics) {
  const visible = new Set((preferences.visible ?? []).filter((id) => availableMetrics.has(id)));
  const pinned = new Set((preferences.pinned ?? []).filter((id) => availableMetrics.has(id)));
  const forced = new Set(['connection']);

  for (const id of DEFAULT_METRIC_ORDER) {
    if (!availableMetrics.has(id)) continue;
    if (severity[id] && severity[id] !== 'neutral') {
      forced.add(id);
      continue;
    }
    if (pinned.has(id)) {
      forced.add(id);
    }
  }

  return (preferences.order ?? DEFAULT_METRIC_ORDER)
    .filter((id) => availableMetrics.has(id))
    .filter((id) => visible.has(id) || forced.has(id));
}

function measureWidth(element, fallback = 0) {
  if (!element) return fallback;

  if (typeof element.getBoundingClientRect === 'function') {
    const width = finiteNumber(element.getBoundingClientRect().width);
    if (width != null && width > 0) return width;
  }

  const clientWidth = finiteNumber(element.clientWidth);
  if (clientWidth != null && clientWidth > 0) return clientWidth;

  const offsetWidth = finiteNumber(element.offsetWidth);
  if (offsetWidth != null && offsetWidth > 0) return offsetWidth;

  return fallback;
}

function sanitizeMetricList(value) {
  return Array.isArray(value)
    ? value.filter((id, index, list) => METRICS[id] && list.indexOf(id) === index)
    : [];
}

function shortMemory(bytes) {
  const value = finiteNumber(bytes);
  if (value == null) return '--';
  if (value >= 1024 ** 3) {
    const gb = value / 1024 ** 3;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)}G`;
  }
  if (value >= 1024 ** 2) {
    return `${Math.round(value / 1024 ** 2)}M`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)}K`;
  }
  return `${Math.round(value)}B`;
}

function formatMemory(bytes) {
  const value = finiteNumber(bytes);
  if (value == null) return '--';
  if (value >= 1024 ** 3) {
    return `${value / 1024 ** 3 >= 10 ? (value / 1024 ** 3).toFixed(0) : (value / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function formatPercent(value) {
  const number = finiteNumber(value);
  return number == null ? '--' : `${Math.round(number)}%`;
}

function formatRate(value, suffix) {
  const number = finiteNumber(value) ?? 0;
  return `${Math.round(number)} ${suffix}`;
}

function formatRuntime(milliseconds) {
  const value = finiteNumber(milliseconds);
  if (value == null) return '';

  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatStaleAge(milliseconds) {
  const value = finiteNumber(milliseconds);
  return value == null ? '' : formatRuntime(value);
}

function formatTokens(tokens) {
  if (!tokens || (!Number.isFinite(tokens.input) && !Number.isFinite(tokens.output))) {
    return '';
  }

  const parts = [];
  if (Number.isFinite(tokens.input)) {
    parts.push(`${Math.round(tokens.input).toLocaleString()} in`);
  }
  if (Number.isFinite(tokens.output)) {
    parts.push(`${Math.round(tokens.output).toLocaleString()} out`);
  }
  return parts.join(' · ');
}

function formatTime(value) {
  const at = parseTimestamp(value);
  return at == null ? '' : new Date(at).toLocaleTimeString();
}

function nativeFailureWindows(health, sampledAt) {
  const failures = Array.isArray(health?.failureAt)
    ? health.failureAt.filter((at) => finiteNumber(at) != null)
    : [];
  const recentFailures = failures.filter((at) => sampledAt - at <= FAILURE_DISCONNECTED_WINDOW_MS);

  return {
    recentFailures,
    degradedCount: recentFailures.filter((at) => sampledAt - at <= FAILURE_DEGRADED_WINDOW_MS).length,
    disconnectedCount: recentFailures.length,
  };
}

function staleAgeMs(health, sampledAt) {
  const lastSuccessAt = parseTimestamp(health?.lastSuccessAt);
  return lastSuccessAt == null ? null : Math.max(0, sampledAt - lastSuccessAt);
}

function resolveNativeHealthStatus(health, sampledAt) {
  const { degradedCount, disconnectedCount } = nativeFailureWindows(health, sampledAt);
  const ageMs = staleAgeMs(health, sampledAt);

  if (ageMs != null && ageMs >= FAILURE_DISCONNECTED_WINDOW_MS) return 'disconnected';
  if (disconnectedCount >= FAILURE_DISCONNECTED_COUNT) return 'disconnected';
  if (ageMs != null && ageMs >= FAILURE_DEGRADED_WINDOW_MS) return 'degraded';
  if (degradedCount >= FAILURE_DEGRADED_COUNT) return 'degraded';
  return ageMs == null ? 'starting' : 'ready';
}

function nextNativeHealthTransitionDelay(health, sampledAt) {
  const ageMs = staleAgeMs(health, sampledAt);
  if (ageMs == null) return null;
  if (ageMs < FAILURE_DEGRADED_WINDOW_MS) {
    return FAILURE_DEGRADED_WINDOW_MS - ageMs;
  }
  if (ageMs < FAILURE_DISCONNECTED_WINDOW_MS) {
    return FAILURE_DISCONNECTED_WINDOW_MS - ageMs;
  }
  return null;
}

function createNativePollTimeoutError(timeoutMs) {
  const seconds = timeoutMs % 1000 === 0
    ? `${Math.round(timeoutMs / 1000)}s`
    : `${timeoutMs}ms`;
  const error = new Error(`Native metrics timed out after ${seconds}`);
  error.name = 'NativeMetricsTimeoutError';
  return error;
}

function createEmptyActivitySample() {
  return {
    workspace: {
      bytesPerSecond: 0,
      linesPerSecond: 0,
      operationsPerSecond: 0,
      errors: 0,
    },
    threads: [],
  };
}

function createEmptyFrameSample() {
  return {
    fps: null,
    renderLatencyMs: null,
    droppedFrames: null,
  };
}

function diagnosticsShell(scope) {
  // Diagnostics are a bounded text snapshot, not a row collection, so there is
  // no diagnostics-list surface to virtualize.
  return {
    sampledAt: Date.now(),
    scope: scope === 'focused' ? 'focused' : 'workspace',
    metrics: {},
    services: [],
  };
}

function appendVirtualSpacer(body, doc, position, height) {
  const spacer = doc.createElement('div');
  spacer.className = `virtual-list-spacer virtual-list-spacer-${position}`;
  spacer.setAttribute('aria-hidden', 'true');
  spacer.setAttribute('role', 'presentation');
  spacer.setAttribute('style', `height:${Math.max(0, height)}px`);
  body.appendChild(spacer);
}

function renderVirtualStatusRows(viewport, body, doc, items, getKey, renderRow) {
  resetNode(body);
  if (!shouldVirtualize(items.length)) {
    items.forEach((item, index) => {
      body.appendChild(renderRow(item, getKey(item, index)));
    });
    return;
  }
  const window = virtualizeItems(items, {
    rowHeight: STATUS_DETAIL_ROW_HEIGHT,
    viewportHeight: viewport.clientHeight || STATUS_DETAIL_ROW_HEIGHT * 10,
    scrollTop: viewport.scrollTop || 0,
    overscan: VIRTUAL_LIST_OVERSCAN,
    getKey,
  });
  appendVirtualSpacer(body, doc, 'before', window.before);
  for (const item of window.items) body.appendChild(renderRow(item.item, item.key));
  appendVirtualSpacer(body, doc, 'after', window.after);
}

function readPreferences(storage) {
  try {
    const value = storage.getItem(STORAGE_KEY);
    return normalizePreferences(value ? JSON.parse(value) : {});
  } catch (error) {
    console.warn('[status preferences] load failed:', error);
    return normalizePreferences({});
  }
}

function savePreferences(storage, preferences) {
  const normalized = normalizePreferences(preferences);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (error) {
    console.warn('[status preferences] save failed:', error);
  }
  return normalized;
}

function resolveScopeName(button) {
  const datasetName = typeof button?.dataset?.statusScope === 'string'
    ? button.dataset.statusScope.trim().toLowerCase()
    : '';
  if (datasetName === 'focused') return 'focused';
  if (datasetName === 'workspace') return 'workspace';

  const id = typeof button?.id === 'string' ? button.id.toLowerCase() : '';
  if (id.includes('focused')) return 'focused';
  return 'workspace';
}

function buttonScopeValue(button) {
  return resolveScopeName(button) === 'focused' ? 'focused' : 'workspace';
}

function collectScopeButtons(elements) {
  const explicit = Array.isArray(elements.scopeButtons)
    ? elements.scopeButtons
    : Array.from(elements.scopeButtons ?? []);
  if (explicit.length) return [...new Set(explicit.filter(Boolean))];

  const roots = [elements.bar, elements.detail].filter(Boolean);
  const buttons = [];
  for (const root of roots) {
    if (typeof root.querySelectorAll !== 'function') continue;
    buttons.push(...root.querySelectorAll('[data-status-scope], .status-scope-btn, .status-detail-scope-btn'));
  }

  return [...new Set(buttons.filter(Boolean))];
}

function assertFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`createStatusController requires ${name}()`);
  }
  return value;
}

function assertElement(name, value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`createStatusController requires elements.${name}`);
  }
  return value;
}

function resolveStorage(storage) {
  const candidate = storage ?? globalThis.localStorage;
  if (!candidate || typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function') {
    throw new TypeError('createStatusController requires storage with getItem/setItem');
  }
  return candidate;
}

function resolveCopyText(copyText) {
  if (typeof copyText === 'function') return copyText;

  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    return (text) => clipboard.writeText(text);
  }

  throw new TypeError('createStatusController requires copyText(text)');
}

function documentHidden(doc) {
  return doc?.visibilityState === 'hidden' || doc?.hidden === true;
}

function captureFocusToken(doc, elements) {
  const active = doc?.activeElement;
  if (!active || typeof active !== 'object') return null;

  if (active.id) return { type: 'id', value: active.id };
  const focusKey = active.dataset?.focusKey;
  if (typeof focusKey === 'string' && focusKey) {
    return { type: 'focus-key', value: focusKey };
  }
  const metric = active.dataset?.metric;
  if (typeof metric === 'string' && metric) {
    return { type: 'metric', value: metric };
  }
  if (active === elements.more) {
    return { type: 'more', value: 'more' };
  }
  return null;
}

function restoreFocusToken(doc, elements, token) {
  if (!token) return;

  let target = null;
  if (token.type === 'id' && typeof doc.getElementById === 'function') {
    target = doc.getElementById(token.value);
  } else if (token.type === 'focus-key' && typeof doc.querySelector === 'function') {
    target = doc.querySelector(`[data-focus-key="${token.value}"]`);
  } else if (token.type === 'metric' && typeof elements.metrics.querySelector === 'function') {
    target = elements.metrics.querySelector(`[data-metric="${token.value}"]`);
  } else if (token.type === 'more') {
    target = elements.more;
  }

  if (canFocusNode(doc, target)) {
    target.focus();
    return;
  }

  if (token.type === 'focus-key' && token.value.startsWith('more-') && canFocusNode(doc, elements.more)) {
    elements.more.focus();
  }
}

function focusPrimaryDetailControl(doc, elements) {
  for (const control of [elements.close, elements.copy, elements.pin]) {
    if (canFocusNode(doc, control)) {
      control.focus();
      return true;
    }
  }

  return false;
}

function resetNode(node) {
  while (node.firstChild) {
    node.firstChild.remove();
  }
}

function appendTextCell(doc, className, text) {
  const cell = doc.createElement('span');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function appendOptionalRowText(doc, row, className, text) {
  if (!text) return;
  row.appendChild(appendTextCell(doc, className, text));
}

function appendEmpty(body, doc, message) {
  const empty = doc.createElement('div');
  empty.className = 'status-empty';
  empty.textContent = message;
  body.appendChild(empty);
}

function renderSparkline(doc, values) {
  const pathData = sparklinePath(values, SPARKLINE_WIDTH, SPARKLINE_HEIGHT);
  if (!pathData) return null;

  const svg = typeof doc.createElementNS === 'function'
    ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    : doc.createElement('svg');
  svg.setAttribute('class', 'status-sparkline');
  svg.setAttribute('viewBox', `0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`);
  svg.setAttribute('aria-hidden', 'true');

  const path = typeof doc.createElementNS === 'function'
    ? doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    : doc.createElement('path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

function createMetricNode(doc, cache, id) {
  let record = cache.get(id);
  if (record) return record;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'status-metric';
  button.dataset.metric = id;
  button.dataset.focusKey = `metric:${id}`;
  button.setAttribute('aria-controls', 'status-detail');

  const label = doc.createElement('span');
  label.className = 'status-metric-label';
  label.textContent = METRICS[id].compactLabel;

  const value = doc.createElement('span');
  value.className = 'status-metric-value';

  button.append(label, value);
  record = { button, label, value };
  cache.set(id, record);
  return record;
}

function seedMetricNodes(doc, container, cache) {
  if (typeof container.querySelectorAll !== 'function') return;

  for (const existing of container.querySelectorAll('[data-metric]')) {
    const id = typeof existing.dataset?.metric === 'string' ? existing.dataset.metric : '';
    if (!METRICS[id] || cache.has(id)) continue;

    const label = existing.querySelector('.status-metric-label') ?? doc.createElement('span');
    if (!label.parentNode) {
      label.className = 'status-metric-label';
      existing.appendChild(label);
    }
    const value = existing.querySelector('.status-metric-value') ?? doc.createElement('span');
    if (!value.parentNode) {
      value.className = 'status-metric-value';
      existing.appendChild(value);
    }

    existing.type = 'button';
    existing.dataset.metric = id;
    existing.dataset.focusKey = `metric:${id}`;
    existing.setAttribute('aria-controls', 'status-detail');
    cache.set(id, { button: existing, label, value });
  }
}

function peakValue(trend) {
  return Number.isFinite(trend?.peak) ? trend.peak : null;
}

function cloneTrendValues(trend) {
  return Array.isArray(trend?.values) ? [...trend.values] : [];
}

function normalizeFailureTimestamps(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseTimestamp(entry))
      .filter((entry) => entry != null);
  }

  const parsed = parseTimestamp(value);
  return parsed == null ? [] : [parsed];
}

function metricDisplayValue(valueText) {
  const text = valueText == null ? null : String(valueText);
  return {
    available: text != null,
    valueText: text,
  };
}

function coerceBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function compactConnection(nativeHealth, covenHealth) {
  let state = 'connected';
  let valueText = 'Connected';

  if (nativeHealth.status === 'disconnected') {
    state = 'disconnected';
    valueText = 'Disconnected';
  } else if (nativeHealth.status === 'starting') {
    state = 'connecting';
    valueText = 'Connecting';
  } else if (
    nativeHealth.status === 'degraded'
    || ['incompatible', 'error'].includes(covenHealth.phase)
  ) {
    state = 'degraded';
    valueText = 'Degraded';
  }

  return {
    available: true,
    state,
    valueText,
  };
}

function compactTasks(summary) {
  const parts = [
    `${summary.counts.running} Run`,
    `${summary.counts.waiting} Wait`,
  ];
  if (summary.counts.failed > 0) {
    parts.push(`${summary.counts.failed} Fail`);
  }
  return parts.join('  ');
}

function compactActivity(activity) {
  const lines = finiteNumber(activity?.workspace?.linesPerSecond) ?? 0;
  const operations = finiteNumber(activity?.workspace?.operationsPerSecond) ?? 0;
  if (lines <= 0 && operations <= 0) return 'idle';
  if (lines > 0) return `${Math.round(lines)} l/s`;
  return `${Math.round(operations)} ops`;
}

function buildMetricDisplays(sample) {
  const nativeSnapshot = sample.nativeSnapshot;
  const frame = sample.frame;
  const activity = sample.activity;
  const summary = sample.summary;

  return {
    connection: compactConnection(sample.nativeHealth, sample.covenHealth),
    agents: metricDisplayValue(String(summary.counts.agents)),
    shells: metricDisplayValue(String(summary.counts.shells)),
    tasks: metricDisplayValue(compactTasks(summary)),
    performance: metricDisplayValue(
      nativeSnapshot
        ? `${formatPercent(nativeSnapshot.workspace?.cpuPercent)} ${shortMemory(nativeSnapshot.workspace?.memoryBytes)}`
        : null,
    ),
    fps: metricDisplayValue(Number.isFinite(frame?.fps) ? String(Math.round(frame.fps)) : null),
    activity: metricDisplayValue(compactActivity(activity)),
  };
}

function setPlainMetricValue(record, text) {
  record.value.textContent = text;
  record.value.setAttribute('data-connection-state', 'none');
}

function setConnectionMetricValue(doc, record, display) {
  resetNode(record.value);
  record.value.setAttribute('data-connection-state', display.state);

  const indicator = doc.createElement('span');
  indicator.className = 'status-connection-indicator';
  indicator.setAttribute('aria-hidden', 'true');

  const text = doc.createElement('span');
  text.className = 'status-connection-text';
  text.textContent = display.valueText;

  record.value.append(indicator, text);
}

function applyButtonState(doc, record, id, display, severity, expanded) {
  record.label.textContent = METRICS[id].compactLabel;
  if (id === 'connection') {
    setConnectionMetricValue(doc, record, display);
  } else {
    setPlainMetricValue(record, display?.valueText ?? '--');
  }
  record.button.dataset.metric = id;
  record.button.dataset.severity = severity ?? 'neutral';
  record.button.title = METRICS[id].tooltip;
  record.button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function buildDiagnostics(sample, effectiveScope, trends) {
  const metrics = {};
  const peaks = {};
  const trendValues = {};

  if (sample.nativeSnapshot) {
    metrics.cpuPercent = finiteNumber(sample.nativeSnapshot.workspace?.cpuPercent);
    metrics.memoryBytes = finiteNumber(sample.nativeSnapshot.workspace?.memoryBytes);
    metrics.memoryPressurePercent = finiteNumber(sample.nativeSnapshot.memoryPressurePercent);
    peaks.cpuPercent = peakValue(trends.cpuPercent);
    peaks.memoryBytes = peakValue(trends.memoryBytes);
    peaks.memoryPressurePercent = peakValue(trends.memoryPressurePercent);
    trendValues.cpuPercent = cloneTrendValues(trends.cpuPercent);
    trendValues.memoryBytes = cloneTrendValues(trends.memoryBytes);
    trendValues.memoryPressurePercent = cloneTrendValues(trends.memoryPressurePercent);
  }

  metrics.fps = finiteNumber(sample.frame?.fps);
  metrics.renderLatencyMs = finiteNumber(sample.frame?.renderLatencyMs);
  metrics.droppedFrames = finiteNumber(sample.frame?.droppedFrames);
  peaks.fps = peakValue(trends.fps);
  peaks.renderLatencyMs = peakValue(trends.renderLatencyMs);
  peaks.droppedFrames = peakValue(trends.droppedFrames);
  trendValues.fps = cloneTrendValues(trends.fps);
  trendValues.renderLatencyMs = cloneTrendValues(trends.renderLatencyMs);
  trendValues.droppedFrames = cloneTrendValues(trends.droppedFrames);

  metrics.outputLinesPerSecond = finiteNumber(sample.activity?.workspace?.linesPerSecond);
  metrics.outputBytesPerSecond = finiteNumber(sample.activity?.workspace?.bytesPerSecond);
  metrics.operationsPerSecond = finiteNumber(sample.activity?.workspace?.operationsPerSecond);
  metrics.errors = finiteNumber(sample.activity?.workspace?.errors);
  peaks.outputLinesPerSecond = peakValue(trends.outputLinesPerSecond);
  peaks.outputBytesPerSecond = peakValue(trends.outputBytesPerSecond);
  peaks.operationsPerSecond = peakValue(trends.operationsPerSecond);
  peaks.errors = peakValue(trends.errors);
  trendValues.outputLinesPerSecond = cloneTrendValues(trends.outputLinesPerSecond);
  trendValues.outputBytesPerSecond = cloneTrendValues(trends.outputBytesPerSecond);
  trendValues.operationsPerSecond = cloneTrendValues(trends.operationsPerSecond);
  trendValues.errors = cloneTrendValues(trends.errors);

  return {
    sampledAt: sample.sampledAt,
    scope: effectiveScope,
    metrics,
    peaks,
    trends: trendValues,
    services: [
      {
        name: 'Native',
        status: sample.nativeHealth.status,
        latencyMs: sample.nativeHealth.latencyMs,
      },
      {
        name: 'Coven',
        status: sample.covenHealth.phase,
        latencyMs: sample.covenHealth.latencyMs,
      },
    ],
  };
}

function mergeNativeHealthState(previous, value) {
  const input = asObject(value);

  return {
    ...previous,
    status: typeof input.status === 'string' ? input.status : previous.status,
    reconnects: hasOwn(input, 'reconnects')
      ? (finiteNumber(input.reconnects) ?? previous.reconnects)
      : previous.reconnects,
    latencyMs: hasOwn(input, 'latencyMs')
      ? finiteNumber(input.latencyMs)
      : previous.latencyMs,
    lastSuccessAt: hasOwn(input, 'lastSuccessAt')
      ? parseTimestamp(input.lastSuccessAt)
      : previous.lastSuccessAt,
    error: hasOwn(input, 'error')
      ? (input.error ? formatError(input.error) : '')
      : previous.error,
    failureAt: hasOwn(input, 'failureAt')
      ? normalizeFailureTimestamps(input.failureAt)
      : previous.failureAt,
  };
}

function mergeCovenHealthState(previous, value) {
  const input = asObject(value);
  const hasPhase = hasOwn(input, 'phase');
  const hasStatus = hasOwn(input, 'status');
  const hasRefreshedAt = hasOwn(input, 'refreshedAt')
    || hasOwn(input, 'sampledAt')
    || hasOwn(input, 'updatedAt');
  const parsedRefreshedAt = hasRefreshedAt
    ? parseTimestamp(input.refreshedAt ?? input.sampledAt ?? input.updatedAt)
    : null;
  const phase = hasPhase
    ? (typeof input.phase === 'string' ? input.phase : previous.phase)
    : hasStatus
      ? (typeof input.status === 'string' ? input.status : previous.phase)
      : previous.phase;
  const failurePhase = phase === 'error' || phase === 'unavailable' || phase === 'incompatible';

  return {
    ...previous,
    phase,
    reconnects: hasOwn(input, 'reconnects')
      ? (finiteNumber(input.reconnects) ?? previous.reconnects)
      : previous.reconnects,
    latencyMs: hasOwn(input, 'latencyMs')
      ? finiteNumber(input.latencyMs)
      : previous.latencyMs,
    refreshedAt: phase === 'ready'
      ? (parsedRefreshedAt ?? previous.refreshedAt)
      : failurePhase
        ? previous.refreshedAt
        : (parsedRefreshedAt ?? previous.refreshedAt),
    error: phase === 'ready'
      ? ''
      : hasOwn(input, 'error')
        ? (input.error ? formatError(input.error) : '')
        : previous.error,
  };
}

function nativeRequestScope(scopeState) {
  const threadId = typeof scopeState?.activeThreadId === 'string' && scopeState.activeThreadId
    ? scopeState.activeThreadId
    : null;
  if (scopeState?.scopeName === 'focused' && threadId) {
    return {
      key: threadId,
      scope: { threadId },
    };
  }

  return {
    key: 'workspace',
    scope: undefined,
  };
}

function shouldDiscardFocusedSnapshot(requestScopeKey, currentScopeState) {
  return requestScopeKey !== 'workspace'
    && nativeRequestScope(currentScopeState).key !== requestScopeKey;
}

function isStoppedNativeRequest(result) {
  return result?.cancelled === true && result.error === STOP_POLL_SENTINEL;
}

function renderAgents(viewport, body, doc, summary) {
  if (!summary.agents.length) {
    resetNode(body);
    appendEmpty(body, doc, 'No active agents.');
    return;
  }

  renderVirtualStatusRows(viewport, body, doc, summary.agents, (agent, index) => (
    agent.id ?? agent.threadId ?? `${agent.name}:${index}`
  ), (agent, key) => {
    const row = doc.createElement('div');
    row.className = 'status-agent-row';
    row.dataset.virtualKey = String(key);
    row.append(
      appendTextCell(doc, 'status-row-name', agent.name),
      appendTextCell(doc, 'status-row-state', agent.status),
      appendTextCell(doc, 'status-row-runtime', formatRuntime(agent.runtimeMs)),
    );
    appendOptionalRowText(doc, row, 'status-row-meta', [agent.harness, agent.model].filter(Boolean).join(' · '));
    appendOptionalRowText(doc, row, 'status-row-task', [
      agent.currentTask,
      formatTokens(agent.tokens),
    ].filter(Boolean).join(' · '));
    return row;
  });
}

function renderShells(viewport, body, doc, summary, nativeSnapshot, activity) {
  if (!summary.shells.length) {
    resetNode(body);
    appendEmpty(body, doc, 'No active shells.');
    return;
  }

  const processByThreadId = new Map((nativeSnapshot?.processes ?? []).map((row) => [row.threadId, row]));
  const activityByThreadId = new Map((activity?.threads ?? []).map((row) => [row.threadId, row]));

  renderVirtualStatusRows(viewport, body, doc, summary.shells, (shell, index) => (
    shell.threadId ?? `${shell.name}:${index}`
  ), (shell, key) => {
    const process = processByThreadId.get(shell.threadId) ?? null;
    const rate = activityByThreadId.get(shell.threadId) ?? null;
    const cpuPercent = finiteNumber(process?.cpuPercent);
    const memoryBytes = finiteNumber(process?.memoryBytes);
    const linesPerSecond = finiteNumber(rate?.linesPerSecond);
    const row = doc.createElement('div');
    row.className = 'status-shell-row';
    row.dataset.virtualKey = String(key);
    row.append(
      appendTextCell(doc, 'status-row-name', shell.name),
      appendTextCell(
        doc,
        'status-row-state',
        cpuPercent != null ? `${Math.round(cpuPercent)}% CPU` : 'CPU --',
      ),
      appendTextCell(
        doc,
        'status-row-runtime',
        memoryBytes != null ? formatMemory(memoryBytes) : 'MEM --',
      ),
    );

    const metaParts = [];
    if (process?.processName) metaParts.push(process.processName);
    if (Number.isFinite(process?.pid)) metaParts.push(`PID ${process.pid}`);
    appendOptionalRowText(doc, row, 'status-row-meta', metaParts.join(' · '));
    if (linesPerSecond != null) {
      appendOptionalRowText(doc, row, 'status-row-task', formatRate(linesPerSecond, 'lines/s'));
    }
    return row;
  });
}

function renderTasks(body, doc, summary) {
  resetNode(body);
  if (!summary.tasks.length) {
    appendEmpty(body, doc, 'No active tasks.');
    return;
  }

  for (const status of ['running', 'waiting', 'blocked', 'failed', 'completed']) {
    const tasks = summary.tasks.filter((task) => task.status === status);
    if (!tasks.length) continue;

    const group = doc.createElement('section');
    group.className = 'status-task-group';
    group.appendChild(appendTextCell(doc, 'status-task-heading', `${status} · ${tasks.length}`));

    for (const task of tasks.slice(0, 20)) {
      const row = doc.createElement('div');
      row.className = 'status-task-row';
      row.append(
        appendTextCell(doc, 'status-row-name', task.name),
        appendTextCell(doc, 'status-row-runtime', formatRuntime(task.runtimeMs)),
      );
      group.appendChild(row);
    }

    if (tasks.length > 20) {
      group.appendChild(appendTextCell(doc, 'status-more-count', `${tasks.length - 20} more`));
    }
    body.appendChild(group);
  }
}

function performanceCell(doc, label, value, meta, values) {
  const cell = doc.createElement('div');
  cell.className = 'status-performance-cell';
  cell.append(
    appendTextCell(doc, 'status-cell-label', label),
    appendTextCell(doc, 'status-cell-value', value),
    appendTextCell(doc, 'status-cell-meta', meta),
  );
  const sparkline = renderSparkline(doc, values);
  if (sparkline) cell.appendChild(sparkline);
  return cell;
}

function renderPerformance(body, doc, sample, trends) {
  resetNode(body);

  const grid = doc.createElement('div');
  grid.className = 'status-performance-grid';
  let cellCount = 0;
  const hasFrameSample = Number.isFinite(sample.frame?.fps)
    && Number.isFinite(sample.frame?.renderLatencyMs)
    && Number.isFinite(sample.frame?.droppedFrames);

  if (sample.nativeSnapshot) {
    const workspace = sample.nativeSnapshot.workspace ?? {};
    const usedSystem = finiteNumber(sample.nativeSnapshot.usedMemoryBytes);
    const totalSystem = finiteNumber(sample.nativeSnapshot.totalMemoryBytes);
    const pressure = finiteNumber(sample.nativeSnapshot.memoryPressurePercent);
    grid.appendChild(performanceCell(
      doc,
      'CPU',
      formatPercent(workspace.cpuPercent),
      `Peak ${formatPercent(peakValue(trends.cpuPercent) ?? workspace.cpuPercent)}`,
      trends.cpuPercent.values,
    ));
    cellCount += 1;
    const systemParts = [];
    if (usedSystem != null && totalSystem != null) {
      systemParts.push(`${formatMemory(usedSystem)} / ${formatMemory(totalSystem)}`);
    }
    if (pressure != null) {
      systemParts.push(`${Math.round(pressure)}% pressure`);
    }
    grid.appendChild(performanceCell(
      doc,
      'Memory',
      formatMemory(workspace.memoryBytes),
      [
        `Peak ${formatMemory(peakValue(trends.memoryBytes) ?? workspace.memoryBytes)}`,
        ...systemParts,
      ].join(' · '),
      trends.memoryBytes.values,
    ));
    cellCount += 1;
  }

  if (hasFrameSample) {
    grid.appendChild(performanceCell(
      doc,
      'Frame rate',
      `${Math.round(sample.frame.fps)} FPS`,
      `${sample.frame.renderLatencyMs.toFixed(1)} ms`,
      trends.fps.values,
    ));
    grid.appendChild(performanceCell(
      doc,
      'Dropped',
      String(Math.round(sample.frame.droppedFrames)),
      `Peak ${Math.round(peakValue(trends.droppedFrames) ?? sample.frame.droppedFrames)} / sample`,
      trends.droppedFrames.values,
    ));
    cellCount += 2;
  }

  if (!cellCount) {
    appendEmpty(body, doc, 'No active performance metrics.');
    return;
  }

  body.appendChild(grid);
}

function activityCell(doc, label, value, meta, values) {
  const cell = doc.createElement('div');
  cell.className = 'status-activity-cell';
  cell.append(
    appendTextCell(doc, 'status-cell-label', label),
    appendTextCell(doc, 'status-cell-value', value),
    appendTextCell(doc, 'status-cell-meta', meta),
  );
  const sparkline = renderSparkline(doc, values);
  if (sparkline) cell.appendChild(sparkline);
  return cell;
}

function renderActivity(body, doc, activity, trends, spikes, agentToolCalls) {
  resetNode(body);
  const grid = doc.createElement('div');
  grid.className = 'status-activity-grid';

  grid.append(
    activityCell(
      doc,
      'Lines',
      formatRate(activity.workspace.linesPerSecond, 'lines/s'),
      `Peak ${formatRate(peakValue(trends.outputLinesPerSecond) ?? activity.workspace.linesPerSecond, 'lines/s')}`,
      trends.outputLinesPerSecond.values,
    ),
    activityCell(
      doc,
      'Bytes',
      formatRate(activity.workspace.bytesPerSecond, 'bytes/s'),
      `Peak ${formatRate(peakValue(trends.outputBytesPerSecond) ?? activity.workspace.bytesPerSecond, 'bytes/s')}`,
      trends.outputBytesPerSecond.values,
    ),
    activityCell(
      doc,
      'Ops',
      formatRate(activity.workspace.operationsPerSecond, 'Ops/s'),
      `Peak ${formatRate(peakValue(trends.operationsPerSecond) ?? activity.workspace.operationsPerSecond, 'Ops/s')}`,
      trends.operationsPerSecond.values,
    ),
    activityCell(
      doc,
      'Errors',
      String(Math.round(activity.workspace.errors ?? 0)),
      `Peak ${Math.round(peakValue(trends.errors) ?? activity.workspace.errors ?? 0)} failures / sample`,
      trends.errors.values,
    ),
  );

  if (Number.isFinite(agentToolCalls)) {
    grid.appendChild(activityCell(
      doc,
      'Agent tools',
      String(Math.round(agentToolCalls)),
      'Structured Coven events only',
      [],
    ));
  }

  body.appendChild(grid);

  if (spikes.length) {
    const list = doc.createElement('div');
    list.className = 'status-spikes';
    for (const spike of spikes) {
      const row = doc.createElement('div');
      row.className = 'status-spike';
      row.textContent = `${formatTime(spike.at)} · ${metricDisplayName(spike.metric)} ${spike.severity}`;
      list.appendChild(row);
    }
    body.appendChild(list);
    return;
  }

  appendEmpty(body, doc, 'No recent activity spikes.');
}

function serviceRow(doc, service) {
  const row = doc.createElement('div');
  row.className = 'status-service-row';
  const refreshedAt = parseTimestamp(service.refreshedAt);
  row.append(
    appendTextCell(doc, 'status-row-name', service.name),
    appendTextCell(doc, 'status-row-state', service.status),
    appendTextCell(doc, 'status-row-runtime', service.latencyMs != null ? `${Math.round(service.latencyMs)} ms` : ''),
  );

  const showStaleAge = service.status === 'degraded' || service.status === 'disconnected';
  const note = [
    `Reconnects ${service.reconnects}`,
    showStaleAge
      ? (service.staleAgeMs != null
        ? `Stale ${formatStaleAge(service.staleAgeMs)}`
        : 'Stale age unavailable')
      : '',
    refreshedAt != null
      ? `Last refresh ${formatTime(refreshedAt)}`
      : (showStaleAge ? 'Last refresh unavailable' : ''),
  ].filter(Boolean).join(' · ');
  appendOptionalRowText(doc, row, 'status-row-meta', note);
  appendOptionalRowText(doc, row, 'status-row-task', service.error ?? '');
  return row;
}

function renderConnection(body, doc, nativeHealth, covenHealth) {
  resetNode(body);

  body.append(
    serviceRow(doc, {
      name: 'Native bridge',
      status: nativeHealth.status,
      latencyMs: nativeHealth.latencyMs,
      reconnects: nativeHealth.reconnects,
      staleAgeMs: nativeHealth.staleAgeMs,
      refreshedAt: nativeHealth.lastSuccessAt,
      error: nativeHealth.error,
    }),
    serviceRow(doc, {
      name: 'Coven',
      status: covenHealth.phase,
      latencyMs: covenHealth.latencyMs,
      reconnects: covenHealth.reconnects,
      refreshedAt: covenHealth.refreshedAt,
      error: covenHealth.error,
    }),
  );
}

function renderMoreMenuState({
  body,
  doc,
  availableMetrics,
  currentMetricSeverity,
  metricDisplays,
  elements,
  overflowed,
  preferences,
  currentTriggerMetric,
}) {
  resetNode(body);
  body.setAttribute('role', 'dialog');
  body.setAttribute('aria-modal', 'false');
  body.setAttribute('aria-labelledby', 'status-more-title');

  const head = doc.createElement('div');
  head.className = 'status-more-head';
  head.id = 'status-more-title';
  head.textContent = 'Status options';
  body.appendChild(head);

  for (const id of preferences.order) {
    const row = doc.createElement('div');
    row.className = 'status-more-row';

    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'status-more-item status-more-open';
    open.dataset.focusKey = `more-open:${id}`;
    open.dataset.metric = id;
    open.dataset.moreAction = 'open-metric';
    open.dataset.severity = currentMetricSeverity[id] ?? 'neutral';
    open.title = METRICS[id].tooltip;
    open.setAttribute('aria-expanded', currentTriggerMetric === id ? 'true' : 'false');
    const display = metricDisplays[id];
    const available = display?.available !== false;
    open.disabled = !available;

    const label = appendTextCell(doc, 'status-more-open-label', METRICS[id].label);
    const value = doc.createElement('span');
    value.className = 'status-more-open-value';
    if (id === 'connection') {
      setConnectionMetricValue(doc, { value }, display);
      value.className = 'status-more-open-value';
    } else {
      setPlainMetricValue(
        { value },
        available ? (display?.valueText ?? '--') : 'Unavailable',
      );
      value.className = 'status-more-open-value';
    }
    open.append(label, value);

    const toggle = doc.createElement('label');
    toggle.className = 'status-more-toggle';
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = id === 'connection'
      || preferences.visible.includes(id)
      || preferences.pinned.includes(id);
    checkbox.disabled = id === 'connection';
    checkbox.dataset.focusKey = `more-show:${id}`;
    checkbox.dataset.metric = id;
    checkbox.dataset.moreAction = 'toggle-visible';
    checkbox.setAttribute('aria-label', `Show ${METRICS[id].label}`);
    toggle.append(
      checkbox,
      appendTextCell(doc, 'status-more-toggle-label', 'Show'),
    );

    const meta = doc.createElement('div');
    meta.className = 'status-more-meta';
    const badges = [];
    if (!availableMetrics.has(id)) badges.push('unavailable');
    if (overflowed.includes(id)) badges.push('hidden by width');
    if (preferences.pinned.includes(id)) badges.push('pinned');
    meta.textContent = badges.join(' · ');

    const controls = doc.createElement('div');
    controls.className = 'status-more-controls';
    const earlier = doc.createElement('button');
    earlier.type = 'button';
    earlier.className = 'status-more-move';
    earlier.dataset.focusKey = `more-earlier:${id}`;
    earlier.dataset.metric = id;
    earlier.dataset.moreAction = 'move-earlier';
    earlier.textContent = 'Earlier';
    earlier.setAttribute('aria-label', `Move ${METRICS[id].label} earlier`);
    earlier.disabled = preferences.order.indexOf(id) <= 0;

    const later = doc.createElement('button');
    later.type = 'button';
    later.className = 'status-more-move';
    later.dataset.focusKey = `more-later:${id}`;
    later.dataset.metric = id;
    later.dataset.moreAction = 'move-later';
    later.textContent = 'Later';
    later.setAttribute('aria-label', `Move ${METRICS[id].label} later`);
    later.disabled = preferences.order.indexOf(id) >= preferences.order.length - 1;

    controls.append(earlier, later);
    row.append(open, toggle, meta, controls);
    body.appendChild(row);
  }

  elements.more.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
}

function nativeHealthView(health, sampledAt = Date.now()) {
  return {
    status: resolveNativeHealthStatus(health, sampledAt),
    reconnects: health.reconnects,
    latencyMs: health.latencyMs,
    lastSuccessAt: health.lastSuccessAt,
    staleAgeMs: staleAgeMs(health, sampledAt),
    error: health.error,
  };
}

function covenHealthView(health) {
  return {
    phase: health.phase,
    reconnects: health.reconnects,
    latencyMs: health.latencyMs,
    refreshedAt: health.refreshedAt,
    error: health.error,
  };
}

export function createStatusController(options = {}) {
  const source = asObject(options);
  const elementsInput = asObject(source.elements);
  const elements = {
    bar: assertElement('bar', elementsInput.bar),
    metrics: assertElement('metrics', elementsInput.metrics),
    detail: assertElement('detail', elementsInput.detail),
    detailTitle: assertElement('detailTitle', elementsInput.detailTitle),
    detailBody: assertElement('detailBody', elementsInput.detailBody),
    more: assertElement('more', elementsInput.more),
    moreMenu: assertElement('moreMenu', elementsInput.moreMenu),
    live: assertElement('live', elementsInput.live),
    alert: assertElement('alert', elementsInput.alert),
    pin: assertElement('pin', elementsInput.pin),
    copy: assertElement('copy', elementsInput.copy),
    close: assertElement('close', elementsInput.close),
    trailing: elementsInput.trailing ?? elementsInput.more?.parentElement ?? null,
  };

  const doc = source.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.addEventListener !== 'function') {
    throw new TypeError('createStatusController requires a document implementation');
  }

  const ResizeObserverClass = source.ResizeObserver ?? globalThis.ResizeObserver;
  if (typeof ResizeObserverClass !== 'function') {
    throw new TypeError('createStatusController requires ResizeObserver');
  }

  const now = assertFunction('now', source.now ?? Date.now);
  const requestFrame = assertFunction('requestFrame', source.requestFrame ?? globalThis.requestAnimationFrame);
  const cancelFrame = assertFunction('cancelFrame', source.cancelFrame ?? globalThis.cancelAnimationFrame);
  const setTimer = assertFunction('setTimer', source.setTimer ?? globalThis.setTimeout);
  const clearTimer = assertFunction('clearTimer', source.clearTimer ?? globalThis.clearTimeout);
  const performanceApi = source.performance ?? globalThis.performance;
  if (!performanceApi || typeof performanceApi.now !== 'function') {
    throw new TypeError('createStatusController requires performance.now()');
  }

  const storage = resolveStorage(source.storage);
  const copyText = resolveCopyText(source.copyText);
  const fetchMetrics = assertFunction('fetchMetrics', source.fetchMetrics);
  const nativePollTimeoutMs = (() => {
    const value = finiteNumber(source.nativePollTimeoutMs);
    return value != null && value > 0 ? value : DEFAULT_NATIVE_POLL_TIMEOUT_MS;
  })();
  const getContext = assertFunction('getContext', source.getContext);
  const scopeButtons = collectScopeButtons(elementsInput);

  const preferencesState = { value: readPreferences(storage) };
  const activity = createActivityTracker();
  const frameSampler = createFrameSampler();
  const metricNodeCache = new Map();
  const widthCache = new Map();
  const trends = {
    cpuPercent: { values: [], peak: Number.NEGATIVE_INFINITY },
    memoryBytes: { values: [], peak: Number.NEGATIVE_INFINITY },
    memoryPressurePercent: { values: [], peak: Number.NEGATIVE_INFINITY },
    fps: { values: [], peak: Number.NEGATIVE_INFINITY },
    renderLatencyMs: { values: [], peak: Number.NEGATIVE_INFINITY },
    droppedFrames: { values: [], peak: Number.NEGATIVE_INFINITY },
    outputLinesPerSecond: { values: [], peak: Number.NEGATIVE_INFINITY },
    outputBytesPerSecond: { values: [], peak: Number.NEGATIVE_INFINITY },
    operationsPerSecond: { values: [], peak: Number.NEGATIVE_INFINITY },
    errors: { values: [], peak: Number.NEGATIVE_INFINITY },
  };
  const resizeObserver = new ResizeObserverClass(() => {
    if (lastSampleContext) {
      renderView();
    }
  });
  let cleanupCallbacks = [];

  function pushCleanup(callback) {
    cleanupCallbacks.push(callback);
    return callback;
  }

  function drainCleanup() {
    while (cleanupCallbacks.length) {
      const callback = cleanupCallbacks.pop();
      callback?.();
    }
  }

  function registerListener(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
      return;
    }

    target.addEventListener(type, handler, options);
    pushCleanup(() => {
      target.removeEventListener(type, handler, options);
    });
  }

  activity.lastFlushAt = now();
  seedMetricNodes(doc, elements.metrics, metricNodeCache);

  let running = false;
  let timerId = null;
  let nativeHealthTimerId = null;
  let frameId = null;
  let detailRenderFrameId = null;
  let pollInFlight = null;
  let refreshQueued = false;
  let nativePollGeneration = 0;
  let nativeRequestCancels = new Set();
  let lifecycleToken = 0;
  let lastFrameFlushAt = now();
  let lastSuccessfulSnapshot = null;
  let lastActivityAt = now();
  let lastActivitySample = createEmptyActivitySample();
  let lastFrameSample = createEmptyFrameSample();
  let lastSampleContext = null;
  let lastRenderedDiagnostics = diagnosticsShell(preferencesState.value.scope);
  let lastView = null;
  let thresholdState = {};
  let currentMetricSeverity = {};
  let previousMetricSeverity = {};
  let spikes = [];
  let activeTriggerMetric = null;
  let activePanelId = null;
  let nativeHealth = {
    status: 'starting',
    reconnects: 0,
    latencyMs: null,
    lastSuccessAt: null,
    error: '',
    failureAt: [],
  };
  let covenHealth = {
    phase: 'idle',
    reconnects: 0,
    latencyMs: null,
    refreshedAt: null,
    error: '',
  };

  function clearNativeHealthTimer() {
    if (nativeHealthTimerId == null) return;
    clearTimer(nativeHealthTimerId);
    nativeHealthTimerId = null;
  }

  function scheduleNativeHealthTransition(at = now()) {
    clearNativeHealthTimer();
    if (!running) return;

    const delay = nextNativeHealthTransitionDelay(nativeHealth, at);
    if (delay == null) return;

    nativeHealthTimerId = setTimer(() => {
      nativeHealthTimerId = null;
      if (!running) return;
      render();
    }, delay);
  }

  function liveHealthSample(sample, at = now()) {
    return {
      ...sample,
      nativeHealth: nativeHealthView(nativeHealth, at),
      covenHealth: covenHealthView(covenHealth),
    };
  }

  function requestNativeMetrics(requestedScope) {
    const generation = nativePollGeneration + 1;
    nativePollGeneration = generation;

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      let cancelRequest = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId != null) {
          clearTimer(timeoutId);
          timeoutId = null;
        }
        if (cancelRequest) {
          nativeRequestCancels.delete(cancelRequest);
          cancelRequest = null;
        }
        resolve({ generation, ...result });
      };

      cancelRequest = () => {
        settle({
          ok: false,
          cancelled: true,
          error: STOP_POLL_SENTINEL,
        });
      };
      nativeRequestCancels.add(cancelRequest);

      // Tauri invoke is not cancellable, so a timed-out generation may still
      // settle later. Only the first settlement for this generation is allowed
      // to reach the controller; late results are ignored.
      Promise.resolve()
        .then(() => fetchMetrics(requestedScope))
        .then(
          (snapshot) => settle({ ok: true, snapshot }),
          (error) => settle({ ok: false, error }),
        );

      timeoutId = setTimer(() => {
        settle({
          ok: false,
          error: createNativePollTimeoutError(nativePollTimeoutMs),
          timedOut: true,
        });
      }, nativePollTimeoutMs);
    });
  }

  function recordTrend(name, value) {
    const trend = trends[name];
    const next = pushTrend(trend.values, finiteNumber(value), trend.peak);
    trends[name] = { values: next.values, peak: next.peak };
    return trends[name];
  }

  function writePreferences(next) {
    preferencesState.value = savePreferences(storage, next);
    return preferencesState.value;
  }

  function effectiveScopeForContext(context) {
    const thread = Array.isArray(context?.threads)
      ? context.threads.find((candidate) => candidate?.id === context.activeThreadId)
      : null;
    const focusedAvailable = thread?.processBacked === true;
    const scopeName = preferencesState.value.scope === 'focused' && focusedAvailable
      ? 'focused'
      : 'workspace';
    return {
      focusedAvailable,
      scopeName,
      activeThreadId: focusedAvailable ? thread.id : null,
    };
  }

  function closeMoreMenu({ restoreFocus = false } = {}) {
    if (elements.moreMenu.hidden) return;
    elements.moreMenu.hidden = true;
    elements.more.setAttribute('aria-expanded', 'false');
    if (restoreFocus && canFocusNode(doc, elements.more)) {
      elements.more.focus();
    }
  }

  function noteActivity(at = now()) {
    const value = finiteNumber(at) ?? now();
    lastActivityAt = value;
    if (running) schedulePoll();
  }

  function openMetric(id, fromMoreMenu = false) {
    if (!METRICS[id]) return;
    if (activeTriggerMetric === id) {
      closePanel();
      return;
    }

    activeTriggerMetric = id;
    activePanelId = METRICS[id].panel;
    elements.detail.hidden = false;
    if (fromMoreMenu) {
      closeMoreMenu();
    }
    renderView();
    if (fromMoreMenu) {
      focusPrimaryDetailControl(doc, elements);
    }
  }

  function toggleMetric(id) {
    if (activeTriggerMetric === id) {
      closePanel();
      return;
    }
    openMetric(id);
  }

  function closePanel() {
    const restoreMetric = activeTriggerMetric;
    activeTriggerMetric = null;
    activePanelId = null;
    elements.detail.hidden = true;
    renderView();

    const trigger = restoreMetric && typeof elements.metrics.querySelector === 'function'
      ? elements.metrics.querySelector(`[data-metric="${restoreMetric}"]`)
      : null;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
      return;
    }
    if (typeof elements.more.focus === 'function') {
      elements.more.focus();
    }
  }

  function moveMetric(id, delta) {
    const order = [...preferencesState.value.order];
    const index = order.indexOf(id);
    if (index === -1) return;
    const target = Math.max(0, Math.min(order.length - 1, index + delta));
    if (index === target) return;

    order.splice(index, 1);
    order.splice(target, 0, id);
    writePreferences({ ...preferencesState.value, order });
    renderView();
  }

  function toggleVisibleMetric(id, visible) {
    let nextVisible = sanitizeMetricList(preferencesState.value.visible);
    let nextPinned = sanitizeMetricList(preferencesState.value.pinned);
    if (id === 'connection') {
      writePreferences({ ...preferencesState.value, visible: nextVisible, pinned: nextPinned });
      renderView();
      return;
    }

    if (visible) {
      nextVisible = [...new Set([...nextVisible, id])];
    } else {
      nextVisible = nextVisible.filter((metricId) => metricId !== id);
      nextPinned = nextPinned.filter((metricId) => metricId !== id);
    }

    writePreferences({ ...preferencesState.value, visible: nextVisible, pinned: nextPinned });
    renderView();
  }

  function togglePinnedMetric(id) {
    if (!id || !METRICS[id]) return;

    const pinned = new Set(preferencesState.value.pinned);
    const visible = sanitizeMetricList(preferencesState.value.visible);
    let announcement = '';
    if (pinned.has(id)) {
      pinned.delete(id);
      announcement = `Unpinned ${metricAnnouncementLabel(id)}`;
    } else {
      pinned.add(id);
      if (!visible.includes(id)) {
        visible.push(id);
      }
      announcement = `Pinned ${metricAnnouncementLabel(id)}`;
    }
    writePreferences({ ...preferencesState.value, visible, pinned: [...pinned] });
    renderView();
    elements.live.textContent = announcement;
    elements.alert.textContent = '';
  }

  async function copyDiagnostics() {
    const diagnostics = lastRenderedDiagnostics ?? diagnosticsShell(preferencesState.value.scope);
    const text = formatLiveDiagnostics(diagnostics);
    try {
      await copyText(text);
      elements.live.textContent = 'Diagnostics copied';
      elements.alert.textContent = '';
    } catch (error) {
      elements.live.textContent = '';
      elements.alert.textContent = `Unable to copy diagnostics: ${formatError(error)}`;
    }
  }

  function updateNativeHealthFromSuccess(snapshot, latencyMs, sampledAt, { commitSnapshot = true } = {}) {
    const previousStatus = resolveNativeHealthStatus(nativeHealth, sampledAt);
    const recovered = previousStatus === 'degraded' || previousStatus === 'disconnected';
    nativeHealth = {
      status: 'ready',
      reconnects: nativeHealth.reconnects + (recovered ? 1 : 0),
      latencyMs,
      lastSuccessAt: snapshot?.sampledAtMs ?? sampledAt,
      error: '',
      failureAt: [],
    };
    if (commitSnapshot) {
      lastSuccessfulSnapshot = snapshot;
    }
    scheduleNativeHealthTransition(sampledAt);
  }

  function updateNativeHealthFromFailure(error, latencyMs, sampledAt) {
    const recent = [...nativeHealth.failureAt, sampledAt]
      .filter((at) => sampledAt - at <= FAILURE_DISCONNECTED_WINDOW_MS);

    nativeHealth = {
      ...nativeHealth,
      status: resolveNativeHealthStatus({ ...nativeHealth, failureAt: recent }, sampledAt),
      latencyMs,
      error: formatError(error),
      failureAt: recent,
    };
    scheduleNativeHealthTransition(sampledAt);
  }

  function recordSpikes(metricSeverity, sampledAt) {
    for (const [metric, severity] of Object.entries(metricSeverity)) {
      const previous = previousMetricSeverity[metric] ?? 'neutral';
      if (severity !== 'neutral' && previous === 'neutral') {
        spikes.unshift({ metric, severity, at: sampledAt });
      }
    }
    previousMetricSeverity = { ...metricSeverity };
    spikes = spikes
      .filter((spike) => sampledAt - spike.at <= FIVE_MINUTES_MS)
      .slice(0, 20);
  }

  function processSample(rawSample) {
    const summary = rawSample.summary ?? summarizeWorkspace({
      now: rawSample.sampledAt,
      activeThreadId: rawSample.context?.activeThreadId ?? null,
      threads: rawSample.context?.threads ?? [],
      covenSessions: rawSample.context?.covenSessions ?? [],
    });
    rawSample.summary = summary;

    const lineHistory = trends.outputLinesPerSecond.values.slice(-30);
    const outputBaseline = median(lineHistory);
    const thresholds = evaluateSeverity({
      cpuPercent: rawSample.nativeSnapshot?.workspace?.cpuPercent ?? null,
      memoryPressurePercent: rawSample.nativeSnapshot?.memoryPressurePercent ?? null,
      fps: rawSample.frame?.fps ?? null,
      renderLatencyMs: rawSample.frame?.renderLatencyMs ?? null,
      outputLinesPerSecond: rawSample.activity?.workspace?.linesPerSecond ?? null,
      outputBaseline,
    }, thresholdState);
    thresholdState = thresholds.state;

    const tasksFailed = summary.tasks.some((task) => task.status === 'failed');
    const tasksWaiting = summary.tasks.some((task) => task.status === 'waiting');
    const connectionSeverity = rawSample.nativeHealth.status === 'disconnected'
      ? 'danger'
      : (rawSample.nativeHealth.status === 'degraded'
        || ['incompatible', 'error'].includes(rawSample.covenHealth.phase))
        ? 'warn'
        : 'neutral';
    const metricSeverity = {
      connection: connectionSeverity,
      agents: summary.agents.some((agent) => agent.status === 'waiting') ? 'warn' : 'neutral',
      shells: 'neutral',
      tasks: tasksFailed ? 'danger' : tasksWaiting ? 'warn' : 'neutral',
      performance: maxTone(thresholds.severity.cpu, thresholds.severity.memory),
      fps: maxTone(thresholds.severity.fps, thresholds.severity.latency),
      activity: thresholds.severity.activity,
    };
    currentMetricSeverity = metricSeverity;
    recordSpikes(metricSeverity, rawSample.sampledAt);

    recordTrend('cpuPercent', rawSample.nativeSnapshot?.workspace?.cpuPercent);
    recordTrend('memoryBytes', rawSample.nativeSnapshot?.workspace?.memoryBytes);
    recordTrend('memoryPressurePercent', rawSample.nativeSnapshot?.memoryPressurePercent);
    recordTrend('fps', rawSample.frame?.fps);
    recordTrend('renderLatencyMs', rawSample.frame?.renderLatencyMs);
    recordTrend('droppedFrames', rawSample.frame?.droppedFrames);
    recordTrend('outputLinesPerSecond', rawSample.activity?.workspace?.linesPerSecond);
    recordTrend('outputBytesPerSecond', rawSample.activity?.workspace?.bytesPerSecond);
    recordTrend('operationsPerSecond', rawSample.activity?.workspace?.operationsPerSecond);
    recordTrend('errors', rawSample.activity?.workspace?.errors);

    lastSampleContext = {
      ...rawSample,
      outputBaseline,
      summary,
    };

    renderView();
  }

  function renderView(sample = lastSampleContext) {
    if (!sample) return null;

    const renderedAt = now();
    const liveSample = liveHealthSample(sample, renderedAt);
    const focusToken = captureFocusToken(doc, elements);
    const metricDisplays = buildMetricDisplays(liveSample);
    const labels = Object.fromEntries(
      Object.entries(metricDisplays).map(([id, display]) => [id, display?.available ? display.valueText : null]),
    );
    const { focusedAvailable, scopeName } = liveSample.scopeState ?? effectiveScopeForContext(liveSample.context ?? {});
    liveSample.scopeState = {
      focusedAvailable,
      scopeName,
      activeThreadId: liveSample.context?.activeThreadId ?? null,
    };

    const availableMetrics = new Set(['connection', 'agents', 'shells', 'tasks', 'activity']);
    if (labels.performance != null && liveSample.nativeSnapshot) {
      availableMetrics.add('performance');
    }
    if (labels.fps != null) {
      availableMetrics.add('fps');
    }

    const visiblePreference = preferencesState.value.visible.filter((id) => availableMetrics.has(id));
    const pinnedPreference = preferencesState.value.pinned.filter((id) => availableMetrics.has(id));
    const order = preferencesState.value.order;

    const buttonRecords = new Map();
    for (const id of availableMetrics) {
      const record = createMetricNode(doc, metricNodeCache, id);
      applyButtonState(
        doc,
        record,
        id,
        metricDisplays[id],
        currentMetricSeverity[id] ?? 'neutral',
        activeTriggerMetric === id,
      );
      buttonRecords.set(id, record);
      widthCache.set(id, measureWidth(record.button, widthCache.get(id) ?? METRIC_WIDTH_FALLBACKS[id] ?? 80));
    }

    const widths = {};
    for (const id of DEFAULT_METRIC_ORDER) {
      widths[id] = widthCache.get(id) ?? METRIC_WIDTH_FALLBACKS[id] ?? 80;
    }

    const availableWidth = measureWidth(elements.bar, 0);
    const fixedWidth = measureWidth(elements.trailing, measureWidth(elements.more, 60));
    const visibleMetrics = chooseVisibleMetrics({
      order,
      visible: visiblePreference,
      pinned: pinnedPreference,
      severity: currentMetricSeverity,
      widths,
      availableWidth,
      fixedWidth,
    }).filter((id) => availableMetrics.has(id));
    const overflowed = metricCandidates(preferencesState.value, currentMetricSeverity, availableMetrics)
      .filter((id) => !visibleMetrics.includes(id));

    resetNode(elements.metrics);
    for (const id of visibleMetrics) {
      elements.metrics.appendChild(buttonRecords.get(id).button);
      widthCache.set(id, measureWidth(buttonRecords.get(id).button, widths[id]));
    }

    const overflowTone = overflowed.reduce((best, id) => maxTone(best, currentMetricSeverity[id] ?? 'neutral'), 'neutral');
    elements.more.dataset.severity = overflowTone;
    elements.more.textContent = overflowed.length ? `More ${overflowed.length}` : 'More';
    elements.more.title = overflowed.length
      ? `${overflowed.length} metrics hidden at this width`
      : 'Customize footer metrics';

    for (const button of scopeButtons) {
      const scopeNameForButton = buttonScopeValue(button);
      const selected = scopeNameForButton === scopeName;
      button.disabled = scopeNameForButton === 'focused' && !focusedAvailable;
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const panelId = activePanelId;
    elements.detail.hidden = panelId == null;
    elements.detailTitle.textContent = panelId == null
      ? 'Workspace metrics'
      : PANEL_TITLES[panelId] ?? 'Workspace metrics';
    elements.pin.disabled = activeTriggerMetric == null;
    const pinned = activeTriggerMetric != null && preferencesState.value.pinned.includes(activeTriggerMetric);
    elements.pin.textContent = pinned ? 'Unpin metric' : 'Pin metric';
    elements.pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');

    if (panelId == null) {
      resetNode(elements.detailBody);
    } else if (panelId === 'agents') {
      renderAgents(elements.detail, elements.detailBody, doc, liveSample.summary);
    } else if (panelId === 'shells') {
      renderShells(elements.detail, elements.detailBody, doc, liveSample.summary, liveSample.nativeSnapshot, liveSample.activity);
    } else if (panelId === 'tasks') {
      renderTasks(elements.detailBody, doc, liveSample.summary);
    } else if (panelId === 'performance') {
      renderPerformance(elements.detailBody, doc, liveSample, trends);
    } else if (panelId === 'activity') {
      renderActivity(
        elements.detailBody,
        doc,
        liveSample.activity,
        trends,
        spikes,
        Number.isFinite(liveSample.context?.agentToolCalls) ? liveSample.context.agentToolCalls : null,
      );
    } else if (panelId === 'connection') {
      renderConnection(elements.detailBody, doc, liveSample.nativeHealth, liveSample.covenHealth);
    }

    renderMoreMenuState({
      body: elements.moreMenu,
      doc,
      availableMetrics,
      currentMetricSeverity,
      metricDisplays,
      elements,
      overflowed,
      preferences: preferencesState.value,
      currentTriggerMetric: activeTriggerMetric,
    });

    const effectiveDiagnosticsScope = scopeName === 'focused' ? 'focused' : 'workspace';
    lastRenderedDiagnostics = buildDiagnostics(liveSample, effectiveDiagnosticsScope, trends);
    lastView = {
      activeMetric: activeTriggerMetric,
      activePanel: activePanelId,
      effectiveScope: effectiveDiagnosticsScope,
      visibleMetrics,
      overflowed,
      labels,
      metricSeverity: { ...currentMetricSeverity },
      diagnostics: lastRenderedDiagnostics,
    };

    restoreFocusToken(doc, elements, focusToken);
    return lastView;
  }

  function frameLoop(frameAt) {
    frameSampler.frame(frameAt);
    if (!running || documentHidden(doc)) {
      frameId = null;
      return;
    }
    frameId = requestFrame(frameLoop);
  }

  function ensureFrameLoop() {
    if (frameId != null || documentHidden(doc)) return;
    frameId = requestFrame(frameLoop);
  }

  function stopFrameLoop() {
    if (frameId == null) return;
    cancelFrame(frameId);
    frameId = null;
  }

  function schedulePoll() {
    if (!running) return;
    if (timerId != null) {
      clearTimer(timerId);
      timerId = null;
    }

    const delay = samplingDelay({
      hidden: documentHidden(doc),
      idleForMs: now() - lastActivityAt,
    });
    if (delay == null) return;

    timerId = setTimer(() => {
      timerId = null;
      refresh();
    }, delay);
  }

  async function runPoll(token) {
    let context = getContext();
    let scopeState = effectiveScopeForContext(context);
    const requestScope = nativeRequestScope(scopeState);
    const startedAt = performanceApi.now();

    try {
      const result = await requestNativeMetrics(requestScope.scope);
      const latencyMs = performanceApi.now() - startedAt;
      if (isStoppedNativeRequest(result)) {
        return lastView;
      }
      if (token !== lifecycleToken || result.generation !== nativePollGeneration) {
        return lastView;
      }
      const sampledAt = now();
      const currentContext = getContext();
      const currentScopeState = effectiveScopeForContext(currentContext);
      const discardFocusedResult = shouldDiscardFocusedSnapshot(requestScope.key, currentScopeState);
      if (result.ok) {
        updateNativeHealthFromSuccess(result.snapshot, latencyMs, sampledAt, {
          commitSnapshot: !discardFocusedResult,
        });
      } else {
        updateNativeHealthFromFailure(result.error, latencyMs, sampledAt);
      }
      if (discardFocusedResult) {
        // Snapshot applicability is scope-bound, but native bridge health is global.
        refreshQueued = true;
        return lastView;
      }
      context = currentContext;
      scopeState = currentScopeState;
    } catch (error) {
      const latencyMs = performanceApi.now() - startedAt;
      if (token !== lifecycleToken) {
        return lastView;
      }
      updateNativeHealthFromFailure(error, latencyMs, now());
    }

    if (token !== lifecycleToken) {
      return lastView;
    }

    const sampledAt = now();
    const activitySample = flushActivity(activity, sampledAt);
    const frameSample = frameSampler.flush(Math.max(1, sampledAt - lastFrameFlushAt));
    lastFrameFlushAt = sampledAt;
    lastActivitySample = activitySample;
    lastFrameSample = frameSample;

    processSample({
      sampledAt,
      context,
      summary: summarizeWorkspace({
        now: sampledAt,
        activeThreadId: context?.activeThreadId ?? null,
        threads: context?.threads ?? [],
        covenSessions: context?.covenSessions ?? [],
      }),
      scopeState,
      nativeSnapshot: lastSuccessfulSnapshot,
      nativeHealth: nativeHealthView(nativeHealth, sampledAt),
      activity: activitySample,
      frame: frameSample,
      covenHealth: covenHealthView(covenHealth),
    });

    return lastView;
  }

  function refresh() {
    if (pollInFlight) {
      refreshQueued = true;
      return pollInFlight;
    }

    const token = lifecycleToken;
    const request = runPoll(token);
    const trackedRequest = request.finally(() => {
      if (pollInFlight === trackedRequest) {
        pollInFlight = null;
      }
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
        return;
      }
      if (running && token === lifecycleToken) {
        schedulePoll();
      }
    });
    pollInFlight = trackedRequest;

    return pollInFlight;
  }

  function handleVisibilityChange() {
    if (documentHidden(doc)) {
      if (timerId != null) {
        clearTimer(timerId);
        timerId = null;
      }
      stopFrameLoop();
      return;
    }

    noteActivity();
    ensureFrameLoop();
    refresh();
  }

  function handleKeydown(event) {
    noteActivity();
    if (event.key === 'Escape' && !elements.moreMenu.hidden) {
      event.preventDefault();
      closeMoreMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Escape' && activeTriggerMetric) {
      event.preventDefault();
      closePanel();
      return;
    }
  }

  function handleDetailScroll() {
    if (detailRenderFrameId != null ||
        (activePanelId !== 'agents' && activePanelId !== 'shells')) return;
    detailRenderFrameId = requestFrame(() => {
      detailRenderFrameId = null;
      if (lastSampleContext) renderView();
    });
  }

  function handleMetricsClick(event) {
    noteActivity();
    const trigger = findMatchingNode(
      event?.target,
      elements.metrics,
      (node) => typeof node?.dataset?.metric === 'string' && METRICS[node.dataset.metric],
    );
    if (!trigger) return;
    toggleMetric(trigger.dataset.metric);
  }

  function handleMoreClick() {
    noteActivity();
    const willOpen = elements.moreMenu.hidden;
    elements.moreMenu.hidden = !willOpen;
    elements.more.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      renderView();
    }
  }

  function handleMoreMenuClick(event) {
    noteActivity();
    const control = findMatchingNode(
      event?.target,
      elements.moreMenu,
      (node) => typeof node?.dataset?.moreAction === 'string',
    );
    if (!control) return;

    const id = control.dataset.metric;
    if (!id || !METRICS[id]) return;

    if (control.dataset.moreAction === 'open-metric') {
      openMetric(id, true);
      return;
    }
    if (control.dataset.moreAction === 'move-earlier') {
      moveMetric(id, -1);
      return;
    }
    if (control.dataset.moreAction === 'move-later') {
      moveMetric(id, 1);
    }
  }

  function handleMoreMenuChange(event) {
    noteActivity();
    const control = findMatchingNode(
      event?.target,
      elements.moreMenu,
      (node) => node?.dataset?.moreAction === 'toggle-visible',
    );
    if (!control) return;

    const id = control.dataset.metric;
    if (!id || !METRICS[id]) return;
    toggleVisibleMetric(id, control.checked === true);
  }

  function handlePinClick() {
    noteActivity();
    togglePinnedMetric(activeTriggerMetric);
  }

  function handleCopyClick() {
    noteActivity();
    void copyDiagnostics();
  }

  function handleCloseClick() {
    noteActivity();
    closePanel();
  }

  function handleScopeClick(event) {
    const scopeName = buttonScopeValue(event?.currentTarget ?? event?.target);
    setScope(scopeName);
  }

  function notePtyData(threadId, bytes, at = now()) {
    const payload = coerceBytes(bytes);
    if (typeof threadId !== 'string' || !payload) return;
    notePtyChunk(activity, threadId, payload, at);
    noteActivity(at);
  }

  function noteOperation(nameOrRecord, maybeDurationOrOk, maybeOk) {
    let name = '';
    let ok = true;

    if (nameOrRecord && typeof nameOrRecord === 'object') {
      name = nameOrRecord.name ?? nameOrRecord.command ?? '';
      ok = nameOrRecord.ok !== false;
    } else {
      name = typeof nameOrRecord === 'string' ? nameOrRecord : '';
      if (typeof maybeOk === 'boolean') ok = maybeOk;
      else if (typeof maybeDurationOrOk === 'boolean') ok = maybeDurationOrOk;
    }

    if (name === 'workspace_metrics') return;

    noteOperationMetric(activity, ok);
    noteActivity();
  }

  function noteCovenSample(sample = {}) {
    const input = asObject(sample);
    const phase = typeof input.phase === 'string'
      ? input.phase
      : typeof input.status === 'string'
        ? input.status
        : 'idle';
    const recovered = covenHealth.phase !== 'ready' && covenHealth.phase !== 'idle' && phase === 'ready';
    const nextRefreshedAt = parseTimestamp(input.refreshedAt ?? input.sampledAt ?? input.updatedAt);
    const hasError = hasOwn(input, 'formattedError') || hasOwn(input, 'error');
    const failurePhase = phase === 'error' || phase === 'unavailable' || phase === 'incompatible';
    covenHealth = {
      phase,
      reconnects: covenHealth.reconnects + (recovered ? 1 : 0),
      latencyMs: finiteNumber(input.latencyMs),
      refreshedAt: phase === 'ready'
        ? (nextRefreshedAt ?? now())
        : covenHealth.refreshedAt,
      error: phase === 'ready'
        ? ''
        : (failurePhase && hasError)
          ? formatError(input.formattedError ?? input.error)
          : covenHealth.error,
    };

    if (lastSampleContext) {
      lastSampleContext = {
        ...lastSampleContext,
        covenHealth: covenHealthView(covenHealth),
      };
      renderView();
    }
  }

  function setScope(scopeName) {
    const normalizedScope = scopeName === 'focused' ? 'focused' : 'workspace';
    writePreferences({ ...preferencesState.value, scope: normalizedScope });
    noteActivity();
    if (lastSampleContext) {
      renderView();
    }
    return refresh();
  }

  function render(sample) {
    if (sample) {
      const sampledAt = finiteNumber(sample.sampledAt) ?? now();
      const context = sample.context ?? getContext();
      const scopeState = sample.scopeState ?? effectiveScopeForContext(context);
      if (Object.prototype.hasOwnProperty.call(sample, 'nativeSnapshot')) {
        lastSuccessfulSnapshot = sample.nativeSnapshot;
      }
      if (sample.nativeHealth) {
        nativeHealth = mergeNativeHealthState(nativeHealth, sample.nativeHealth);
      }
      if (sample.covenHealth) {
        covenHealth = mergeCovenHealthState(covenHealth, sample.covenHealth);
      }
      lastSampleContext = {
        sampledAt,
        context,
        summary: sample.summary ?? summarizeWorkspace({
          now: sampledAt,
          activeThreadId: context?.activeThreadId ?? null,
          threads: context?.threads ?? [],
          covenSessions: context?.covenSessions ?? [],
        }),
        scopeState,
        nativeSnapshot: sample.nativeSnapshot ?? lastSuccessfulSnapshot,
        nativeHealth: nativeHealthView(nativeHealth, sampledAt),
        activity: sample.activity ?? lastActivitySample,
        frame: sample.frame ?? lastFrameSample,
        covenHealth: covenHealthView(covenHealth),
      };
    } else if (!lastSampleContext) {
      const sampledAt = now();
      const context = getContext();
      lastSampleContext = {
        sampledAt,
        context,
        summary: summarizeWorkspace({
          now: sampledAt,
          activeThreadId: context?.activeThreadId ?? null,
          threads: context?.threads ?? [],
          covenSessions: context?.covenSessions ?? [],
        }),
        scopeState: effectiveScopeForContext(context),
        nativeSnapshot: lastSuccessfulSnapshot,
        nativeHealth: nativeHealthView(nativeHealth, sampledAt),
        activity: lastActivitySample,
        frame: lastFrameSample,
        covenHealth: covenHealthView(covenHealth),
      };
    }

    scheduleNativeHealthTransition();
    return renderView(lastSampleContext);
  }

  function start() {
    if (running) return controller;
    drainCleanup();
    running = true;
    lifecycleToken += 1;
    registerListener(doc, 'visibilitychange', handleVisibilityChange);
    registerListener(doc, 'keydown', handleKeydown);
    registerListener(elements.metrics, 'click', handleMetricsClick);
    registerListener(elements.more, 'click', handleMoreClick);
    registerListener(elements.moreMenu, 'click', handleMoreMenuClick);
    registerListener(elements.moreMenu, 'change', handleMoreMenuChange);
    registerListener(elements.pin, 'click', handlePinClick);
    registerListener(elements.copy, 'click', handleCopyClick);
    registerListener(elements.close, 'click', handleCloseClick);
    registerListener(elements.detail, 'scroll', handleDetailScroll);
    for (const button of scopeButtons) {
      registerListener(button, 'click', handleScopeClick);
    }
    resizeObserver.observe(elements.bar);
    pushCleanup(() => resizeObserver.disconnect());
    ensureFrameLoop();
    scheduleNativeHealthTransition();
    handleVisibilityChange();
    return controller;
  }

  function stop() {
    if (!running
      && !cleanupCallbacks.length
      && timerId == null
      && nativeHealthTimerId == null
      && nativeRequestCancels.size === 0
      && frameId == null) {
      return controller;
    }
    running = false;
    lifecycleToken += 1;
    refreshQueued = false;
    pollInFlight = null;
    clearNativeHealthTimer();
    for (const cancelRequest of [...nativeRequestCancels]) {
      cancelRequest();
    }
    nativeRequestCancels = new Set();
    if (timerId != null) {
      clearTimer(timerId);
      timerId = null;
    }
    stopFrameLoop();
    if (detailRenderFrameId != null) {
      cancelFrame(detailRenderFrameId);
      detailRenderFrameId = null;
    }
    drainCleanup();
    return controller;
  }

  const controller = {
    start,
    stop,
    refresh,
    noteActivity,
    notePtyData,
    noteOperation,
    noteCovenSample,
    setScope,
    toggleMetric,
    closePanel,
    render,
  };

  return controller;
}
