export const DEFAULT_METRIC_ORDER = Object.freeze([
  'connection',
  'agents',
  'shells',
  'tasks',
  'performance',
  'fps',
  'activity',
]);

const METRIC_IDS = new Set(DEFAULT_METRIC_ORDER);
const LOCAL_AGENT_KINDS = new Set(['coven-chat', 'coven-attach']);
const ACTIVE_AGENT_STATUSES = new Set(['running', 'waiting', 'blocked']);
const IDEAL_FRAME_MS = 1000 / 60;
const MAX_TREND_SAMPLES = 60;
const DIAGNOSTIC_LIMIT = 16_384;
const DIAGNOSTIC_EXCLUSION = 'Excludes prompts, terminal contents, file contents, diffs, and browser contents.';

export const METRICS = Object.freeze({
  connection: Object.freeze({
    id: 'connection',
    panel: 'connection',
    label: 'Conn',
    compactLabel: 'Conn',
    priority: 100,
    tooltip: 'Native bridge and optional service health, reconnects, and refresh latency.',
    technicalTooltip: 'Native bridge and optional service health, reconnects, and refresh latency.',
  }),
  agents: Object.freeze({
    id: 'agents',
    panel: 'agents',
    label: 'Agents',
    compactLabel: 'Agents',
    priority: 90,
    tooltip: 'Active local coven panes plus unattached live Coven sessions.',
    technicalTooltip: 'Active local coven panes plus unattached live Coven sessions.',
  }),
  shells: Object.freeze({
    id: 'shells',
    panel: 'shells',
    label: 'Shells',
    compactLabel: 'Shells',
    priority: 80,
    tooltip: 'Running local PTY panes only; web, git, and tool panes are excluded.',
    technicalTooltip: 'Running local PTY panes only; web, git, and tool panes are excluded.',
  }),
  tasks: Object.freeze({
    id: 'tasks',
    panel: 'tasks',
    label: 'Tasks',
    compactLabel: 'Tasks',
    priority: 95,
    tooltip: 'All process-backed local panes plus unattached remote sessions normalized into running, waiting, blocked, failed, and completed states.',
    technicalTooltip: 'All process-backed local panes plus unattached remote sessions normalized into running, waiting, blocked, failed, and completed states.',
  }),
  performance: Object.freeze({
    id: 'performance',
    panel: 'performance',
    label: 'Perf',
    compactLabel: 'Perf',
    priority: 70,
    tooltip: 'Workspace CPU and memory pressure. Warns after 5 consecutive samples at or above 80% CPU or 85% memory, and clears below 70% CPU or 78% memory.',
    technicalTooltip: 'Workspace CPU and memory pressure. Warns after 5 consecutive samples at or above 80% CPU or 85% memory, and clears below 70% CPU or 78% memory.',
  }),
  fps: Object.freeze({
    id: 'fps',
    panel: 'performance',
    label: 'FPS',
    compactLabel: 'FPS',
    priority: 60,
    tooltip: 'UI frame rate and render latency. Warns after 5 consecutive samples below 45 FPS or above 32 ms render latency; clears at 50 FPS and 24 ms.',
    technicalTooltip: 'UI frame rate and render latency. Warns after 5 consecutive samples below 45 FPS or above 32 ms render latency; clears at 50 FPS and 24 ms.',
  }),
  activity: Object.freeze({
    id: 'activity',
    panel: 'activity',
    label: 'Output',
    compactLabel: 'Output',
    priority: 50,
    tooltip: 'Terminal output and native ops. Warns after 3 consecutive samples at or above 1,000 lines/s and at least 4x the output baseline; clears below 500 lines/s.',
    technicalTooltip: 'Terminal output and native ops. Warns after 3 consecutive samples at or above 1,000 lines/s and at least 4x the output baseline; clears below 500 lines/s.',
  }),
});

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
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

function sanitizeMetricIds(value) {
  const unique = [];
  const seen = new Set();

  for (const id of Array.isArray(value) ? value : []) {
    if (!METRIC_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  return unique;
}

function completedOrder(order) {
  const requested = sanitizeMetricIds(order);
  return requested.concat(
    DEFAULT_METRIC_ORDER.filter((id) => !requested.includes(id)),
  );
}

function normalizeLocalStatus(thread) {
  const status = typeof thread?.status === 'string' ? thread.status.trim().toLowerCase() : '';

  if (status === 'failed') return 'failed';
  if (status === 'exited') {
    return thread?.exitCode == null || thread.exitCode === 0 ? 'completed' : 'failed';
  }
  if (status === 'blocked') return 'blocked';
  if (thread?.needsAttention) return 'waiting';
  return 'running';
}

function normalizeRemoteStatus(session) {
  const status = typeof session?.status === 'string' ? session.status.trim().toLowerCase() : '';

  if (status === 'waiting') return 'waiting';
  if (status === 'blocked') return 'blocked';
  if (['failed', 'killed', 'orphaned'].includes(status)) return 'failed';
  if (['completed', 'archived', 'idle'].includes(status)) return 'completed';
  return 'running';
}

function runtimeMs(item, now) {
  const started = parseTimestamp(item?.startedAt ?? item?.createdAt);
  if (started == null) return null;
  const finished = parseTimestamp(item?.finishedAt ?? item?.archivedAt);
  const endedAt = finished == null ? now : finished;
  return Math.max(0, endedAt - started);
}

function mergedTokens(thread, session) {
  const localTokens = asObject(thread?.tokens);
  const remoteInput = finiteNumber(session?.inputTokens);
  const remoteOutput = finiteNumber(session?.outputTokens);
  const localInput = finiteNumber(localTokens.input);
  const localOutput = finiteNumber(localTokens.output);
  const input = remoteInput ?? localInput;
  const output = remoteOutput ?? localOutput;

  return input == null && output == null ? null : { input, output };
}

function isActiveAgentStatus(status) {
  return ACTIVE_AGENT_STATUSES.has(status);
}

export function normalizePreferences(value) {
  const input = asObject(value);
  const visible = Array.isArray(input.visible)
    ? sanitizeMetricIds(input.visible)
    : [...DEFAULT_METRIC_ORDER];
  const order = completedOrder(input.order);
  const pinned = sanitizeMetricIds(input.pinned);

  if (!visible.includes('connection')) {
    visible.push('connection');
  }

  return {
    version: 1,
    visible,
    order,
    pinned,
    scope: input.scope === 'focused' ? 'focused' : 'workspace',
  };
}

export function summarizeWorkspace(input) {
  const source = asObject(input);
  const now = finiteNumber(source.now) ?? Date.now();
  const threads = Array.isArray(source.threads) ? source.threads : [];
  const covenSessions = Array.isArray(source.covenSessions) ? source.covenSessions : [];
  const covenById = new Map(
    covenSessions
      .filter((session) => typeof session?.id === 'string' && session.id)
      .map((session) => [session.id, session]),
  );
  const processThreads = threads.filter((thread) => thread?.processBacked === true);
  const localAgentThreads = processThreads.filter((thread) => LOCAL_AGENT_KINDS.has(thread?.kind));
  const attachedSessionIds = new Set(
    localAgentThreads
      .map((thread) => (typeof thread?.covenSessionId === 'string' && thread.covenSessionId)
        ? thread.covenSessionId
        : null)
      .filter(Boolean),
  );
  const unattachedSessions = covenSessions.filter((session) => !attachedSessionIds.has(session?.id));

  const agents = localAgentThreads
    .map((thread) => {
      const remote = covenById.get(thread.covenSessionId) ?? null;
      const status = normalizeLocalStatus(thread);

      return {
        id: `local:${thread.id}`,
        name: typeof thread?.name === 'string' && thread.name ? thread.name : thread.id,
        harness: remote?.harness ?? thread?.harness ?? null,
        model: remote?.model ?? thread?.model ?? null,
        currentTask: remote?.currentTask ?? thread?.currentTask ?? null,
        tokens: mergedTokens(thread, remote),
        status,
        runtimeMs: runtimeMs(thread, now),
        threadId: thread.id,
      };
    })
    .filter((agent) => isActiveAgentStatus(agent.status))
    .concat(
      unattachedSessions
        .map((session) => ({
          id: `coven:${session.id}`,
          name: typeof session?.title === 'string' && session.title.trim()
            ? session.title.trim()
            : session.id,
          harness: session?.harness ?? null,
          model: session?.model ?? null,
          currentTask: session?.currentTask ?? null,
          tokens: mergedTokens(null, session),
          status: normalizeRemoteStatus(session),
          runtimeMs: runtimeMs(session, now),
          threadId: null,
        }))
        .filter((agent) => isActiveAgentStatus(agent.status)),
    );

  const shells = processThreads
    .filter((thread) => thread?.kind === 'shell')
    .map((thread) => ({
      id: thread.id,
      name: typeof thread?.name === 'string' && thread.name ? thread.name : thread.id,
      status: normalizeLocalStatus(thread),
      runtimeMs: runtimeMs(thread, now),
      threadId: thread.id,
    }))
    .filter((shell) => shell.status === 'running');

  const tasks = processThreads
    .map((thread) => ({
      id: `local:${thread.id}`,
      name: typeof thread?.name === 'string' && thread.name ? thread.name : thread.id,
      status: normalizeLocalStatus(thread),
      runtimeMs: runtimeMs(thread, now),
      threadId: thread.id,
    }))
    .concat(
      unattachedSessions.map((session) => ({
        id: `coven:${session.id}`,
        name: typeof session?.title === 'string' && session.title.trim()
          ? session.title.trim()
          : session.id,
        status: normalizeRemoteStatus(session),
        runtimeMs: runtimeMs(session, now),
        threadId: null,
      })),
    );

  return {
    agents,
    shells,
    tasks,
    counts: {
      agents: agents.length,
      shells: shells.length,
      running: tasks.filter((task) => task.status === 'running').length,
      waiting: tasks.filter((task) => task.status === 'waiting').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
    },
  };
}

export function createActivityTracker() {
  return {
    threads: new Map(),
    lastFlushAt: 0,
    operations: 0,
    errors: 0,
  };
}

export function notePtyChunk(tracker, threadId, bytes, at) {
  if (!tracker?.threads || typeof threadId !== 'string' || !(bytes instanceof Uint8Array)) {
    return;
  }

  let row = tracker.threads.get(threadId);
  if (!row) {
    row = {
      decoder: new TextDecoder(),
      carry: '',
      bytes: 0,
      lines: 0,
      at: finiteNumber(at) ?? 0,
    };
    tracker.threads.set(threadId, row);
  }

  const decoded = row.decoder.decode(bytes, { stream: true });
  const parts = `${row.carry}${decoded}`.split('\n');
  row.carry = parts.pop() ?? '';
  row.lines += parts.length;
  row.bytes += bytes.byteLength;
  row.at = finiteNumber(at) ?? row.at;
}

export function noteOperation(tracker, ok) {
  if (!tracker) return;
  tracker.operations += 1;
  if (ok === false) {
    tracker.errors += 1;
  }
}

export function flushActivity(tracker, at) {
  const flushAt = finiteNumber(at) ?? tracker?.lastFlushAt ?? 0;
  const elapsed = Math.max(1, flushAt - (tracker?.lastFlushAt ?? 0));
  const threads = [];
  let bytes = 0;
  let lines = 0;

  for (const [threadId, row] of tracker?.threads ?? []) {
    bytes += row.bytes;
    lines += row.lines;
    threads.push({
      threadId,
      bytesPerSecond: Math.round((row.bytes * 1000) / elapsed),
      linesPerSecond: Math.round((row.lines * 1000) / elapsed),
    });
    row.bytes = 0;
    row.lines = 0;
  }

  const workspace = {
    bytesPerSecond: Math.round((bytes * 1000) / elapsed),
    linesPerSecond: Math.round((lines * 1000) / elapsed),
    operationsPerSecond: Math.round(((tracker?.operations ?? 0) * 1000) / elapsed),
    errors: tracker?.errors ?? 0,
  };

  tracker.operations = 0;
  tracker.errors = 0;
  tracker.lastFlushAt = flushAt;

  return { workspace, threads };
}

function updateThreshold(previousState, value, { activate, clear, required }) {
  const previous = previousState && typeof previousState === 'object'
    ? previousState
    : { count: 0, warned: false };

  if (!Number.isFinite(value)) {
    return previous;
  }

  if (activate(value)) {
    const count = previous.count + 1;
    return { count, warned: previous.warned || count >= required };
  }

  if (previous.warned) {
    return { count: 0, warned: !clear(value) };
  }

  return { count: 0, warned: false };
}

export function evaluateSeverity(sample, previous = {}) {
  const current = asObject(sample);
  const prior = asObject(previous);
  const outputValue = finiteNumber(current.outputLinesPerSecond);
  const outputBaseline = Math.max(1, finiteNumber(current.outputBaseline) ?? 0);
  const cpu = updateThreshold(prior.cpu, finiteNumber(current.cpuPercent), {
    activate: (value) => value >= 80,
    clear: (value) => value < 70,
    required: 5,
  });
  const memory = updateThreshold(prior.memory, finiteNumber(current.memoryPressurePercent), {
    activate: (value) => value >= 85,
    clear: (value) => value < 78,
    required: 5,
  });
  const fps = updateThreshold(prior.fps, finiteNumber(current.fps), {
    activate: (value) => value < 45,
    clear: (value) => value >= 50,
    required: 5,
  });
  const latency = updateThreshold(prior.latency, finiteNumber(current.renderLatencyMs), {
    activate: (value) => value > 32,
    clear: (value) => value <= 24,
    required: 5,
  });
  const activity = updateThreshold(prior.activity, outputValue, {
    activate: (value) => value >= 1_000 && value >= 4 * outputBaseline,
    clear: (value) => value < 500,
    required: 3,
  });

  return {
    state: { cpu, memory, fps, latency, activity },
    severity: {
      cpu: cpu.warned ? 'warn' : 'neutral',
      memory: memory.warned ? 'warn' : 'neutral',
      fps: fps.warned ? 'warn' : 'neutral',
      latency: latency.warned ? 'warn' : 'neutral',
      activity: activity.warned ? 'warn' : 'neutral',
    },
  };
}

function severityRank(value) {
  if (value === 'danger') return 3;
  if (value === 'warn') return 2;
  return 0;
}

export function chooseVisibleMetrics(input) {
  const source = asObject(input);
  const order = completedOrder(source.order);
  const visible = new Set(sanitizeMetricIds(source.visible));
  const pinned = new Set(sanitizeMetricIds(source.pinned));
  const severity = asObject(source.severity);
  const widths = asObject(source.widths);
  const forced = new Set(['connection']);

  for (const id of DEFAULT_METRIC_ORDER) {
    if (severityRank(severity[id]) > 0 || pinned.has(id)) {
      forced.add(id);
    }
  }

  const candidates = order.filter((id) => visible.has(id) || forced.has(id));
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const ranked = [...candidates].sort((left, right) => {
    const leftRank = left === 'connection'
      ? 4
      : Math.max(severityRank(severity[left]), pinned.has(left) ? 1 : 0);
    const rightRank = right === 'connection'
      ? 4
      : Math.max(severityRank(severity[right]), pinned.has(right) ? 1 : 0);

    if (leftRank !== rightRank) return rightRank - leftRank;
    if (METRICS[left].priority !== METRICS[right].priority) {
      return METRICS[right].priority - METRICS[left].priority;
    }
    return (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0);
  });

  const budget = Math.max(0, (finiteNumber(source.availableWidth) ?? 0)
    - Math.max(0, finiteNumber(source.fixedWidth) ?? 0));
  let used = 0;
  const selected = new Set();

  for (const id of ranked) {
    const width = Math.max(0, finiteNumber(widths[id]) ?? 80);
    if (used + width > budget) continue;
    selected.add(id);
    used += width;
  }

  return order.filter((id) => selected.has(id));
}

export function pushTrend(values, value, previousPeak = Number.NEGATIVE_INFINITY) {
  const nextPeak = Number.isFinite(previousPeak) ? previousPeak : Number.NEGATIVE_INFINITY;

  if (Array.isArray(values) && Number.isFinite(value)) {
    values.push(value);
    if (values.length > MAX_TREND_SAMPLES) {
      values.splice(0, values.length - MAX_TREND_SAMPLES);
    }
  }

  return {
    values,
    peak: Number.isFinite(value) ? Math.max(nextPeak, value) : nextPeak,
  };
}

export function median(values) {
  const finite = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  if (!finite.length) return 0;

  const sorted = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sparklinePath(values, width, height) {
  const finite = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  const maxWidth = Math.max(0, finiteNumber(width) ?? 0);
  const maxHeight = Math.max(0, finiteNumber(height) ?? 0);

  if (!finite.length) return '';

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;
  const baselineY = maxHeight / 2;

  return finite.map((value, index) => {
    const x = finite.length === 1 ? 0 : (index * maxWidth) / (finite.length - 1);
    const y = range === 0
      ? baselineY
      : maxHeight - (((value - min) / range) * maxHeight);
    const command = index === 0 ? 'M' : 'L';
    return `${command} ${clamp(x, 0, maxWidth).toFixed(1)} ${clamp(y, 0, maxHeight).toFixed(1)}`;
  }).join(' ');
}

export function samplingDelay({ hidden, idleForMs }) {
  if (hidden) return null;
  return (finiteNumber(idleForMs) ?? 0) >= 30_000 ? 5_000 : 1_000;
}

export function createFrameSampler() {
  let previousAt = null;
  let frames = 0;
  let intervals = 0;
  let totalIntervalMs = 0;
  let droppedFrames = 0;

  return {
    frame(at) {
      const frameAt = finiteNumber(at);
      if (frameAt == null) return;

      if (previousAt != null) {
        const delta = Math.max(0, frameAt - previousAt);
        totalIntervalMs += delta;
        intervals += 1;
        droppedFrames += Math.max(0, Math.round(delta / IDEAL_FRAME_MS) - 1);
      }

      previousAt = frameAt;
      frames += 1;
    },
    flush(windowMs) {
      const duration = Math.max(1, finiteNumber(windowMs) ?? 0);
      const sample = {
        fps: Math.round((frames * 1000) / duration),
        renderLatencyMs: intervals > 0 ? totalIntervalMs / intervals : 0,
        droppedFrames,
      };

      previousAt = null;
      frames = 0;
      intervals = 0;
      totalIntervalMs = 0;
      droppedFrames = 0;

      return sample;
    },
  };
}

function formatMetricPeak(label, value, formatter) {
  return Number.isFinite(value) ? `${label} ${formatter(value)}` : null;
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function formatMemory(value) {
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function formatTrendSummary(name, values) {
  const finite = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  if (!finite.length) return null;
  return `${name} trend: ${Math.round(finite[0])} → ${Math.round(finite[finite.length - 1])}`;
}

function buildDiagnosticsText(bodyLines, serviceLines) {
  const suffixLines = ['', 'Services:', ...serviceLines, '', DIAGNOSTIC_EXCLUSION];
  let text = [...bodyLines, ...suffixLines].join('\n');
  if (text.length <= DIAGNOSTIC_LIMIT) return text;

  const truncatedBody = [...bodyLines];
  while (truncatedBody.length > 0) {
    text = [...truncatedBody, ...suffixLines].join('\n');
    if (text.length <= DIAGNOSTIC_LIMIT) return text;
    truncatedBody.pop();
  }

  const suffix = suffixLines.join('\n');
  if (suffix.length >= DIAGNOSTIC_LIMIT) {
    return suffix.slice(0, DIAGNOSTIC_LIMIT);
  }

  return suffix;
}

export function formatLiveDiagnostics(input) {
  const source = asObject(input);
  const metrics = asObject(source.metrics);
  const peaks = asObject(source.peaks);
  const trendEntries = Object.entries(asObject(source.trends))
    .map(([name, values]) => formatTrendSummary(name, values))
    .filter(Boolean);
  const outputRate = finiteNumber(metrics.outputLinesPerSecond) ?? finiteNumber(metrics.linesPerSecond);
  const bodyLines = [
    '# Psyche Build Live Metrics',
    `Sampled: ${new Date(finiteNumber(source.sampledAt) ?? 0).toISOString()}`,
    `Scope: ${source.scope === 'focused' ? 'focused' : 'workspace'}`,
  ];

  if (Number.isFinite(metrics.cpuPercent)) {
    bodyLines.push(`CPU: ${formatPercent(metrics.cpuPercent)}`);
  }
  if (Number.isFinite(metrics.memoryBytes)) {
    bodyLines.push(`Memory: ${formatMemory(metrics.memoryBytes)}`);
  }
  if (Number.isFinite(metrics.fps)) {
    bodyLines.push(`FPS: ${Math.round(metrics.fps)}`);
  }
  if (Number.isFinite(outputRate)) {
    bodyLines.push(`Output: ${Math.round(outputRate)} lines/s`);
  }

  const peakParts = [
    formatMetricPeak('CPU', peaks.cpuPercent, formatPercent),
    formatMetricPeak('Memory', peaks.memoryBytes, formatMemory),
    formatMetricPeak('FPS', peaks.fps, (value) => `${Math.round(value)}`),
    formatMetricPeak('Output', peaks.outputLinesPerSecond ?? peaks.linesPerSecond, (value) => `${Math.round(value)} lines/s`),
  ].filter(Boolean);

  if (peakParts.length) {
    bodyLines.push(`Observed peaks: ${peakParts.join(', ')}`);
  }

  if (trendEntries.length) {
    bodyLines.push(...trendEntries);
  }

  const serviceLines = (Array.isArray(source.services) ? source.services : []).map((service) => {
    const latencyMs = finiteNumber(service?.latencyMs);
    const latency = latencyMs == null ? '' : ` (${Math.round(latencyMs)} ms)`;
    return `- ${service?.name ?? 'Service'}: ${service?.status ?? 'unknown'}${latency}`;
  });

  return buildDiagnosticsText(bodyLines, serviceLines);
}
