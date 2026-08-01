import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planOrchestrationTask } from '../src/orchestration/planner.js';
import {
  OrchestrationError,
  type OrchestrationTaskRequest,
} from '../src/orchestration/types.js';

interface TestPaths {
  sandboxRoot: string;
  projectRoot: string;
  cwd: string;
  existingWorktreePath: string;
  mergeTargetWorktreePath: string;
  outsideRoot: string;
}

let testPaths: TestPaths;

function relativeToProject(targetPath: string): string {
  return path.relative(testPaths.projectRoot, targetPath);
}

function buildRequest(
  overrides: Partial<OrchestrationTaskRequest> = {}
): OrchestrationTaskRequest {
  return {
    taskId: 'task-123',
    traceId: 'trace-123',
    projectRoot: testPaths.projectRoot,
    cwd: relativeToProject(testPaths.cwd),
    prompt: 'Implement feature',
    title: 'Orchestrate feature work',
    startPointBranch: 'main',
    mergeTargetChain: [
      {
        branchName: 'main',
        slug: 'main',
        worktreePath: relativeToProject(testPaths.mergeTargetWorktreePath),
      },
    ],
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
  beforeEach(() => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(process.cwd(), '.vitest-orchestration-planner-')
    );
    const projectRoot = path.join(sandboxRoot, 'project');
    const cwd = path.join(projectRoot, 'packages', 'app');
    const existingWorktreePath = path.join(projectRoot, '.worktrees', 'existing');
    const mergeTargetWorktreePath = path.join(projectRoot, '.worktrees', 'main');
    const outsideRoot = path.join(sandboxRoot, 'outside');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(existingWorktreePath, { recursive: true });
    fs.mkdirSync(mergeTargetWorktreePath, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });

    testPaths = {
      sandboxRoot,
      projectRoot,
      cwd,
      existingWorktreePath,
      mergeTargetWorktreePath,
      outsideRoot,
    };
  });

  afterEach(() => {
    fs.rmSync(testPaths.sandboxRoot, { recursive: true, force: true });
  });

  it('preserves deterministic lane order, canonicalizes scoped paths, and defaults concurrency to lane count', () => {
    const plan = planOrchestrationTask(
      buildRequest({
        taskId: '  task-123  ',
        traceId: '  trace-123  ',
        projectRoot: `${testPaths.projectRoot}${path.sep}.`,
        cwd: `.${path.sep}packages${path.sep}app`,
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
      projectRoot: fs.realpathSync.native(testPaths.projectRoot),
      cwd: fs.realpathSync.native(testPaths.cwd),
      concurrency: 2,
    });
    expect(plan.lanes.map((lane) => lane.id)).toEqual(['lane-b', 'lane-a']);
    expect(plan.lanes.map((lane) => lane.index)).toEqual([0, 1]);
    expect(plan.lanes[0]).toMatchObject({
      taskId: 'task-123',
      traceId: 'trace-123',
      projectRoot: fs.realpathSync.native(testPaths.projectRoot),
      cwd: fs.realpathSync.native(testPaths.cwd),
      prompt: 'Implement feature',
      title: 'Orchestrate feature work',
      startPointBranch: 'main',
      mergeTargetChain: [
        {
          branchName: 'main',
          slug: 'main',
          worktreePath: fs.realpathSync.native(testPaths.mergeTargetWorktreePath),
        },
      ],
    });
  });

  it('defaults traceId to taskId when request traceId is blank or omitted', () => {
    const blankTracePlan = planOrchestrationTask(
      buildRequest({
        taskId: '  task-blank-trace  ',
        traceId: '   ',
      })
    );

    expect(blankTracePlan.traceId).toBe('task-blank-trace');
    expect(blankTracePlan.lanes.every((lane) => lane.traceId === 'task-blank-trace')).toBe(true);

    const omittedTracePlan = planOrchestrationTask(
      buildRequest({
        taskId: 'task-missing-trace',
        traceId: undefined,
      })
    );

    expect(omittedTracePlan.traceId).toBe('task-missing-trace');
    expect(omittedTracePlan.lanes.every((lane) => lane.traceId === 'task-missing-trace')).toBe(true);
  });

  it('rejects duplicate lane ids after trimming', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [
              { id: ' lane-a ', mode: 'terminal' },
              { id: 'lane-a', mode: 'isolated-worktree' },
            ],
          })
        ),
      'invalid_orchestration_request',
      /duplicate lane id/i
    );
  });

  it('rejects shared-worktree lanes without an existing worktree ref', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [{ id: 'lane-a', mode: 'shared-worktree' }],
          })
        ),
      'invalid_orchestration_request',
      /existing worktree/i
    );
  });

  it('rejects empty task and prompt request fields', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            taskId: '   ',
            prompt: '   ',
          })
        ),
      'invalid_orchestration_request'
    );
  });

  it('rejects requests without lanes', () => {
    expectError(
      () => planOrchestrationTask(buildRequest({ lanes: [] })),
      'invalid_orchestration_request',
      /at least one lane/i
    );
  });

  it('rejects invalid startPointBranch values before they can reach git commands', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            startPointBranch: 'main && echo pwned',
          })
        ),
      'invalid_orchestration_request',
      /startPointBranch must be a valid git branch name/i
    );
  });

  it('rejects invalid existing worktree branch names before they can reach git commands', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [
              {
                id: 'lane-a',
                mode: 'shared-worktree',
                existingWorktree: {
                  slug: 'existing',
                  worktreePath: relativeToProject(testPaths.existingWorktreePath),
                  branchName: 'feat$(echo pwned)',
                },
              },
            ],
          })
        ),
      'invalid_orchestration_request',
      /existingWorktree\.branchName must be a valid git branch name/i
    );
  });

  it('rejects invalid merge target branch names before they can reach git commands', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            mergeTargetChain: [
              {
                branchName: 'feat/../escape',
                slug: 'main',
                worktreePath: relativeToProject(testPaths.mergeTargetWorktreePath),
              },
            ],
          })
        ),
      'invalid_orchestration_request',
      /mergeTargetChain\[0\]\.branchName must be a valid git branch name/i
    );
  });

  it('rejects nonexistent projectRoot values', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            projectRoot: path.join(testPaths.sandboxRoot, 'missing-project'),
          })
        ),
      'invalid_orchestration_request',
      /projectRoot .*does not exist/i
    );
  });

  it('rejects nonexistent cwd values', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            cwd: path.join('packages', 'missing'),
          })
        ),
      'invalid_orchestration_request',
      /cwd .*does not exist/i
    );
  });

  it('rejects cwd symlink escapes outside the project root', () => {
    const escapedCwd = path.join(testPaths.outsideRoot, 'escaped-cwd');
    const cwdLink = path.join(testPaths.projectRoot, 'linked-cwd');

    fs.mkdirSync(escapedCwd, { recursive: true });
    fs.symlinkSync(escapedCwd, cwdLink, 'dir');

    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            cwd: 'linked-cwd',
          })
        ),
      'project_scope_violation',
      /cwd .*outside the project root/i
    );
  });

  it('rejects existing worktree symlink escapes outside the project root', () => {
    const escapedWorktree = path.join(testPaths.outsideRoot, 'escaped-worktree');
    const worktreeLink = path.join(testPaths.projectRoot, '.worktrees', 'linked-existing');

    fs.mkdirSync(escapedWorktree, { recursive: true });
    fs.symlinkSync(escapedWorktree, worktreeLink, 'dir');

    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [
              {
                id: 'lane-a',
                mode: 'shared-worktree',
                existingWorktree: {
                  slug: 'existing',
                  worktreePath: relativeToProject(worktreeLink),
                  branchName: 'feat/existing',
                },
              },
            ],
          })
        ),
      'project_scope_violation',
      /existingWorktree\.worktreePath .*outside the project root/i
    );
  });

  it('rejects merge target worktree paths outside the project root', () => {
    const escapedMergeTarget = path.join(testPaths.outsideRoot, 'merge-target');
    fs.mkdirSync(escapedMergeTarget, { recursive: true });

    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            mergeTargetChain: [
              {
                branchName: 'main',
                slug: 'main',
                worktreePath: relativeToProject(escapedMergeTarget),
              },
            ],
          })
        ),
      'project_scope_violation',
      /mergeTargetChain\[0\]\.worktreePath .*outside the project root/i
    );
  });

  it('rejects nonexistent merge target worktree paths when supplied', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            mergeTargetChain: [
              {
                branchName: 'main',
                slug: 'main',
                worktreePath: path.join('.worktrees', 'missing-target'),
              },
            ],
          })
        ),
      'invalid_orchestration_request',
      /mergeTargetChain\[0\]\.worktreePath .*does not exist/i
    );
  });

  it('rejects unknown agents from runtime callers', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [{ id: 'lane-a', mode: 'terminal', agent: 'unknown-agent' as never }],
          })
        ),
      'unsupported_agent',
      /unknown-agent/
    );
  });

  it('rejects unknown runtime lane modes', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [{ id: 'lane-a', mode: 'warp-drive' as never }],
          })
        ),
      'unsupported_lane_mode',
      /warp-drive/
    );
  });

  it('rejects coven-session lanes without a harness', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            lanes: [{ id: 'lane-a', mode: 'coven-session', harness: '   ' }],
          })
        ),
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

    const plan = planOrchestrationTask(
      buildRequest({
        concurrency: 99,
        lanes: [
          { id: 'lane-1', mode: 'terminal' },
          { id: 'lane-2', mode: 'terminal' },
          { id: 'lane-3', mode: 'terminal' },
          { id: 'lane-4', mode: 'terminal' },
          { id: 'lane-5', mode: 'terminal' },
        ],
      })
    );

    expect(plan.concurrency).toBe(4);
  });

  it('propagates taskId and traceId to every lane plan and keeps in-root worktree paths canonical', () => {
    const plan = planOrchestrationTask(
      buildRequest({
        taskId: '  task-456  ',
        traceId: '  trace-456  ',
        lanes: [
          { id: 'lane-a', mode: 'terminal' },
          {
            id: 'lane-b',
            mode: 'shared-worktree',
            existingWorktree: {
              slug: 'existing',
              worktreePath: relativeToProject(testPaths.existingWorktreePath),
              branchName: 'feat/existing',
            },
          },
        ],
      })
    );

    expect(plan.lanes).toHaveLength(2);
    expect(plan.lanes.every((lane) => lane.taskId === 'task-456')).toBe(true);
    expect(plan.lanes.every((lane) => lane.traceId === 'trace-456')).toBe(true);
    expect(plan.lanes[1].existingWorktree).toMatchObject({
      slug: 'existing',
      worktreePath: fs.realpathSync.native(testPaths.existingWorktreePath),
      branchName: 'feat/existing',
    });
  });
});
