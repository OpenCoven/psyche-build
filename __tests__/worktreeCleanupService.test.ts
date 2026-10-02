import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import type { PsychePane } from '../src/types.js';

// `fs.readFileSync` is mocked for config reads; evidence uses the real one.
const actualFs = vi.hoisted(() => ({ current: undefined as undefined | typeof import('fs') }));
const readFileSyncActual = (file: string): string => actualFs.current!.readFileSync(file, 'utf8');

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const detectAllWorktreesMock = vi.hoisted(() => vi.fn());
const acquireWorktreeOperationLeaseMock = vi.hoisted(() => vi.fn());
const acquireProjectWorktreeLifecycleLeaseMock = vi.hoisted(() => vi.fn());
const mutateProjectPaneConfigMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
const writeWorktreeRecoveryMarkerMock = vi.hoisted(() => vi.fn());
const findBlockingOverride = vi.hoisted(() => ({
  current: undefined as undefined | { blocked: boolean; reason?: string },
}));
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
  actualFs.current = actual;
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

vi.mock('../src/services/WorktreeRecoveryMarker.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/WorktreeRecoveryMarker.js')>(
    '../src/services/WorktreeRecoveryMarker.js',
  );
  return {
    ...actual,
    writeWorktreeRecoveryMarker: writeWorktreeRecoveryMarkerMock,
    findBlockingWorktreeRecoveryMarker: (
      ...args: Parameters<typeof actual.findBlockingWorktreeRecoveryMarker>
    ) => findBlockingOverride.current ?? actual.findBlockingWorktreeRecoveryMarker(...args),
  };
});

type MockChildProcess = EventEmitter & {
  stderr: EventEmitter | null;
  pid?: number;
  kill?: () => void;
};

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
  let branchAdvanceBeforeDelete: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    worktreeMappings = new Map();
    branchOids = new Map();
    worktreeStatusOutput = '';
    worktreeRemoveError = undefined;
    liveTmuxPanePaths = '';
    liveTmuxQueryError = undefined;
    branchAdvanceBeforeDelete = undefined;
    findBlockingOverride.current = undefined;
    writeWorktreeRecoveryMarkerMock.mockImplementation(async (request: {
      worktreePath: string;
    }) => ({
      marker: { id: 'partial-removal-marker', worktreePath: request.worktreePath },
      path: '/test/project/.psyche/runtime/worktree-recovery/partial-removal-marker.json',
      state: 'complete',
    }));
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
    readFileSyncMock.mockImplementation((file: unknown, ...rest: unknown[]) => (
      // Git link files are real fixtures; everything else is the mocked config.
      String(file).endsWith(`${sep}.git`)
        ? (actualFs.current!.readFileSync as (...args: unknown[]) => unknown)(file, ...rest)
        : JSON.stringify(currentConfig)
    ));
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
      const child = new EventEmitter() as MockChildProcess;
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
          if (worktreeRemoveError) {
            child.stderr?.emit('data', worktreeRemoveError.message);
            child.emit('close', 1);
            return;
          }
          worktreeMappings.get(cwd)?.delete(resolve(gitArgs[2]));
        }
        if (gitArgs[0] === 'branch' && gitArgs[1] === '-D') {
          if (branchAdvanceBeforeDelete) {
            branchOids.set(cwd, branchAdvanceBeforeDelete);
          }
          branchOids.delete(cwd);
        }
        if (gitArgs[0] === 'update-ref' && gitArgs[1] === '-d') {
          if (branchAdvanceBeforeDelete) {
            branchOids.set(cwd, branchAdvanceBeforeDelete);
          }
          const expectedOid = gitArgs[3];
          if (branchOids.get(cwd) !== expectedOid) {
            child.stderr?.emit('data', 'cannot lock ref: is at a different OID');
            child.emit('close', 1);
            return;
          }
          branchOids.delete(cwd);
        }
        child.emit('close', 0);
      });
      return child;
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
        args: ['update-ref', '-d', 'refs/heads/react', 'abc123'],
        cwd: '/test/project',
      },
      {
        args: ['update-ref', '-d', 'refs/heads/react', 'abc123'],
        cwd: '/test/project/docs-ui',
      },
      {
        args: ['update-ref', '-d', 'refs/heads/react', 'abc123'],
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
      expect.arrayContaining(['update-ref', '-d']),
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

  it('settles a retained reuse reservation when its exact recovery marker is acknowledged', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'retained');
    const operationRelease = vi.fn(async () => {});
    const projectRelease = vi.fn(async () => {});
    acquireWorktreeOperationLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      canonicalWorktreePath: worktreePath,
      lockDir: join(cleanupRoot, '.psyche/runtime/worktree.lock'),
      nonce: 'operation-generation',
      release: operationRelease,
    });
    acquireProjectWorktreeLifecycleLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      lockDir: join(cleanupRoot, '.psyche/runtime/project.lock'),
      nonce: 'project-generation',
      release: projectRelease,
    });
    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const reservation = await WorktreeCleanupService.getInstance()
      .beginWorktreeReuseReservation(worktreePath, cleanupRoot);
    const markerPath = join(cleanupRoot, '.psyche', 'runtime', 'marker-generation.json');
    mkdirSync(join(cleanupRoot, '.psyche', 'runtime'), { recursive: true });
    writeFileSync(markerPath, '{}');

    const retained = reservation.retain() as unknown as {
      associateRecoveryMarker: (marker: { path: string; generation: string }) => void;
    };
    expect(retained).toEqual(expect.objectContaining({
      associateRecoveryMarker: expect.any(Function),
    }));
    retained.associateRecoveryMarker({
      path: markerPath,
      generation: 'incident-generation',
    });
    await reservation.cancel();
    expect(operationRelease).not.toHaveBeenCalled();

    rmSync(markerPath);
    const deadline = Date.now() + 1_000;
    while (!operationRelease.mock.calls.length && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(operationRelease).toHaveBeenCalledOnce();
    expect(projectRelease).toHaveBeenCalledOnce();
  });

  it('retries and logs retained reservation settlement failures without an unhandled rejection', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'retained-retry');
    const operationRelease = vi.fn()
      .mockRejectedValueOnce(new Error('transient release failure'))
      .mockResolvedValue(undefined);
    acquireWorktreeOperationLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      canonicalWorktreePath: worktreePath,
      lockDir: join(cleanupRoot, '.psyche/runtime/worktree.lock'),
      nonce: 'operation-generation',
      release: operationRelease,
    });
    acquireProjectWorktreeLifecycleLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      lockDir: join(cleanupRoot, '.psyche/runtime/project.lock'),
      nonce: 'project-generation',
      release: vi.fn(async () => {}),
    });
    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const reservation = await WorktreeCleanupService.getInstance()
      .beginWorktreeReuseReservation(worktreePath, cleanupRoot);
    const markerPath = join(cleanupRoot, '.psyche', 'runtime', 'retry-marker.json');
    mkdirSync(join(cleanupRoot, '.psyche', 'runtime'), { recursive: true });
    writeFileSync(markerPath, '{}');
    const retained = reservation.retain() as unknown as {
      associateRecoveryMarker: (marker: { path: string; generation: string }) => void;
    };
    retained.associateRecoveryMarker({
      path: markerPath,
      generation: 'incident-generation',
    });
    rmSync(markerPath);

    const deadline = Date.now() + 1_000;
    while (operationRelease.mock.calls.length < 2 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(operationRelease).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('transient release failure'),
      'paneActions',
    );
  });

  it('uses unrefed backoff timers for persistent retained settlement failures', async () => {
    const cleanupRoot = mkdtempSync(join(process.cwd(), '.psyche-cleanup-test-'));
    tempDirs.push(cleanupRoot);
    const worktreePath = createReusableWorktree(cleanupRoot, 'retained-backoff');
    const operationRelease = vi.fn(async () => {
      throw new Error('persistent release failure');
    });
    acquireWorktreeOperationLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      canonicalWorktreePath: worktreePath,
      lockDir: join(cleanupRoot, '.psyche/runtime/worktree.lock'),
      nonce: 'operation-generation',
      release: operationRelease,
    });
    acquireProjectWorktreeLifecycleLeaseMock.mockResolvedValueOnce({
      canonicalProjectRoot: cleanupRoot,
      lockDir: join(cleanupRoot, '.psyche/runtime/project.lock'),
      nonce: 'project-generation',
      release: vi.fn(async () => {}),
    });
    const timeoutHandles: NodeJS.Timeout[] = [];
    const originalSetTimeout = global.setTimeout;
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(callback, delay, ...args);
      if ((delay || 0) >= 50) timeoutHandles.push(handle);
      return handle;
    }) as typeof setTimeout);
    try {
      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const reservation = await WorktreeCleanupService.getInstance()
        .beginWorktreeReuseReservation(worktreePath, cleanupRoot);
      const markerPath = join(cleanupRoot, '.psyche', 'runtime', 'backoff-marker.json');
      mkdirSync(join(cleanupRoot, '.psyche', 'runtime'), { recursive: true });
      writeFileSync(markerPath, '{}');
      const retained = reservation.retain() as unknown as {
        associateRecoveryMarker: (marker: { path: string; generation: string }) => void;
      };
      retained.associateRecoveryMarker({
        path: markerPath,
        generation: 'incident-generation',
      });
      rmSync(markerPath);

      await new Promise((resolveWait) => originalSetTimeout(resolveWait, 260));
      expect(operationRelease.mock.calls.length).toBeLessThanOrEqual(3);
      expect(timeoutHandles.length).toBeGreaterThan(0);
      expect(timeoutHandles.every((handle) => !handle.hasRef())).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
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
      ['update-ref', '-d', 'refs/heads/react', 'abc123'],
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
      ['update-ref', '-d', 'refs/heads/react', 'abc123'],
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

  it.each([
    'no server running on /private/tmp/tmux-501/default',
    'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
  ])('treats "%s" as confirmation that no tmux pane can block rollback', async (stderr) => {
    configureCleanupIdentity();
    liveTmuxQueryError = Object.assign(new Error('tmux exited'), {
      status: 1,
      stderr,
    });

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const result = await WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
      worktreePath: '/test/project/.psyche/worktrees/react',
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result).toEqual({ success: true });
    expect(
      worktreeMappings.get('/test/project')?.has(
        resolve('/test/project/.psyche/worktrees/react'),
      ),
    ).toBe(false);
  });

  it('preserves a rollback branch that advances after validation but before deletion', async () => {
    configureCleanupIdentity();
    branchAdvanceBeforeDelete = 'advanced-oid';
    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;

    const result = await WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
      worktreePath: '/test/project/.psyche/worktrees/react',
      branchName: 'react',
      branchOid: 'abc123',
      mainRepoPath: '/test/project',
      deleteBranch: true,
    });

    expect(result.success).toBe(false);
    expect(branchOids.get('/test/project')).toBe('advanced-oid');
  });

  it('preserves a cleanup branch that advances after validation but before deletion', async () => {
    configureCleanupIdentity();
    branchAdvanceBeforeDelete = 'advanced-oid';
    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;

    await enqueueAndWait(service);

    expect(branchOids.get('/test/project')).toBe('advanced-oid');
  });

  it('tracks destructive Git children in both filesystem leases until close', async () => {
    configureCleanupIdentity();
    const lifecycle = {
      trackChildProcess: vi.fn(async (pid: number) => ({
        pid,
        processStartIdentity: 'project-child-start',
      })),
      clearChildProcess: vi.fn(async () => {}),
    };
    const worktree = {
      trackChildProcess: vi.fn(async (pid: number) => ({
        pid,
        processStartIdentity: 'worktree-child-start',
      })),
      clearChildProcess: vi.fn(async () => {}),
    };
    acquireProjectWorktreeLifecycleLeaseMock.mockResolvedValue({
      canonicalProjectRoot: '/test/project',
      lockDir: '/test/project/.psyche/runtime/project-worktree-lifecycle.lock',
      nonce: 'project-lease',
      release: async () => {},
      ...lifecycle,
    });
    acquireWorktreeOperationLeaseMock.mockResolvedValue({
      canonicalProjectRoot: '/test/project',
      canonicalWorktreePath: '/test/project/.psyche/worktrees/react',
      lockDir: '/test/project/.psyche/runtime/worktree-locks/test.lock',
      nonce: 'worktree-lease',
      release: async () => {},
      ...worktree,
    });

    let closeChild!: () => void;
    spawnMock.mockImplementation((_command, args, options) => {
      expect(options).toMatchObject({ shell: false });
      const child = new EventEmitter() as MockChildProcess;
      child.pid = 4242;
      child.stderr = new EventEmitter();
      closeChild = () => {
        const gitArgs = args as string[];
        worktreeMappings.get('/test/project')?.delete(resolve(gitArgs[2]));
        child.emit('close', 0);
      };
      return child;
    });

    const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
    (WorktreeCleanupService as any).instance = undefined;
    const service = WorktreeCleanupService.getInstance() as any;
    const running = enqueueAndWait(service, false);

    await vi.waitFor(() => {
      expect(lifecycle.trackChildProcess).toHaveBeenCalledWith(4242);
      expect(worktree.trackChildProcess).toHaveBeenCalledWith(4242);
    });
    expect(lifecycle.clearChildProcess).not.toHaveBeenCalled();
    expect(worktree.clearChildProcess).not.toHaveBeenCalled();

    closeChild();
    await running;

    expect(lifecycle.clearChildProcess).toHaveBeenCalledWith({
      pid: 4242,
      processStartIdentity: 'project-child-start',
    });
    expect(worktree.clearChildProcess).toHaveBeenCalledWith({
      pid: 4242,
      processStartIdentity: 'worktree-child-start',
    });
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
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: '/test/project', shell: false }),
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
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ shell: false }),
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
      ['update-ref', '-d', 'refs/heads/react', 'abc123'],
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
  describe('partial Git removal', () => {
    const ADMIN_LINK = 'gitdir: /test/project/.git/worktrees/react\n';

    function createHalfRemovedWorktree(options: { gitLink?: string }): string {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-partial-removal-')));
      tempDirs.push(root);
      const worktreePath = join(root, 'react');
      mkdirSync(join(worktreePath, 'locked'), { recursive: true });
      writeFileSync(join(worktreePath, 'locked', 'survivor.txt'), 'remaining user file\n');
      if (options.gitLink !== undefined) {
        writeFileSync(join(worktreePath, '.git'), options.gitLink);
      }
      return worktreePath;
    }

    function failRemovalAfterGitBeganWriting(options: {
      dropRegistration: boolean;
      message: string;
      afterRemoval?: () => void;
    }) {
      spawnMock.mockImplementation((_command, args, spawnOptions) => {
        const gitArgs = args as string[];
        const cwd = String((spawnOptions as { cwd?: string } | undefined)?.cwd || '');
        const child = new EventEmitter() as MockChildProcess;
        child.stderr = new EventEmitter();
        process.nextTick(() => {
          if (gitArgs[0] === 'worktree' && gitArgs[1] === 'remove') {
            // Real Git deletes the administrative entry even after it failed
            // to delete the whole tree: "there's no going back from here".
            if (options.dropRegistration) {
              worktreeMappings.get(cwd)?.delete(resolve(gitArgs[2]));
            }
            options.afterRemoval?.();
            child.stderr?.emit('data', options.message);
            child.emit('close', 255);
            return;
          }
          child.emit('close', 0);
        });
        return child;
      });
    }

    function failWorktreeListing(): void {
      const previous = execFileSyncMock.getMockImplementation()!;
      execFileSyncMock.mockImplementation((command, args, options) => {
        const gitArgs = args as string[];
        if (command === 'git' && gitArgs[0] === 'worktree' && gitArgs[1] === 'list') {
          throw new Error('fatal: not a git repository');
        }
        return previous(command, args, options);
      });
    }

    async function enqueuePaneAt(worktreePath: string): Promise<any> {
      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const service = WorktreeCleanupService.getInstance() as any;
      service.enqueueCleanup({
        pane: { ...createCleanupPane(), worktreePath },
        paneProjectRoot: '/test/project',
        mainRepoPath: '/test/project',
        configPath: '/test/project/.psyche/psyche.config.json',
        currentProjectRoot: '/test/project',
        deleteBranch: true,
      });
      await service.cleanupQueue;
      return service;
    }

    function markerReason(): string {
      return String(writeWorktreeRecoveryMarkerMock.mock.calls[0]?.[0]?.reason);
    }

    it('classifies only evidenced removals as partially removed', async () => {
      const { classifyWorktreeRemovalState: classify } = await import('../src/services/WorktreeCleanupService.js');
      const base = { registered: false, directoryPresent: true, gitLink: 'other' as const };
      expect(classify({ ...base, directoryPresent: false })).toBe('removed');
      expect(classify({ ...base, registered: true, directoryPresent: false })).toBe('registration_only');
      expect(classify({ ...base, registered: true })).toBe('intact');
      expect(classify({ ...base, registered: true, gitLink: 'missing' })).toBe('partially_removed');
      expect(classify({ ...base, gitLink: 'orphaned' })).toBe('partially_removed');
      expect(classify({ ...base, removalObserved: true })).toBe('partially_removed');
      // No evidence a removal ran: a plain directory or a link elsewhere.
      expect(classify({ ...base, gitLink: 'missing' })).toBe('unregistered');
      expect(classify(base)).toBe('unregistered');
      expect(classify({ ...base, registered: undefined })).toBe('unknown');
    });

    it('reads a Git link as orphaned only when it names this repository\'s missing admin entry', async () => {
      const { inspectWorktreeGitLink } = await import('../src/services/WorktreeCleanupService.js');
      const otherRepo = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-other-repo-')));
      tempDirs.push(otherRepo);
      mkdirSync(join(otherRepo, '.git', 'worktrees', 'react'), { recursive: true });

      expect(inspectWorktreeGitLink(createHalfRemovedWorktree({ gitLink: ADMIN_LINK }), '/test/project'))
        .toBe('orphaned');
      expect(inspectWorktreeGitLink(createHalfRemovedWorktree({}), '/test/project')).toBe('missing');
      expect(inspectWorktreeGitLink(
        createHalfRemovedWorktree({ gitLink: `gitdir: ${otherRepo}/.git/worktrees/react\n` }),
        '/test/project',
      )).toBe('other');
      expect(inspectWorktreeGitLink(
        createHalfRemovedWorktree({ gitLink: `gitdir: ${otherRepo}/.git/worktrees/react\n` }),
        otherRepo,
      )).toBe('other');
      expect(inspectWorktreeGitLink(createHalfRemovedWorktree({ gitLink: 'not a link\n' }), '/test/project'))
        .toBe('other');
    });

    it('enters recovery_required when Git fails after unregistering a still-present worktree', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({
        dropRegistration: true,
        message: `error: failed to delete '${worktreePath}': Permission denied`,
      });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test/project',
        worktreePath,
        operation: 'cleanup',
        pane: { id: 'psyche-1', paneId: '%1' },
      }));
      expect(markerReason()).toContain('partially removed');
      expect(markerReason()).toContain('exited with code 255');
      // Git's stderr carries paths and free text; it never enters the marker.
      expect(markerReason()).not.toContain('Permission denied');
      expect(markerReason()).not.toContain(worktreePath);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('recovery_required'),
        'paneActions',
        'psyche-1',
      );
      // Nothing Git left behind is deleted, and the branch is never deleted.
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(branchOids.get('/test/project')).toBe('abc123');
    });

    it('treats a worktree unregistered by its own failed removal as partially removed even without a link', async () => {
      const worktreePath = createHalfRemovedWorktree({});
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(markerReason()).toContain('partially removed');
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
    });

    it('enters recovery_required when a registered worktree lost its Git link mid-removal', async () => {
      const worktreePath = createHalfRemovedWorktree({});
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({
        dropRegistration: false,
        message: `fatal: validation failed, cannot remove working tree: '${worktreePath}/.git' does not exist`,
      });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath,
        operation: 'cleanup',
      }));
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('does not flag an intact worktree whose removal Git refused before writing', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({
        dropRegistration: false,
        message: 'fatal: contains modified or untracked files, use --force to delete it',
      });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worktree removal preserved'),
        'paneActions',
        'psyche-1',
      );
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
    });

    it('reports an unverifiable state after a failed removal without calling it preserved', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({
        dropRegistration: true,
        message: 'error: failed to delete',
        afterRemoval: failWorktreeListing,
      });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('removal state unverified'),
        'paneActions',
        'psyche-1',
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Worktree removal preserved'),
        expect.anything(),
        expect.anything(),
      );
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('deletes no branch when the recovery marker cannot be written', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });
      writeWorktreeRecoveryMarkerMock.mockRejectedValueOnce(new Error('recovery directory unwritable'));

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(branchOids.get('/test/project')).toBe('abc123');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('recovery directory unwritable'),
        'paneActions',
        'psyche-1',
        expect.any(Error),
      );
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('detects a worktree an interrupted owner left half-removed on the next cleanup attempt', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      // The owner died after Git unregistered the worktree: nothing maps it.
      branchOids.set('/test/project', 'abc123');

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test/project',
        worktreePath,
        operation: 'cleanup',
      }));
      expect(markerReason()).toContain('partially removed');
      // Detection never mutates: no Git write runs, under any lease.
      expect(spawnMock).not.toHaveBeenCalled();
      expect(acquireProjectWorktreeLifecycleLeaseMock).toHaveBeenCalled();
      expect(acquireWorktreeOperationLeaseMock).toHaveBeenCalled();
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
      expect(branchOids.get('/test/project')).toBe('abc123');
      expect(logger.debug).toHaveBeenCalledWith(
        'Finished background worktree cleanup for react',
        'paneActions',
        'psyche-1',
      );
    });

    it('gives a worktree linked to another repository a neutral marker with no deletion advice', async () => {
      const otherRepo = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-other-repo-')));
      tempDirs.push(otherRepo);
      mkdirSync(join(otherRepo, '.git', 'worktrees', 'react'), { recursive: true });
      const worktreePath = createHalfRemovedWorktree({
        gitLink: `gitdir: ${otherRepo}/.git/worktrees/react\n`,
      });

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(markerReason()).toContain('unregistered directory at pane path');
      expect(markerReason()).toContain('verify before acknowledging');
      expect(markerReason()).not.toMatch(/remove or restore|partially removed/u);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('gives a plain unregistered directory a neutral marker with no deletion advice', async () => {
      const worktreePath = createHalfRemovedWorktree({});

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(markerReason()).toContain('unregistered directory at pane path');
      expect(markerReason()).not.toMatch(/remove or restore|partially removed/u);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('inspects each nested removal target against its own repository', async () => {
      const root = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      const nested = join(root, 'packages', 'sub');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, '.git'), 'gitdir: /test/sub-repo/.git/worktrees/sub\n');
      // The root is still a healthy registered worktree; only the nested one
      // was left behind by its own repository.
      configureCleanupIdentity(root);
      worktreeMappings.get('/test/project')!.set(resolve(root), 'other-branch');
      detectAllWorktreesMock.mockReturnValue([
        { parentRepoPath: '/test/sub-repo', worktreePath: nested, depth: 1 },
      ]);

      await enqueuePaneAt(root);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test/project',
        worktreePath: nested,
      }));
      expect(markerReason()).toContain('partially removed');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('takes no action on the next attempt when the registration cannot be read', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      failWorktreeListing();

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('does not publish a second marker for a worktree already awaiting acknowledgement', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      findBlockingOverride.current = {
        blocked: true,
        reason: 'recovery marker existing requires operator acknowledgement',
      };

      await enqueuePaneAt(worktreePath);

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('requires operator acknowledgement'),
        'paneActions',
        'psyche-1',
      );
    });

    it('treats an unregistered worktree whose directory is gone as already removed', async () => {
      await enqueuePaneAt('/test/project/.psyche/worktrees/react');

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('reconciles a registration whose directory is already gone through non-forced removal', async () => {
      configureCleanupIdentity();

      await enqueuePaneAt('/test/project/.psyche/worktrees/react');

      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', '/test/project/.psyche/worktrees/react'],
        expect.anything(),
      );
      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
    });

    async function rollbackAt(worktreePath: string) {
      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      return WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
        worktreePath,
        branchName: 'react',
        branchOid: 'abc123',
        mainRepoPath: '/test/project',
        deleteBranch: true,
      });
    }

    function preparePrunePartial(): { projectRoot: string; older: string } {
      const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-prune-partial-')));
      tempDirs.push(projectRoot);
      const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
      writeFileSync(join(older, 'survivor.txt'), 'remaining user file\n');
      worktreeMappings.set(projectRoot, new Map([[resolve(older), 'older']]));
      branchOids.set(projectRoot, 'abc123');
      writeFileSync(join(projectRoot, '.psyche', 'psyche.config.json'), '{}');
      currentConfig = { projectRoot, panes: [] };
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });
      return { projectRoot, older };
    }

    async function pruneTarget(projectRoot: string, older: string): Promise<void> {
      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const service = WorktreeCleanupService.getInstance() as any;
      await service.runPruneManagedWorktrees(
        { projectRoot, activePanes: [], maxManagedWorktrees: 1 },
        [{
          canonicalWorktreePath: older,
          mtimeMs: 0,
          expectedGeneration: 0,
          blockedByActiveReuseReservation: false,
        }],
      );
    }

    it('reports an unverifiable rollback without claiming a recovery marker', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({
        dropRegistration: true,
        message: 'error: failed to delete',
        afterRemoval: failWorktreeListing,
      });

      const result = await rollbackAt(worktreePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('removal state unverified');
      expect(result.error).toContain('no recovery marker written');
      expect(result.error).not.toContain('recovery_required');
      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(branchOids.get('/test/project')).toBe('abc123');
    });

    it('deletes no branch when a rollback recovery marker cannot be written', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });
      writeWorktreeRecoveryMarkerMock.mockRejectedValueOnce(new Error('recovery directory unwritable'));

      const result = await rollbackAt(worktreePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('could not be written');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(branchOids.get('/test/project')).toBe('abc123');
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('deletes nothing further when a prune recovery marker cannot be written', async () => {
      const { projectRoot, older } = preparePrunePartial();
      writeWorktreeRecoveryMarkerMock.mockRejectedValueOnce(new Error('recovery directory unwritable'));

      await pruneTarget(projectRoot, older);

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).not.toHaveBeenCalledWith('git', expect.arrayContaining(['update-ref']), expect.anything());
      expect(branchOids.get(projectRoot)).toBe('abc123');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('recovery directory unwritable'),
        'paneActions',
      );
      expect(readFileSyncActual(join(older, 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('keeps a nested worktree discovery cannot see once its admin entry is gone', async () => {
      const root = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      const nested = join(root, 'packages', 'sub');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'survivor.txt'), 'nested remaining file\n');
      // The interrupted nested removal deleted its admin entry, so Git-based
      // discovery no longer returns it while the root stays healthy.
      writeFileSync(join(nested, '.git'), 'gitdir: /test/sub-repo/.git/worktrees/sub\n');
      configureCleanupIdentity(root);
      detectAllWorktreesMock.mockReturnValue([]);

      await enqueuePaneAt(root);

      // The root is not removed around a half-removed child.
      expect(spawnMock).not.toHaveBeenCalled();
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledTimes(1);
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test/project',
        worktreePath: nested,
      }));
      expect(markerReason()).toContain('partially removed');
      expect(readFileSyncActual(join(nested, 'survivor.txt'))).toBe('nested remaining file\n');
      expect(branchOids.get('/test/project')).toBe('abc123');
    });

    it('finds only nested links whose worktree admin entry is missing', async () => {
      const { findOrphanedNestedWorktreeLinks } = await import('../src/services/WorktreeCleanupService.js');
      const root = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      const liveRepo = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-live-repo-')));
      tempDirs.push(liveRepo);
      mkdirSync(join(liveRepo, '.git', 'worktrees', 'live'), { recursive: true });
      const orphan = join(root, 'a', 'orphan');
      const live = join(root, 'b', 'live');
      const submodule = join(root, 'c', 'lib');
      const hidden = join(root, '.cache', 'orphan');
      for (const dir of [orphan, live, submodule, hidden]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(orphan, '.git'), 'gitdir: /test/sub-repo/.git/worktrees/orphan\n');
      writeFileSync(join(live, '.git'), `gitdir: ${liveRepo}/.git/worktrees/live\n`);
      writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n');
      writeFileSync(join(hidden, '.git'), 'gitdir: /test/sub-repo/.git/worktrees/hidden\n');

      expect(findOrphanedNestedWorktreeLinks(root)).toEqual([
        { repoPath: '/test/sub-repo', worktreePath: orphan, depth: 2 },
      ]);
    });

    it('leaves a nested submodule checkout alone on the next attempt', async () => {
      const root = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      const nested = join(root, 'vendor', 'lib');
      mkdirSync(nested, { recursive: true });
      // A submodule links into `.git/modules/`, never `.git/worktrees/`.
      writeFileSync(join(nested, '.git'), 'gitdir: ../../.git/modules/lib\n');
      configureCleanupIdentity(root);
      worktreeMappings.get('/test/project')!.set(resolve(root), 'other-branch');
      detectAllWorktreesMock.mockReturnValue([
        { parentRepoPath: root, worktreePath: nested, depth: 1 },
      ]);

      await enqueuePaneAt(root);

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('enters recovery_required when a rollback removal stops partway', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });

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
      expect(result.error).toContain('recovery_required');
      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test/project',
        worktreePath,
        operation: 'cleanup',
      }));
      expect(markerReason()).toContain('partially removed');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(branchOids.get('/test/project')).toBe('abc123');
      expect(readFileSyncActual(join(worktreePath, 'locked', 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('keeps a dirty rollback refusal as preservation without a marker', async () => {
      const worktreePath = createHalfRemovedWorktree({ gitLink: ADMIN_LINK });
      configureCleanupIdentity(worktreePath);
      failRemovalAfterGitBeganWriting({ dropRegistration: false, message: 'fatal: contains modified files' });

      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const result = await WorktreeCleanupService.getInstance().rollbackCreatedWorktree({
        worktreePath,
        branchName: 'react',
        branchOid: 'abc123',
        mainRepoPath: '/test/project',
        deleteBranch: true,
      });

      expect(result.error).toContain('preserved worktree and branch');
      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
    });

    it('enters recovery_required when a managed prune removal stops partway', async () => {
      const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-prune-partial-')));
      tempDirs.push(projectRoot);
      const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
      writeFileSync(join(older, 'survivor.txt'), 'remaining user file\n');
      worktreeMappings.set(projectRoot, new Map([[resolve(older), 'older']]));
      writeFileSync(join(projectRoot, '.psyche', 'psyche.config.json'), '{}');
      currentConfig = { projectRoot, panes: [] };
      failRemovalAfterGitBeganWriting({ dropRegistration: true, message: 'error: failed to delete' });

      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const service = WorktreeCleanupService.getInstance() as any;
      await service.runPruneManagedWorktrees(
        { projectRoot, activePanes: [], maxManagedWorktrees: 1 },
        [{
          canonicalWorktreePath: older,
          mtimeMs: 0,
          expectedGeneration: 0,
          blockedByActiveReuseReservation: false,
        }],
      );

      expect(writeWorktreeRecoveryMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot,
        worktreePath: older,
        operation: 'cleanup',
        pane: { id: 'managed-worktree-prune', paneId: 'none' },
      }));
      expect(markerReason()).toContain('partially removed');
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('preserved dirty or inaccessible'),
        expect.anything(),
      );
      expect(readFileSyncActual(join(older, 'survivor.txt'))).toBe('remaining user file\n');
    });

    it('keeps a managed prune refusal of a never-registered directory as preservation', async () => {
      const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'psyche-prune-partial-')));
      tempDirs.push(projectRoot);
      const older = createManagedWorktree(projectRoot, 'older', new Date('2026-01-01T00:00:00Z'));
      writeFileSync(join(projectRoot, '.psyche', 'psyche.config.json'), '{}');
      currentConfig = { projectRoot, panes: [] };
      failRemovalAfterGitBeganWriting({ dropRegistration: false, message: 'fatal: not a working tree' });

      const { WorktreeCleanupService } = await import('../src/services/WorktreeCleanupService.js');
      (WorktreeCleanupService as any).instance = undefined;
      const service = WorktreeCleanupService.getInstance() as any;
      await service.runPruneManagedWorktrees(
        { projectRoot, activePanes: [], maxManagedWorktrees: 1 },
        [{
          canonicalWorktreePath: older,
          mtimeMs: 0,
          expectedGeneration: 0,
          blockedByActiveReuseReservation: false,
        }],
      );

      expect(writeWorktreeRecoveryMarkerMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('preserved dirty or inaccessible'),
        'paneActions',
      );
    });
  });
});
