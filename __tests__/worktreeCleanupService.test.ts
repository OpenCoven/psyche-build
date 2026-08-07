import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { PsychePane } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const detectAllWorktreesMock = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: readFileSyncMock,
  };
});

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
  let worktreeMappings: Map<string, Map<string, string>>;
  let branchOids: Map<string, string>;
  let currentConfig: { projectRoot: string; panes: PsychePane[] };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    worktreeMappings = new Map();
    branchOids = new Map();
    currentConfig = {
      projectRoot: '/test/project',
      panes: [],
    };
    readFileSyncMock.mockImplementation(() => JSON.stringify(currentConfig));
    detectAllWorktreesMock.mockReturnValue([]);

    execFileSyncMock.mockImplementation((_command, args, options) => {
      const gitArgs = args as string[];
      const cwd = String((options as { cwd?: string } | undefined)?.cwd || '');

      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'list') {
        const worktrees = worktreeMappings.get(cwd);
        return Array.from(worktrees?.entries() || [])
          .map(([worktreePath, branchName]) => (
            `worktree ${worktreePath}\nbranch refs/heads/${branchName}\n`
          ))
          .join('\n');
      }

      if (gitArgs[0] === 'rev-parse') {
        const oid = branchOids.get(cwd);
        if (!oid) {
          throw new Error(`No branch OID configured for ${cwd}`);
        }
        return `${oid}\n`;
      }

      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
        worktreeMappings.get(cwd)?.delete(resolve(gitArgs[2]));
        return '';
      }

      if (gitArgs[0] === 'branch' && gitArgs[1] === '-D') {
        branchOids.delete(cwd);
        return '';
      }

      throw new Error(`Unexpected synchronous git command: git ${gitArgs.join(' ')}`);
    });

    spawnMock.mockImplementation((_command, args, options) => {
      const gitArgs = args as string[];
      const cwd = String((options as { cwd?: string } | undefined)?.cwd || '');
      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
        worktreeMappings.get(cwd)?.delete(resolve(gitArgs[2]));
      }
      return createSuccessfulChildProcess();
    });
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

  function configureCleanupIdentity(
    worktreePath = '/test/project/.psyche/worktrees/react',
    branchName = 'react',
    branchOid = 'abc123'
  ): void {
    worktreeMappings.set('/test/project', new Map([
      [resolve(worktreePath), branchName],
    ]));
    branchOids.set('/test/project', branchOid);
  }

  function createCleanupPane(): PsychePane {
    return {
      id: 'psyche-1',
      slug: 'react',
      branchName: 'react',
      prompt: '',
      paneId: '%1',
      worktreePath: '/test/project/.psyche/worktrees/react',
    };
  }

  async function enqueueAndWait(
    service: {
      enqueueCleanup: (job: {
        pane: PsychePane;
        paneProjectRoot: string;
        mainRepoPath: string;
        configPath: string;
        currentProjectRoot: string;
        deleteBranch: boolean;
      }) => void;
      cleanupQueue: Promise<void>;
    },
    deleteBranch = true
  ): Promise<void> {
    service.enqueueCleanup({
      pane: createCleanupPane(),
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch,
    });
    await service.cleanupQueue;
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
    worktreeMappings.set('/test/project', new Map([
      ['/test/project/.psyche/worktrees/react', 'react'],
    ]));
    worktreeMappings.set('/test/project/docs-ui', new Map([
      ['/test/project/.psyche/worktrees/react/docs-ui', 'react'],
    ]));
    worktreeMappings.set('/test/project/theme-schemas', new Map([
      ['/test/project/.psyche/worktrees/react/theme-schemas', 'react'],
    ]));
    branchOids.set('/test/project', 'abc123');
    branchOids.set('/test/project/docs-ui', 'abc123');
    branchOids.set('/test/project/theme-schemas', 'abc123');

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
    service.enqueueCleanup({
      pane,
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    await service.cleanupQueue;

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
        args: ['branch', '-D', 'react'],
        cwd: '/test/project',
      },
      {
        args: ['branch', '-D', 'react'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['branch', '-D', 'react'],
        cwd: '/test/project/theme-schemas',
      },
    ]));

    expect(triggerHookMock).toHaveBeenCalledWith('worktree_removed', '/test/project', pane);
  });

  it('skips a delayed cleanup after the worktree is reopened', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: createCleanupPane(),
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    service.cancelCleanupForWorktree('/test/project/.psyche/worktrees/react');
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.anything()
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch', '-D']),
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cleanup was canceled'),
      'paneActions',
      'psyche-1'
    );
  });

  it('skips cleanup when the branch no longer points to its queued OID', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: createCleanupPane(),
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    branchOids.set('/test/project', 'moved-oid');
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react', '--force'],
      expect.anything()
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'react'],
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('branch OID changed'),
      'paneActions',
      'psyche-1'
    );
  });

  it('cancels cleanup queued through a symlink when reopening its real path', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const realWorktreePath = join(cleanupRoot, 'real-worktree');
    const symlinkWorktreePath = join(cleanupRoot, 'worktree-alias');
    mkdirSync(realWorktreePath);
    symlinkSync(realWorktreePath, symlinkWorktreePath);
    configureCleanupIdentity(realWorktreePath);

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: {
        ...createCleanupPane(),
        worktreePath: symlinkWorktreePath,
      },
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    service.cancelCleanupForWorktree(realWorktreePath);
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cleanup was canceled'),
      'paneActions',
      'psyche-1'
    );
  });

  it('skips cleanup while the current config references the worktree', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: createCleanupPane(),
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    currentConfig.panes = [createCleanupPane()];
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react', '--force'],
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('current config still references'),
      'paneActions',
      'psyche-1'
    );
  });

  it('deletes an unchanged worktree and branch after verification', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    await enqueueAndWait(service);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react', '--force'],
      expect.objectContaining({ cwd: '/test/project' })
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'react'],
      expect.objectContaining({ cwd: '/test/project' })
    );
  });

  it('rolls back only a newly created worktree and branch with matching identities', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();

    const result = service.rollbackCreatedWorktree({
      worktreePath: '/test/project/.psyche/worktrees/react',
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result).toEqual({ success: true });
    expect(
      worktreeMappings.get('/test/project')?.has(
        resolve('/test/project/.psyche/worktrees/react')
      )
    ).toBe(false);
    expect(branchOids.has('/test/project')).toBe(false);
  });

  it('leaves a newly created worktree intact when its branch identity changes', async () => {
    configureCleanupIdentity();
    branchOids.set('/test/project', 'moved-oid');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();

    const result = service.rollbackCreatedWorktree({
      worktreePath: '/test/project/.psyche/worktrees/react',
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(
      worktreeMappings.get('/test/project')?.get(
        resolve('/test/project/.psyche/worktrees/react')
      )
    ).toBe('react');
    expect(branchOids.get('/test/project')).toBe('moved-oid');
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
