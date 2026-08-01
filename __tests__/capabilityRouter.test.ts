import { describe, expect, it } from 'vitest';
import {
  AgenticCapabilityRouter,
  CapabilityRoutingError,
  createCovenNativeCapabilityStrategy,
  type AgenticCapabilityStrategy,
} from '../src/orchestration/capabilityRouter.js';

const baseRequest = {
  taskId: 'task-123',
  capability: 'planning' as const,
  input: {
    prompt: 'Fix the failing tests',
    harness: 'codex',
  },
  context: {
    projectRoot: '/repo',
    cwd: '/repo',
    attempt: 1,
    idempotencyKey: 'task-123:planning',
  },
};

describe('AgenticCapabilityRouter', () => {
  it('keeps Coven-native behavior as the default route', async () => {
    const router = new AgenticCapabilityRouter({
      strategies: [createCovenNativeCapabilityStrategy()],
      clock: () => '2026-08-01T14:00:00.000Z',
    });

    await expect(router.execute(baseRequest)).resolves.toEqual({
      output: baseRequest.input,
      trace: {
        taskId: 'task-123',
        traceId: 'task-123:planning:1',
        capability: 'planning',
        provider: 'coven-native',
        attempt: 1,
        idempotencyKey: 'task-123:planning',
        startedAt: '2026-08-01T14:00:00.000Z',
        completedAt: '2026-08-01T14:00:00.000Z',
        toolCalls: [],
        deltas: [],
        evaluationOutcomes: [],
      },
    });
  });

  it('routes an explicit request through a registered Psyche strategy', async () => {
    const psyche: AgenticCapabilityStrategy = {
      id: 'psyche',
      supports: (capability) => capability === 'planning',
      execute: async (request) => ({
        output: {
          ...request.input,
          prompt: `Psyche plan:\n${request.input.prompt}`,
        },
        instrumentation: {
          toolCalls: [{
            toolCallId: 'tool-1',
            toolName: 'repo.search',
            status: 'completed',
          }],
          deltas: [{
            deltaId: 'delta-1',
            kind: 'plan',
            summary: 'Added repository-aware plan',
          }],
          evaluationOutcomes: [{
            evaluationId: 'eval-1',
            evaluator: 'planning-contract',
            outcome: 'passed',
          }],
        },
      }),
    };
    const router = new AgenticCapabilityRouter({
      strategies: [createCovenNativeCapabilityStrategy(), psyche],
      clock: () => '2026-08-01T14:00:00.000Z',
    });

    const result = await router.execute({
      ...baseRequest,
      provider: 'psyche',
      traceId: 'trace-123',
    });

    expect(result.output.prompt).toBe('Psyche plan:\nFix the failing tests');
    expect(result.trace).toMatchObject({
      taskId: 'task-123',
      traceId: 'trace-123',
      capability: 'planning',
      provider: 'psyche',
      toolCalls: [{ toolCallId: 'tool-1', toolName: 'repo.search', status: 'completed' }],
      deltas: [{ deltaId: 'delta-1', kind: 'plan' }],
      evaluationOutcomes: [{ evaluationId: 'eval-1', outcome: 'passed' }],
    });
  });

  it('fails closed when explicit Psyche routing is unavailable', async () => {
    const router = new AgenticCapabilityRouter({
      strategies: [createCovenNativeCapabilityStrategy()],
    });

    await expect(router.execute({
      ...baseRequest,
      provider: 'psyche',
    })).rejects.toEqual(expect.objectContaining<Partial<CapabilityRoutingError>>({
      code: 'capability_provider_unavailable',
    }));
  });

  it('fails closed when a provider does not support the requested capability', async () => {
    const router = new AgenticCapabilityRouter({
      strategies: [
        createCovenNativeCapabilityStrategy(),
        {
          id: 'psyche',
          supports: () => false,
          execute: async () => {
            throw new Error('should not execute');
          },
        },
      ],
    });

    await expect(router.execute({
      ...baseRequest,
      provider: 'psyche',
    })).rejects.toEqual(expect.objectContaining<Partial<CapabilityRoutingError>>({
      code: 'capability_not_supported',
    }));
  });

  it('snapshots trace identity before provider execution', async () => {
    const router = new AgenticCapabilityRouter({
      strategies: [{
        id: 'coven-native',
        supports: () => true,
        execute: async (request) => {
          expect(() => {
            (request.context as { attempt?: number }).attempt = 99;
          }).toThrow();
          return { output: { ...request.input } };
        },
      }],
      clock: () => '2026-08-01T14:00:00.000Z',
    });

    const result = await router.execute(baseRequest);

    expect(result.trace).toMatchObject({
      taskId: 'task-123',
      traceId: 'task-123:planning:1',
      capability: 'planning',
      attempt: 1,
      idempotencyKey: 'task-123:planning',
    });
  });

  it('rejects harness replacement and strips undeclared authority fields', async () => {
    const replacingRouter = new AgenticCapabilityRouter({
      strategies: [{
        id: 'coven-native',
        supports: () => true,
        execute: async (request) => ({
          output: {
            ...request.input,
            harness: 'claude',
          },
        }),
      }],
    });

    await expect(replacingRouter.execute(baseRequest)).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityRoutingError>>({
        code: 'capability_contract_violation',
      }),
    );

    const injectingRouter = new AgenticCapabilityRouter({
      strategies: [{
        id: 'coven-native',
        supports: () => true,
        execute: async (request) => ({
          output: {
            ...request.input,
            prompt: 'Refined prompt',
            sessionId: 'different-session',
            projectRoot: '/outside',
          },
        }),
      }],
    });

    const result = await injectingRouter.execute(baseRequest);
    expect(result.output).toEqual({
      prompt: 'Refined prompt',
      harness: 'codex',
    });
    expect(result.output).not.toHaveProperty('sessionId');
    expect(result.output).not.toHaveProperty('projectRoot');
  });
});
