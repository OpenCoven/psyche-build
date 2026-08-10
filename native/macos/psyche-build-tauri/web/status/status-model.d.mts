export type MetricId =
  | 'connection'
  | 'agents'
  | 'shells'
  | 'tasks'
  | 'performance'
  | 'fps'
  | 'activity';

export type MetricPanelId =
  | 'connection'
  | 'agents'
  | 'shells'
  | 'tasks'
  | 'performance'
  | 'activity';

export type Severity = 'neutral' | 'warn' | 'danger';
export type TaskStatus = 'running' | 'waiting' | 'blocked' | 'failed' | 'completed';
export type ScopePreference = 'workspace' | 'focused';
export type TimestampLike = number | string | null;
export type TokenUsage = {
  input: number | null;
  output: number | null;
};

export type MetricDefinition = {
  id: MetricId;
  panel: MetricPanelId;
  label: string;
  compactLabel: string;
  priority: number;
  tooltip: string;
  technicalTooltip: string;
};

export type StatusThread = {
  id: string;
  name: string;
  kind: string;
  status: string;
  processBacked: boolean;
  covenSessionId?: string | null;
  harness?: string | null;
  model?: string | null;
  currentTask?: string | null;
  tokens?: TokenUsage | null;
  needsAttention?: boolean;
  startedAt?: TimestampLike;
  finishedAt?: TimestampLike;
  exitCode?: number | null;
};

export type StatusCovenSession = {
  id: string;
  title?: string | null;
  harness?: string | null;
  model?: string | null;
  currentTask?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  status?: string | null;
  createdAt?: TimestampLike;
  archivedAt?: TimestampLike;
};

export type StatusPreferences = {
  version: 1;
  visible: MetricId[];
  order: MetricId[];
  pinned: MetricId[];
  scope: ScopePreference;
};

export type AgentSummary = {
  id: string;
  name: string;
  harness: string | null;
  model: string | null;
  currentTask: string | null;
  tokens: TokenUsage | null;
  status: 'running' | 'waiting' | 'blocked';
  runtimeMs: number | null;
  threadId: string | null;
};

export type ShellSummary = {
  id: string;
  name: string;
  status: 'running';
  runtimeMs: number | null;
  threadId: string;
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
  shells: ShellSummary[];
  tasks: TaskSummary[];
  counts: {
    agents: number;
    shells: number;
    running: number;
    waiting: number;
    failed: number;
  };
};

export type ActivityThreadState = {
  decoder: TextDecoder;
  carry: string;
  bytes: number;
  lines: number;
  at: number;
};

export type ActivityThreadSample = {
  threadId: string;
  bytesPerSecond: number;
  linesPerSecond: number;
};

export type ActivityWorkspaceSample = {
  bytesPerSecond: number;
  linesPerSecond: number;
  operationsPerSecond: number;
  errors: number;
};

export type ActivityTracker = {
  threads: Map<string, ActivityThreadState>;
  lastFlushAt: number;
  operations: number;
  errors: number;
};

export type SeverityCounterState = {
  count: number;
  warned: boolean;
};

export type SeverityState = {
  cpu: SeverityCounterState;
  memory: SeverityCounterState;
  fps: SeverityCounterState;
  latency: SeverityCounterState;
  activity: SeverityCounterState;
};

export type FrameSample = {
  fps: number;
  renderLatencyMs: number;
  droppedFrames: number;
};

export type FrameSampler = {
  frame(at: number): void;
  flush(windowMs: number): FrameSample;
};

export type DiagnosticsMetrics = {
  cpuPercent?: number | null;
  memoryBytes?: number | null;
  fps?: number | null;
  linesPerSecond?: number | null;
  outputLinesPerSecond?: number | null;
};

export type DiagnosticsPeaks = {
  cpuPercent?: number | null;
  memoryBytes?: number | null;
  fps?: number | null;
  linesPerSecond?: number | null;
  outputLinesPerSecond?: number | null;
};

export type DiagnosticsService = {
  name: string;
  status: string;
  latencyMs?: number | null;
};

export type DiagnosticsInput = {
  sampledAt: number;
  scope: ScopePreference;
  metrics: DiagnosticsMetrics;
  peaks?: DiagnosticsPeaks;
  trends?: Record<string, number[]>;
  services: DiagnosticsService[];
};

export const DEFAULT_METRIC_ORDER: readonly MetricId[];
export const METRICS: Readonly<Record<MetricId, MetricDefinition>>;

export function normalizePreferences(value: unknown): StatusPreferences;
export function summarizeWorkspace(input: {
  now?: number;
  activeThreadId?: string | null;
  threads: StatusThread[];
  covenSessions: StatusCovenSession[];
}): WorkspaceSummary;

export function createActivityTracker(): ActivityTracker;
export function notePtyChunk(
  tracker: ActivityTracker,
  threadId: string,
  bytes: Uint8Array,
  at: number,
): void;
export function noteOperation(tracker: ActivityTracker, ok: boolean): void;
export function flushActivity(
  tracker: ActivityTracker,
  at: number,
): {
  workspace: ActivityWorkspaceSample;
  threads: ActivityThreadSample[];
};

export function evaluateSeverity(
  sample: {
    cpuPercent?: number | null;
    memoryPressurePercent?: number | null;
    fps?: number | null;
    renderLatencyMs?: number | null;
    outputLinesPerSecond?: number | null;
    outputBaseline?: number | null;
  },
  previous?: Partial<SeverityState>,
): {
  state: SeverityState;
  severity: {
    cpu: Severity;
    memory: Severity;
    fps: Severity;
    latency: Severity;
    activity: Severity;
  };
};

export function pushTrend(
  values: number[],
  value: number,
  previousPeak?: number,
): {
  values: number[];
  peak: number;
};
export function median(values: number[]): number;
export function sparklinePath(values: number[], width: number, height: number): string;
export function samplingDelay(input: { hidden: boolean; idleForMs: number }): number | null;
export function createFrameSampler(): FrameSampler;

export function chooseVisibleMetrics(input: {
  order: readonly MetricId[];
  visible: readonly MetricId[];
  pinned: readonly MetricId[];
  severity: Partial<Record<MetricId, Severity>>;
  widths: Partial<Record<MetricId, number>>;
  availableWidth: number;
  fixedWidth: number;
}): MetricId[];

export function formatLiveDiagnostics(input: DiagnosticsInput): string;
