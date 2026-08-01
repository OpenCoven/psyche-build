import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  projectRootFile: string;
  cwdFile: string;
  existingWorktreePath: string;
  existingWorktreeFilePath: string;
  mergeTargetWorktreePath: string;
  mergeTargetWorktreeFilePath: string;
  outsideRoot: string;
}

let testPaths: TestPaths;

function relativeToProject(targetPath: string): string {
  return path.relative(testPaths.projectRoot, targetPath);
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeGitRepo(projectRoot: string): void {
  runGit(['init'], projectRoot);
  runGit(['config', 'user.name', 'Test User'], projectRoot);
  runGit(['config', 'user.email', 'test@example.invalid'], projectRoot);
  runGit(['checkout', '-b', 'main'], projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Test repo\n');
  runGit(['add', 'README.md'], projectRoot);
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createGitBranch(projectRoot: string, branchName: string): void {
  runGit(['branch', branchName, 'main'], projectRoot);
}

function createGitWorktree(worktreePath: string, branchName: string, startPoint = 'main'): void {
  fs.rmSync(worktreePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync(
    'git',
    ['-C', testPaths.projectRoot, 'worktree', 'add', worktreePath, '-b', branchName, startPoint],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

function detachGitWorktree(worktreePath: string): void {
  execFileSync('git', ['-C', worktreePath, 'checkout', '--detach', 'HEAD'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

const invalidBranchNames = ['foo.lock', 'foo/', '.foo', 'foo//bar', 'foo.'];

const branchFieldCases = [
  {
    fieldName: 'startPointBranch',
    expectedMessage: /startPointBranch must be a valid git branch name/i,
    buildRequest: (branchName: string): OrchestrationTaskRequest =>
      buildRequest({ startPointBranch: branchName }),
    buildAcceptanceRequest: (): OrchestrationTaskRequest => {
      createGitBranch(testPaths.projectRoot, 'feature/normal-branch');
      return buildRequest({ startPointBranch: 'feature/normal-branch' });
    },
  },
  {
    fieldName: 'existingWorktree.branchName',
    expectedMessage: /existingWorktree\.branchName must be a valid git branch name/i,
    buildRequest: (branchName: string): OrchestrationTaskRequest =>
      buildRequest({
        lanes: [
          {
            id: 'lane-a',
            mode: 'shared-worktree',
            existingWorktree: {
              slug: 'existing',
              worktreePath: relativeToProject(testPaths.existingWorktreePath),
              branchName,
            },
          },
        ],
      }),
    buildAcceptanceRequest: (): OrchestrationTaskRequest => {
      createGitWorktree(testPaths.existingWorktreePath, 'feature/normal-branch');
      return buildRequest({
        lanes: [
          {
            id: 'lane-a',
            mode: 'shared-worktree',
            existingWorktree: {
              slug: 'existing',
              worktreePath: relativeToProject(testPaths.existingWorktreePath),
              branchName: 'feature/normal-branch',
            },
          },
        ],
      });
    },
  },
  {
    fieldName: 'mergeTargetChain[0].branchName',
    expectedMessage: /mergeTargetChain\[0\]\.branchName must be a valid git branch name/i,
    buildRequest: (branchName: string): OrchestrationTaskRequest =>
      buildRequest({
        mergeTargetChain: [
          {
            branchName,
            slug: 'main',
            worktreePath: relativeToProject(testPaths.mergeTargetWorktreePath),
          },
        ],
      }),
  },
];

describe('planOrchestrationTask', () => {
  beforeEach(() => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(process.cwd(), '.vitest-orchestration-planner-')
    );
    const projectRoot = path.join(sandboxRoot, 'project');
    const cwd = path.join(projectRoot, 'packages', 'app');
    const projectRootFile = path.join(sandboxRoot, 'project-root.txt');
    const cwdFile = path.join(projectRoot, 'packages', 'cwd.txt');
    const existingWorktreePath = path.join(projectRoot, '.worktrees', 'existing');
    const existingWorktreeFilePath = path.join(projectRoot, '.worktrees', 'existing-file.txt');
    const mergeTargetWorktreePath = path.join(projectRoot, '.worktrees', 'main');
    const mergeTargetWorktreeFilePath = path.join(projectRoot, '.worktrees', 'main-file.txt');
    const outsideRoot = path.join(sandboxRoot, 'outside');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(existingWorktreePath, { recursive: true });
    fs.mkdirSync(mergeTargetWorktreePath, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    initializeGitRepo(projectRoot);
    fs.writeFileSync(projectRootFile, 'not a directory');
    fs.writeFileSync(cwdFile, 'not a directory');
    fs.writeFileSync(existingWorktreeFilePath, 'not a directory');
    fs.writeFileSync(mergeTargetWorktreeFilePath, 'not a directory');

    testPaths = {
      sandboxRoot,
      projectRoot,
      cwd,
      projectRootFile,
      cwdFile,
      existingWorktreePath,
      existingWorktreeFilePath,
      mergeTargetWorktreePath,
      mergeTargetWorktreeFilePath,
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

  describe.each(branchFieldCases)(
    '$fieldName validation',
    ({ buildRequest, buildAcceptanceRequest, expectedMessage }) => {
    it.each(invalidBranchNames)('rejects %s', (branchName) => {
      expectError(
        () => planOrchestrationTask(buildRequest(branchName)),
        'invalid_orchestration_request',
        expectedMessage
      );
    });

    it('accepts a normal branch name', () => {
      const acceptedRequest = buildAcceptanceRequest?.()
        ?? buildRequest('feature/normal-branch');
      expect(() =>
        planOrchestrationTask(acceptedRequest)
      ).not.toThrow();
    });
    }
  );

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

  it('rejects projectRoot values that resolve to files', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            projectRoot: testPaths.projectRootFile,
          })
        ),
      'invalid_orchestration_request',
      /projectRoot .*must be a directory, not a file/i
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

  it('rejects cwd values that resolve to files', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            cwd: path.relative(testPaths.projectRoot, testPaths.cwdFile),
          })
        ),
      'invalid_orchestration_request',
      /cwd .*must be a directory, not a file/i
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

  it('rejects existing worktree paths that resolve to files', () => {
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
                  worktreePath: relativeToProject(testPaths.existingWorktreeFilePath),
                  branchName: 'feat/existing',
                },
              },
            ],
          })
        ),
      'invalid_orchestration_request',
      /existingWorktree\.worktreePath .*must be a directory, not a file/i
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

  it('rejects merge target worktree paths that resolve to files', () => {
    expectError(
      () =>
        planOrchestrationTask(
          buildRequest({
            mergeTargetChain: [
              {
                branchName: 'main',
                slug: 'main',
                worktreePath: path.relative(
                  testPaths.projectRoot,
                  testPaths.mergeTargetWorktreeFilePath
                ),
              },
            ],
          })
        ),
      'invalid_orchestration_request',
      /mergeTargetChain\[0\]\.worktreePath .*must be a directory, not a file/i
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
    createGitWorktree(testPaths.existingWorktreePath, 'feat/existing');
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

  it('accepts projectRoot, cwd, existing worktree, and merge target directory paths', () => {
    createGitWorktree(testPaths.existingWorktreePath, 'feat/existing');
    const plan = planOrchestrationTask(
      buildRequest({
        projectRoot: testPaths.projectRoot,
        cwd: relativeToProject(testPaths.cwd),
        mergeTargetChain: [
          {
            branchName: 'main',
            slug: 'main',
            worktreePath: relativeToProject(testPaths.mergeTargetWorktreePath),
          },
        ],
        lanes: [
          {
            id: 'lane-a',
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

    expect(plan.projectRoot).toBe(fs.realpathSync.native(testPaths.projectRoot));
    expect(plan.cwd).toBe(fs.realpathSync.native(testPaths.cwd));
    expect(plan.lanes[0].existingWorktree?.worktreePath).toBe(
      fs.realpathSync.native(testPaths.existingWorktreePath)
    );
    expect(plan.lanes[0].mergeTargetChain?.[0]?.worktreePath).toBe(
      fs.realpathSync.native(testPaths.mergeTargetWorktreePath)
    );
  });

  describe('git identity validation', () => {
    it('accepts a supplied startPointBranch that exists in projectRoot', () => {
      createGitBranch(testPaths.projectRoot, 'feature/start-point');

      expect(() =>
        planOrchestrationTask(
          buildRequest({
            startPointBranch: 'feature/start-point',
          })
        )
      ).not.toThrow();
    });

    it('rejects a supplied startPointBranch that does not exist in projectRoot', () => {
      expectError(
        () =>
          planOrchestrationTask(
            buildRequest({
              startPointBranch: 'feature/missing-start-point',
            })
          ),
        'invalid_orchestration_request',
        /startPointBranch "feature\/missing-start-point" does not exist in projectRoot/i
      );
    });

    it('accepts an existing worktree whose checked out branch matches the request', () => {
      createGitWorktree(testPaths.existingWorktreePath, 'feat/existing');

      expect(() =>
        planOrchestrationTask(
          buildRequest({
            lanes: [
              {
                id: 'lane-a',
                mode: 'shared-worktree',
                existingWorktree: {
                  slug: 'existing',
                  worktreePath: relativeToProject(testPaths.existingWorktreePath),
                  branchName: 'feat/existing',
                },
              },
            ],
          })
        )
      ).not.toThrow();
    });

    it('rejects an existing worktree whose checked out branch does not match the request', () => {
      createGitWorktree(testPaths.existingWorktreePath, 'feat/actual');

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
                    branchName: 'feat/expected',
                  },
                },
              ],
            })
          ),
        'invalid_orchestration_request',
        /existingWorktree\.branchName "feat\/expected" does not match checked out branch "feat\/actual"/i
      );
    });

    it('rejects a detached existing worktree', () => {
      createGitWorktree(testPaths.existingWorktreePath, 'feat/detached');
      detachGitWorktree(testPaths.existingWorktreePath);

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
                    branchName: 'feat/detached',
                  },
                },
              ],
            })
          ),
        'invalid_orchestration_request',
        /existingWorktree\.worktreePath .*detached or not a git worktree/i
      );
    });
  });
});
