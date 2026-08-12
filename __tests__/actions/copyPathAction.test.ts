/**
 * Unit tests for copyPathAction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyPath } from '../../src/actions/implementations/copyPathAction.js';
import { createMockPane, createShellPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectSuccess, expectError, expectInfo } from '../helpers/actionAssertions.js';

const runProcessMock = vi.fn();
vi.mock('../../src/utils/runProcess.js', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args),
}));

describe('copyPathAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runProcessMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('should copy worktree path to clipboard successfully', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/project/.psyche/worktrees/my-feature',
    });
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith('pbcopy', {
      input: '/test/project/.psyche/worktrees/my-feature',
    });

    // Verify success result with path in message
    expectSuccess(result, '/test/project/.psyche/worktrees/my-feature');
  });

  it('should return error for shell pane without worktree', async () => {
    const mockPane = createShellPane();
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should return error for pane without worktreePath', async () => {
    const mockPane = createMockPane({ worktreePath: undefined });
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should fallback to info message when clipboard copy fails', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    // Mock clipboard command failure
    runProcessMock.mockRejectedValue(new Error('pbcopy not found'));

    const result = await copyPath(mockPane, mockContext);

    // Should still return success but as info (showing path instead of copying)
    expectInfo(result, '/test/path');
  });

  it('should handle paths with special characters', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/project name with spaces/.psyche/worktrees/my-feature',
    });
    const mockContext = createMockContext([mockPane]);

    await copyPath(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith('pbcopy', {
      input: '/test/project name with spaces/.psyche/worktrees/my-feature',
    });
  });

  it('should handle very long paths', async () => {
    const longPath = '/very/long/path/'.repeat(20) + 'worktree';
    const mockPane = createMockPane({ worktreePath: longPath });
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expectSuccess(result);
    expect(result.message).toContain(longPath);
  });

  it('sends shell metacharacters to pbcopy as exact stdin bytes', async () => {
    const hostilePath = '$(touch sentinel) `backtick` "quote"; newline\n--leading-dash';
    const mockPane = createMockPane({ worktreePath: hostilePath });
    const mockContext = createMockContext([mockPane]);

    await copyPath(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith('pbcopy', { input: hostilePath });
  });
});
