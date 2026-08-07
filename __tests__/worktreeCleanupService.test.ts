import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { PsychePane } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const detectAllWorktreesMock = vi.hoisted(() => vi.fn());
const acquireWorktreeOperationLeaseMock = vi.hoisted(() => vi.fn());
const acquireProjectWorktreeLifecycleLeaseMock = vi.hoisted(() => vi.fn());
const mutateProjectPaneConfigMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
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

vi.mock('../src/services/WorktreeOperationLease.js', () => ({
  acquireWorktreeOperationLease: acquireWorktreeOperationLeaseMock,
  acquireProjectWorktreeLifecycleLease: acquireProjectWorktreeLifecycleLeaseMock,
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  mutateProjectPaneConfig: mutateProjectPaneConfigMock,
  readProjectPaneConfigUnderLock: readProjectPaneConfigUnderLockMock,
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
  let worktreeStatusOutput: string;
  let worktreeRemoveError: Error | undefined;
  let liveTmuxPanePaths: string;
  let liveTmuxQueryError: Error | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    worktreeMappings = new Map();
    branchOids = new Map();
    worktreeStatusOutput = '';
    worktreeRemoveError = undefined;
    liveTmuxPanePaths = '';
    liveTmuxQueryError = undefined;
    currentConfig = {
      projectRoot: '/test/project',
      panes: [],
    };
    mutateProjectPaneConfigMock.mockImplementation(async (
      _projectRoot: string,
      mutation: (config: typeof currentConfig) => unknown | Promise<unknown>,
    ) => {
      const result = await mutation(currentConfig);
      return { config: currentConfig, result };
    });
    readProjectPaneConfigUnderLockMock.mockImplementation(async () => currentConfig);
    readFileSyncMock.mockImplementation(() => JSON.stringify(currentConfig));
    detectAllWorktreesMock.mockReturnValue([]);
    acquireWorktreeOperationLeaseMock.mockImplementation(async ({
      worktreePath,
      projectRoot,
    }: {
      worktreePath: string;
      projectRoot?: string;
    }) => ({
      canonicalProjectRoot: projectRoot || '/test/project',
      canonicalWorktreePath: worktreePath,
      lockDir: '/test/project/.psyche/runtime/worktree-locks/test.lock',
      nonce: 'test-lease',
      release: async () => {},
    }));
    acquireProjectWorktreeLifecycleLeaseMock.mockImplementation(async ({
      projectRoot,
      worktreePath,
    }: {
      projectRoot?: string;
      worktreePath?: string;
    }) => ({
      canonicalProjectRoot: projectRoot || '/test/project',
      lockDir: `${projectRoot || '/test/project'}/.psyche/runtime/project-worktree-lifecycle.lock`,
      nonce: `project-lease-${worktreePath || 'root'}`,
      release: async () => {},
    }));

    execFileSyncMock.mockImplementation((command, args, options) => {
      if (command === 'tmux') {
        if (liveTmuxQueryError) {
          throw liveTmuxQueryError;
        }
        return liveTmuxPanePaths;
      }
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

      if (gitArgs[0] === 'status' && gitArgs[1] === '--porcelain=v1') {
        return worktreeStatusOutput;
      }

      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
        if (worktreeRemoveError) {
          throw worktreeRemoveError;
        }
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

  function createReusableWorktree(root: string, name: string): string {
    const worktreePath = join(root, name);
    mkdirSync(join(worktreePath, '.git'), { recursive: true });
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
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react/docs-ui'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react/theme-schemas'],
        cwd: '/test/project/theme-schemas',
      },
      {
        args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
        cwd: '/test/project',
      },
    ]));
    expect(worktreeRemovalCalls.at(-1)).toEqual({
      args: ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
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
    await service.cancelCleanupForWorktree('/test/project/.psyche/worktrees/react');
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

  it('lets a reuse reservation cancel cleanup before removal launches', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'reopen-me');
    configureCleanupIdentity(worktreePath);

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: {
        ...createCleanupPane(),
        worktreePath,
      },
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    const reservation = await service.beginWorktreeReuseReservation(worktreePath);
    reservation.cancel();
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.anything()
    );
  });

  it('keeps cleanup queued during a reuse reservation invalid after pane persistence', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'reopen-me');
    configureCleanupIdentity(worktreePath);

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    let continuePersistence!: () => void;
    let signalBeforePersistence!: () => void;
    const beforePersistence = new Promise<void>((resolve) => {
      signalBeforePersistence = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      continuePersistence = resolve;
    });

    const reuse = service.withWorktreeReuseReservation(
      worktreePath,
      async (canonicalWorktreePath: string) => {
        service.enqueueCleanup({
          pane: {
            ...createCleanupPane(),
            worktreePath: canonicalWorktreePath,
          },
          paneProjectRoot: '/test/project',
          mainRepoPath: '/test/project',
          configPath: '/test/project/.psyche/psyche.config.json',
          currentProjectRoot: '/test/project',
          deleteBranch: true,
        });
        signalBeforePersistence();
        await persistence;
      }
    );

    await beforePersistence;
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.anything()
    );

    continuePersistence();
    await reuse;
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('actively reserved for reuse'),
      'paneActions',
      'psyche-1'
    );
  });

  it('releases a failed reuse reservation so a later cleanup can remove an inactive worktree', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'save-failed');
    configureCleanupIdentity(worktreePath);

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    await expect(
      service.withWorktreeReuseReservation(worktreePath, async () => {
        throw new Error('pane save failed');
      })
    ).rejects.toThrow('pane save failed');

    service.enqueueCleanup({
      pane: {
        ...createCleanupPane(),
        worktreePath,
      },
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    await service.cleanupQueue;

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: '/test/project' })
    );
  });

  it('makes reuse wait for a launched cleanup and reject a removed worktree', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'removed-before-reopen');
    configureCleanupIdentity(worktreePath);

    let child!: MockChildProcess;
    let signalRemovalLaunched!: () => void;
    const removalLaunched = new Promise<void>((resolve) => {
      signalRemovalLaunched = resolve;
    });
    spawnMock.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
        child = new EventEmitter() as MockChildProcess;
        child.stderr = new EventEmitter();
        signalRemovalLaunched();
        return child;
      }
      return createSuccessfulChildProcess();
    });

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueueCleanup({
      pane: {
        ...createCleanupPane(),
        worktreePath,
      },
      paneProjectRoot: '/test/project',
      mainRepoPath: '/test/project',
      configPath: '/test/project/.psyche/psyche.config.json',
      currentProjectRoot: '/test/project',
      deleteBranch: true,
    });
    await removalLaunched;

    const reusePromise = service.beginWorktreeReuseReservation(worktreePath);
    let reuseSettled = false;
    void reusePromise.then(
      () => {
        reuseSettled = true;
      },
      () => {
        reuseSettled = true;
      }
    );
    await Promise.resolve();
    expect(reuseSettled).toBe(false);

    worktreeMappings.get('/test/project')?.delete(resolve(worktreePath));
    rmSync(worktreePath, { recursive: true, force: true });
    child.emit('close', 0);

    await expect(reusePromise).rejects.toThrow('no longer available for reuse');
    await service.cleanupQueue;
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
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
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
    await service.cancelCleanupForWorktree(realWorktreePath);
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

  it('shares a generation key between planned symlink and real cleanup paths', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const realRoot = join(cleanupRoot, 'real-worktrees');
    const symlinkRoot = join(cleanupRoot, 'worktrees-alias');
    mkdirSync(realRoot);
    symlinkSync(realRoot, symlinkRoot);
    const realPlannedPath = join(realRoot, 'new-worktree');
    const symlinkPlannedPath = join(symlinkRoot, 'new-worktree');
    const canonicalPlannedPath = join(realpathSync.native(realRoot), 'new-worktree');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    const symlinkReservation = await service.beginWorktreeCreation(
      symlinkPlannedPath,
      '/test/project',
    );
    expect(symlinkReservation.canonicalWorktreePath).toBe(canonicalPlannedPath);
    await symlinkReservation.cancel();

    await service.cancelCleanupForWorktree(realPlannedPath);

    expect(service.cleanupGenerations).toEqual(
      new Map([[canonicalPlannedPath, 2]]),
    );
    expect(acquireWorktreeOperationLeaseMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        worktreePath: canonicalPlannedPath,
        operation: 'create',
      }),
    );
  });

  it('acquires the project lifecycle lease before an exact creation lease', async () => {
    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    const reservation = await service.beginWorktreeCreation(
      '/test/project/.psyche/worktrees/ordered',
      '/test/project',
    );

    expect(acquireProjectWorktreeLifecycleLeaseMock.mock.invocationCallOrder[0])
      .toBeLessThan(acquireWorktreeOperationLeaseMock.mock.invocationCallOrder[0]);
    await reservation.cancel();
  });

  it('removes the validated canonical target when a queued symlink is retargeted', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const originalTarget = join(cleanupRoot, 'original-worktree');
    const retargetedTarget = join(cleanupRoot, 'replacement-worktree');
    const symlinkWorktreePath = join(cleanupRoot, 'worktree-alias');
    mkdirSync(originalTarget);
    mkdirSync(retargetedTarget);
    symlinkSync(originalTarget, symlinkWorktreePath);
    configureCleanupIdentity(originalTarget);

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
    rmSync(symlinkWorktreePath);
    symlinkSync(retargetedTarget, symlinkWorktreePath);
    await service.cleanupQueue;

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', originalTarget],
      expect.objectContaining({ cwd: '/test/project' })
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', retargetedTarget],
      expect.anything()
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
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
      expect.anything()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('current config still references'),
      'paneActions',
      'psyche-1'
    );
  });

  it('keeps a managed worktree when a tracked manual shell cwd is inside it', async () => {
    configureCleanupIdentity();
    const worktreePath = '/test/project/.psyche/worktrees/react';
    currentConfig.panes = [{
      id: 'shell-in-worktree',
      slug: 'shell-1',
      prompt: '',
      paneId: '%9',
      type: 'shell',
      cwdReference: `${worktreePath}/src/components`,
    }];

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.anything(),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('current config still references'),
      'paneActions',
      'psyche-1',
    );
  });

  it('does not let a shell elsewhere block managed worktree cleanup', async () => {
    configureCleanupIdentity();
    currentConfig.panes = [{
      id: 'shell-elsewhere',
      slug: 'shell-2',
      prompt: '',
      paneId: '%10',
      type: 'shell',
      cwdReference: '/test/project/.psyche/worktrees/other/src',
    }];

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
      expect.objectContaining({ cwd: '/test/project' }),
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
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
      expect.objectContaining({ cwd: '/test/project' })
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'react'],
      expect.objectContaining({ cwd: '/test/project' })
    );
  });

  it('refuses cleanup when an untracked pane changed cwd inside the target worktree', async () => {
    configureCleanupIdentity();
    liveTmuxPanePaths = '%untracked\t@42\t/test/project/.psyche/worktrees/react/src\n';

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
      expect.anything(),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('live tmux pane(s) still use the worktree'),
      'paneActions',
      'psyche-1',
    );
  });

  it('refuses cleanup when a detached dev or test window still has the target cwd', async () => {
    configureCleanupIdentity();
    liveTmuxPanePaths = '%background\t@dev\t/test/project/.psyche/worktrees/react\n';

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses cleanup when the global tmux cwd query is unknown', async () => {
    configureCleanupIdentity();
    liveTmuxQueryError = new Error('tmux unavailable');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not query live tmux pane paths'),
      'paneActions',
      'psyche-1',
    );
  });

  it('rolls back only a newly created worktree and branch with matching identities', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();

    const result = await service.rollbackCreatedWorktree({
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

  it('checks rollback references with the read-only config lease', async () => {
    configureCleanupIdentity();

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();

    const result = await service.rollbackCreatedWorktree({
      worktreePath: '/test/project/.psyche/worktrees/react',
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result).toEqual({ success: true });
    expect(readProjectPaneConfigUnderLockMock).toHaveBeenCalledWith('/test/project');
    expect(mutateProjectPaneConfigMock).not.toHaveBeenCalled();
  });

  it('lets non-forced git removal atomically preserve a dirty rollback target', async () => {
    configureCleanupIdentity();
    worktreeRemoveError = new Error('contains modified or untracked files');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();
    const worktreePath = '/test/project/.psyche/worktrees/react';

    const result = await service.rollbackCreatedWorktree({
      worktreePath,
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result).toEqual({
      success: false,
      error: `failed to remove newly created worktree; preserved worktree and branch at ${worktreePath}: contains modified or untracked files`,
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: '/test/project' }),
    );
    expect(
      worktreeMappings.get('/test/project')?.get(resolve(worktreePath))
    ).toBe('react');
    expect(branchOids.get('/test/project')).toBe('abc123');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(worktreePath),
      'paneActions',
    );
  });

  it('preserves an ignored .env when Git refuses non-forced rollback', async () => {
    configureCleanupIdentity();
    const worktreePath = '/test/project/.psyche/worktrees/react';
    worktreeRemoveError = new Error('worktree contains ignored .env');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const result = await WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
      worktreePath,
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('preserved worktree and branch');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.anything(),
    );
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['status']),
      expect.anything(),
    );
    expect(branchOids.get('/test/project')).toBe('abc123');
  });

  it('lets Git reject a write that races after any local cleanliness observation', async () => {
    configureCleanupIdentity();
    const worktreePath = '/test/project/.psyche/worktrees/react';
    // The write happens after all identity checks. There is intentionally no
    // status precheck to race: non-forced worktree remove is the final guard.
    worktreeRemoveError = new Error('worktree became dirty during rollback');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const result = await WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
      worktreePath,
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result.success).toBe(false);
    expect(worktreeMappings.get('/test/project')?.get(resolve(worktreePath))).toBe('react');
    expect(branchOids.get('/test/project')).toBe('abc123');
  });

  it('preserves a dirty background cleanup target and does not delete its branch', async () => {
    configureCleanupIdentity();
    spawnMock.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      const child = new EventEmitter() as MockChildProcess;
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
          child.stderr?.emit('data', 'worktree contains modified files');
          child.emit('close', 1);
          return;
        }
        child.emit('close', 0);
      });
      return child;
    });

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    await enqueueAndWait(service);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
      expect.anything(),
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'react'],
      expect.anything(),
    );
    expect(worktreeMappings.get('/test/project')?.get(
      resolve('/test/project/.psyche/worktrees/react'),
    )).toBe('react');
    expect(branchOids.get('/test/project')).toBe('abc123');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Worktree removal preserved'),
      'paneActions',
      'psyche-1',
    );
  });

  it('leaves a newly created worktree intact when its branch identity changes', async () => {
    configureCleanupIdentity();
    branchOids.set('/test/project', 'moved-oid');

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance();

    const result = await service.rollbackCreatedWorktree({
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
      { args: ['worktree', 'remove', realpathSync.native(older)], cwd: projectRoot },
      { args: ['worktree', 'remove', realpathSync.native(middle)], cwd: projectRoot },
    ]);
    expect(gitCalls).not.toContainEqual({
      args: ['worktree', 'remove', realpathSync.native(active)],
      cwd: projectRoot,
    });
    expect(gitCalls).not.toContainEqual({
      args: ['worktree', 'remove', realpathSync.native(newest)],
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
      ['worktree', 'remove', realpathSync.native(old)],
      expect.anything()
    );
  });

  it('rechecks current config before removing a delayed managed prune target', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-prune-'));
    tempDirs.push(projectRoot);
    const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
    createManagedWorktree(projectRoot, 'newer', new Date('2026-01-02T00:00:00Z'));
    mkdirSync(join(older, '.git'));
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    const prunePromise = service.runPruneManagedWorktrees({
      projectRoot,
      activePanes: [],
      configPath: join(projectRoot, '.psyche', 'psyche.config.json'),
      maxManagedWorktrees: 1,
    });
    currentConfig.panes = [
      {
        id: 'reopened-pane',
        slug: 'older',
        prompt: '',
        paneId: '%4',
        worktreePath: older,
      },
    ];
    await prunePromise;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', older],
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('current config still references it'),
      'paneActions'
    );
  });

  it('skips a delayed managed prune when reopen advances its generation', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-prune-'));
    tempDirs.push(projectRoot);
    const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
    createManagedWorktree(projectRoot, 'newer', new Date('2026-01-02T00:00:00Z'));
    mkdirSync(join(older, '.git'));
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    const pruneJob = {
      projectRoot,
      activePanes: [],
      configPath: join(projectRoot, '.psyche', 'psyche.config.json'),
      maxManagedWorktrees: 1,
    };
    const pruneTargets = service.getManagedWorktreePruneTargets(pruneJob);
    const blockingReservation = await service.beginWorktreeReuseReservation(older);
    const reopenReservationPromise = service.beginWorktreeReuseReservation(older);
    const prunePromise = service.runPruneManagedWorktrees(pruneJob, pruneTargets);

    blockingReservation.cancel();
    const reopenReservation = await reopenReservationPromise;
    reopenReservation.cancel();
    await prunePromise;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', older],
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('cleanup generation changed'),
      'paneActions'
    );
  });

  it('skips a prune target selected before reuse releases without config persistence', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-prune-'));
    tempDirs.push(projectRoot);
    const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
    createManagedWorktree(projectRoot, 'newer', new Date('2026-01-02T00:00:00Z'));
    mkdirSync(join(older, '.git'));
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    service.enqueuePruneManagedWorktrees({
      projectRoot,
      activePanes: [],
      configPath: join(projectRoot, '.psyche', 'psyche.config.json'),
      maxManagedWorktrees: 1,
    });
    const prunePromise = service.cleanupQueue;
    const reuseReservation = await service.beginWorktreeReuseReservation(older);

    reuseReservation.cancel();
    await prunePromise;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', older],
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('cleanup generation changed'),
      'paneActions'
    );
  });

  it('keeps a prune queued during a reuse reservation invalid after pane persistence', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-prune-'));
    tempDirs.push(projectRoot);
    const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
    createManagedWorktree(projectRoot, 'newer', new Date('2026-01-02T00:00:00Z'));
    mkdirSync(join(older, '.git'));
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    let continuePersistence!: () => void;
    let signalBeforePersistence!: () => void;
    const beforePersistence = new Promise<void>((resolve) => {
      signalBeforePersistence = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      continuePersistence = resolve;
    });

    const reuse = service.withWorktreeReuseReservation(older, async () => {
      service.enqueuePruneManagedWorktrees({
        projectRoot,
        activePanes: [],
        configPath: join(projectRoot, '.psyche', 'psyche.config.json'),
        maxManagedWorktrees: 1,
      });
      signalBeforePersistence();
      await persistence;
    });

    await beforePersistence;
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', older],
      expect.anything()
    );

    continuePersistence();
    await reuse;
    await service.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', older],
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('actively reserved for reuse'),
      'paneActions'
    );
  });
});
