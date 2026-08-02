import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PsychePane } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const detectAllWorktreesMock = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../src/utils/hooks.js', () => ({
  triggerHook: triggerHookMock,
}));

vi.mock('../src/utils/worktreeDiscovery.js', () => ({
  detectAllWorktrees: detectAllWorktreesMock,
}));

vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => logger),
  },
}));

type MockChildProcess = EventEmitter & { stderr: EventEmitter | null };

function createSuccessfulChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stderr = new EventEmitter();

  process.nextTick(() => {
    child.emit('close', 0);
  });

  return child;
}

describe('WorktreeCleanupService', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    spawnMock.mockImplementation(() => createSuccessfulChildProcess());
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  function createManagedWorktree(projectRoot: string, slug: string, mtime: Date): string {
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', slug);
    mkdirSync(join(worktreePath, '.psyche'), { recursive: true });
    utimesSync(worktreePath, mtime, mtime);
    return worktreePath;
  }

  it('removes nested worktrees and deletes the pane branch from every repo in a multi-repo workspace cleanup', async () => {
    detectAllWorktreesMock.mockReturnValue([
      {
        worktreePath: '/test/project/.psyche/worktrees/react',
        parentRepoPath: '/test/project',
        repoName: 'project',
        branch: 'react',
        mainBranch: 'main',
        isRoot: true,
        relativePath: '.',
        depth: 0,
      },
      {
        worktreePath: '/test/project/.psyche/worktrees/react/docs-ui',
        parentRepoPath: '/test/project/docs-ui',
        repoName: 'docs-ui',
        branch: 'react',
        mainBranch: 'main',
        isRoot: false,
        relativePath: 'docs-ui',
        depth: 1,
      },
      {
        worktreePath: '/test/project/.psyche/worktrees/react/theme-schemas',
        parentRepoPath: '/test/project/theme-schemas',
        repoName: 'theme-schemas',
        branch: 'react',
        mainBranch: 'main',
        isRoot: false,
        relativePath: 'theme-schemas',
        depth: 1,
      },
    ]);

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;

    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'react',
      branchName: 'react',
      prompt: '',
      paneId: '%1',
      worktreePath: '/test/project/.psyche/worktrees/react',
    };

    const service = WorktreeCleanupService.getInstance() as any;
    await service.runCleanup({
      pane,
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    const gitCalls = spawnMock.mock.calls.map((call) => ({
      args: call[1],
      cwd: call[2]?.cwd,
    }));

    const worktreeRemovalCalls = gitCalls.filter((call) => call.args[0] === 'worktree');
    expect(worktreeRemovalCalls).toEqual(expect.arrayContaining([
      {
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react/docs-ui', '--force'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react/theme-schemas', '--force'],
        cwd: '/test/project/theme-schemas',
      },
      {
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react', '--force'],
        cwd: '/test/project',
      },
    ]));
    expect(worktreeRemovalCalls.at(-1)).toEqual({
      args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react', '--force'],
      cwd: '/test/project',
    });

    expect(gitCalls).toEqual(expect.arrayContaining([
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/react'],
        cwd: '/test/project',
      },
      {
        args: ['branch', '-D', 'react'],
        cwd: '/test/project',
      },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/react'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['branch', '-D', 'react'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/react'],
        cwd: '/test/project/theme-schemas',
      },
      {
        args: ['branch', '-D', 'react'],
        cwd: '/test/project/theme-schemas',
      },
    ]));

    expect(triggerHookMock).toHaveBeenCalledWith('worktree_removed', '/test/project', pane);
  });

  it('prunes the oldest inactive managed worktrees when the configured cap is exceeded', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'psyche-prune-'));
    tempDirs.push(projectRoot);
    const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
    const middle = createManagedWorktree(projectRoot, 'middle', new Date('2026-01-02T00:00:00Z'));
    const active = createManagedWorktree(projectRoot, 'active', new Date('2026-01-03T00:00:00Z'));
    const newest = createManagedWorktree(projectRoot, 'newest', new Date('2026-01-04T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;

    const service = WorktreeCleanupService.getInstance() as any;
    await service.runPruneManagedWorktrees({
      projectRoot,
      activePanes: [
        {
          id: 'psyche-active',
          slug: 'active',
          prompt: '',
          paneId: '%2',
          worktreePath: active,
        },
      ],
      maxManagedWorktrees: 2,
    });

    const gitCalls = spawnMock.mock.calls.map((call) => ({
      args: call[1],
      cwd: call[2]?.cwd,
    }));

    expect(gitCalls).toEqual([
      { args: ['worktree', 'remove', older], cwd: projectRoot },
      { args: ['worktree', 'remove', middle], cwd: projectRoot },
    ]);
    expect(gitCalls).not.toContainEqual({
      args: ['worktree', 'remove', active],
      cwd: projectRoot,
    });
    expect(gitCalls).not.toContainEqual({
      args: ['worktree', 'remove', newest],
      cwd: projectRoot,
    });
  });

  it('does not prune when active panes already occupy the configured cap', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'psyche-prune-'));
    tempDirs.push(projectRoot);
    const old = createManagedWorktree(projectRoot, 'old', new Date('2026-01-01T00:00:00Z'));
    const activeA = createManagedWorktree(projectRoot, 'active-a', new Date('2026-01-02T00:00:00Z'));
    const activeB = createManagedWorktree(projectRoot, 'active-b', new Date('2026-01-03T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;

    const service = WorktreeCleanupService.getInstance() as any;
    await service.runPruneManagedWorktrees({
      projectRoot,
      activePanes: [
        { id: 'a', slug: 'active-a', prompt: '', paneId: '%1', worktreePath: activeA },
        { id: 'b', slug: 'active-b', prompt: '', paneId: '%2', worktreePath: activeB },
      ],
      maxManagedWorktrees: 2,
    });

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', old],
      expect.anything()
    );
  });
});
