import { describe, expect, test } from 'vitest';

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
  noteOperation,
  notePtyChunk,
  pushTrend,
  samplingDelay,
  sparklinePath,
  summarizeWorkspace,
} from '../native/macos/psyche-build-tauri/web/status/status-model.mjs';

describe('tauri footer status model', () => {
  test('sanitizes preferences and restores the required connection metric', () => {
    expect(DEFAULT_METRIC_ORDER).toEqual([
      'connection',
      'agents',
      'shells',
      'tasks',
      'performance',
      'fps',
      'activity',
    ]);
    expect(METRICS.fps.panel).toBe('performance');
    expect(METRICS.performance.tooltip).toMatch(/80% CPU|85% memory/i);
    expect(METRICS.performance.tooltip).toMatch(/used\/total memory ratio/i);
    expect(METRICS.fps.tooltip).toMatch(/45 FPS|32 ?ms/i);
    expect(METRICS.activity.tooltip).toMatch(/1,?000 lines\/s|4x/i);

    expect(normalizePreferences({
      version: 9,
      visible: ['fps', 'unknown', 'fps'],
      order: ['activity', 'unknown', 'fps', 'activity'],
      pinned: ['unknown', 'fps', 'fps'],
      scope: 'elsewhere',
    })).toEqual({
      version: 1,
      visible: ['fps', 'connection'],
      order: ['activity', 'fps', 'connection', 'agents', 'shells', 'tasks', 'performance'],
      pinned: ['fps'],
      scope: 'workspace',
    });
    expect(normalizePreferences(undefined)).toMatchObject({
      version: 1,
      visible: DEFAULT_METRIC_ORDER,
      order: DEFAULT_METRIC_ORDER,
      pinned: [],
      scope: 'workspace',
    });
  });

  test('normalizes process-backed tasks, de-duplicates remote attachments, and merges metadata', () => {
    const summary = summarizeWorkspace({
      now: 20_000,
      activeThreadId: 'agent',
      threads: [
        {
          id: 'agent',
          name: 'Nova',
          kind: 'coven-attach',
          status: 'running',
          covenSessionId: 'session-1',
          currentTask: 'Local fallback',
          startedAt: 5_000,
          needsAttention: true,
          processBacked: true,
        },
        {
          id: 'shell',
          name: 'Tests',
          kind: 'shell',
          status: 'exited',
          startedAt: 1_000,
          finishedAt: 10_000,
          exitCode: 1,
          processBacked: true,
        },
        {
          id: 'build',
          name: 'Build',
          kind: 'exec',
          status: 'running',
          startedAt: 8_000,
          processBacked: true,
        },
        {
          id: 'web',
          name: 'Web',
          kind: 'web',
          status: 'running',
          processBacked: false,
        },
      ],
      covenSessions: [
        {
          id: 'session-1',
          title: 'Nova remote',
          harness: 'claude',
          status: 'waiting',
          model: 'claude-sonnet',
          currentTask: 'Reviewing tests',
          inputTokens: 120,
          outputTokens: 40,
          createdAt: '2026-08-10T15:48:00.000Z',
        },
        {
          id: 'session-2',
          title: 'Codex',
          harness: 'codex',
          status: 'running',
          model: 'gpt-5.5',
          currentTask: 'Answering follow-up',
          inputTokens: 12,
          outputTokens: 34,
        },
        {
          id: 'session-3',
          title: 'Archived task',
          status: 'archived',
          createdAt: '2026-08-10T15:00:00.000Z',
          archivedAt: '2026-08-10T15:15:00.000Z',
        },
      ],
    });

    expect(summary.agents).toHaveLength(2);
    expect(summary.shells).toEqual([]);
    expect(summary.tasks.map((task) => task.status).sort()).toEqual([
      'completed',
      'failed',
      'running',
      'running',
      'waiting',
    ]);
    expect(summary.counts).toEqual({
      agents: 2,
      shells: 0,
      running: 2,
      waiting: 1,
      failed: 1,
    });
    expect(summary.agents.find((agent) => agent.id === 'local:agent')).toMatchObject({
      harness: 'claude',
      model: 'claude-sonnet',
      currentTask: 'Reviewing tests',
      tokens: { input: 120, output: 40 },
      status: 'waiting',
      runtimeMs: 15_000,
    });
    expect(summary.agents.find((agent) => agent.id === 'coven:session-2')).toMatchObject({
      name: 'Codex',
      model: 'gpt-5.5',
      currentTask: 'Answering follow-up',
      tokens: { input: 12, output: 34 },
      status: 'running',
      runtimeMs: null,
    });
    expect(summary.tasks.find((task) => task.id === 'coven:session-3')?.runtimeMs).toBe(900_000);
  });

  test('keeps live remote agents visible when an attached local pane has already completed', () => {
    const summary = summarizeWorkspace({
      now: 20_000,
      threads: [
        {
          id: 'agent',
          name: 'Nova local',
          kind: 'coven-attach',
          status: 'exited',
          exitCode: 0,
          covenSessionId: 'session-1',
          startedAt: 5_000,
          finishedAt: 12_000,
          processBacked: true,
        },
      ],
      covenSessions: [
        {
          id: 'session-1',
          title: 'Nova remote',
          harness: 'claude',
          status: 'running',
          currentTask: 'Reviewing follow-up',
          createdAt: 8_000,
        },
      ],
    });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        id: 'coven:session-1',
        name: 'Nova remote',
        harness: 'claude',
        currentTask: 'Reviewing follow-up',
        status: 'running',
        threadId: null,
      }),
    ]);
    expect(summary.tasks).toEqual([
      expect.objectContaining({
        id: 'local:agent',
        name: 'Nova local',
        status: 'completed',
        runtimeMs: 7_000,
        threadId: 'agent',
      }),
    ]);
    expect(summary.counts).toEqual({
      agents: 1,
      shells: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });

  test('ignores non-counted pane session ids when deciding which remote sessions are attached', () => {
    const summary = summarizeWorkspace({
      now: 20_000,
      threads: [
        {
          id: 'web-pane',
          name: 'Dashboard',
          kind: 'web',
          status: 'running',
          covenSessionId: 'session-web',
          processBacked: false,
        },
        {
          id: 'build-pane',
          name: 'Build',
          kind: 'exec',
          status: 'running',
          covenSessionId: 'session-exec',
          processBacked: true,
        },
      ],
      covenSessions: [
        {
          id: 'session-web',
          title: 'Remote web session',
          status: 'running',
          currentTask: 'Streaming logs',
          createdAt: 5_000,
        },
        {
          id: 'session-exec',
          title: 'Remote exec session',
          status: 'waiting',
          currentTask: 'Reviewing build',
          createdAt: 7_000,
        },
      ],
    });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        id: 'coven:session-web',
        name: 'Remote web session',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'coven:session-exec',
        name: 'Remote exec session',
        status: 'waiting',
      }),
    ]);
    expect(summary.tasks).toEqual([
      expect.objectContaining({
        id: 'local:build-pane',
        name: 'Build',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'coven:session-web',
        name: 'Remote web session',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'coven:session-exec',
        name: 'Remote exec session',
        status: 'waiting',
      }),
    ]);
  });

  test('keeps only running shell panes in the shell summary', () => {
    const summary = summarizeWorkspace({
      now: 5_000,
      threads: [
        {
          id: 'shell-live',
          name: 'Shell live',
          kind: 'shell',
          status: 'running',
          processBacked: true,
          startedAt: 1_000,
        },
        {
          id: 'shell-done',
          name: 'Shell done',
          kind: 'shell',
          status: 'exited',
          processBacked: true,
          startedAt: 1_000,
          finishedAt: 4_000,
          exitCode: 0,
        },
        {
          id: 'git-pane',
          name: 'Git',
          kind: 'git',
          status: 'running',
          processBacked: false,
        },
      ],
      covenSessions: [],
    });

    expect(summary.shells).toEqual([
      {
        id: 'shell-live',
        name: 'Shell live',
        status: 'running',
        runtimeMs: 4_000,
        threadId: 'shell-live',
      },
    ]);
    expect(summary.counts.shells).toBe(1);
  });

  test('tracks split UTF-8 chunks, bytes, lines, operations, and per-thread rates', () => {
    const tracker = createActivityTracker();
    const encoder = new TextEncoder();

    notePtyChunk(tracker, 'a', encoder.encode('one\npar'), 0);
    notePtyChunk(tracker, 'a', encoder.encode('tial\ntwo\n'), 500);
    noteOperation(tracker, true);
    noteOperation(tracker, false);

    const first = flushActivity(tracker, 1_000);
    expect(first.workspace).toEqual({
      bytesPerSecond: 16,
      linesPerSecond: 3,
      operationsPerSecond: 2,
      errors: 1,
    });
    expect(first.threads).toEqual([{
      threadId: 'a',
      bytesPerSecond: 16,
      linesPerSecond: 3,
    }]);

    notePtyChunk(tracker, 'a', encoder.encode('tail\n'), 1_200);
    expect(flushActivity(tracker, 2_000)).toEqual({
      workspace: {
        bytesPerSecond: 5,
        linesPerSecond: 1,
        operationsPerSecond: 0,
        errors: 0,
      },
      threads: [{
        threadId: 'a',
        bytesPerSecond: 5,
        linesPerSecond: 1,
      }],
    });
  });

  test('tracks a real multibyte character split across UTF-8 byte chunks', () => {
    const tracker = createActivityTracker();
    const bytes = new TextEncoder().encode('😀\nthree\n');

    notePtyChunk(tracker, 'emoji', bytes.subarray(0, 2), 0);
    notePtyChunk(tracker, 'emoji', bytes.subarray(2), 500);

    expect(flushActivity(tracker, 1_000)).toEqual({
      workspace: {
        bytesPerSecond: 11,
        linesPerSecond: 2,
        operationsPerSecond: 0,
        errors: 0,
      },
      threads: [{
        threadId: 'emoji',
        bytesPerSecond: 11,
        linesPerSecond: 2,
      }],
    });
  });

  test('requires sustained thresholds and hysteresis before clearing', () => {
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

    state = {};
    for (let index = 0; index < 4; index += 1) {
      ({ state } = evaluateSeverity({
        memoryPressurePercent: 90,
        fps: 40,
        renderLatencyMs: 40,
      }, state));
    }
    evaluated = evaluateSeverity({
      memoryPressurePercent: 90,
      fps: 40,
      renderLatencyMs: 40,
    }, state);
    expect(evaluated.severity).toMatchObject({
      memory: 'warn',
      fps: 'warn',
      latency: 'warn',
    });
    evaluated = evaluateSeverity({
      memoryPressurePercent: 77,
      fps: 51,
      renderLatencyMs: 20,
    }, evaluated.state);
    expect(evaluated.severity).toMatchObject({
      memory: 'neutral',
      fps: 'neutral',
      latency: 'neutral',
    });
  });

  test('warns only on sustained absolute and relative output spikes', () => {
    let state = {};
    for (let index = 0; index < 2; index += 1) {
      ({ state } = evaluateSeverity({
        outputLinesPerSecond: 1_200,
        outputBaseline: 200,
      }, state));
    }

    let evaluated = evaluateSeverity({
      outputLinesPerSecond: 1_200,
      outputBaseline: 200,
    }, state);
    expect(evaluated.severity.activity).toBe('warn');

    evaluated = evaluateSeverity({
      outputLinesPerSecond: 700,
      outputBaseline: 100,
    }, evaluated.state);
    expect(evaluated.severity.activity).toBe('warn');

    evaluated = evaluateSeverity({
      outputLinesPerSecond: 499,
      outputBaseline: 100,
    }, evaluated.state);
    expect(evaluated.severity.activity).toBe('neutral');
  });

  test('keeps hidden warnings and pinned metrics ahead of healthy overflow', () => {
    expect(chooseVisibleMetrics({
      order: DEFAULT_METRIC_ORDER,
      visible: ['connection', 'agents', 'shells', 'performance'],
      pinned: ['fps'],
      severity: { tasks: 'danger' },
      widths: {
        connection: 90,
        agents: 80,
        shells: 80,
        tasks: 110,
        performance: 150,
        fps: 70,
        activity: 100,
      },
      availableWidth: 380,
      fixedWidth: 100,
    })).toEqual(['connection', 'tasks', 'fps']);
  });

  test('keeps connection visible when the remaining metric budget is narrower than its measured width', () => {
    expect(chooseVisibleMetrics({
      order: DEFAULT_METRIC_ORDER,
      visible: ['connection', 'agents'],
      pinned: [],
      severity: {},
      widths: {
        connection: 90,
        agents: 80,
      },
      availableWidth: 180,
      fixedWidth: 100,
    })).toEqual(['connection']);
  });

  test('caps trends at sixty finite samples and reports the observed peak', () => {
    const values: number[] = [];
    let peak = 0;

    for (let value = 1; value <= 75; value += 1) {
      ({ peak } = pushTrend(values, value, peak));
    }
    ({ peak } = pushTrend(values, Number.NaN, peak));

    expect(values).toHaveLength(60);
    expect(values[0]).toBe(16);
    expect(values.at(-1)).toBe(75);
    expect(peak).toBe(75);
  });

  test('computes medians for even, odd, and empty sets', () => {
    expect(median([9, 1, 5, 3])).toBe(4);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([])).toBe(0);
  });

  test('builds a bounded sparkline path and bounded safe diagnostics', () => {
    const path = sparklinePath([1, 2, 3], 30, 10);
    expect(path).toMatch(/^M /);

    const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    numbers.forEach((value, index) => {
      const max = index % 2 === 0 ? 30 : 10;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(max);
    });

    const text = formatLiveDiagnostics({
      sampledAt: 1_700_000_000_000,
      scope: 'workspace',
      metrics: { cpuPercent: 18, memoryBytes: 640 * 1024 * 1024 },
      peaks: { cpuPercent: 42, memoryBytes: 900 * 1024 * 1024 },
      trends: {
        cpuPercent: Array.from({ length: 2_000 }, (_, index) => index % 100),
      },
      services: [
        { name: 'Native', status: 'ready', latencyMs: 4 },
        { name: 'Coven', status: 'unavailable', latencyMs: null },
      ],
    });

    expect(text).toContain('CPU: 18%');
    expect(text).toContain('Memory: 640 MB');
    expect(text).toContain('Observed peaks: CPU 42%, Memory 900 MB');
    expect(text).toContain('cpuPercent trend: 0 → 99');
    expect(text).toContain('Native: ready (4 ms)');
    expect(text).toContain('Coven: unavailable');
    expect(text).toContain('Excludes prompts, terminal contents, file contents, diffs, and browser contents.');
    expect(text).not.toContain('FPS: 0');
    expect(text).not.toContain('Output: 0 lines/s');
    expect(Array.from(text).length).toBeLessThanOrEqual(16_384);
  });

  test('truncates diagnostics by Unicode code points without splitting astral characters', () => {
    const text = formatLiveDiagnostics({
      sampledAt: 1_700_000_000_000,
      scope: 'workspace',
      metrics: {
        cpuPercent: 18,
      },
      services: [{
        name: `Native-${'😀'.repeat(20_000)}`,
        status: 'ready',
        latencyMs: 4,
      }],
    });
    const hasUnpairedSurrogate = Array.from({ length: text.length }).some((_, index) => {
      const code = text.charCodeAt(index);
      if (code < 0xD800 || code > 0xDFFF) return false;
      if (code <= 0xDBFF) {
        const next = text.charCodeAt(index + 1);
        return !(next >= 0xDC00 && next <= 0xDFFF);
      }
      const previous = text.charCodeAt(index - 1);
      return !(previous >= 0xD800 && previous <= 0xDBFF);
    });

    expect(text).toContain('...(truncated)');
    expect(text).toContain('Native-');
    expect(hasUnpairedSurrogate).toBe(false);
    expect(text).not.toContain('\uFFFD');
    expect(Array.from(text).length).toBe(16_384);
  });

  test('uses adaptive sampling and counts dropped frames from 60Hz intervals', () => {
    expect(samplingDelay({ hidden: false, idleForMs: 5_000 })).toBe(1_000);
    expect(samplingDelay({ hidden: false, idleForMs: 30_000 })).toBe(5_000);
    expect(samplingDelay({ hidden: true, idleForMs: 0 })).toBeNull();

    const sampler = createFrameSampler();
    [0, 16.7, 33.4, 83.4, 100.1].forEach((time) => sampler.frame(time));
    const sample = sampler.flush(1_000);

    expect(sample.fps).toBe(5);
    expect(sample.droppedFrames).toBeGreaterThanOrEqual(2);
    expect(sample.renderLatencyMs).toBeCloseTo(25.025, 3);
  });
});
