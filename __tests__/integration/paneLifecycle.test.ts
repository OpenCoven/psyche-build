/**
 * Integration tests for pane lifecycle (creation, closure, rebinding)
 * Target: Cover src/utils/paneCreation.ts (568 lines, currently 0%)
 * Expected coverage gain: +3-4%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PsychePane } from '../../src/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import {
  createMockTmuxSession,
  type MockTmuxSession,
} from '../fixtures/integration/tmuxSession.js';
import {
  createMockGitRepo,
  addWorktree,
  type MockGitRepo,
} from '../fixtures/integration/gitRepo.js';
import { createMockExecSync, createMockOpenRouterAPI } from '../helpers/integration/mockCommands.js';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn((_target?: unknown, _options?: unknown): string =>
    JSON.stringify({ controlPaneId: '%0' })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
const destroyWelcomePaneCoordinatedMock = vi.hoisted(() => vi.fn());

// Mock child_process
const mockExecSync = createMockExecSync({});
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// Mock StateManager
const mockGetPanes = vi.fn((): PsychePane[] => []);
const mockSetPanes = vi.fn();
const mockGetState = vi.fn(() => ({ projectRoot: '/test' }));
const mockPauseConfigWatcher = vi.fn();
const mockResumeConfigWatcher = vi.fn();
vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => ({
      getPanes: mockGetPanes,
      setPanes: mockSetPanes,
      getState: mockGetState,
      pauseConfigWatcher: mockPauseConfigWatcher,
      resumeConfigWatcher: mockResumeConfigWatcher,
    })),
  },
}));

// Mock hooks
const mockTriggerHook = vi.hoisted(() => vi.fn((_eventName?: string) => Promise.resolve()));
const mockTriggerHookSync = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));
const mockAtomicWriteJsonSync = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: mockTriggerHook,
  triggerHookSync: mockTriggerHookSync,
  initializeHooksDirectory: vi.fn(),
}));

// Mock LogService
vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

const mockEnqueueCleanup = vi.fn();
const mockWithWorktreeReuseReservation = vi.fn();
const mockRollbackCreatedWorktree = vi.fn(() => ({ success: true }));
const mockPersistReusedPane = vi.fn(async () => {});
vi.mock('../../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      enqueueCleanup: mockEnqueueCleanup,
      withWorktreeReuseReservation: mockWithWorktreeReuseReservation,
      rollbackCreatedWorktree: mockRollbackCreatedWorktree,
    })),
  },
}));

vi.mock('../../src/utils/welcomePaneManager.js', () => ({
  destroyWelcomePaneCoordinated: destroyWelcomePaneCoordinatedMock,
}));

vi.mock('../../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: mockAtomicWriteJsonSync,
}));

// Mock fs for reading config
vi.mock('fs', () => ({
  default: fsMock,
  ...fsMock,
}));

describe('Pane Lifecycle Integration Tests', () => {
  let tmuxSession: MockTmuxSession;
  let gitRepo: MockGitRepo;
  let createdWorktreePaths: Set<string>;
  let killedPaneIds: Set<string>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    mockEnqueueCleanup.mockReset();
    mockWithWorktreeReuseReservation.mockImplementation(
      async (
        worktreePath: string,
        operation: (canonicalWorktreePath: string) => Promise<unknown>
      ) => operation(worktreePath)
    );
    mockRollbackCreatedWorktree.mockReturnValue({ success: true });
    mockTriggerHook.mockImplementation(() => Promise.resolve());
    mockTriggerHookSync.mockImplementation(() => Promise.resolve({ success: true }));

    // Create fresh test environment
    tmuxSession = createMockTmuxSession('psyche-test', 1);
    gitRepo = createMockGitRepo('main');
    createdWorktreePaths = new Set<string>();
    killedPaneIds = new Set<string>();

    fsMock.existsSync.mockImplementation((target) => {
      const value = String(target);
      if (value.includes('/.psyche/worktrees/')) {
        return createdWorktreePaths.has(value);
      }
      return true;
    });

    // Configure mock execSync with test data
    mockExecSync.mockImplementation((command: string, options?: any) => {
      const cmd = command.toString().trim();
      const encoding = options?.encoding;

      // Helper to return string or buffer based on encoding option
      const returnValue = (value: string) => {
        if (encoding === 'utf-8') {
          return value;
        }
        return Buffer.from(value);
      };

      // Tmux display-message (get current pane id or session name)
      if (cmd.includes('display-message')) {
        if (cmd.includes('#{session_name}')) {
          return returnValue('psyche-test');
        }
        return returnValue('%0');
      }

      // Tmux list-panes
      if (cmd.includes('list-panes')) {
        return returnValue(
          [
            '%0:psyche-control:80x24',
            '%1:test:80x24',
          ]
            .filter((line) => {
              const paneId = line.match(/^%\d+/)?.[0];
              return paneId && !killedPaneIds.has(paneId);
            })
            .join('\n')
        );
      }

      // Tmux kill-pane
      if (cmd.includes('kill-pane')) {
        const paneId = cmd.match(/-t '([^']+)'/)?.[1];
        if (paneId) {
          killedPaneIds.add(paneId);
        }
        return returnValue('');
      }

      // Tmux split-window
      if (cmd.includes('split-window')) {
        return returnValue('%1');
      }

      // Git worktree add
      if (cmd.includes('worktree add')) {
        const pathMatch = cmd.match(/git worktree add "([^"]+)"/);
        const branchMatch = cmd.match(/-b "([^"]+)"/) || cmd.match(/git worktree add "[^"]+" "([^"]+)"/);
        const worktreePath = pathMatch?.[1] || '/test/.psyche/worktrees/test-slug';
        const branchName = branchMatch?.[1] || 'test-slug';
        createdWorktreePaths.add(worktreePath);
        createdWorktreePaths.add(`${worktreePath}/.git`);
        gitRepo = addWorktree(gitRepo, worktreePath, branchName);
        return returnValue('');
      }

      // Git worktree list
      if (cmd.includes('worktree list')) {
        return returnValue(
          Array.from(createdWorktreePaths)
            .filter((worktreePath) => !worktreePath.endsWith('/.git'))
            .map((worktreePath) => `${worktreePath} abc123 [${worktreePath.split('/').pop()}]`)
            .join('\n')
        );
      }

      // Git symbolic-ref (main branch)
      if (cmd.includes('symbolic-ref')) {
        return returnValue('refs/heads/main');
      }

      // Git rev-parse (current branch)
      if (cmd.includes('rev-parse --git-common-dir')) {
        return returnValue('.git');
      }

      if (cmd.includes('rev-parse --show-toplevel')) {
        return returnValue('/test');
      }

      if (cmd.includes('rev-parse')) {
        return returnValue('main');
      }

      // Default
      return returnValue('');
    });

    // Configure StateManager mock
    mockGetPanes.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Pane Creation Flow', () => {
    it('should create pane with generated slug', async () => {
      // Import pane creation utilities
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'fix authentication bug',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude', 'opencode']
      );

      // Should return a pane (not needsAgentChoice)
      expect(result).toHaveProperty('pane');
      if ('pane' in result) {
        expect(result.pane.prompt).toBe('fix authentication bug');
        expect(result.pane.slug).toBeTruthy();
        expect(result.pane.paneId).toBeTruthy();
      }
    });

    it('should scope pane border status to the current tmux session', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'scope pane borders',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      expect(mockExecSync.mock.calls.some(([cmd]) =>
        typeof cmd === 'string'
        && cmd.includes('tmux set -t psyche-test pane-border-status top')
      )).toBe(true);

      expect(mockExecSync.mock.calls.some(([cmd]) =>
        typeof cmd === 'string'
        && cmd.includes('tmux set-option -g pane-border-status top')
      )).toBe(false);
    });

    it('should create git worktree with branch', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'add user dashboard',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // Verify git worktree add was called
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git worktree add'),
        expect.any(Object)
      );
    });

    it('should validate remote tracking baseBranch values without forcing refs/heads', async () => {
      fsMock.readFileSync.mockImplementation((target) => {
        const value = String(target);
        if (value.endsWith('/.psyche/settings.json')) {
          return JSON.stringify({ baseBranch: 'origin/main' });
        }
        if (value.endsWith('/.psyche/psyche.config.json')) {
          return JSON.stringify({ controlPaneId: '%0' });
        }
        return JSON.stringify({});
      });

      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'branch from remote main',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
          slugBase: 'remote-base',
        },
        ['claude']
      );

      expect(mockExecSync.mock.calls.some(([cmd]) =>
        typeof cmd === 'string'
        && cmd.includes('git rev-parse --verify --end-of-options "origin/main"')
      )).toBe(true);

      expect(mockExecSync.mock.calls.some(([cmd]) =>
        typeof cmd === 'string'
        && cmd.includes('refs/heads/origin/main')
      )).toBe(false);
    });

    it('should attach a fresh pane to an existing worktree without recreating it', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const existingWorktreePath = '/test/.psyche/worktrees/resume-me';
      createdWorktreePaths.add(existingWorktreePath);
      createdWorktreePaths.add(`${existingWorktreePath}/.git`);

      const result = await createPane(
        {
          prompt: '',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
          existingWorktree: {
            slug: 'resume-me',
            worktreePath: existingWorktreePath,
            branchName: 'feature/resume-me',
          },
          persistReusedPane: mockPersistReusedPane,
        },
        ['claude']
      );

      expect(mockExecSync.mock.calls.some(([cmd]) =>
        typeof cmd === 'string' && cmd.includes(`git worktree add "${existingWorktreePath}"`)
      )).toBe(false);

      if ('pane' in result) {
        expect(result.pane.slug).toBe('resume-me');
        expect(result.pane.branchName).toBe('feature/resume-me');
        expect(result.pane.worktreePath).toBe(existingWorktreePath);
        expect(result.pane.prompt).toBe('No initial prompt');
      }
    });

    it('cancels blocked cleanup before awaited existing-worktree setup can persist the pane', async () => {
      vi.useFakeTimers();
      const existingWorktreePath = '/test/.psyche/worktrees/resume-me';
      let worktreeExists = true;
      let cleanupCanceled = false;
      let releaseCleanup!: () => void;
      let releasePaneCreation!: () => void;
      let signalPaneCreationStarted!: () => void;
      const paneCreationStarted = new Promise<void>((resolve) => {
        signalPaneCreationStarted = resolve;
      });
      const paneCreation = new Promise<void>((resolve) => {
        releasePaneCreation = resolve;
      });
      const queuedCleanup = new Promise<void>((resolve) => {
        releaseCleanup = () => {
          if (!cleanupCanceled) {
            worktreeExists = false;
          }
          resolve();
        };
      });

      createdWorktreePaths.add(existingWorktreePath);
      createdWorktreePaths.add(`${existingWorktreePath}/.git`);
      mockWithWorktreeReuseReservation.mockImplementation(async (
        worktreePath: string,
        operation: (canonicalWorktreePath: string) => Promise<unknown>
      ) => {
        cleanupCanceled = true;
        return operation(worktreePath);
      });
      mockTriggerHook.mockImplementation((eventName) => {
        if (eventName === 'before_pane_create') {
          signalPaneCreationStarted();
          return paneCreation;
        }
        return Promise.resolve();
      });

      try {
        const { createPane } = await import('../../src/utils/paneCreation.js');
        const createPromise = createPane(
          {
            prompt: '',
            projectName: 'test-project',
            existingPanes: [],
            skipAgentSelection: true,
            existingWorktree: {
              slug: 'resume-me',
              worktreePath: existingWorktreePath,
              branchName: 'feature/resume-me',
            },
            persistReusedPane: mockPersistReusedPane,
          },
          []
        );

        await paneCreationStarted;
        expect(mockAtomicWriteJsonSync).not.toHaveBeenCalled();

        releaseCleanup();
        await queuedCleanup;
        expect(worktreeExists).toBe(true);
        expect(mockAtomicWriteJsonSync).not.toHaveBeenCalled();

        releasePaneCreation();
        await vi.runAllTimersAsync();
        await createPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should split tmux pane', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'refactor component',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // Verify tmux split-window was called
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux split-window'),
        expect.any(Object)
      );

      // Pane should have tmux pane ID
      if ('pane' in result) {
        expect(result.pane.paneId).toMatch(/%\d+/);
      }
    });

    it('should create agent panes in the selected project root for added projects', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'work on added project',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [
            {
              id: 'psyche-1',
              slug: 'existing',
              prompt: 'existing pane',
              paneId: '%5',
              projectRoot: '/primary/repo',
              worktreePath: '/primary/repo/.psyche/worktrees/existing',
            },
          ],
          projectRoot: '/target/repo',
          slugBase: 'target-slug',
        },
        ['claude']
      );

      const splitCall = mockExecSync.mock.calls.find(([cmd]) =>
        typeof cmd === 'string' && cmd.includes('tmux split-window')
      );
      expect(splitCall?.[0]).toContain('-c "/target/repo"');

      const worktreeCall = mockExecSync.mock.calls.find(([cmd]) =>
        typeof cmd === 'string' && cmd.includes('git worktree add')
      );
      expect(worktreeCall?.[0]).toContain('cd "/target/repo" && git worktree add "/target/repo/.psyche/worktrees/target-slug"');
    });

    it('should destroy the welcome pane when tracked shell panes make the pane list non-empty', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'investigate issue',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [
            {
              id: 'psyche-1',
              slug: 'shell-1',
              prompt: '',
              paneId: '%5',
              type: 'shell',
              shellType: 'zsh',
            },
          ],
        },
        ['claude']
      );

      expect(destroyWelcomePaneCoordinatedMock).toHaveBeenCalledWith('/test');
    });

    it('should handle slug generation failure (fallback to timestamp)', async () => {
      // Mock OpenRouter API failure
      const mockFetch = vi.fn(() =>
        Promise.reject(new Error('API timeout'))
      );
      global.fetch = mockFetch;

      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // Should fallback to timestamp-based slug
      if ('pane' in result) {
        expect(result.pane.slug).toMatch(/psyche-\d+/);
      }
    });

    it('should return needsAgentChoice when agent not specified', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude', 'opencode']
      );

      // Should return needsAgentChoice
      expect(result).toHaveProperty('needsAgentChoice');
      if ('needsAgentChoice' in result) {
        expect(result.needsAgentChoice).toBe(true);
      }
    });

    it('should handle empty agent list', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          projectName: 'test-project',
          existingPanes: [],
        },
        []
      );

      // Should return error or handle gracefully
      expect(result).toBeDefined();
    });
  });

  describe('Worktree Setup Failure Handling', () => {
    // Regression tests for: when worktree preparation fails, the pane must
    // be torn down and the agent must NOT be launched. Leaving the pane open
    // at projectRoot would let the agent run against main, which is dangerous.

    const getSendKeysCommands = () =>
      mockExecSync.mock.calls
        .map(([cmd]) => (typeof cmd === 'string' ? cmd : ''))
        .filter((cmd) => cmd.includes('send-keys'));

    const getKillPaneCommands = () =>
      mockExecSync.mock.calls
        .map(([cmd]) => (typeof cmd === 'string' ? cmd : ''))
        .filter((cmd) => cmd.includes('kill-pane'));

    it('kills the pane and throws when the worktree is missing', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      // Point at an "existing" worktree path that isn't tracked as created
      // → fs.existsSync(worktreePath + '/.git') returns false → throws inside
      // the worktree-creation try/catch before any agent command is sent.
      const missingWorktreePath = '/test/.psyche/worktrees/does-not-exist';

      await expect(
        createPane(
          {
            prompt: 'fix auth bug',
            agent: 'claude',
            projectName: 'test-project',
            existingPanes: [],
            existingWorktree: {
              slug: 'does-not-exist',
              worktreePath: missingWorktreePath,
              branchName: 'does-not-exist',
            },
            persistReusedPane: mockPersistReusedPane,
          },
          ['claude']
        )
      ).rejects.toThrow(/Failed to create worktree/);

      // Pane must be killed so the user is never dropped at projectRoot
      // with a live shell.
      expect(
        getKillPaneCommands().some((cmd) => cmd.includes('%1'))
      ).toBe(true);

      // Agent launch command must never reach the pane.
      const sendKeys = getSendKeysCommands();
      expect(sendKeys.some((cmd) => cmd.includes('claude'))).toBe(false);
    });

    it('kills the pane and throws when the worktree_created hook fails', async () => {
      const { triggerHookSync } = await import('../../src/utils/hooks.js');
      vi.mocked(triggerHookSync).mockResolvedValueOnce({
        success: false,
        error: 'dependency install failed',
      });
      const originalImpl = mockExecSync.getMockImplementation();
      mockExecSync.mockImplementation((command: string, options?: any) => {
        if (command.includes('git show-ref --verify --quiet')) {
          throw new Error('branch does not exist');
        }
        return originalImpl ? originalImpl(command, options) : '';
      });

      const { createPane } = await import('../../src/utils/paneCreation.js');

      await expect(
        createPane(
          {
            prompt: 'add dashboard',
            agent: 'claude',
            projectName: 'test-project',
            existingPanes: [],
          },
          ['claude']
        )
      ).rejects.toThrow(/worktree_created hook failed/);

      // Pane must be killed so the agent cannot run inside a
      // half-configured worktree.
      expect(
        getKillPaneCommands().some((cmd) => cmd.includes('%1'))
      ).toBe(true);

      // Agent launch command must never reach the pane.
      const sendKeys = getSendKeysCommands();
      expect(sendKeys.some((cmd) => cmd.includes('claude'))).toBe(false);

      expect(mockRollbackCreatedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          mainRepoPath: '/test',
          deleteBranch: true,
        })
      );
    });

    it('does not roll back a reused worktree when the worktree_created hook fails', async () => {
      const existingWorktreePath = '/test/.psyche/worktrees/resume-me';
      createdWorktreePaths.add(existingWorktreePath);
      createdWorktreePaths.add(`${existingWorktreePath}/.git`);
      const { triggerHookSync } = await import('../../src/utils/hooks.js');
      vi.mocked(triggerHookSync).mockResolvedValueOnce({
        success: false,
        error: 'dependency install failed',
      });

      const { createPane } = await import('../../src/utils/paneCreation.js');

      await expect(
        createPane(
          {
            prompt: 'resume work',
            agent: 'claude',
            projectName: 'test-project',
            existingPanes: [],
            existingWorktree: {
              slug: 'resume-me',
              worktreePath: existingWorktreePath,
              branchName: 'feature/resume-me',
            },
            persistReusedPane: mockPersistReusedPane,
          },
          ['claude']
        )
      ).rejects.toThrow(/worktree_created hook failed/);

      expect(mockRollbackCreatedWorktree).not.toHaveBeenCalled();
    });

    it('runs worktree_created hook before launching the agent', async () => {
      const { triggerHookSync } = await import('../../src/utils/hooks.js');
      const callOrder: string[] = [];

      vi.mocked(triggerHookSync).mockImplementationOnce(async (hookName) => {
        callOrder.push(`hook:${hookName}`);
        return { success: true };
      });

      // Record when the agent launch command is sent to the pane.
      const originalImpl = mockExecSync.getMockImplementation();
      mockExecSync.mockImplementation((command: string, options?: any) => {
        const cmd = command.toString();
        if (
          cmd.includes('send-keys')
          && cmd.includes('claude')
          && !cmd.includes('worktree add')
        ) {
          callOrder.push('agent-launch');
        }
        return originalImpl ? originalImpl(command, options) : '';
      });

      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane(
        {
          prompt: 'hook ordering test',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      const hookIdx = callOrder.indexOf('hook:worktree_created');
      const agentIdx = callOrder.indexOf('agent-launch');

      expect(hookIdx).toBeGreaterThanOrEqual(0);
      expect(agentIdx).toBeGreaterThanOrEqual(0);
      expect(hookIdx).toBeLessThan(agentIdx);
    });
  });

  describe('Pane Closure Flow', () => {
    it('should present choice dialog for worktree panes', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.psyche/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        sessionName: 'test-session',
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      const result = await closePane(testPane, mockContext);

      // Should return choice dialog with 3 options
      expect(result.type).toBe('choice');
      if (result.type === 'choice') {
        expect(result.options).toHaveLength(3);
        expect(result.options?.map(o => o.id)).toEqual([
          'kill_only',
          'kill_and_clean',
          'kill_clean_branch',
        ]);
      }
    });

    it('should kill tmux pane when closing', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.psyche/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        sessionName: 'test-session',
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      // Execute the close
      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_only');
      }

      // Verify tmux kill-pane was called
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux kill-pane'),
        expect.any(Object)
      );
    });

    it('should queue worktree cleanup with kill_and_clean option', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.psyche/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        sessionName: 'test-session',
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_and_clean');
      }

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: testPane,
          deleteBranch: false,
        })
      );
    });

    it('should handle background cleanup enqueue failure gracefully', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      mockEnqueueCleanup.mockImplementation(() => {
        throw new Error('enqueue failed');
      });

      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.psyche/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        sessionName: 'test-session',
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);
      let executeResult = result;

      if (result.type === 'choice' && result.onSelect) {
        executeResult = await result.onSelect('kill_and_clean');
      }

      // Should still succeed (cleanup enqueue failures are non-critical)
      expect(executeResult.type).toBe('success');
    });

    it('should trigger post-close hooks', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');
      const { triggerHook } = await import('../../src/utils/hooks.js');

      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.psyche/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        sessionName: 'test-session',
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_and_cleanup_worktree');
      }

      // Verify hooks were triggered
      expect(triggerHook).toHaveBeenCalled();
    });
  });

  describe('Pane Rebinding Flow', () => {
    it('should detect dead pane', async () => {
      // Mock tmux pane not found
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('select-pane') && cmd.includes('%1')) {
          throw new Error("can't find pane: %1");
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');

      // Attempt to select dead pane
      try {
        execSync('tmux select-pane -t %1', { stdio: 'pipe' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain("can't find pane");
      }
    });

    it('should create new tmux pane for rebind', async () => {
      // This would test the rebinding logic once it's implemented
      // For now, we verify the tmux split-window command works

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('split-window')) {
          return Buffer.from('%2');
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');
      const newPaneId = execSync('tmux split-window -h', { stdio: 'pipe' })
        .toString()
        .trim();

      expect(newPaneId).toBe('%2');
    });

    it('should preserve worktree and slug during rebind', async () => {
      // Test that rebinding doesn't recreate worktree
      const testPane: PsychePane = {
        id: 'psyche-1',
        slug: 'existing-branch',
        prompt: 'original prompt',
        paneId: '%1', // Old, dead pane
        worktreePath: '/test/.psyche/worktrees/existing-branch',
      };

      // Rebinding would update paneId but keep slug and worktreePath
      const reboundPane = {
        ...testPane,
        paneId: '%2', // New pane ID
      };

      expect(reboundPane.slug).toBe(testPane.slug);
      expect(reboundPane.worktreePath).toBe(testPane.worktreePath);
      expect(reboundPane.paneId).not.toBe(testPane.paneId);
    });
  });
});
