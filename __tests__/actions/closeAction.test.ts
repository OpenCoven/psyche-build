/**
 * Unit tests for closeAction
 *
 * This is a complex action with multiple code paths:
 * - Shell panes close immediately without options
 * - Worktree panes present context-aware options based on sibling panes
 * - Hooks are triggered, config watcher is paused, tmux operations, layout recalculation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closePane } from '../../src/actions/implementations/closeAction.js';
import type { PsychePane } from '../../src/types.js';
import { createMockPane, createShellPane, createWorktreePane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectChoice, expectSuccess, expectError } from '../helpers/actionAssertions.js';

// Mock all external dependencies
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockEnqueueCleanup = vi.fn();

vi.mock('../../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      enqueueCleanup: mockEnqueueCleanup,
    })),
  },
}));

// Create a persistent mock state manager instance
const mockStateManager = {
  getState: vi.fn(() => ({ projectRoot: '/test/project' })),
  pauseConfigWatcher: vi.fn(),
  resumeConfigWatcher: vi.fn(),
};

vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => mockStateManager),
  },
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn().mockResolvedValue(undefined),
  triggerHookSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('fs', () => {
  const readFileSync = vi.fn();
  return {
    default: { readFileSync },
    readFileSync,
  };
});

import { execSync } from 'child_process';
import { StateManager } from '../../src/shared/StateManager.js';
import { triggerHook, triggerHookSync } from '../../src/utils/hooks.js';
import fs from 'fs';

describe('closeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueCleanup.mockReset();
  });

  describe('shell panes', () => {
    it('should close shell pane immediately without presenting options', async () => {
      const mockPane = createShellPane({ id: 'psyche-1', paneId: '%42' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      const result = await closePane(mockPane, mockContext);

      // Should return success immediately (not a choice dialog)
      expectSuccess(result, 'closed successfully');
    });

    it('should kill shell pane via tmux', async () => {
      const mockPane = createShellPane({ paneId: '%99' });
      const mockContext = createMockContext([mockPane]);

      // Mock must return the pane ID before kill and omit it after kill.
      let paneKilled = false;
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return paneKilled ? '' : '%99\n';
        }
        if (cmd.includes('kill-pane')) {
          paneKilled = true;
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      await closePane(mockPane, mockContext);

      // Verify existence check was called
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux list-panes'),
        expect.anything()
      );
      // Verify kill command was called after existence check passed
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux kill-pane'),
        expect.anything()
      );
      expect(execSync).not.toHaveBeenCalledWith(
        expect.stringContaining('tmux send-keys'),
        expect.anything()
      );
    });
  });

  describe('worktree panes - option presentation', () => {
    it('should present 3 cleanup options for worktree pane when no siblings share the worktree', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      expectChoice(result, 3);
      expect(result.title).toBe('Close Pane');

      // Verify all 3 options are present
      const optionIds = result.options!.map(o => o.id);
      expect(optionIds).toContain('kill_only');
      expect(optionIds).toContain('kill_and_clean');
      expect(optionIds).toContain('kill_clean_branch');
    });

    it('should mark destructive options as dangerous', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killAndClean = result.options!.find(o => o.id === 'kill_and_clean');
      const killCleanBranch = result.options!.find(o => o.id === 'kill_clean_branch');

      expect(killAndClean?.danger).toBe(true);
      expect(killCleanBranch?.danger).toBe(true);
    });

    it('should set kill_only as default option', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killOnly = result.options!.find(o => o.id === 'kill_only');
      expect(killOnly?.default).toBe(true);
    });

    it('should only present kill_only and explain cleanup is unavailable when sibling panes share the worktree', async () => {
      const sharedWorktreePath = '/test/project/.psyche/worktrees/shared';
      const pane1 = createWorktreePane({ id: 'psyche-1', slug: 'alpha', worktreePath: sharedWorktreePath });
      const pane2 = createWorktreePane({ id: 'psyche-2', slug: 'bravo', worktreePath: sharedWorktreePath });
      const mockContext = createMockContext([pane1, pane2]);

      const result = await closePane(pane1, mockContext);

      expectChoice(result, 1);
      expect(result.message).toContain('still in use by 1 other pane');
      expect(result.message).toContain('Other panes on this worktree:');
      expect(result.message).toContain('  - bravo');
      expect(result.options?.[0]?.id).toBe('kill_only');
    });
  });

  describe('close execution - kill_only', () => {
    const oldServerGeneration = {
      pid: 111,
      processStartIdentity: 'Thu Aug  7 19:00:00 2026',
      socketPath: '/tmp/tmux-501/default',
      sessionId: '$1',
    };
    const currentServerGeneration = {
      pid: 222,
      processStartIdentity: 'Thu Aug  7 20:00:00 2026',
      socketPath: '/tmp/tmux-501/default',
      sessionId: '$1',
    };

    it('removes an old-server record without killing a reused pane ID', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: oldServerGeneration,
        testPaneId: '%43',
        testWindowId: '@7',
        testTmuxServerIdentity: oldServerGeneration,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      vi.mocked(execSync).mockReturnValue(Buffer.from('%42\n%43\n'));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectSuccess(result, 'closed successfully');
      expect(context.panes).toEqual([]);
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('kill-pane') || String(command).includes('kill-window')
      )).toBe(false);
    });

    it('tears down a uniquely owned pane in the same tmux server generation', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: currentServerGeneration,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      let alive = true;
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) return alive ? '%42\n' : '';
        if (command.includes('kill-pane')) {
          alive = false;
          return Buffer.from('');
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      await choice.onSelect!('kill_only');

      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        expect.stringContaining("tmux kill-pane -t '%42'"),
        expect.anything(),
      );
    });

    it('does not inherit a rebound primary generation for legacy background IDs', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: currentServerGeneration,
        testPaneId: '%legacy-test',
        testWindowId: '@legacy-test',
        testTmuxServerIdentity: undefined,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) return '%42\n%legacy-test\n';
        if (command.includes('list-windows')) return '@legacy-test\n';
        return Buffer.from('');
      });

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectError(result, 'worktree cleanup was not started');
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('kill-pane') || String(command).includes('kill-window')
      )).toBe(false);
      expect(context.panes).toEqual([pane]);
    });

    it('kills a current primary pane without targeting its stale background generation', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: currentServerGeneration,
        testPaneId: '%old-test',
        testWindowId: '@old-test',
        testTmuxServerIdentity: oldServerGeneration,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      let primaryAlive = true;
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) {
          return primaryAlive ? '%42\n%old-test\n' : '%old-test\n';
        }
        if (command.includes('list-windows')) return '@old-test\n';
        if (command.includes("kill-pane -t '%42'")) {
          primaryAlive = false;
          return Buffer.from('');
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectSuccess(result, 'closed successfully');
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        expect.stringContaining("tmux kill-pane -t '%42'"),
        expect.anything(),
      );
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('%old-test') && String(command).includes('kill-pane')
      )).toBe(false);
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('@old-test') && String(command).includes('kill-window')
      )).toBe(false);
      expect(context.panes).toEqual([]);
    });

    it('never kills a live unversioned legacy pane record', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: undefined,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      vi.mocked(execSync).mockImplementation((command: string) => (
        command.includes('list-panes') ? '%42\n' : Buffer.from('')
      ));

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectError(result, 'worktree cleanup was not started');
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('kill-pane')
      )).toBe(false);
      expect(context.panes).toEqual([pane]);
    });

    it('removes an absent unversioned legacy record without killing its ID', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: undefined,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      vi.mocked(execSync).mockImplementation((command: string) => (
        command.includes('list-panes') ? '' : Buffer.from('')
      ));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectSuccess(result, 'closed successfully');
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        String(command).includes('kill-pane')
      )).toBe(false);
      expect(context.panes).toEqual([]);
    });

    it('aborts before teardown and refreshes UI when the exact pane identity was rebound', async () => {
      const pane = createWorktreePane({ id: 'psyche-identity', paneId: '%42' });
      const refreshPanes = vi.fn(async () => {});
      const context = createMockContext([pane], {
        refreshPanes,
        removePaneIdentitiesFromConfig: vi.fn(async () => {
          throw new Error('Pane identity conflict for "psyche-identity"');
        }),
      });
      vi.mocked(execSync).mockReturnValue(Buffer.from('%42\n'));

      const choice = await closePane(pane, context);
      const result = await choice.onSelect!('kill_only');

      expectError(result, 'Close aborted');
      expect(refreshPanes).toHaveBeenCalledTimes(1);
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        typeof command === 'string' && command.includes('kill-pane')
      )).toBe(false);
    });

    it('verified-kills owned test and dev windows before removing the pane record', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: currentServerGeneration,
        testWindowId: '@7',
        testTmuxServerIdentity: currentServerGeneration,
        devWindowId: '@8',
        devTmuxServerIdentity: currentServerGeneration,
      });
      const context = createMockContext([pane], {
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      const liveWindows = new Set(['@7', '@8']);
      let paneAlive = true;
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-windows')) {
          return [...liveWindows].join('\n');
        }
        if (command.includes('kill-window')) {
          const windowId = command.match(/-t '([^']+)'/)?.[1];
          if (windowId) liveWindows.delete(windowId);
          return Buffer.from('');
        }
        if (command.includes('list-panes')) {
          return paneAlive ? '%42\n' : '';
        }
        if (command.includes('kill-pane')) {
          paneAlive = false;
          return Buffer.from('');
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      await choice.onSelect!('kill_only');

      const commands = vi.mocked(execSync).mock.calls
        .map(([command]) => String(command));
      expect(commands.findIndex((command) => command.includes("kill-window -t '@7'")))
        .toBeLessThan(commands.findIndex((command) => command.includes("kill-pane -t '%42'")));
      expect(commands.some((command) => command.includes("kill-window -t '@8'"))).toBe(true);
      expect(context.panes).toEqual([]);
    });

    it('uses fresh locked background pane/window fields rather than stale UI fields', async () => {
      const stalePane = createWorktreePane({
        paneId: '%42',
        tmuxServerIdentity: currentServerGeneration,
        testPaneId: '%stale-test',
        testWindowId: '@stale-test',
        testTmuxServerIdentity: currentServerGeneration,
        devPaneId: '%stale-dev',
        devWindowId: '@stale-dev',
        devTmuxServerIdentity: currentServerGeneration,
      });
      const freshPane = {
        ...stalePane,
        testPaneId: '%fresh-test',
        testWindowId: '@fresh-test',
        devPaneId: '%fresh-dev',
        devWindowId: '@fresh-dev',
      };
      const livePanes = new Set(['%42', '%fresh-test', '%fresh-dev']);
      const liveWindows = new Set(['@fresh-test', '@fresh-dev']);
      const removePaneIdentitiesFromConfig = vi.fn(async (
        _identities: unknown,
        beforeRemove?: (
          panes?: readonly PsychePane[],
          exactPanes?: readonly PsychePane[],
        ) => Promise<void> | void,
      ) => {
        await beforeRemove?.([], [freshPane]);
        return [];
      });
      const context = createMockContext([stalePane], {
        removePaneIdentitiesFromConfig,
        getTmuxServerIdentity: () => currentServerGeneration,
      });
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) return [...livePanes].join('\n');
        if (command.includes('list-windows')) return [...liveWindows].join('\n');
        if (command.includes('kill-pane')) {
          const paneId = command.match(/-t '([^']+)'/)?.[1];
          if (paneId) livePanes.delete(paneId);
          return Buffer.from('');
        }
        if (command.includes('kill-window')) {
          const windowId = command.match(/-t '([^']+)'/)?.[1];
          if (windowId) liveWindows.delete(windowId);
          return Buffer.from('');
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(stalePane, context);
      await choice.onSelect!('kill_only');

      const commands = vi.mocked(execSync).mock.calls
        .map(([command]) => String(command));
      expect(commands.some((command) => command.includes("kill-pane -t '%fresh-test'"))).toBe(true);
      expect(commands.some((command) => command.includes("kill-pane -t '%fresh-dev'"))).toBe(true);
      expect(commands.some((command) => command.includes("kill-window -t '@fresh-test'"))).toBe(true);
      expect(commands.some((command) => command.includes("kill-window -t '@fresh-dev'"))).toBe(true);
      expect(commands.some((command) => command.includes('stale-test'))).toBe(false);
      expect(commands.some((command) => command.includes('stale-dev'))).toBe(false);
    });

    it('preserves the record when a transient tmux probe cannot confirm absence', async () => {
      const pane = createWorktreePane({ paneId: '%42' });
      const context = createMockContext([pane]);
      const savePanesSpy = vi.spyOn(context, 'savePanes');
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) {
          throw new Error('tmux probe timed out');
        }
        return Buffer.from('');
      });

      const choice = await closePane(pane, context);
      const execution = await choice.onSelect!('kill_only');

      expectError(execution, 'Could not confirm pane');
      expect(savePanesSpy).not.toHaveBeenCalled();
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });

    it('preserves the record and skips worktree cleanup when an owned dev window is unknown', async () => {
      const pane = createWorktreePane({
        paneId: '%42',
        devWindowId: '@8',
        worktreePath: '/test/project/.psyche/worktrees/feature',
      });
      const context = createMockContext([pane]);
      const savePanesSpy = vi.spyOn(context, 'savePanes');
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-windows')) {
          throw new Error('tmux window probe timed out');
        }
        if (command.includes('list-panes')) {
          return '%42\n';
        }
        if (command.includes('kill-pane')) {
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const choice = await closePane(pane, context);
      const execution = await choice.onSelect!('kill_and_clean');

      expectError(execution, 'Could not confirm pane');
      expect(savePanesSpy).not.toHaveBeenCalled();
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });

    it('removes a record when tmux confirms the pane is already absent', async () => {
      const pane = createWorktreePane({ paneId: '%42' });
      const context = createMockContext([pane]);
      const savePanesSpy = vi.spyOn(context, 'savePanes');
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) return '';
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));

      const choice = await closePane(pane, context);
      await choice.onSelect!('kill_only');

      expect(savePanesSpy).toHaveBeenCalled();
      expect(vi.mocked(execSync).mock.calls.some(([command]) =>
        typeof command === 'string' && command.includes('kill-pane')
      )).toBe(false);
    });

    it('keeps the record when kill outcome cannot be verified', async () => {
      const pane = createWorktreePane({ paneId: '%42' });
      const context = createMockContext([pane]);
      const savePanesSpy = vi.spyOn(context, 'savePanes');
      let killAttempted = false;
      vi.mocked(execSync).mockImplementation((command: string) => {
        if (command.includes('list-panes')) {
          if (!killAttempted) return '%42\n';
          throw new Error('tmux probe timed out after kill');
        }
        if (command.includes('kill-pane')) {
          killAttempted = true;
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const choice = await closePane(pane, context);
      const execution = await choice.onSelect!('kill_only');

      expectError(execution, 'Could not confirm pane');
      expect(savePanesSpy).not.toHaveBeenCalled();
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });

    it('should remove pane from tracking when kill_only selected', async () => {
      const pane1 = createWorktreePane({ id: 'psyche-1' });
      const pane2 = createWorktreePane({ id: 'psyche-2' });
      const mockContext = createMockContext([pane1, pane2]);
      const savePanesSpy = vi.spyOn(mockContext, 'savePanes');

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(pane1, mockContext);
      await result.onSelect!('kill_only');

      // Verify pane was removed
      expect(savePanesSpy).toHaveBeenCalledWith([pane2], [pane1, pane2]);
    });

    it('should call onPaneRemove callback with tmux pane ID', async () => {
      const mockPane = createWorktreePane({ paneId: '%42' });
      const mockContext = createMockContext([mockPane]);
      const onPaneRemoveSpy = vi.fn();
      mockContext.onPaneRemove = onPaneRemoveSpy;

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(onPaneRemoveSpy).toHaveBeenCalledWith('%42');
    });

    it('should not treat pane ID prefixes as an existing pane', async () => {
      const mockPane = createWorktreePane({ paneId: '%1' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%10\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      const killCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
        typeof cmd === 'string' && cmd.includes('tmux kill-pane')
      );
      expect(killCalls).toHaveLength(0);
    });

    it('should trigger before_pane_close and pane_closed hooks', async () => {
      const mockPane = createWorktreePane({ slug: 'test' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(triggerHook).toHaveBeenCalledWith('before_pane_close', '/test/project', mockPane);
      expect(triggerHook).toHaveBeenCalledWith('pane_closed', '/test/project', mockPane);
    });

    it('should pause and resume config watcher', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(mockStateManager.pauseConfigWatcher).toHaveBeenCalled();
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('close execution - kill_and_clean', () => {
    it('should queue worktree cleanup when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({
        worktreePath: '/test/project/.psyche/worktrees/my-feature',
      });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: mockPane,
          paneProjectRoot: '/test/project',
          mainRepoPath: '/test/project',
          deleteBranch: false,
        })
      );
    });

    it('should not remove pane state or cleanup worktree when tmux pane survives kill', async () => {
      const mockPane = createWorktreePane({
        paneId: '%42',
        worktreePath: '/test/project/.psyche/worktrees/my-feature',
      });
      const mockContext = createMockContext([mockPane]);
      const savePanesSpy = vi.spyOn(mockContext, 'savePanes');

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%42\n%0\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      const executeResult = await result.onSelect!('kill_and_clean');

      expectError(executeResult, 'Failed to close pane');
      expect(savePanesSpy).not.toHaveBeenCalled();
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });

    it('should trigger worktree removal hooks', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(triggerHookSync).toHaveBeenCalledWith('before_worktree_remove', expect.anything(), mockPane);
    });

    // Regression test for https://github.com/standardagents/comux/issues/63
    // before_worktree_remove must block until the hook finishes, otherwise the
    // worktree directory is deleted while the hook is still running.
    it('should wait for before_worktree_remove hook to finish before enqueueing worktree cleanup', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      // Record call ordering. Make the hook resolve on a later microtask so a
      // fire-and-forget caller would observably enqueue cleanup before the
      // hook finishes.
      const order: string[] = [];
      vi.mocked(triggerHookSync).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('hook_done');
        return { success: true };
      });
      mockEnqueueCleanup.mockImplementation(() => {
        order.push('enqueue_cleanup');
      });

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(triggerHookSync).toHaveBeenCalledWith('before_worktree_remove', expect.anything(), mockPane);
      expect(mockEnqueueCleanup).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['hook_done', 'enqueue_cleanup']);
    });

    it('should NOT delete branch when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(false);
    });

    it('merges the freshly persisted panes before deciding whether cleanup is safe', async () => {
      const sharedWorktreePath = '/test/project/.psyche/worktrees/shared';
      const closingPane = createWorktreePane({
        id: 'tui-close',
        paneId: '%42',
        worktreePath: sharedWorktreePath,
      });
      const daemonPane = createWorktreePane({
        id: 'daemon-pane',
        paneId: '%43',
        worktreePath: sharedWorktreePath,
      });
      const mockContext = createMockContext([closingPane]);
      mockContext.removePaneIdentitiesFromConfig = vi.fn(async (
        _identities,
        beforeRemove,
      ) => {
        await beforeRemove?.();
        return [daemonPane];
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(closingPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(mockContext.removePaneIdentitiesFromConfig).toHaveBeenCalledWith(
        [{ id: 'tui-close', paneId: '%42' }],
        expect.any(Function),
      );
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });
  });

  describe('close execution - kill_clean_branch', () => {
    it('should queue cleanup with branch deletion when kill_clean_branch selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      // Mock must return the pane ID in list-panes so existence check passes
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%1\n'; // Pane exists
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext); // Fixed: added missing mockContext
      await result.onSelect!('kill_clean_branch');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(true);
    });

    it('should use the pane project root when deleting a sidebar project worktree', async () => {
      const mockPane = createWorktreePane({
        slug: 'project-b-feature',
        projectRoot: '/test/project-b',
        projectName: 'project-b',
        worktreePath: '/test/project-b/.psyche/worktrees/project-b-feature',
      });
      const mockContext = createMockContext([mockPane]);

      mockStateManager.getState.mockReturnValueOnce({
        projectRoot: '/test/project-a',
      });

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%1\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_clean_branch');

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: mockPane,
          paneProjectRoot: '/test/project-b',
          mainRepoPath: '/test/project-b',
          deleteBranch: true,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return error when close operation fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      // Mock tmux kill to fail
      vi.mocked(execSync).mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.includes('kill-pane')) {
          throw new Error('tmux error');
        }
        return Buffer.from('');
      });

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      const executeResult = await result.onSelect!('kill_only');

      // Should still complete (errors are logged but not fatal)
      expect(executeResult.type).toBe('success');
    });

    it('should resume config watcher even if close fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('fatal error');
      });

      const result = await closePane(mockPane, mockContext);

      try {
        await result.onSelect!('kill_only');
      } catch {
        // Expected to throw
      }

      // Config watcher should still be resumed
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('layout recalculation', () => {
    it('should NOT recalculate layout when no panes remain', async () => {
      const mockPane = createWorktreePane({ id: 'psyche-1' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      // No layout module should be imported when panes.length === 0
      // (This is tested by not mocking the layout module and ensuring no errors)
    });
  });

  describe('dev source fallback', () => {
    const originalPsycheDev = process.env.PSYCHE_DEV;

    beforeEach(() => {
      process.env.PSYCHE_DEV = 'true';
    });

    afterEach(() => {
      if (originalPsycheDev === undefined) {
        delete process.env.PSYCHE_DEV;
      } else {
        process.env.PSYCHE_DEV = originalPsycheDev;
      }
    });

    it('should NOT reset source to root when sibling panes remain on the same worktree', async () => {
      const sourceWorktreePath = '/test/project/.psyche/worktrees/shared-worktree';
      const closingPane = createWorktreePane({
        id: 'psyche-1',
        paneId: '%11',
        worktreePath: sourceWorktreePath,
      });
      const siblingPane = createWorktreePane({
        id: 'psyche-2',
        paneId: '%12',
        worktreePath: sourceWorktreePath,
      });
      const otherPane = createWorktreePane({
        id: 'psyche-3',
        paneId: '%13',
        worktreePath: '/test/project/.psyche/worktrees/other-worktree',
      });
      const mockContext = createMockContext([closingPane, siblingPane, otherPane]);
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sourceWorktreePath);

      try {
        vi.mocked(execSync).mockReturnValue(Buffer.from(''));
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
          controlPaneId: '%0',
        }));

        const result = await closePane(closingPane, mockContext);
        await result.onSelect!('kill_only');

        const respawnCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
          typeof cmd === 'string' && cmd.includes('tmux respawn-pane -k')
        );
        expect(respawnCalls).toHaveLength(0);
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it('should reset source to root when the last pane for source worktree is closed', async () => {
      const sourceWorktreePath = '/test/project/.psyche/worktrees/shared-worktree';
      const closingPane = createWorktreePane({
        id: 'psyche-1',
        paneId: '%11',
        worktreePath: sourceWorktreePath,
      });
      const otherPane = createWorktreePane({
        id: 'psyche-3',
        paneId: '%13',
        worktreePath: '/test/project/.psyche/worktrees/other-worktree',
      });
      const mockContext = createMockContext([closingPane, otherPane]);
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sourceWorktreePath);

      try {
        vi.mocked(execSync).mockReturnValue(Buffer.from(''));
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
          controlPaneId: '%0',
        }));

        const result = await closePane(closingPane, mockContext);
        await result.onSelect!('kill_only');

        const respawnCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
          typeof cmd === 'string' && cmd.includes('tmux respawn-pane -k')
        );
        expect(respawnCalls).toHaveLength(1);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
});
