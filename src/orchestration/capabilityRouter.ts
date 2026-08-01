export const AGENTIC_CAPABILITIES = [
  'planning',
  'code-synthesis',
  'tool-routing',
  'repo-navigation',
  'iterative-refinement',
  'verification',
  'evaluation',
  'debugging',
  'reasoning-policy',
] as const;

export type AgenticCapability = typeof AGENTIC_CAPABILITIES[number];
export type CapabilityProviderId = 'coven-native' | 'psyche';

export interface AgenticCapabilityInput {
  prompt: string;
  harness: string;
  title?: string;
  state?: Readonly<Record<string, unknown>>;
}

export interface AgenticCapabilityContext {
  projectRoot: string;
  cwd: string;
  sessionId?: string;
  attempt?: number;
  idempotencyKey?: string;
}

export interface AgenticCapabilityRequest {
  readonly taskId: string;
  readonly traceId?: string;
  readonly capability: AgenticCapability;
  readonly provider?: CapabilityProviderId;
  readonly input: AgenticCapabilityInput;
  readonly context: AgenticCapabilityContext;
}

export interface AgenticCapabilityOutput extends AgenticCapabilityInput {
  stateDelta?: Readonly<Record<string, unknown>>;
}

export interface CapabilityToolCall {
  toolCallId: string;
  toolName: string;
  status: 'requested' | 'running' | 'completed' | 'failed';
}

export interface CapabilityDelta {
  deltaId: string;
  kind: 'plan' | 'code' | 'state' | 'diagnostic';
  summary: string;
}

export interface CapabilityEvaluationOutcome {
  evaluationId: string;
  evaluator: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  score?: number;
}

export interface CapabilityInstrumentation {
  toolCalls?: readonly CapabilityToolCall[];
  deltas?: readonly CapabilityDelta[];
  evaluationOutcomes?: readonly CapabilityEvaluationOutcome[];
}

export interface AgenticCapabilityStrategyResult {
  output: AgenticCapabilityOutput;
  instrumentation?: CapabilityInstrumentation;
}

export interface AgenticCapabilityStrategy {
  readonly id: CapabilityProviderId;
  supports(capability: AgenticCapability): boolean;
  execute(request: AgenticCapabilityRequest): Promise<AgenticCapabilityStrategyResult>;
}

export interface AgenticCapabilityTrace {
  taskId: string;
  traceId: string;
  capability: AgenticCapability;
  provider: CapabilityProviderId;
  attempt: number;
  idempotencyKey?: string;
  startedAt: string;
  completedAt: string;
  toolCalls: CapabilityToolCall[];
  deltas: CapabilityDelta[];
  evaluationOutcomes: CapabilityEvaluationOutcome[];
}

export interface AgenticCapabilityExecution {
  output: AgenticCapabilityOutput;
  trace: AgenticCapabilityTrace;
}

export type CapabilityRoutingErrorCode =
  | 'capability_provider_unavailable'
  | 'capability_not_supported'
  | 'capability_contract_violation';

export class CapabilityRoutingError extends Error {
  constructor(
    public readonly code: CapabilityRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityRoutingError';
  }
}

export interface AgenticCapabilityRouterOptions {
  strategies: readonly AgenticCapabilityStrategy[];
  clock?: () => string;
}

export class AgenticCapabilityRouter {
  private readonly strategies: ReadonlyMap<CapabilityProviderId, AgenticCapabilityStrategy>;
  private readonly clock: () => string;

  constructor(options: AgenticCapabilityRouterOptions) {
    const strategies = new Map<CapabilityProviderId, AgenticCapabilityStrategy>();
    for (const strategy of options.strategies) {
      if (strategies.has(strategy.id)) {
        throw new CapabilityRoutingError(
          'capability_contract_violation',
          `Capability provider "${strategy.id}" is registered more than once`,
        );
      }
      strategies.set(strategy.id, strategy);
    }
    this.strategies = strategies;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async execute(request: AgenticCapabilityRequest): Promise<AgenticCapabilityExecution> {
    const provider = request.provider ?? 'coven-native';
    const strategy = this.strategies.get(provider);
    if (!strategy) {
      throw new CapabilityRoutingError(
        'capability_provider_unavailable',
        `Capability provider "${provider}" is not registered`,
      );
    }
    if (!strategy.supports(request.capability)) {
      throw new CapabilityRoutingError(
        'capability_not_supported',
        `Capability provider "${provider}" does not support "${request.capability}"`,
      );
    }

    const taskId = request.taskId;
    const capability = request.capability;
    const attempt = request.context.attempt ?? 1;
    const idempotencyKey = request.context.idempotencyKey;
    const traceId = request.traceId ?? `${taskId}:${capability}:${attempt}`;
    const startedAt = this.clock();
    const normalizedContext: AgenticCapabilityContext = Object.freeze({
      ...request.context,
      attempt,
    });
    const strategyRequest: AgenticCapabilityRequest = Object.freeze({
      ...request,
      input: Object.freeze({ ...request.input }),
      context: normalizedContext,
    });
    const result = await strategy.execute(strategyRequest);
    const output = normalizeStrategyOutput(result, strategyRequest.input);
    const completedAt = this.clock();

    return {
      output,
      trace: {
        taskId,
        traceId,
        capability,
        provider,
        attempt,
        idempotencyKey,
        startedAt,
        completedAt,
        toolCalls: [...(result.instrumentation?.toolCalls ?? [])],
        deltas: [...(result.instrumentation?.deltas ?? [])],
        evaluationOutcomes: [...(result.instrumentation?.evaluationOutcomes ?? [])],
      },
    };
  }
}

export function createCovenNativeCapabilityStrategy(): AgenticCapabilityStrategy {
  return {
    id: 'coven-native',
    supports: () => true,
    execute: async (request) => ({ output: { ...request.input } }),
  };
}

export function createCovenNativeCapabilityRouter(): AgenticCapabilityRouter {
  return new AgenticCapabilityRouter({
    strategies: [createCovenNativeCapabilityStrategy()],
  });
}

export function isAgenticCapability(value: string): value is AgenticCapability {
  return (AGENTIC_CAPABILITIES as readonly string[]).includes(value);
}

function normalizeStrategyOutput(
  result: AgenticCapabilityStrategyResult,
  input: AgenticCapabilityInput,
): AgenticCapabilityOutput {
  if (!result || typeof result !== 'object' || !result.output) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned no output',
    );
  }
  if (typeof result.output.prompt !== 'string' || !result.output.prompt.trim()) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned an empty prompt',
    );
  }
  if (typeof result.output.harness !== 'string' || !result.output.harness.trim()) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned an empty harness',
    );
  }
  if (result.output.harness !== input.harness) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider cannot replace the authoritative harness',
    );
  }

  if (result.output.title !== undefined && typeof result.output.title !== 'string') {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned a non-string title',
    );
  }
  const title = typeof result.output.title === 'string' ? result.output.title.trim() : undefined;

  if (
    result.output.state !== undefined
    && (result.output.state === null || typeof result.output.state !== 'object' || Array.isArray(result.output.state))
  ) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned an invalid state payload',
    );
  }

  if (
    result.output.stateDelta !== undefined
    && (result.output.stateDelta === null || typeof result.output.stateDelta !== 'object' || Array.isArray(result.output.stateDelta))
  ) {
    throw new CapabilityRoutingError(
      'capability_contract_violation',
      'Capability provider returned an invalid stateDelta payload',
    );
  }

  return {
    prompt: result.output.prompt.trim(),
    harness: input.harness,
    ...(title ? { title } : {}),
    ...(result.output.state !== undefined ? { state: result.output.state } : {}),
    ...(result.output.stateDelta !== undefined ? { stateDelta: result.output.stateDelta } : {}),
  };
}
