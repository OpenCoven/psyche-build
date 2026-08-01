import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planOrchestrationTask } from '../src/orchestration/planner.js';
import {
  OrchestrationError,
  type OrchestrationTaskRequest,
} from '../src/orchestration/types.js';

function buildRequest(
  overrides: Partial<OrchestrationTaskRequest> = {}
): OrchestrationTaskRequest {
  return {
    taskId: 'task-123',
    traceId: 'trace-123',
    projectRoot: '/repo',
    cwd: 'packages/app',
    prompt: 'Implement feature',
    title: 'Orchestrate feature work',
    startPointBranch: 'main',
    mergeTargetChain: [{ branchName: 'main', slug: 'main' }],
    lanes: [
      { id: 'lane-b', mode: 'terminal' },
      { id: 'lane-a', mode: 'isolated-worktree', agent: 'codex' },
    ],
    ...overrides,
  };
}

function expectError(
  run: () => unknown,
  code: OrchestrationError['code'],
  message?: RegExp
): void {
  try {
    run();
    throw new Error('Expected planOrchestrationTask to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestrationError);
    expect((error as OrchestrationError).code).toBe(code);
    if (message) {
      expect((error as Error).message).toMatch(message);
    }
  }
}

describe('planOrchestrationTask', () => {
  it('preserves deterministic lane order and defaults concurrency to lane count', () => {
    const plan = planOrchestrationTask(
      buildRequest({
        taskId: '  task-123  ',
        traceId: '  trace-123  ',
        projectRoot: '/repo/./',
        cwd: './packages/app',
        prompt: '  Implement feature  ',
        title: '  Orchestrate feature work  ',
        startPointBranch: '  main  ',
        lanes: [
          { id: ' lane-b ', mode: 'terminal' },
          { id: ' lane-a ', mode: 'isolated-worktree', agent: 'codex' },
        ],
      })
    );

    expect(plan).toMatchObject({
      taskId: 'task-123',
      traceId: 'trace-123',
      projectRoot: path.resolve('/repo/./'),
      cwd: path.resolve('/repo', './packages/app'),
      concurrency: 2,
    });
    expect(plan.lanes.map((lane) => lane.id)).toEqual(['lane-b', 'lane-a']);
    expect(plan.lanes.map((lane) => lane.index)).toEqual([0, 1]);
    expect(plan.lanes[0]).toMatchObject({
      taskId: 'task-123',
      traceId: 'trace-123',
      projectRoot: path.resolve('/repo/./'),
      cwd: path.resolve('/repo', './packages/app'),
      prompt: 'Implement feature',
      title: 'Orchestrate feature work',
      startPointBranch: 'main',
      mergeTargetChain: [{ branchName: 'main', slug: 'main' }],
    });
  });

  it('rejects duplicate lane ids after trimming', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        lanes: [
          { id: ' lane-a ', mode: 'terminal' },
          { id: 'lane-a', mode: 'isolated-worktree' },
        ],
      })),
      'invalid_orchestration_request',
      /duplicate lane id/i
    );
  });

  it('rejects shared-worktree lanes without an existing worktree ref', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        lanes: [{ id: 'lane-a', mode: 'shared-worktree' }],
      })),
      'invalid_orchestration_request',
      /existing worktree/i
    );
  });

  it('rejects empty request fields and missing lanes', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        taskId: '   ',
        prompt: '   ',
        lanes: [],
      })),
      'invalid_orchestration_request'
    );
  });

  it('rejects cwd values outside the project root', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        cwd: '../outside',
      })),
      'project_scope_violation',
      /outside the project root/i
    );
  });

  it('rejects unknown agents from runtime callers', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        lanes: [{ id: 'lane-a', mode: 'terminal', agent: 'unknown-agent' as never }],
      })),
      'unsupported_agent',
      /unknown-agent/
    );
  });

  it('rejects unknown runtime lane modes', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        lanes: [{ id: 'lane-a', mode: 'warp-drive' as never }],
      })),
      'unsupported_lane_mode',
      /warp-drive/
    );
  });

  it('rejects coven-session lanes without a harness', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({
        lanes: [{ id: 'lane-a', mode: 'coven-session', harness: '   ' }],
      })),
      'invalid_orchestration_request',
      /harness/i
    );
  });

  it('validates concurrency values and clamps them to supported bounds', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({ concurrency: 0 })),
      'invalid_orchestration_request',
      /concurrency/i
    );
    expectError(
      () => planOrchestrationTask(buildRequest({ concurrency: 1.5 })),
      'invalid_orchestration_request',
      /concurrency/i
    );

    const plan = planOrchestrationTask(buildRequest({
      concurrency: 99,
      lanes: [
        { id: 'lane-1', mode: 'terminal' },
        { id: 'lane-2', mode: 'terminal' },
        { id: 'lane-3', mode: 'terminal' },
        { id: 'lane-4', mode: 'terminal' },
        { id: 'lane-5', mode: 'terminal' },
      ],
    }));

    expect(plan.concurrency).toBe(4);
  });

  it('propagates taskId and traceId to every lane plan', () => {
    const plan = planOrchestrationTask(buildRequest({
      taskId: '  task-456  ',
      traceId: '  trace-456  ',
      lanes: [
        { id: 'lane-a', mode: 'terminal' },
        { id: 'lane-b', mode: 'shared-worktree', existingWorktree: {
          slug: 'existing',
          worktreePath: '/repo/.worktrees/existing',
          branchName: 'feat/existing',
        } },
      ],
    }));

    expect(plan.lanes).toHaveLength(2);
    expect(plan.lanes.every((lane) => lane.taskId === 'task-456')).toBe(true);
    expect(plan.lanes.every((lane) => lane.traceId === 'trace-456')).toBe(true);
  });
});
