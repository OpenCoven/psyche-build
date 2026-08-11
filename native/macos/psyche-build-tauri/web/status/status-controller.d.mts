import type {
  ActivityThreadSample,
  ActivityWorkspaceSample,
  DiagnosticsInput,
  FrameSample,
  MetricId,
  ScopePreference,
  WorkspaceSummary,
} from './status-model.mjs';

export type StatusControllerContext = {
  activeThreadId?: string | null;
  threads?: unknown[];
  covenSessions?: unknown[];
  agentToolCalls?: number | null;
};

export type StatusControllerScopeState = {
  focusedAvailable?: boolean;
  scopeName?: ScopePreference;
  activeThreadId?: string | null;
};

export type StatusControllerHealth = {
  status?: string;
  phase?: string;
  reconnects?: number;
  latencyMs?: number | null;
  lastSuccessAt?: number | string | null;
  staleAgeMs?: number | null;
  refreshedAt?: number | string | null;
  failureAt?: number | string | null;
  error?: string;
};

export type StatusControllerSample = {
  sampledAt?: number;
  context?: StatusControllerContext;
  summary?: WorkspaceSummary;
  scopeState?: StatusControllerScopeState;
  nativeSnapshot?: unknown;
  nativeHealth?: StatusControllerHealth;
  activity?: {
    workspace: ActivityWorkspaceSample;
    threads: ActivityThreadSample[];
  };
  frame?: FrameSample;
  covenHealth?: StatusControllerHealth;
};

export type StatusControllerElements = {
  bar: object;
  metrics: object;
  detail: object;
  detailTitle: object;
  detailBody: object;
  more: object;
  moreMenu: object;
  live: object;
  alert: object;
  pin: object;
  copy: object;
  close: object;
  trailing?: object | null;
  scopeButtons?: ArrayLike<object> | Iterable<object> | object[] | null;
};

export type StatusControllerOptions = {
  elements: StatusControllerElements;
  document?: object;
  ResizeObserver?: new (callback: () => void) => {
    observe(target: object): void;
    disconnect(): void;
  };
  now?: () => number;
  requestFrame?: (callback: (at: number) => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (callback: () => void, delay: number) => any;
  clearTimer?: (id: any) => void;
  performance?: {
    now(): number;
  };
  storage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  copyText?: (text: string) => Promise<void>;
  nativePollTimeoutMs?: number;
  fetchMetrics: (scope?: { threadId?: string }) => Promise<unknown>;
  getContext: () => StatusControllerContext;
};

export type StatusController = {
  start(): StatusController;
  stop(): StatusController;
  refresh(): Promise<StatusControllerView | null>;
  noteActivity(at?: number): void;
  notePtyData(
    threadId: string,
    bytes: Uint8Array | string | ArrayBuffer | ArrayBufferView,
    at?: number,
  ): void;
  noteOperation(
    nameOrRecord: string | { name?: string; command?: string; ok?: boolean },
    maybeDurationOrOk?: number | boolean,
    maybeOk?: boolean,
  ): void;
  noteCovenSample(sample?: Record<string, unknown>): void;
  setScope(scopeName: ScopePreference): Promise<StatusControllerView | null>;
  toggleMetric(id: MetricId): void;
  closePanel(): void;
  render(sample?: StatusControllerSample): StatusControllerView | null;
};

export type StatusControllerView = {
  activeMetric: MetricId | null;
  activePanel: string | null;
  effectiveScope: ScopePreference;
  visibleMetrics: MetricId[];
  overflowed: MetricId[];
  labels: Partial<Record<MetricId, string | null>>;
  metricSeverity: Record<string, string>;
  diagnostics: DiagnosticsInput;
};

export function createStatusController(options?: StatusControllerOptions): StatusController;
