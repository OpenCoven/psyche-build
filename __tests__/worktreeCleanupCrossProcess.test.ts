import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const detectAllWorktreesMock = vi.hoisted(() => vi.fn(() => []));
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
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
  process.nextTick(() => child.emit('close', 0));
  return child;
}

describe('cross-process worktree lifecycle coordination', () => {
  const roots: string[] = [];
  let worktreeMappings: Map<string, Map<string, string>>;
  let branchOids: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    worktreeMappings = new Map();
    branchOids = new Map();

    execFileSyncMock.mockImplementation((_command, args, options) => {
      const gitArgs = args as string[];
      const cwd = String((options as { cwd?: string } | undefined)?.cwd || '');

      if (gitArgs[0] === 'worktree' && gitArgs[1] === 'list') {
        return Array.from(worktreeMappings.get(cwd)?.entries() || [])
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

      throw new Error(`Unexpected synchronous git command: git ${gitArgs.join(' ')}`);
    });
    spawnMock.mockImplementation(() => createSuccessfulChildProcess());
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it('makes daemon reuse block TUI cleanup until persisted config protects the worktree', async () => {
    const projectRoot = mkdtempSync(
      join(process.cwd(), '.psyche-cross-process-cleanup-test-'),
    );
    roots.push(projectRoot);
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'reuse-me');
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    mkdirSync(join(worktreePath, '.git'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      projectRoot,
      panes: [],
    }));

    const canonicalWorktreePath = realpathSync.native(worktreePath);
    worktreeMappings.set(projectRoot, new Map([
      [canonicalWorktreePath, 'reuse-me'],
    ]));
    branchOids.set(projectRoot, 'abc123');

    const { WorktreeCleanupService } = await import(
      '../src/services/WorktreeCleanupService.js'
    );
    const daemonService = new WorktreeCleanupService();
    const tuiService = new WorktreeCleanupService() as any;
    let allowPersistence!: () => void;
    let signalReservation!: () => void;
    const reservationStarted = new Promise<void>((resolveReservation) => {
      signalReservation = resolveReservation;
    });
    const persistence = new Promise<void>((resolvePersistence) => {
      allowPersistence = resolvePersistence;
    });

    const daemonReuse = daemonService.withWorktreeReuseReservation(
      worktreePath,
      async () => {
        signalReservation();
        await persistence;
        writeFileSync(configPath, JSON.stringify({
          projectRoot,
          panes: [{
            id: 'daemon-pane',
            slug: 'reuse-me',
            prompt: '',
            paneId: '%2',
            worktreePath,
          }],
        }));
      },
      projectRoot,
    );
    await reservationStarted;

    const cleanupPane: PsychePane = {
      id: 'tui-pane',
      slug: 'reuse-me',
      branchName: 'reuse-me',
      prompt: '',
      paneId: '%1',
      worktreePath,
    };
    tuiService.enqueueCleanup({
      pane: cleanupPane,
      paneProjectRoot: projectRoot,
      mainRepoPath: projectRoot,
      configPath,
      currentProjectRoot: projectRoot,
      deleteBranch: true,
    });

    let cleanupSettled = false;
    void tuiService.cleanupQueue.then(() => {
      cleanupSettled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(logger.error).not.toHaveBeenCalled();
    expect(cleanupSettled).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    allowPersistence();
    await daemonReuse;
    await tuiService.cleanupQueue;

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('current config still references'),
      'paneActions',
      'tui-pane',
    );
    expect(resolve(worktreePath)).toBe(canonicalWorktreePath);
  });
});
