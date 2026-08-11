# Minimal Footer Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 26px bottom status bar with real workspace/process telemetry, adaptive sampling, responsive overflow, and expandable metric details to the Psyche Build macOS Tauri app.

**Architecture:** A managed Rust `MetricsCollector` samples the Psyche process and tracked PTY process trees through `sysinfo` and exposes one `workspace_metrics` command. A bundled frontend status module combines native snapshots with existing pane/Coven lifecycle data, PTY throughput, operation timings, and frame sampling; it owns persistence, severity, responsive ordering, rendering, and interactions while `main.js` remains the adapter to existing application state.

**Tech Stack:** Rust 1.77+, Tauri 2, `sysinfo` 0.36.1, vanilla JavaScript ES modules bundled with esbuild, HTML/CSS, Vitest, TypeScript contract tests.

---

## File Structure

### New files

- `native/macos/psyche-build-tauri/src-tauri/src/metrics.rs` — native process sampling, process-tree aggregation, serializable metric snapshots, and Rust unit tests.
- `native/macos/psyche-build-tauri/web/status/status-model.mjs` — pure metric registry, task/agent normalization, rate tracking, thresholds, preferences, responsive selection, sparklines, and diagnostics formatting.
- `native/macos/psyche-build-tauri/web/status/status-model.d.mts` — TypeScript declarations for the pure model consumed by Vitest.
- `native/macos/psyche-build-tauri/web/status/status-controller.mjs` — adaptive polling, frame sampling, DOM rendering, panel interaction, More/customization, and clipboard behavior.
- `native/macos/psyche-build-tauri/web/status/status-entry.js` — browser bundle entrypoint exporting the model and controller API.
- `native/macos/psyche-build-tauri/web/status.bundle.js` — committed esbuild output.
- `__tests__/tauriStatusModel.test.ts` — pure frontend metric behavior.
- `__tests__/tauriMetricsNativeContract.test.ts` — Tauri command, PID lifecycle, and native dependency wiring.
- `__tests__/tauriFooterStatusBar.test.ts` — markup, CSS, bundle, main-shell integration, accessibility, and interaction contracts.

### Modified files

- `native/macos/psyche-build-tauri/src-tauri/Cargo.toml` — add `sysinfo`.
- `native/macos/psyche-build-tauri/src-tauri/Cargo.lock` — lock the native dependency.
- `native/macos/psyche-build-tauri/src-tauri/src/lib.rs` — retain PTY PIDs, manage the collector, expose `workspace_metrics`, and preserve exit codes.
- `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs` — pass through optional structured model/task/token fields.
- `native/macos/psyche-build-tauri/web/sessions/session-model.d.mts` — describe the optional Coven metric fields.
- `native/macos/psyche-build-tauri/web/index.html` — add the footer stack, detail host, status bar, More menu, live region, and status bundle.
- `native/macos/psyche-build-tauri/web/styles.css` — 26px bar, bounded detail panel, compact rows, sparklines, responsive overflow, and semantic states.
- `native/macos/psyche-build-tauri/web/main.js` — instrument invocations, record lifecycle timestamps/exit codes, feed PTY/Coven activity, and initialize the status controller.
- `native/macos/psyche-build-tauri/package.json` — build `status.bundle.js`.
- `__tests__/tauriWorkspacePanels.test.ts` — update the exact bundle script and script-order contract.
- `__tests__/tauriWebBundles.test.ts` — require the committed status bundle.

## Task 1: Build the Pure Frontend Metric Model

**Files:**
- Create: `native/macos/psyche-build-tauri/web/status/status-model.mjs`
- Create: `native/macos/psyche-build-tauri/web/status/status-model.d.mts`
- Create: `__tests__/tauriStatusModel.test.ts`

- [ ] **Step 1: Write failing registry, preference, and normalization tests**

Create `__tests__/tauriStatusModel.test.ts` with these initial tests:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRIC_ORDER,
  normalizePreferences,
  summarizeWorkspace,
} from '../native/macos/psyche-build-tauri/web/status/status-model.mjs';

describe('status metric preferences', () => {
  it('keeps only known metrics and restores required controls', () => {
    expect(normalizePreferences({
      version: 1,
      visible: ['fps', 'unknown', 'connection'],
      order: ['unknown', 'fps'],
      pinned: ['unknown', 'fps'],
      scope: 'focused',
    })).toEqual({
      version: 1,
      visible: ['fps', 'connection'],
      order: ['fps', ...DEFAULT_METRIC_ORDER.filter((id) => id !== 'fps')],
      pinned: ['fps'],
      scope: 'focused',
    });
  });
});

describe('workspace status normalization', () => {
  it('treats every process-backed pane as task work and de-duplicates Coven attachments', () => {
    const summary = summarizeWorkspace({
      now: 20_000,
      activeThreadId: 'agent',
      threads: [
        {
          id: 'agent', name: 'Nova', kind: 'coven-attach', status: 'running',
          covenSessionId: 'session-1', startedAt: 5_000, needsAttention: true,
          processBacked: true,
        },
        {
          id: 'shell', name: 'Tests', kind: 'shell', status: 'exited',
          startedAt: 1_000, finishedAt: 10_000, exitCode: 1,
          processBacked: true,
        },
        { id: 'web', name: 'Web', kind: 'web', status: 'running', processBacked: false },
      ],
      covenSessions: [
        {
          id: 'session-1', title: 'Nova remote', harness: 'claude', status: 'waiting',
          model: 'claude-sonnet', currentTask: 'Reviewing tests',
          inputTokens: 120, outputTokens: 40,
        },
        { id: 'session-2', title: 'Codex', harness: 'codex', status: 'running' },
      ],
    });

    expect(summary.agents).toHaveLength(2);
    expect(summary.shells).toHaveLength(0);
    expect(summary.tasks.map((task) => task.status).sort()).toEqual([
      'failed', 'running', 'waiting',
    ]);
    expect(summary.counts).toMatchObject({
      agents: 2, shells: 0, running: 1, waiting: 1, failed: 1,
    });
    expect(summary.agents.find((agent) => agent.id === 'local:agent')).toMatchObject({
      harness: 'claude',
      model: 'claude-sonnet',
      currentTask: 'Reviewing tests',
      tokens: { input: 120, output: 40 },
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify module resolution fails**

Run:

```bash
pnpm exec vitest --run __tests__/tauriStatusModel.test.ts
```

Expected: FAIL because `web/status/status-model.mjs` does not exist.

- [ ] **Step 3: Implement the registry, preference validation, and workspace normalization**

Create `status-model.mjs` with this public registry and normalization contract:

```js
export const DEFAULT_METRIC_ORDER = [
  "connection", "agents", "shells", "tasks",
  "performance", "fps", "activity",
];

export const METRICS = Object.freeze({
  connection: { id: "connection", panel: "connection", label: "Connection", priority: 100, tooltip: "Native bridge and optional service health" },
  agents: { id: "agents", panel: "agents", label: "Agents", priority: 90, tooltip: "Active local and Coven-backed agent sessions" },
  shells: { id: "shells", panel: "shells", label: "Shells", priority: 80, tooltip: "Running local PTY processes" },
  tasks: { id: "tasks", panel: "tasks", label: "Tasks", priority: 95, tooltip: "Running, waiting, blocked, failed, and completed pane work" },
  performance: { id: "performance", panel: "performance", label: "CPU / memory", priority: 70, tooltip: "Workspace process-tree CPU and resident memory; warns after sustained 80% CPU or 85% memory pressure" },
  fps: { id: "fps", panel: "performance", label: "Frame rate", priority: 60, tooltip: "UI frames per second, frame interval, and dropped frames; warns below 45 FPS" },
  activity: { id: "activity", panel: "activity", label: "Output rate", priority: 50, tooltip: "Terminal lines per second and Psyche native operations; warns on sustained output spikes" },
});

const METRIC_IDS = new Set(DEFAULT_METRIC_ORDER);
const AGENT_KINDS = new Set(["coven-chat", "coven-attach"]);

export function normalizePreferences(value) {
  const input = value && typeof value === "object" ? value : {};
  const visible = Array.isArray(input.visible)
    ? input.visible.filter((id, index, ids) => METRIC_IDS.has(id) && ids.indexOf(id) === index)
    : DEFAULT_METRIC_ORDER.slice();
  if (!visible.includes("connection")) visible.push("connection");
  const requestedOrder = Array.isArray(input.order)
    ? input.order.filter((id, index, ids) => METRIC_IDS.has(id) && ids.indexOf(id) === index)
    : [];
  const order = requestedOrder.concat(
    DEFAULT_METRIC_ORDER.filter((id) => !requestedOrder.includes(id)),
  );
  const pinned = Array.isArray(input.pinned)
    ? input.pinned.filter((id, index, ids) => METRIC_IDS.has(id) && ids.indexOf(id) === index)
    : [];
  return {
    version: 1,
    visible,
    order,
    pinned,
    scope: input.scope === "focused" ? "focused" : "workspace",
  };
}

function localTaskStatus(thread) {
  if (thread.status === "failed") return "failed";
  if (thread.status === "exited") {
    return thread.exitCode == null || thread.exitCode === 0 ? "completed" : "failed";
  }
  if (thread.status === "blocked") return "blocked";
  if (thread.needsAttention) return "waiting";
  return "running";
}

function remoteTaskStatus(session) {
  const status = String(session.status || "").toLowerCase();
  if (status === "waiting") return "waiting";
  if (status === "blocked") return "blocked";
  if (["failed", "killed", "orphaned"].includes(status)) return "failed";
  if (["completed", "archived", "idle"].includes(status)) return "completed";
  return "running";
}

function runtimeMs(item, now) {
  const started = Number(item.startedAt || Date.parse(item.createdAt || ""));
  if (!Number.isFinite(started)) return null;
  const finished = Number(item.finishedAt || Date.parse(item.archivedAt || ""));
  return Math.max(0, (Number.isFinite(finished) ? finished : now) - started);
}

export function summarizeWorkspace(input) {
  const now = Number(input.now) || Date.now();
  const threads = Array.isArray(input.threads) ? input.threads : [];
  const covenSessions = Array.isArray(input.covenSessions) ? input.covenSessions : [];
  const covenById = new Map(covenSessions.map((session) => [session.id, session]));
  const attached = new Set(
    threads.map((thread) => thread.covenSessionId).filter(Boolean),
  );
  const processThreads = threads.filter((thread) => thread.processBacked === true);
  const unattachedCoven = covenSessions.filter((session) => !attached.has(session.id));
  const agents = processThreads
    .filter((thread) => AGENT_KINDS.has(thread.kind))
    .map((thread) => {
      const remote = covenById.get(thread.covenSessionId) || {};
      return {
        id: "local:" + thread.id,
        name: thread.name,
        harness: remote.harness || thread.kind,
        model: remote.model || thread.model || null,
        currentTask: remote.currentTask || thread.currentTask || null,
        tokens: remote.inputTokens == null && remote.outputTokens == null
          ? (thread.tokens || null)
          : { input: remote.inputTokens || 0, output: remote.outputTokens || 0 },
        status: localTaskStatus(thread),
        runtimeMs: runtimeMs(thread, now),
        threadId: thread.id,
      };
    })
    .filter((agent) => ["running", "waiting", "blocked"].includes(agent.status))
    .concat(unattachedCoven.map((session) => ({
      id: "coven:" + session.id,
      name: session.title || session.id,
      harness: session.harness || null,
      model: session.model || null,
      currentTask: session.currentTask || null,
      tokens: session.inputTokens == null && session.outputTokens == null ? null : {
        input: session.inputTokens || 0,
        output: session.outputTokens || 0,
      },
      status: remoteTaskStatus(session),
      runtimeMs: runtimeMs(session, now),
      threadId: null,
    })).filter((agent) => ["running", "waiting", "blocked"].includes(agent.status)));
  const shells = processThreads
    .filter((thread) => (thread.kind || "shell") === "shell")
    .map((thread) => ({
      id: thread.id,
      name: thread.name,
      status: localTaskStatus(thread),
      threadId: thread.id,
    }))
    .filter((shell) => shell.status === "running");
  const tasks = processThreads.map((thread) => ({
    id: "local:" + thread.id,
    name: thread.name,
    status: localTaskStatus(thread),
    runtimeMs: runtimeMs(thread, now),
    threadId: thread.id,
  })).concat(unattachedCoven.map((session) => ({
    id: "coven:" + session.id,
    name: session.title || session.id,
    status: remoteTaskStatus(session),
    runtimeMs: runtimeMs(session, now),
    threadId: null,
  })));
  const counts = {
    agents: agents.filter((agent) => !["completed", "failed"].includes(agent.status)).length,
    shells: shells.filter((shell) => shell.status === "running").length,
    running: tasks.filter((task) => task.status === "running").length,
    waiting: tasks.filter((task) => task.status === "waiting").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
  return { agents, shells, tasks, counts };
}
```

Create `status-model.d.mts`:

```ts
export type MetricId =
  | 'connection' | 'agents' | 'shells' | 'tasks'
  | 'performance' | 'fps' | 'activity';
export type TaskStatus = 'running' | 'waiting' | 'blocked' | 'failed' | 'completed';
export type StatusThread = {
  id: string;
  name: string;
  kind: string;
  status: string;
  processBacked: boolean;
  covenSessionId?: string | null;
  model?: string | null;
  currentTask?: string | null;
  tokens?: { input: number; output: number } | null;
  needsAttention?: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
  exitCode?: number | null;
};
export type StatusCovenSession = {
  id: string;
  title?: string;
  harness?: string;
  model?: string;
  currentTask?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  createdAt?: string;
  archivedAt?: string;
};
export type StatusPreferences = {
  version: 1;
  visible: MetricId[];
  order: MetricId[];
  pinned: MetricId[];
  scope: 'workspace' | 'focused';
};
export type AgentSummary = {
  id: string;
  name: string;
  harness: string | null;
  model: string | null;
  currentTask: string | null;
  tokens: { input: number; output: number } | null;
  status: TaskStatus;
  runtimeMs: number | null;
  threadId: string | null;
};
export type TaskSummary = {
  id: string;
  name: string;
  status: TaskStatus;
  runtimeMs: number | null;
  threadId: string | null;
};
export type WorkspaceSummary = {
  agents: AgentSummary[];
  shells: Array<{ id: string; name: string; status: 'running'; threadId: string }>;
  tasks: TaskSummary[];
  counts: { agents: number; shells: number; running: number; waiting: number; failed: number };
};
export const DEFAULT_METRIC_ORDER: MetricId[];
export const METRICS: Readonly<Record<MetricId, {
  id: MetricId;
  panel: 'connection' | 'agents' | 'shells' | 'tasks' | 'performance' | 'activity';
  label: string;
  priority: number;
  tooltip: string;
}>>;
export function normalizePreferences(value: unknown): StatusPreferences;
export function summarizeWorkspace(input: {
  now: number;
  activeThreadId?: string | null;
  threads: StatusThread[];
  covenSessions: StatusCovenSession[];
}): WorkspaceSummary;
```

- [ ] **Step 4: Add failing tests for rates, thresholds, responsive order, and diagnostics**

Append tests that verify:

```ts
import {
  createActivityTracker,
  notePtyChunk,
  flushActivity,
  evaluateSeverity,
  chooseVisibleMetrics,
  median,
  pushTrend,
  sparklinePath,
  formatLiveDiagnostics,
} from '../native/macos/psyche-build-tauri/web/status/status-model.mjs';

it('tracks split UTF-8 chunks and completed terminal lines', () => {
  const tracker = createActivityTracker();
  notePtyChunk(tracker, 'a', new TextEncoder().encode('one\npar'), 0);
  notePtyChunk(tracker, 'a', new TextEncoder().encode('tial\ntwo\n'), 500);
  expect(flushActivity(tracker, 1_000).workspace).toMatchObject({
    linesPerSecond: 3,
    bytesPerSecond: 16,
  });
});

it('requires sustained pressure and hysteresis', () => {
  let state = {};
  for (let index = 0; index < 4; index += 1) {
    ({ state } = evaluateSeverity({ cpuPercent: 90 }, state));
  }
  let evaluated = evaluateSeverity({ cpuPercent: 90 }, state);
  expect(evaluated.severity.cpu).toBe('warn');
  evaluated = evaluateSeverity({ cpuPercent: 72 }, evaluated.state);
  expect(evaluated.severity.cpu).toBe('warn');
  evaluated = evaluateSeverity({ cpuPercent: 65 }, evaluated.state);
  expect(evaluated.severity.cpu).toBe('neutral');
});

it('warns only on sustained absolute and relative output spikes', () => {
  let state = {};
  for (let index = 0; index < 2; index += 1) {
    ({ state } = evaluateSeverity({
      outputLinesPerSecond: 1_200,
      outputBaseline: 200,
    }, state));
  }
  expect(evaluateSeverity({
    outputLinesPerSecond: 1_200,
    outputBaseline: 200,
  }, state).severity.activity).toBe('warn');
  expect(evaluateSeverity({
    outputLinesPerSecond: 900,
    outputBaseline: 100,
  }, state).severity.activity).toBe('neutral');
});

it('keeps warnings and pins ahead of healthy overflow', () => {
  expect(chooseVisibleMetrics({
    order: DEFAULT_METRIC_ORDER,
    visible: DEFAULT_METRIC_ORDER,
    pinned: ['fps'],
    severity: { tasks: 'danger' },
    widths: { connection: 90, agents: 80, shells: 80, tasks: 110, performance: 150, fps: 70, activity: 100 },
    availableWidth: 380,
    fixedWidth: 100,
  })).toEqual(expect.arrayContaining(['connection', 'tasks', 'fps']));
});

it('keeps sixty samples and reports the observed peak', () => {
  const values = [];
  let peak = 0;
  for (let value = 1; value <= 75; value += 1) {
    ({ peak } = pushTrend(values, value, peak));
  }
  expect(values).toHaveLength(60);
  expect(values[0]).toBe(16);
  expect(peak).toBe(75);
});

it('computes a stable rolling median', () => {
  expect(median([9, 1, 5, 3])).toBe(4);
  expect(median([])).toBe(0);
});

it('produces a bounded SVG path and content-safe diagnostics', () => {
  expect(sparklinePath([1, 2, 3], 30, 10)).toMatch(/^M /);
  const text = formatLiveDiagnostics({
    sampledAt: 1_700_000_000_000,
    scope: 'workspace',
    metrics: { cpuPercent: 18, memoryBytes: 640 * 1024 * 1024 },
    services: [{ name: 'Native', status: 'ready', latencyMs: 4 }],
  });
  expect(text).toContain('CPU: 18%');
  expect(text).not.toMatch(/prompt|terminal contents/i);
  expect(text.length).toBeLessThanOrEqual(16_384);
});
```

- [ ] **Step 5: Implement activity, severity, responsive, sparkline, and diagnostics helpers**

Add these concrete exports to `status-model.mjs`:

```js
export function createActivityTracker() {
  return { threads: new Map(), lastFlushAt: 0, operations: 0, errors: 0 };
}

export function notePtyChunk(tracker, threadId, bytes, at) {
  let row = tracker.threads.get(threadId);
  if (!row) {
    row = { decoder: new TextDecoder(), carry: "", bytes: 0, lines: 0, at };
    tracker.threads.set(threadId, row);
  }
  const text = row.carry + row.decoder.decode(bytes, { stream: true });
  const parts = text.split("\n");
  row.carry = parts.pop() || "";
  row.lines += parts.length;
  row.bytes += bytes.byteLength;
  row.at = at;
}

export function noteOperation(tracker, ok) {
  tracker.operations += 1;
  if (!ok) tracker.errors += 1;
}

export function flushActivity(tracker, at) {
  const elapsed = Math.max(1, at - tracker.lastFlushAt);
  const rows = [];
  let bytes = 0;
  let lines = 0;
  for (const [threadId, row] of tracker.threads) {
    bytes += row.bytes;
    lines += row.lines;
    rows.push({
      threadId,
      bytesPerSecond: Math.round(row.bytes * 1000 / elapsed),
      linesPerSecond: Math.round(row.lines * 1000 / elapsed),
    });
    row.bytes = 0;
    row.lines = 0;
  }
  const workspace = {
    bytesPerSecond: Math.round(bytes * 1000 / elapsed),
    linesPerSecond: Math.round(lines * 1000 / elapsed),
    operationsPerSecond: Math.round(tracker.operations * 1000 / elapsed),
    errors: tracker.errors,
  };
  tracker.operations = 0;
  tracker.errors = 0;
  tracker.lastFlushAt = at;
  return { workspace, threads: rows };
}

function sustained(next, previous, key, active, clearBelow, required) {
  const prior = previous[key] || { count: 0, warned: false };
  const count = active ? prior.count + 1 : 0;
  const warned = active ? (prior.warned || count >= required) : (
    prior.warned && next >= clearBelow
  );
  return { count, warned };
}

export function evaluateSeverity(sample, previous = {}) {
  const cpu = sustained(sample.cpuPercent || 0, previous, "cpu",
    (sample.cpuPercent || 0) >= 80, 70, 5);
  const memory = sustained(sample.memoryPressurePercent || 0, previous, "memory",
    (sample.memoryPressurePercent || 0) >= 85, 78, 5);
  const fps = sustained(sample.fps || 60, previous, "fps",
    sample.fps != null && sample.fps < 45, 50, 5);
  const latency = sustained(sample.renderLatencyMs || 0, previous, "latency",
    (sample.renderLatencyMs || 0) > 32, 24, 5);
  const output = sustained(sample.outputLinesPerSecond || 0, previous, "output",
    (sample.outputLinesPerSecond || 0) >= 1_000
      && (sample.outputLinesPerSecond || 0) >= 4 * Math.max(1, sample.outputBaseline || 0),
    500, 3);
  return {
    state: { cpu, memory, fps, latency, output },
    severity: {
      cpu: cpu.warned ? "warn" : "neutral",
      memory: memory.warned ? "warn" : "neutral",
      fps: fps.warned ? "warn" : "neutral",
      latency: latency.warned ? "warn" : "neutral",
      activity: output.warned ? "warn" : "neutral",
    },
  };
}

export function chooseVisibleMetrics(input) {
  const required = new Set(["connection"]);
  Object.entries(input.severity || {}).forEach(([id, severity]) => {
    if (severity === "warn" || severity === "danger") required.add(id);
  });
  (input.pinned || []).forEach((id) => required.add(id));
  const candidates = input.order.filter((id) =>
    input.visible.includes(id) || required.has(id));
  const rank = (id) => required.has(id) ? 1_000 + METRICS[id].priority : METRICS[id].priority;
  const keep = candidates.slice().sort((left, right) => rank(right) - rank(left));
  let used = input.fixedWidth || 0;
  const selected = [];
  for (const id of keep) {
    const width = input.widths[id] || 80;
    if (used + width <= input.availableWidth) {
      selected.push(id);
      used += width;
    }
  }
  return candidates.filter((id) => selected.includes(id));
}

export function pushTrend(values, value, previousPeak = Number.NEGATIVE_INFINITY) {
  if (Number.isFinite(value)) {
    values.push(value);
    if (values.length > 60) values.splice(0, values.length - 60);
  }
  return {
    values,
    peak: Number.isFinite(value) ? Math.max(previousPeak, value) : previousPeak,
  };
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sparklinePath(values, width, height) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  return values.map((value, index) => {
    const x = values.length === 1 ? width : index * width / (values.length - 1);
    const y = height - ((value - min) / span) * height;
    return `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

export function formatLiveDiagnostics(input) {
  const lines = [
    "# Psyche Build Live Metrics",
    `Sampled: ${new Date(input.sampledAt).toISOString()}`,
    `Scope: ${input.scope}`,
  ];
  if (Number.isFinite(input.metrics.cpuPercent)) {
    lines.push(`CPU: ${Math.round(input.metrics.cpuPercent)}%`);
  }
  if (Number.isFinite(input.metrics.memoryBytes)) {
    lines.push(`Memory: ${Math.round(input.metrics.memoryBytes / 1024 / 1024)} MB`);
  }
  if (Number.isFinite(input.metrics.fps)) {
    lines.push(`FPS: ${Math.round(input.metrics.fps)}`);
  }
  if (Number.isFinite(input.metrics.linesPerSecond)) {
    lines.push(`Terminal output: ${Math.round(input.metrics.linesPerSecond)} lines/s`);
  }
  if (input.peaks) {
    const peakParts = [];
    if (Number.isFinite(input.peaks.cpuPercent)) {
      peakParts.push(`CPU ${Math.round(input.peaks.cpuPercent)}%`);
    }
    if (Number.isFinite(input.peaks.memoryBytes)) {
      peakParts.push(`MEM ${Math.round(input.peaks.memoryBytes / 1024 / 1024)} MB`);
    }
    if (peakParts.length) lines.push(`Observed peaks: ${peakParts.join(", ")}`);
  }
  for (const [name, values] of Object.entries(input.trends || {})) {
    if (!Array.isArray(values) || !values.length) continue;
    lines.push(`${name} trend: ${Math.round(values[0])} → ${Math.round(values.at(-1))}`);
  }
  lines.push(
    "",
    "Services:",
    ...(input.services || []).map((service) => {
      const latency = Number.isFinite(service.latencyMs)
        ? ` (${Math.round(service.latencyMs)} ms)`
        : "";
      return `- ${service.name}: ${service.status}${latency}`;
    }),
    "",
    "Excludes prompts, terminal contents, file contents, diffs, and browser contents.",
  );
  return lines.join("\n").slice(0, 16_384);
}
```

Append to `status-model.d.mts`:

```ts
export type ActivityTracker = {
  threads: Map<string, {
    decoder: TextDecoder;
    carry: string;
    bytes: number;
    lines: number;
    at: number;
  }>;
  lastFlushAt: number;
  operations: number;
  errors: number;
};
export function createActivityTracker(): ActivityTracker;
export function notePtyChunk(
  tracker: ActivityTracker,
  threadId: string,
  bytes: Uint8Array,
  at: number,
): void;
export function noteOperation(tracker: ActivityTracker, ok: boolean): void;
export function flushActivity(tracker: ActivityTracker, at: number): {
  workspace: {
    bytesPerSecond: number;
    linesPerSecond: number;
    operationsPerSecond: number;
    errors: number;
  };
  threads: Array<{ threadId: string; bytesPerSecond: number; linesPerSecond: number }>;
};
export type Severity = 'neutral' | 'warn' | 'danger';
export function evaluateSeverity(
  sample: {
    cpuPercent?: number;
    memoryPressurePercent?: number;
    fps?: number;
    renderLatencyMs?: number;
    outputLinesPerSecond?: number;
    outputBaseline?: number;
  },
  previous?: Record<string, { count: number; warned: boolean }>,
): {
  state: Record<string, { count: number; warned: boolean }>;
  severity: {
    cpu: Severity;
    memory: Severity;
    fps: Severity;
    latency: Severity;
    activity: Severity;
  };
};
export function chooseVisibleMetrics(input: {
  order: MetricId[];
  visible: MetricId[];
  pinned: MetricId[];
  severity: Partial<Record<MetricId, Severity>>;
  widths: Partial<Record<MetricId, number>>;
  availableWidth: number;
  fixedWidth: number;
}): MetricId[];
export function pushTrend(values: number[], value: number, previousPeak?: number): {
  values: number[];
  peak: number;
};
export function median(values: number[]): number;
export function sparklinePath(values: number[], width: number, height: number): string;
export function samplingDelay(input: { hidden: boolean; idleForMs: number }): number | null;
export function createFrameSampler(): {
  frame(at: number): void;
  flush(windowMs: number): { fps: number; renderLatencyMs: number; droppedFrames: number };
};
export function formatLiveDiagnostics(input: {
  sampledAt: number;
  scope: 'workspace' | 'focused';
  metrics: {
    cpuPercent?: number;
    memoryBytes?: number;
    fps?: number;
    linesPerSecond?: number;
  };
  peaks?: { cpuPercent?: number; memoryBytes?: number };
  trends?: Record<string, number[]>;
  services: Array<{ name: string; status: string; latencyMs?: number | null }>;
}): string;
```

- [ ] **Step 6: Run the model tests**

Run:

```bash
pnpm exec vitest --run __tests__/tauriStatusModel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the pure model**

```bash
git add native/macos/psyche-build-tauri/web/status/status-model.mjs \
  native/macos/psyche-build-tauri/web/status/status-model.d.mts \
  __tests__/tauriStatusModel.test.ts
git commit -m "feat: add footer status metric model" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Add the Native Process Metrics Collector

**Files:**
- Create: `native/macos/psyche-build-tauri/src-tauri/src/metrics.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.lock`

- [ ] **Step 1: Add deterministic aggregation tests before the dependency**

Create `metrics.rs` with the serializable types and a test-only pure aggregation seam:

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Debug, PartialEq)]
struct ProcessSample {
    pid: u32,
    parent: Option<u32>,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct TrackedPty {
    pub thread_id: String,
    pub pid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsScope {
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    pub thread_id: String,
    pub process_name: String,
    pub pid: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateMetrics {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSnapshot {
    pub sampled_at_ms: u64,
    pub total_memory_bytes: u64,
    pub used_memory_bytes: u64,
    pub memory_pressure_percent: f32,
    pub workspace: AggregateMetrics,
    pub processes: Vec<ProcessMetrics>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_descendants_once_and_scopes_to_one_thread() {
        let samples = vec![
            ProcessSample { pid: 10, parent: None, name: "psyche".into(), cpu_percent: 40.0, memory_bytes: 100 },
            ProcessSample { pid: 20, parent: Some(10), name: "zsh".into(), cpu_percent: 20.0, memory_bytes: 200 },
            ProcessSample { pid: 21, parent: Some(20), name: "cargo".into(), cpu_percent: 80.0, memory_bytes: 300 },
            ProcessSample { pid: 30, parent: Some(10), name: "node".into(), cpu_percent: 60.0, memory_bytes: 400 },
        ];
        let tracked = vec![
            TrackedPty { thread_id: "a".into(), pid: 20 },
            TrackedPty { thread_id: "b".into(), pid: 30 },
        ];
        let workspace = aggregate_samples(&samples, 10, &tracked, None, 4);
        assert_eq!(workspace.workspace.memory_bytes, 1_000);
        assert_eq!(workspace.workspace.cpu_percent, 50.0);
        assert_eq!(workspace.processes[0].memory_bytes, 500);

        let focused = aggregate_samples(&samples, 10, &tracked, Some("a"), 4);
        assert_eq!(focused.workspace.memory_bytes, 500);
        assert_eq!(focused.processes.len(), 1);
        assert_eq!(focused.processes[0].thread_id, "a");
    }

    #[test]
    fn omits_a_tracked_process_that_disappeared() {
        let snapshot = aggregate_samples(
            &[],
            10,
            &[TrackedPty { thread_id: "gone".into(), pid: 99 }],
            None,
            8,
        );
        assert!(snapshot.processes.is_empty());
    }
}
```

At this point the file intentionally does not compile because `sysinfo` is not declared and `aggregate_samples` is missing.

- [ ] **Step 2: Run Rust tests and verify the expected failure**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml metrics::tests
```

Expected: FAIL with unresolved import `sysinfo` or missing module/function.

- [ ] **Step 3: Add the dependency and implement process-tree aggregation**

Add to `Cargo.toml`:

```toml
sysinfo = "0.36.1"
```

Implement these helpers above the tests:

```rust
fn descendants(samples: &[ProcessSample], root: u32) -> HashSet<u32> {
    let mut result = HashSet::from([root]);
    loop {
        let before = result.len();
        for sample in samples {
            if sample.parent.is_some_and(|parent| result.contains(&parent)) {
                result.insert(sample.pid);
            }
        }
        if result.len() == before {
            return result;
        }
    }
}

fn aggregate_set(samples: &[ProcessSample], pids: &HashSet<u32>, cpu_count: usize) -> AggregateMetrics {
    let raw_cpu = samples.iter()
        .filter(|sample| pids.contains(&sample.pid))
        .map(|sample| sample.cpu_percent)
        .sum::<f32>();
    AggregateMetrics {
        cpu_percent: raw_cpu / cpu_count.max(1) as f32,
        memory_bytes: samples.iter()
            .filter(|sample| pids.contains(&sample.pid))
            .map(|sample| sample.memory_bytes)
            .sum(),
    }
}

fn aggregate_samples(
    samples: &[ProcessSample],
    app_pid: u32,
    tracked: &[TrackedPty],
    focused_thread_id: Option<&str>,
    cpu_count: usize,
) -> MetricsSnapshot {
    let selected = tracked.iter()
        .filter(|root| focused_thread_id.map_or(true, |thread_id| root.thread_id == thread_id))
        .collect::<Vec<_>>();
    let workspace_pids = if focused_thread_id.is_some() {
        selected.iter()
            .flat_map(|root| descendants(samples, root.pid))
            .collect::<HashSet<_>>()
    } else {
        let mut pids = descendants(samples, app_pid);
        for root in tracked {
            pids.extend(descendants(samples, root.pid));
        }
        pids
    };
    let mut processes = selected.into_iter().filter_map(|root| {
        let own = samples.iter().find(|sample| sample.pid == root.pid)?;
        let pids = descendants(samples, root.pid);
        let aggregate = aggregate_set(samples, &pids, cpu_count);
        Some(ProcessMetrics {
            thread_id: root.thread_id.clone(),
            process_name: own.name.clone(),
            pid: root.pid,
            cpu_percent: aggregate.cpu_percent,
            memory_bytes: aggregate.memory_bytes,
        })
    }).collect::<Vec<_>>();
    processes.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    MetricsSnapshot {
        sampled_at_ms: 0,
        total_memory_bytes: 0,
        used_memory_bytes: 0,
        memory_pressure_percent: 0.0,
        workspace: aggregate_set(samples, &workspace_pids, cpu_count),
        processes,
    }
}
```

- [ ] **Step 4: Implement the managed collector**

Add:

```rust
pub(crate) struct MetricsCollector {
    system: System,
}

impl Default for MetricsCollector {
    fn default() -> Self {
        let mut system = System::new_all();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        Self { system }
    }
}

impl MetricsCollector {
    pub(crate) fn snapshot(
        &mut self,
        app_pid: u32,
        tracked: &[TrackedPty],
        scope: Option<&MetricsScope>,
    ) -> MetricsSnapshot {
        self.system.refresh_memory();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        let samples = self.system.processes().iter().map(|(pid, process)| ProcessSample {
            pid: pid.as_u32(),
            parent: process.parent().map(Pid::as_u32),
            name: process.name().to_string_lossy().into_owned(),
            cpu_percent: process.cpu_usage(),
            memory_bytes: process.memory(),
        }).collect::<Vec<_>>();
        let mut snapshot = aggregate_samples(
            &samples,
            app_pid,
            tracked,
            scope.and_then(|value| value.thread_id.as_deref()),
            self.system.cpus().len(),
        );
        snapshot.sampled_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        snapshot.total_memory_bytes = self.system.total_memory();
        snapshot.used_memory_bytes = self.system.used_memory();
        snapshot.memory_pressure_percent = if snapshot.total_memory_bytes == 0 {
            0.0
        } else {
            snapshot.used_memory_bytes as f32 * 100.0 / snapshot.total_memory_bytes as f32
        };
        snapshot
    }
}
```

Run:

```bash
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

This resolves `sysinfo` 0.36.1, whose Rust 1.75 minimum remains compatible with the crate's declared Rust 1.77 floor, and updates `Cargo.lock`.

- [ ] **Step 5: Format and run the collector tests**

Run:

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml metrics::tests
```

Expected: PASS.

- [ ] **Step 6: Commit the collector**

```bash
git add native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/Cargo.lock \
  native/macos/psyche-build-tauri/src-tauri/src/metrics.rs
git commit -m "feat: collect native workspace metrics" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Wire PTY PIDs and the Tauri Metrics Command

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Create: `__tests__/tauriMetricsNativeContract.test.ts`

- [ ] **Step 1: Write the failing native wiring contract**

Create `__tests__/tauriMetricsNativeContract.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const lib = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const cargo = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml'),
  'utf8',
);

describe('native workspace metrics wiring', () => {
  it('retains optional PTY process identity without making spawn depend on it', () => {
    expect(lib).toMatch(/struct PtySession \{[\s\S]*pid: Option<u32>/);
    expect(lib).toMatch(/let pid = child\.process_id\(\);/);
    expect(lib).toMatch(/PtySession \{[\s\S]*pid,/);
  });

  it('manages and registers the metrics collector', () => {
    expect(lib).toContain('mod metrics;');
    expect(lib).toMatch(/async fn workspace_metrics\(/);
    expect(lib).toContain('tauri::async_runtime::spawn_blocking');
    expect(lib).toMatch(/\.manage\(MetricsState::default\(\)\)/);
    expect(lib).toMatch(/generate_handler!\[[\s\S]*workspace_metrics,/);
    expect(cargo).toMatch(/^sysinfo = "0\.36\.1"$/m);
  });
});
```

- [ ] **Step 2: Run the contract and verify it fails**

Run:

```bash
pnpm exec vitest --run __tests__/tauriMetricsNativeContract.test.ts
```

Expected: FAIL because `lib.rs` does not expose the collector.

- [ ] **Step 3: Add PID retention and the command**

In `lib.rs`:

```rust
mod metrics;
use metrics::{MetricsCollector, MetricsScope, MetricsSnapshot, TrackedPty};
use tauri::State;

#[derive(Clone, Default)]
struct MetricsState(Arc<Mutex<MetricsCollector>>);

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: Option<u32>,
}
```

Immediately after spawning the PTY child:

```rust
let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
let pid = child.process_id();
```

Store `pid` in `PtySession`. Add:

```rust
#[tauri::command]
async fn workspace_metrics(
    state: State<'_, MetricsState>,
    scope: Option<MetricsScope>,
) -> Result<MetricsSnapshot, String> {
    let tracked = {
        let sessions = SESSIONS.lock();
        sessions.iter().filter_map(|(thread_id, session)| {
            session.pid.map(|pid| TrackedPty {
                thread_id: thread_id.clone(),
                pid,
            })
        }).collect::<Vec<_>>()
    };
    let collector = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        collector.lock().snapshot(
            std::process::id(),
            &tracked,
            scope.as_ref(),
        )
    }).await.map_err(|error| format!("metrics collector task failed: {error}"))
}
```

Register `workspace_metrics` in `generate_handler!` and add `.manage(MetricsState::default())` before `.invoke_handler(...)`.

- [ ] **Step 4: Run native and contract tests**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm exec vitest --run __tests__/tauriMetricsNativeContract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit native wiring**

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriMetricsNativeContract.test.ts
git commit -m "feat: expose workspace metrics to Tauri" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Preserve Structured Agent and Task Metadata

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-model.mjs`
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-model.d.mts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriStatusModel.test.ts`
- Modify: `__tests__/tauriMetricsNativeContract.test.ts`

- [ ] **Step 1: Add failing metadata and lifecycle tests**

Append to `tauriMetricsNativeContract.test.ts`:

```ts
const coven = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs'),
  'utf8',
);
const main = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);

it('passes through optional structured agent metrics', () => {
  for (const field of ['model', 'current_task', 'input_tokens', 'output_tokens']) {
    expect(coven).toMatch(new RegExp(`\\b${field}:`));
  }
});

it('records local lifecycle timestamps and exit codes', () => {
  expect(main).toMatch(/startedAt: Date\.now\(\)/);
  expect(main).toMatch(/thread\.finishedAt = Date\.now\(\)/);
  expect(main).toMatch(/thread\.exitCode = payload\.code/);
});
```

Append a `summarizeWorkspace` assertion that a Coven session with `model`, `currentTask`, `inputTokens`, and `outputTokens` preserves those values in the agent row.

Add a session-model test proving rail filtering does not discard historical task states:

```ts
import {
  applyCovenResponse,
  beginCovenRequest,
  createCovenDiscoveryState,
} from '../native/macos/psyche-build-tauri/web/sessions/session-model.mjs';

it('keeps all Coven sessions for task metrics while the rail stays live-only', () => {
  const started = beginCovenRequest(createCovenDiscoveryState());
  const next = applyCovenResponse(started.state, started.requestId, {
    status: 'ready',
    sessions: [
      { id: 'live', projectRoot: '/repo', status: 'running' },
      { id: 'done', projectRoot: '/repo', status: 'completed' },
      { id: 'failed', projectRoot: '/repo', status: 'failed' },
    ],
  }, 100);
  expect(next.sessionsByProject.get('/repo')?.map((session) => session.id)).toEqual(['live']);
  expect(next.allSessionsByProject.get('/repo')?.map((session) => session.id).sort())
    .toEqual(['done', 'failed', 'live']);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriMetricsNativeContract.test.ts
```

Expected: FAIL on missing fields and lifecycle timestamps.

- [ ] **Step 3: Extend Coven session normalization**

Add optional fields to `CovenSessionSummary`:

```rust
model: Option<String>,
current_task: Option<String>,
input_tokens: Option<u64>,
output_tokens: Option<u64>,
```

Add:

```rust
fn optional_u64(
    fields: &Map<String, Value>,
    camel_case: &str,
    snake_case: &str,
) -> Option<u64> {
    fields.get(camel_case)
        .or_else(|| fields.get(snake_case))
        .and_then(Value::as_u64)
}
```

Populate the fields in `normalize_session`:

```rust
model: optional_string(fields, "model", "model")?,
current_task: optional_string(fields, "currentTask", "current_task")?,
input_tokens: optional_u64(fields, "inputTokens", "input_tokens"),
output_tokens: optional_u64(fields, "outputTokens", "output_tokens"),
```

Update all `CovenSessionSummary` test fixtures and add one normalization test containing these fields.

Update `session-model.d.mts`:

```ts
model?: string;
currentTask?: string;
inputTokens?: number;
outputTokens?: number;
```

In `session-model.mjs`, preserve both live rail sessions and the complete response:

```js
export function groupAllCovenSessions(sessions) {
  const grouped = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || !isSafeCovenSessionId(session.id)
      || typeof session.projectRoot !== "string" || !session.projectRoot) {
      continue;
    }
    const projectSessions = grouped.get(session.projectRoot) || [];
    projectSessions.push(session);
    grouped.set(session.projectRoot, projectSessions);
  }
  for (const [projectRoot, projectSessions] of grouped) {
    grouped.set(projectRoot, sortCovenSessions(projectSessions));
  }
  return grouped;
}
```

Add `allSessionsByProject: new Map()` to `createCovenDiscoveryState`, preserve it during request/error transitions, set it to `groupAllCovenSessions(response.sessions)` on ready/empty responses, and clear it in `invalidateCovenRequests`. Add the field and `groupAllCovenSessions` signature to `session-model.d.mts`.

In `main.js`, add:

```js
function allCovenSessionsForProject(project) {
  var roots = [project.root].concat(
    (project.worktrees || []).map(function (worktree) { return worktree.path; })
  ).filter(function (root, index, candidates) {
    return root && candidates.indexOf(root) === index;
  });
  return roots.reduce(function (sessions, root) {
    return sessions.concat(covenDiscovery.allSessionsByProject.get(root) || []);
  }, []);
}
```

Keep `covenSessionsForProject` unchanged for the live-only rail.

- [ ] **Step 4: Record local lifecycle fields**

In `createThread`, initialize:

```js
startedAt: Date.now(),
finishedAt: null,
exitCode: null,
```

In `spawnPty`, reset `startedAt`, `finishedAt`, and `exitCode` when retrying. In `handlePtyExit`:

```js
var stoppedByUser = thread.stopRequested;
thread.finishedAt = Date.now();
thread.exitCode = payload.code == null ? null : payload.code;
thread.status = stoppedByUser || payload.code == null || payload.code === 0
  ? "exited"
  : "failed";
```

Capture `stoppedByUser` before the existing code resets `thread.stopRequested`. Keep the exit annotation and attention cleanup.

In the `pty_start` failure branch that sets `thread.status = "failed"`, also set:

```js
thread.finishedAt = Date.now();
thread.exitCode = null;
```

- [ ] **Step 5: Run focused Rust and frontend tests**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm exec vitest --run \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriMetricsNativeContract.test.ts \
  __tests__/tauriSessionModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit metadata support**

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs \
  native/macos/psyche-build-tauri/web/sessions/session-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/session-model.d.mts \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriMetricsNativeContract.test.ts
git commit -m "feat: preserve agent runtime metadata" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Add the Footer Stack Markup and Minimal Styling

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Create: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Write the failing markup and CSS contract**

Create `__tests__/tauriFooterStatusBar.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd(), 'native/macos/psyche-build-tauri/web');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const main = readFileSync(join(root, 'main.js'), 'utf8');

describe('minimal footer status bar', () => {
  it('stacks composer, detail panel, and bottom status bar', () => {
    const footer = html.slice(html.indexOf('id="footer-stack"'));
    expect(footer.indexOf('id="composer"')).toBeLessThan(footer.indexOf('id="status-detail"'));
    expect(footer.indexOf('id="status-detail"')).toBeLessThan(footer.indexOf('id="status-bar"'));
    expect(html).toMatch(/id="status-detail"[^>]*hidden/);
    expect(html).toContain('id="status-metrics"');
    expect(html).toContain('id="status-more"');
    expect(html).toContain('id="status-live"');
    expect(html).toContain('id="status-alert"');
  });

  it('keeps the collapsed status row between 24 and 28 pixels', () => {
    expect(css).toMatch(/--status-h:\s*26px/);
    expect(css).toMatch(/\.status-bar\s*\{[\s\S]*height:\s*var\(--status-h\)/);
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('uses semantic emphasis without glass or large dashboard chrome', () => {
    const statusCss = css.slice(css.indexOf('/* -------- Footer status'));
    expect(statusCss).not.toMatch(/backdrop-filter|linear-gradient/);
    expect(statusCss).toContain('.status-metric[data-severity="warn"]');
    expect(statusCss).toContain('.status-metric[data-severity="danger"]');
  });
});
```

- [ ] **Step 2: Run the contract and verify failure**

Run:

```bash
pnpm exec vitest --run __tests__/tauriFooterStatusBar.test.ts
```

Expected: FAIL because the footer hosts do not exist.

- [ ] **Step 3: Wrap the existing composer and add status hosts**

In `index.html`, replace the current composer opening tag:

```html
<div class="footer-stack" id="footer-stack">
  <footer class="composer" id="composer">
```

Leave every existing composer child in place. Immediately after its existing closing `</footer>`, insert:

```html

  <section
    class="status-detail"
    id="status-detail"
    aria-label="Workspace metrics"
    hidden
  >
    <header class="status-detail-head">
      <strong id="status-detail-title">Performance</strong>
      <div class="status-scope" role="group" aria-label="Metric scope">
        <button type="button" data-status-scope="workspace" aria-pressed="true">Workspace</button>
        <button type="button" data-status-scope="focused" aria-pressed="false">Focused pane</button>
      </div>
      <button type="button" id="status-pin">Pin metric</button>
      <button type="button" id="status-copy">Copy diagnostics</button>
      <button type="button" id="status-close" aria-label="Close metric details">×</button>
    </header>
    <div class="status-detail-body" id="status-detail-body"></div>
  </section>

  <footer class="status-bar" id="status-bar" aria-label="Workspace status">
    <div class="status-metrics" id="status-metrics"></div>
    <select class="status-scope-compact" id="status-scope-compact" aria-label="Metric scope">
      <option value="workspace">Workspace</option>
      <option value="focused">Focused pane</option>
    </select>
    <button type="button" class="status-more" id="status-more"
      aria-haspopup="menu" aria-expanded="false">More</button>
  </footer>

  <div class="status-more-menu" id="status-more-menu" role="menu" hidden></div>
  <div class="sr-only" id="status-live" aria-live="polite"></div>
  <div class="sr-only" id="status-alert" role="alert"></div>
</div>
```

- [ ] **Step 4: Add the footer CSS**

Change the app grid to:

```css
:root {
  --status-h: 26px;
}

.app {
  grid-template-rows: var(--titlebar-h) minmax(0, 1fr) auto;
}

.footer-stack {
  position: relative;
  display: grid;
  grid-template-rows: var(--composer-h) auto var(--status-h);
  min-width: 0;
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.94));
}
```

Add a `/* -------- Footer status -------- */` section implementing:

```css
.status-bar {
  display: flex;
  align-items: center;
  min-width: 0;
  height: var(--status-h);
  padding: 0 8px;
  border-top: 1px solid var(--border);
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.98));
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}
.status-metrics { display: flex; align-items: center; min-width: 0; overflow: hidden; }
.status-metric,
.status-scope-compact,
.status-more {
  height: 22px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
}
.status-metric { padding: 0 8px; border-right: 1px solid var(--border); }
.status-metric[data-metric="connection"] { min-width: 86px; }
.status-metric[data-metric="agents"],
.status-metric[data-metric="shells"],
.status-metric[data-metric="fps"] { min-width: 68px; }
.status-metric[data-metric="tasks"] { min-width: 112px; }
.status-metric[data-metric="performance"] { min-width: 148px; }
.status-metric[data-metric="activity"] { min-width: 92px; }
.status-metric:hover,
.status-metric[aria-expanded="true"] { color: var(--text); background: var(--surface-2); }
.status-metric[data-severity="warn"] { color: var(--warn); }
.status-metric[data-severity="danger"] { color: var(--error); }
.status-more[data-severity="warn"] { color: var(--warn); border-color: currentColor; }
.status-more[data-severity="danger"] { color: var(--error); border-color: currentColor; }
.status-scope-compact { margin-left: auto; padding: 0 7px; }
.status-more { width: 56px; padding: 0 6px; border: 1px solid var(--border); border-radius: 4px; }
.status-detail {
  min-height: 156px;
  max-height: min(220px, 32vh);
  overflow: auto;
  border-top: 1px solid var(--border);
  background: rgba(var(--rgb-s1), calc(var(--bg-opacity) * 0.98));
}
.status-detail[hidden],
.status-more-menu[hidden] { display: none; }
.status-detail-head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--rgb-s1), 0.98);
}
.status-detail-body {
  display: grid;
  gap: 8px;
  padding: 10px 12px 12px;
}
.status-sparkline { width: 72px; height: 18px; fill: none; stroke: currentColor; }
.status-more-menu {
  position: absolute;
  right: 8px;
  bottom: var(--status-h);
  z-index: 70;
  width: 260px;
  max-height: 320px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: rgb(var(--rgb-s1));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
}
```

Add compact table/row styles for `.status-agent-row`, `.status-shell-row`, `.status-task-group`, `.status-performance-grid`, `.status-activity-grid`, and `.status-service-row`; keep row heights between 24px and 32px and use ellipsis for long task/name text.

- [ ] **Step 5: Run the footer contract**

Run:

```bash
pnpm exec vitest --run __tests__/tauriFooterStatusBar.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the footer shell**

```bash
git add native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriFooterStatusBar.test.ts
git commit -m "feat: add minimal footer status shell" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Implement Adaptive Sampling and the Status Controller

**Files:**
- Create: `native/macos/psyche-build-tauri/web/status/status-controller.mjs`
- Create: `native/macos/psyche-build-tauri/web/status/status-entry.js`
- Modify: `native/macos/psyche-build-tauri/web/status/status-model.mjs`
- Modify: `native/macos/psyche-build-tauri/web/status/status-model.d.mts`
- Modify: `__tests__/tauriStatusModel.test.ts`
- Modify: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Add failing cadence and frame sampler tests**

Append:

```ts
import {
  samplingDelay,
  createFrameSampler,
} from '../native/macos/psyche-build-tauri/web/status/status-model.mjs';

it('samples every second while active, every five seconds idle, and pauses hidden', () => {
  expect(samplingDelay({ hidden: false, idleForMs: 5_000 })).toBe(1_000);
  expect(samplingDelay({ hidden: false, idleForMs: 30_000 })).toBe(5_000);
  expect(samplingDelay({ hidden: true, idleForMs: 0 })).toBeNull();
});

it('counts dropped frames from frame intervals', () => {
  const sampler = createFrameSampler();
  [0, 16.7, 33.4, 83.4, 100.1].forEach((time) => sampler.frame(time));
  const sample = sampler.flush(1_000);
  expect(sample.fps).toBe(5);
  expect(sample.droppedFrames).toBeGreaterThanOrEqual(2);
  expect(sample.renderLatencyMs).toBeGreaterThan(16);
});
```

Add a source contract:

```ts
const controller = readFileSync(join(root, 'status/status-controller.mjs'), 'utf8');
expect(controller).toContain('createStatusController');
expect(controller).toContain('ResizeObserver');
expect(html).toContain('Copy diagnostics');
expect(controller).toContain('Unable to copy diagnostics');
expect(controller).toMatch(/event\.key === "Escape"/);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriFooterStatusBar.test.ts
```

Expected: FAIL on missing exports and controller.

- [ ] **Step 3: Implement cadence and frame sampling**

Add to `status-model.mjs`:

```js
export function samplingDelay({ hidden, idleForMs }) {
  if (hidden) return null;
  return idleForMs >= 30_000 ? 5_000 : 1_000;
}

export function createFrameSampler() {
  let previous = null;
  let frames = 0;
  let dropped = 0;
  let totalDelta = 0;
  return {
    frame(at) {
      if (previous != null) {
        const delta = Math.max(0, at - previous);
        totalDelta += delta;
        dropped += Math.max(0, Math.round(delta / (1000 / 60)) - 1);
      }
      previous = at;
      frames += 1;
    },
    flush(windowMs) {
      const sample = {
        fps: Math.round(frames * 1000 / Math.max(1, windowMs)),
        renderLatencyMs: frames > 1 ? totalDelta / (frames - 1) : 0,
        droppedFrames: dropped,
      };
      frames = 0;
      dropped = 0;
      totalDelta = 0;
      return sample;
    },
  };
}
```

- [ ] **Step 4: Implement the controller public API**

Create `status-controller.mjs` importing the model helpers and exporting:

```js
import {
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
} from "./status-model.mjs";

export function createStatusController(options) {
  const {
    elements, fetchMetrics, getContext, storage, copyText,
    now = Date.now,
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  const activity = createActivityTracker();
  activity.lastFlushAt = now();
  const frames = createFrameSampler();
  let preferences = readPreferences(storage);
  let nativeSnapshot = null;
  let nativeHealth = { failures: 0, reconnects: 0, status: "starting", latencyMs: null, lastSuccessAt: null };
  let activeMetric = null;
  let activeTriggerMetric = null;
  let lastActivityAt = now();
  let timer = null;
  let frameId = null;
  let pollInFlight = null;
  let previousFlushAt = now();
  let trend = new Map();
  let covenHealth = { phase: "idle", latencyMs: null, reconnects: 0, refreshedAt: null };
  let lastSample = null;
  let lastRenderedDiagnostics = null;
  const metricNodes = new Map();
  const resizeObserver = new ResizeObserver(() => renderLast());
  let previousMetricSeverity = {};
  let spikes = [];

  function recordTrend(id, value) {
    const current = trend.get(id) || { values: [], peak: Number.NEGATIVE_INFINITY };
    const next = pushTrend(current.values, value, current.peak);
    trend.set(id, next);
    return next;
  }

  function noteActivity() { lastActivityAt = now(); }
  function notePtyData(threadId, bytes) {
    notePtyChunk(activity, threadId, bytes, now());
    noteActivity();
  }
  function noteOperation(name, durationMs, ok) {
    if (name !== "workspace_metrics") noteOperationMetric(activity, ok);
    if (!ok) noteActivity();
  }
  function frame(at) {
    frames.frame(at);
    frameId = requestFrame(frame);
  }
  function visibilityChanged() {
    if (document.visibilityState === "hidden") {
      if (timer) clearTimer(timer);
      timer = null;
      if (frameId != null) cancelFrame(frameId);
      frameId = null;
      return;
    }
    noteActivity();
    if (frameId == null) frameId = requestFrame(frame);
    poll();
  }
  async function runPoll() {
    const context = getContext();
    const focusedAvailable = context.threads.some((thread) =>
      thread.id === context.activeThreadId && thread.processBacked === true);
    const started = performance.now();
    try {
      nativeSnapshot = await fetchMetrics(preferences.scope === "focused" && focusedAvailable
        ? { threadId: context.activeThreadId }
        : null);
      const wasUnhealthy = ["degraded", "disconnected"].includes(nativeHealth.status);
      nativeHealth = {
        failures: 0,
        reconnects: nativeHealth.reconnects + (wasUnhealthy ? 1 : 0),
        status: "ready",
        latencyMs: performance.now() - started,
        lastSuccessAt: now(),
      };
    } catch (error) {
      const failures = nativeHealth.failures + 1;
      const age = nativeHealth.lastSuccessAt == null ? Infinity : now() - nativeHealth.lastSuccessAt;
      const neverConnected = nativeHealth.lastSuccessAt == null;
      nativeHealth = {
        ...nativeHealth,
        failures,
        status: neverConnected
          ? (failures >= 5 ? "disconnected" : "degraded")
          : failures >= 5 || age >= 30_000
            ? "disconnected"
            : failures >= 2 || age >= 10_000
              ? "degraded"
              : nativeHealth.status,
        latencyMs: performance.now() - started,
        error: String(error),
      };
    }
    const at = now();
    const activitySample = flushActivity(activity, at);
    const frameSample = frames.flush(Math.max(1, at - previousFlushAt));
    previousFlushAt = at;
    lastSample = {
      context,
      nativeSnapshot,
      nativeHealth,
      activity: activitySample,
      frame: frameSample,
      covenHealth,
    };
    render(lastSample);
  }
  function poll() {
    if (pollInFlight) return pollInFlight;
    pollInFlight = runPoll().finally(() => {
      pollInFlight = null;
      schedule();
    });
    return pollInFlight;
  }
  function schedule() {
    if (timer) clearTimer(timer);
    const delay = samplingDelay({
      hidden: document.visibilityState === "hidden",
      idleForMs: now() - lastActivityAt,
    });
    timer = delay == null ? null : setTimer(poll, delay);
  }
  function start() {
    document.addEventListener("visibilitychange", visibilityChanged);
    resizeObserver.observe(elements.bar);
    visibilityChanged();
  }
  function stop() {
    if (timer) clearTimer(timer);
    if (frameId != null) cancelFrame(frameId);
    document.removeEventListener("visibilitychange", visibilityChanged);
    resizeObserver.disconnect();
    timer = null;
    frameId = null;
  }
  return {
    start, stop, refresh: poll, noteActivity, notePtyData, noteOperation,
    noteCovenSample, setScope, toggleMetric, closePanel, render,
  };
}
```

Implement `readPreferences`, `savePreferences`, `noteCovenSample`, `setScope`, `toggleMetric`, `closePanel`, and `render` in the same file. `readPreferences` uses key `psyche.tauri.status.v1`, calls `normalizePreferences`, and catches only storage parse/access failures.

Use these exact state helpers:

```js
const STORAGE_KEY = "psyche.tauri.status.v1";

function readPreferences(storage) {
  try {
    return normalizePreferences(JSON.parse(storage.getItem(STORAGE_KEY) || "{}"));
  } catch (error) {
    console.warn("[status preferences] load failed:", error);
    return normalizePreferences({});
  }
}

function savePreferences(storage, preferences) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.warn("[status preferences] save failed:", error);
  }
}

function renderLast() {
  if (lastSample) render(lastSample);
}

function toggleMetric(id) {
  if (activeMetric === id) {
    closePanel();
    return;
  }
  activeMetric = id;
  activeTriggerMetric = id;
  elements.detail.hidden = false;
  renderLast();
}

function closePanel() {
  const restoreMetric = activeTriggerMetric;
  activeMetric = null;
  elements.detail.hidden = true;
  renderLast();
  const trigger = restoreMetric
    ? elements.metrics.querySelector(`[data-metric="${restoreMetric}"]`)
    : null;
  if (trigger) trigger.focus();
  else if (restoreMetric) elements.more.focus();
  activeTriggerMetric = null;
}

function setScope(scope) {
  preferences.scope = scope === "focused" ? "focused" : "workspace";
  savePreferences(storage, preferences);
  noteActivity();
  poll();
}

function noteCovenSample(sample) {
  const recovered = ["unavailable", "incompatible", "error"].includes(covenHealth.phase)
    && sample.phase === "ready";
  covenHealth = {
    phase: sample.phase,
    latencyMs: sample.latencyMs,
    refreshedAt: sample.refreshedAt,
    reconnects: covenHealth.reconnects + (recovered ? 1 : 0),
  };
  renderLast();
}
```

- [ ] **Step 5: Implement footer, panels, More, pin, reorder, and copy**

Inside `status-controller.mjs`, add concrete renderers:

```js
function metricButton(id, text, severity, expanded) {
  let button = metricNodes.get(id);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "status-metric";
    button.dataset.metric = id;
    metricNodes.set(id, button);
  }
  button.dataset.severity = severity || "neutral";
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.title = METRICS[id].tooltip;
  button.textContent = text;
  return button;
}

function renderSparkline(values) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "status-sparkline");
  svg.setAttribute("viewBox", "0 0 72 18");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", sparklinePath(values, 72, 18));
  svg.appendChild(path);
  return svg;
}
```

Implement one renderer per panel:

- `renderAgents(body, summary)`
- `renderShells(body, summary, processRows, activityRows)`
- `renderTasks(body, summary)`
- `renderPerformance(body, sample, trend)`
- `renderActivity(body, activity, trend, spikes, agentToolCalls)`
- `renderConnection(body, nativeHealth, covenHealth)`

Each renderer creates compact text rows and appends optional fields only when non-null. Performance uses four compact cells for CPU, memory, FPS/render latency, and dropped frames; GPU is not rendered because the native snapshot has no GPU field.

Use these shared DOM helpers and renderer shapes:

```js
function resetBody(body) {
  while (body.firstChild) body.firstChild.remove();
}

function textCell(className, text) {
  const cell = document.createElement("span");
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function formatRuntime(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatMemory(bytes) {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;
}

function renderAgents(body, summary) {
  resetBody(body);
  for (const agent of summary.agents) {
    const row = document.createElement("div");
    row.className = "status-agent-row";
    row.append(
      textCell("status-primary", agent.name),
      textCell("status-secondary", [agent.harness, agent.model].filter(Boolean).join(" · ")),
      textCell("status-state", agent.status),
      textCell("status-runtime", formatRuntime(agent.runtimeMs)),
    );
    if (agent.currentTask) row.append(textCell("status-task", agent.currentTask));
    if (agent.tokens) {
      row.append(textCell("status-tokens",
        `${agent.tokens.input.toLocaleString()} in · ${agent.tokens.output.toLocaleString()} out`));
    }
    body.appendChild(row);
  }
}

function renderShells(body, summary, processRows, activityRows) {
  resetBody(body);
  const processes = new Map(processRows.map((row) => [row.threadId, row]));
  const activity = new Map(activityRows.map((row) => [row.threadId, row]));
  for (const shell of summary.shells) {
    const process = processes.get(shell.threadId);
    if (!process) continue;
    const rate = activity.get(shell.threadId);
    const row = document.createElement("div");
    row.className = "status-shell-row";
    row.append(
      textCell("status-primary", shell.name),
      textCell("status-secondary", process.processName),
      textCell("status-pid", `PID ${process.pid}`),
      textCell("status-cpu", `${Math.round(process.cpuPercent)}% CPU`),
      textCell("status-memory", formatMemory(process.memoryBytes)),
      textCell("status-rate", rate ? `${rate.linesPerSecond} lines/s` : ""),
    );
    body.appendChild(row);
  }
}

function renderTasks(body, summary) {
  resetBody(body);
  for (const status of ["running", "waiting", "blocked", "failed", "completed"]) {
    const tasks = summary.tasks.filter((task) => task.status === status);
    const group = document.createElement("section");
    group.className = "status-task-group";
    group.appendChild(textCell("status-task-heading", `${status} · ${tasks.length}`));
    for (const task of tasks.slice(0, 20)) {
      const row = document.createElement("div");
      row.className = "status-task-row";
      row.append(
        textCell("status-primary", task.name),
        textCell("status-runtime", formatRuntime(task.runtimeMs)),
      );
      group.appendChild(row);
    }
    if (tasks.length > 20) {
      group.appendChild(textCell("status-more-count", `${tasks.length - 20} more`));
    }
    body.appendChild(group);
  }
}

function performanceCell(label, value, meta, values) {
  const cell = document.createElement("div");
  cell.className = "status-performance-cell";
  cell.append(
    textCell("status-metric-label", label),
    textCell("status-metric-value", value),
    textCell("status-metric-meta", meta),
    renderSparkline(values),
  );
  return cell;
}

function renderPerformance(body, sample, trend) {
  resetBody(body);
  const grid = document.createElement("div");
  grid.className = "status-performance-grid";
  grid.append(
    performanceCell("CPU", `${Math.round(sample.nativeSnapshot.workspace.cpuPercent)}%`,
      `peak ${Math.round(trend.cpu.peak)}%`, trend.cpu.values),
    performanceCell("Memory", formatMemory(sample.nativeSnapshot.workspace.memoryBytes),
      `peak ${formatMemory(trend.memory.peak)}`, trend.memory.values),
    performanceCell("Frame rate", `${sample.frame.fps} FPS`,
      `${sample.frame.renderLatencyMs.toFixed(1)} ms`, trend.fps.values),
    performanceCell("Dropped", String(sample.frame.droppedFrames),
      "frames / sample", trend.dropped.values),
  );
  body.appendChild(grid);
}

function renderActivity(body, activity, trend, spikes, agentToolCalls) {
  resetBody(body);
  const grid = document.createElement("div");
  grid.className = "status-activity-grid";
  grid.append(
    textCell("status-activity-value", `${activity.workspace.linesPerSecond} lines/s`),
    textCell("status-activity-value", `${activity.workspace.bytesPerSecond} bytes/s`),
    textCell("status-activity-value", `${activity.workspace.operationsPerSecond} Ops/s`),
    textCell("status-activity-value", `${activity.workspace.errors} errors`),
  );
  if (Number.isFinite(agentToolCalls)) {
    grid.append(textCell("status-activity-value", `${agentToolCalls} Agent tools`));
  }
  grid.append(renderSparkline(trend.lines.values));
  body.appendChild(grid);
  for (const spike of spikes) {
    body.appendChild(textCell("status-spike",
      `${new Date(spike.at).toLocaleTimeString()} · ${spike.metric} ${spike.severity}`));
  }
}

function renderConnection(body, nativeHealth, covenHealth) {
  resetBody(body);
  const services = [
    {
      name: "Native bridge",
      status: nativeHealth.status,
      latencyMs: nativeHealth.latencyMs,
      reconnects: nativeHealth.reconnects,
      refreshedAt: nativeHealth.lastSuccessAt,
    },
    {
      name: "Coven",
      status: covenHealth.phase,
      latencyMs: covenHealth.latencyMs,
      reconnects: covenHealth.reconnects,
      refreshedAt: covenHealth.refreshedAt,
    },
  ];
  for (const service of services) {
    const row = document.createElement("div");
    row.className = "status-service-row";
    row.append(
      textCell("status-primary", service.name),
      textCell("status-state", service.status),
      textCell("status-latency", Number.isFinite(service.latencyMs)
        ? `${Math.round(service.latencyMs)} ms` : ""),
      textCell("status-reconnects", `${service.reconnects} reconnects`),
      textCell("status-refreshed", Number.isFinite(service.refreshedAt)
        ? new Date(service.refreshedAt).toLocaleTimeString() : ""),
    );
    body.appendChild(row);
  }
  if (nativeHealth.error) {
    body.appendChild(textCell("status-error", nativeHealth.error));
  }
}
```

`renderShells` joins `summary.shells`, native `processes`, and activity thread rows by `threadId`, so each row shows the frontend pane name beside the native `processName`, PID, CPU, memory, and output rate.

`renderTasks` shows full counts but renders at most 20 rows per status group, followed by a muted `N more` row, so daemon history cannot turn the lightweight panel into an unbounded list.

`renderActivity` always labels instrumented Tauri calls as `Ops`; it appends an `Agent tools` row only when `context.agentToolCalls` is a finite structured count.

`render()` must:

1. merge `summarizeWorkspace(context)` with native/activity/frame data;
2. compute output baseline with `median((trend.get("lines")?.values || []).slice(-30))`;
3. evaluate severities before appending the current sample to the trend;
4. update bounded 60-sample trend arrays and observed peaks through `recordTrend`;
5. build metric labels only for valid sources: native snapshot for Performance, frame sample for FPS, PTY/operation data for Activity, and structured session fields for optional agent details;
6. measure cached button widths;
7. call `chooseVisibleMetrics`;
8. render overflowed metrics in More and apply the highest overflow severity plus a count to the More button;
9. render the active panel without replacing the panel element;
10. assign `lastRenderedDiagnostics` from the same normalized values shown in the UI;
11. update pin/copy/scope state;
12. disable focused-pane scope unless the active thread has `processBacked === true`;
13. preserve focus when the focused control still exists.

Update the More button without changing its width unpredictably:

```js
const overflowTone = overflowed.reduce((tone, id) =>
  maxTone(tone, metricSeverity[id] || "neutral"), "neutral");
elements.more.dataset.severity = overflowTone;
elements.more.textContent = overflowed.length ? `More ${overflowed.length}` : "More";
elements.more.title = overflowed.length
  ? `${overflowed.length} metrics hidden at this width`
  : "Customize footer metrics";
renderMoreMenu(overflowed);
```

For both the compact select and segmented buttons:

```js
const focusedOption = elements.scope.querySelector('option[value="focused"]');
focusedOption.disabled = !focusedAvailable;
const effectiveScope = preferences.scope === "focused" && focusedAvailable
  ? "focused"
  : "workspace";
elements.scope.value = effectiveScope;
elements.scopeButtons.forEach((button) => {
  const selected = button.dataset.statusScope === effectiveScope;
  button.disabled = button.dataset.statusScope === "focused" && !focusedAvailable;
  button.setAttribute("aria-pressed", selected ? "true" : "false");
});
```

Map threshold output to footer metric IDs before responsive selection:

```js
const toneRank = { neutral: 0, warn: 1, danger: 2 };
const maxTone = (...tones) => tones.reduce((best, tone) =>
  toneRank[tone] > toneRank[best] ? tone : best, "neutral");
const metricSeverity = {
  connection: nativeHealth.status === "disconnected" ? "danger"
    : nativeHealth.status === "degraded"
      || ["incompatible", "error"].includes(covenHealth.phase) ? "warn" : "neutral",
  agents: summary.agents.some((agent) => agent.status === "waiting") ? "warn" : "neutral",
  shells: "neutral",
  tasks: summary.counts.failed > 0 ? "danger"
    : summary.counts.waiting > 0 ? "warn" : "neutral",
  performance: maxTone(thresholds.cpu, thresholds.memory),
  fps: maxTone(thresholds.fps, thresholds.latency),
  activity: thresholds.activity,
};
```

After computing `metricSeverity`, retain recent severity transitions:

```js
for (const [metric, severity] of Object.entries(metricSeverity)) {
  const previous = previousMetricSeverity[metric] || "neutral";
  if (severity !== "neutral" && previous === "neutral") {
    spikes.unshift({ metric, severity, at: now() });
  }
}
previousMetricSeverity = metricSeverity;
spikes = spikes.filter((spike) => now() - spike.at <= 5 * 60_000).slice(0, 20);
```

Pass `spikes` to `renderActivity`.

Use compact stable labels:

```js
const labels = {
  connection: nativeHealth.status === "ready" ? "● Connected"
    : nativeHealth.status === "starting" ? "○ Connecting"
      : nativeHealth.status === "disconnected" ? "● Disconnected" : "● Degraded",
  agents: `${summary.counts.agents} Agents`,
  shells: `${summary.counts.shells} Shells`,
  tasks: `${summary.counts.running} Run  ${summary.counts.waiting} Wait`
    + (summary.counts.failed ? `  ${summary.counts.failed} Fail` : ""),
  performance: nativeSnapshot
    ? `CPU ${Math.round(nativeSnapshot.workspace.cpuPercent)}%  MEM ${formatMemory(nativeSnapshot.workspace.memoryBytes)}`
    : null,
  fps: Number.isFinite(frame.fps) ? `${frame.fps} FPS` : null,
  activity: Number.isFinite(activity.workspace.linesPerSecond)
    ? `${activity.workspace.linesPerSecond} lines/s`
    : null,
};
```

Do not create a button for a `null` label.

Register:

```js
elements.metrics.addEventListener("click", (event) => {
  const button = event.target.closest("[data-metric]");
  if (button) toggleMetric(button.dataset.metric);
});
elements.scope.addEventListener("change", () => setScope(elements.scope.value));
elements.scopeButtons.forEach((button) => {
  button.addEventListener("click", () => setScope(button.dataset.statusScope));
});
elements.more.addEventListener("click", () => {
  elements.moreMenu.hidden = !elements.moreMenu.hidden;
  elements.more.setAttribute("aria-expanded", elements.moreMenu.hidden ? "false" : "true");
});
elements.close.addEventListener("click", closePanel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeMetric) {
    event.preventDefault();
    closePanel();
  } else if (event.key === "Escape" && !elements.moreMenu.hidden) {
    event.preventDefault();
    elements.moreMenu.hidden = true;
    elements.more.setAttribute("aria-expanded", "false");
    elements.more.focus();
  }
});
elements.pin.addEventListener("click", () => {
  const pinned = new Set(preferences.pinned);
  if (pinned.has(activeMetric)) pinned.delete(activeMetric);
  else pinned.add(activeMetric);
  preferences.pinned = [...pinned];
  savePreferences(storage, preferences);
  renderLast();
});
elements.copy.addEventListener("click", async () => {
  const text = formatLiveDiagnostics(lastRenderedDiagnostics);
  try {
    await copyText(text);
    elements.live.textContent = "Diagnostics copied";
  } catch (error) {
    elements.alert.textContent = "Unable to copy diagnostics: " + String(error);
  }
});
```

The More menu renders every metric with a checkbox and Move Up/Move Down buttons. Those buttons update `preferences.visible` and `preferences.order`, persist, and rerender. A `ResizeObserver` on `elements.bar` reruns responsive selection.

Implement the menu with one row per metric:

```js
function moveMetric(id, delta) {
  const index = preferences.order.indexOf(id);
  const target = Math.max(0, Math.min(preferences.order.length - 1, index + delta));
  if (index === target) return;
  preferences.order.splice(index, 1);
  preferences.order.splice(target, 0, id);
  savePreferences(storage, preferences);
  renderLast();
}

function renderMoreMenu(overflowed) {
  resetBody(elements.moreMenu);
  for (const id of preferences.order) {
    const row = document.createElement("div");
    row.className = "status-more-row";
    row.setAttribute("role", "menuitem");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = preferences.visible.includes(id);
    toggle.disabled = id === "connection";
    toggle.setAttribute("aria-label", `Show ${METRICS[id].label}`);
    toggle.addEventListener("change", () => {
      preferences.visible = toggle.checked
        ? [...new Set([...preferences.visible, id])]
        : preferences.visible.filter((metric) => metric !== id);
      savePreferences(storage, preferences);
      renderLast();
    });
    const label = textCell("status-more-label", METRICS[id].label);
    if (overflowed.includes(id)) label.append(" · hidden by width");
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.setAttribute("aria-label", `Move ${METRICS[id].label} earlier`);
    up.addEventListener("click", () => moveMetric(id, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.setAttribute("aria-label", `Move ${METRICS[id].label} later`);
    down.addEventListener("click", () => moveMetric(id, 1));
    row.append(toggle, label, up, down);
    elements.moreMenu.appendChild(row);
  }
}
```

- [ ] **Step 6: Export the browser API**

Create `status-entry.js`:

```js
export { createStatusController } from "./status-controller.mjs";
export {
  DEFAULT_METRIC_ORDER,
  METRICS,
  chooseVisibleMetrics,
  createActivityTracker,
  createFrameSampler,
  evaluateSeverity,
  formatLiveDiagnostics,
  median,
  normalizePreferences,
  pushTrend,
  samplingDelay,
  sparklinePath,
  summarizeWorkspace,
} from "./status-model.mjs";
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriFooterStatusBar.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the controller**

```bash
git add native/macos/psyche-build-tauri/web/status \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriFooterStatusBar.test.ts
git commit -m "feat: add adaptive footer status controller" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Integrate Live Application State and Instrument Operations

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Add failing integration contracts**

Append:

```ts
it('initializes status with raw metrics invocation and live context', () => {
  expect(main).toContain('var invokeNative = window.__TAURI__.core.invoke;');
  expect(main).toMatch(/PsycheStatus\.createStatusController\(\{/);
  expect(main).toMatch(/fetchMetrics:[\s\S]*invokeNative\("workspace_metrics"/);
  expect(main).toMatch(/getContext:[\s\S]*threads:[\s\S]*covenSessions/);
});

it('feeds PTY bytes, Coven latency, operations, visibility, and focus changes', () => {
  expect(main).toMatch(/listen\("pty:data"[\s\S]*statusController\.notePtyData/);
  expect(main).toMatch(/function invoke\(command, args\)[\s\S]*statusController\.noteOperation/);
  expect(main).toMatch(/refreshCovenSessions[\s\S]*statusController\.noteCovenSample/);
  expect(main).toMatch(/handleVisibilityChange[\s\S]*statusController\.refresh/);
  expect(main).toMatch(/focusThread[\s\S]*statusController\.refresh/);
});

it('never converts an instrumented rejection into success', () => {
  expect(main).toMatch(/return invokeNative\(command, args\)\.then\([\s\S]*throw error/);
});
```

- [ ] **Step 2: Run the footer contract and verify failure**

Run:

```bash
pnpm exec vitest --run __tests__/tauriFooterStatusBar.test.ts
```

Expected: FAIL because `main.js` has no controller wiring.

- [ ] **Step 3: Wrap Tauri invocation without swallowing errors**

Replace the raw alias near the top of `main.js`:

```js
var invokeNative = window.__TAURI__.core.invoke;
var statusController = null;
function invoke(command, args) {
  var started = performance.now();
  return invokeNative(command, args).then(function (value) {
    if (statusController) {
      statusController.noteOperation(command, performance.now() - started, true);
    }
    return value;
  }, function (error) {
    if (statusController) {
      statusController.noteOperation(command, performance.now() - started, false);
    }
    throw error;
  });
}
```

The controller's own `workspace_metrics` request must call `invokeNative` so polling does not count itself as an application operation.

- [ ] **Step 4: Initialize the controller after DOM references**

Add DOM references for every status host, then initialize:

```js
statusController = PsycheStatus.createStatusController({
  elements: {
    bar: document.getElementById("status-bar"),
    metrics: document.getElementById("status-metrics"),
    detail: document.getElementById("status-detail"),
    detailTitle: document.getElementById("status-detail-title"),
    detailBody: document.getElementById("status-detail-body"),
    close: document.getElementById("status-close"),
    pin: document.getElementById("status-pin"),
    copy: document.getElementById("status-copy"),
    scope: document.getElementById("status-scope-compact"),
    scopeButtons: document.querySelectorAll("[data-status-scope]"),
    more: document.getElementById("status-more"),
    moreMenu: document.getElementById("status-more-menu"),
    live: document.getElementById("status-live"),
    alert: document.getElementById("status-alert"),
  },
  fetchMetrics: function (scope) {
    return invokeNative("workspace_metrics", { scope: scope || null });
  },
  getContext: function () {
    var project = activeProject();
    return {
      now: Date.now(),
      activeThreadId: state.activeThreadId,
      threads: state.threads.map(function (thread) {
        return {
          id: thread.id,
          name: thread.name,
          kind: thread.kind,
          status: thread.status,
          covenSessionId: thread.covenSessionId || null,
          processBacked: !!thread.launch,
          needsAttention: !!thread.needsAttention,
          startedAt: thread.startedAt,
          finishedAt: thread.finishedAt,
          exitCode: thread.exitCode,
        };
      }),
      covenSessions: project ? allCovenSessionsForProject(project) : [],
      covenPhase: covenDiscovery.phase,
      covenRefreshedAt: covenDiscovery.refreshedAt,
    };
  },
  storage: window.localStorage,
  copyText: function (text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      return Promise.reject(new Error("Clipboard API is unavailable"));
    }
    return navigator.clipboard.writeText(text);
  },
});
```

- [ ] **Step 5: Feed live activity**

In the PTY data listener, immediately after constructing `bytes`:

```js
if (statusController) statusController.notePtyData(payload.thread_id, bytes);
```

Around `coven_sessions`, measure and report:

```js
var covenStartedAt = performance.now();
```

After applying success or failure:

```js
if (statusController) {
  statusController.noteCovenSample({
    phase: covenDiscovery.phase,
    latencyMs: performance.now() - covenStartedAt,
    refreshedAt: covenDiscovery.refreshedAt,
  });
}
```

Call `statusController.noteActivity()` on pointer/keyboard input, pane create/close/retry, and PTY data. Call `statusController.refresh()` after focus changes, project/worktree changes, thread exit, and visibility returning to visible. Do not poll while hidden.

Register global activity without interfering with existing handlers:

```js
["pointerdown", "keydown"].forEach(function (eventName) {
  document.addEventListener(eventName, function () {
    if (statusController) statusController.noteActivity();
  }, true);
});
```

Start the controller at the beginning of `boot` after `state.env` is assigned:

```js
statusController.start();
```

Stop it during window unload:

```js
window.addEventListener("beforeunload", function () {
  if (statusController) statusController.stop();
});
```

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit shell integration**

```bash
git add native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriFooterStatusBar.test.ts
git commit -m "feat: wire live footer metrics into desktop" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 8: Bundle and Load the Status Module

**Files:**
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Create: `native/macos/psyche-build-tauri/web/status.bundle.js`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `__tests__/tauriWebBundles.test.ts`
- Modify: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Add failing bundle contracts**

Update `tauriWebBundles.test.ts` expected outputs:

```ts
expect(steps.map((step) => step.outfile).sort()).toEqual([
  'web/diffs.bundle.js',
  'web/editor.bundle.js',
  'web/panes.bundle.js',
  'web/sessions.bundle.js',
  'web/status.bundle.js',
]);
```

Add to `tauriFooterStatusBar.test.ts`:

```ts
it('loads the status bundle before the application shell', () => {
  const statusScript = '<script src="./status.bundle.js" defer></script>';
  const mainScript = '<script src="./main.js" defer></script>';
  expect(html).toContain(statusScript);
  expect(html.indexOf(statusScript)).toBeLessThan(html.indexOf(mainScript));
});
```

Update the exact `build:web` expectation in `tauriWorkspacePanels.test.ts` to append:

```text
&& esbuild web/status/status-entry.js --bundle --minify --format=iife --global-name=PsycheStatus --outfile=web/status.bundle.js
```

- [ ] **Step 2: Run bundle contracts and verify failure**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriWebBundles.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because the package script and committed bundle are missing.

- [ ] **Step 3: Extend the web build and script order**

Append to `build:web` in `native/macos/psyche-build-tauri/package.json`:

```text
&& esbuild web/status/status-entry.js --bundle --minify --format=iife --global-name=PsycheStatus --outfile=web/status.bundle.js
```

Load before `main.js` in `index.html`:

```html
<script src="./status.bundle.js" defer></script>
<script src="./main.js" defer></script>
```

- [ ] **Step 4: Build and commit the generated bundle**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
```

Expected: esbuild writes `web/status.bundle.js` and refreshes all committed bundles without errors.

- [ ] **Step 5: Run bundle freshness tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriWebBundles.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit bundle wiring**

```bash
git add native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/status.bundle.js \
  native/macos/psyche-build-tauri/web/editor.bundle.js \
  native/macos/psyche-build-tauri/web/diffs.bundle.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  native/macos/psyche-build-tauri/web/panes.bundle.js \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts \
  __tests__/tauriFooterStatusBar.test.ts
git commit -m "build: bundle footer status module" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Only stage existing bundles if the build changed their bytes.

## Task 9: Validate Behavior End to End

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run the complete focused frontend suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriMetricsNativeContract.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run native formatting, checks, and tests**

Run:

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

Expected: all commands succeed.

- [ ] **Step 3: Run repository typechecking and unit tests**

Run:

```bash
pnpm run typecheck
pnpm run test
```

Expected: PASS. If a pre-existing unrelated failure appears, record it separately and prove the focused status suites remain green.

- [ ] **Step 4: Build the production Tauri app**

Run:

```bash
pnpm run build:tauri
```

Expected: release application and DMG are created under `native/macos/psyche-build-tauri/src-tauri/target/release/bundle/`.

- [ ] **Step 5: Perform the live desktop acceptance pass**

Run:

```bash
pnpm run dev:tauri
```

Verify:

1. collapsed footer is 26px and remains one line;
2. workspace counts update as panes start, wait, fail, complete, and close;
3. CPU/memory rows show real PIDs and process-tree values;
4. PTY output changes lines/s without shifting layout;
5. clicking each metric opens the correct panel;
6. clicking the active metric and pressing Escape collapse it;
7. workspace/focused-pane scope changes native aggregation;
8. pin, visibility, order, and scope survive restart;
9. narrow width moves healthy metrics into More while failures stay visible;
10. hiding/minimizing pauses sampling and returning refreshes immediately;
11. Copy diagnostics contains live metrics but no prompt or terminal content;
12. unavailable model/token/GPU fields are absent rather than blank.

- [ ] **Step 6: Commit acceptance fixes, if any**

If validation required code changes:

```bash
git add \
  native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/Cargo.lock \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/metrics.rs \
  native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/status \
  native/macos/psyche-build-tauri/web/status.bundle.js \
  native/macos/psyche-build-tauri/web/sessions/session-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/session-model.d.mts \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  __tests__/tauriStatusModel.test.ts \
  __tests__/tauriMetricsNativeContract.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
git commit -m "fix: harden footer status telemetry" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no changes were required, do not create an empty commit.
