/**
 * Unit tests for openInEditorAction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultEditor, openInEditor } from '../../src/actions/implementations/openInEditorAction.js';
import { createMockPane, createShellPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectSuccess, expectError } from '../helpers/actionAssertions.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const runProcessMock = vi.fn();
vi.mock('../../src/utils/runProcess.js', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args),
}));

describe('openInEditorAction', () => {
  const originalEnv = process.env;
  const sentinelPath = path.join(process.cwd(), '.editor-shell-sentinel');

  beforeEach(() => {
    vi.clearAllMocks();
    runProcessMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(sentinelPath, { force: true });
  });

  it('should default to Xcode on macOS and code elsewhere', () => {
    expect(getDefaultEditor('darwin')).toBe('xed');
    expect(getDefaultEditor('linux')).toBe('code');
    expect(getDefaultEditor('win32')).toBe('code');
  });

  it('should open worktree in default editor', async () => {
    delete process.env.EDITOR;
    const mockPane = createMockPane({
      worktreePath: '/test/worktree/path',
    });
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith(getDefaultEditor(), {
      args: ['/test/worktree/path'],
      timeoutMs: 0,
    });
    expectSuccess(result, getDefaultEditor());
  });

  it('should use EDITOR environment variable when set', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith('vim', { args: ['/test/path'], timeoutMs: 0 });
    expectSuccess(result, 'vim');
  });

  it('should use custom editor from params', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext, { editor: 'emacs' });

    expect(runProcessMock).toHaveBeenCalledWith('emacs', { args: ['/test/path'], timeoutMs: 0 });
    expectSuccess(result, 'emacs');
  });

  it('should prioritize params editor over EDITOR env', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    await openInEditor(mockPane, mockContext, { editor: 'nano' });

    expect(runProcessMock).toHaveBeenCalledWith('nano', { args: ['/test/path'], timeoutMs: 0 });
  });

  it('should return error for shell pane without worktree', async () => {
    const mockPane = createShellPane();
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should return error when editor command fails', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    runProcessMock.mockRejectedValue(new Error('editor not found'));

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'Failed to open');
  });

  it('should handle paths with spaces and special characters', async () => {
    delete process.env.EDITOR;
    const mockPane = createMockPane({
      worktreePath: '/test/path with spaces/worktree',
    });
    const mockContext = createMockContext([mockPane]);

    await openInEditor(mockPane, mockContext);

    expect(runProcessMock).toHaveBeenCalledWith(getDefaultEditor(), {
      args: ['/test/path with spaces/worktree'],
      timeoutMs: 0,
    });
  });

  it('should support various editor commands', async () => {
    const editors = ['nvim', 'subl', 'atom', 'idea', 'webstorm'];
    const mockPane = createMockPane({ worktreePath: '/test' });
    const mockContext = createMockContext([mockPane]);

    for (const editor of editors) {
      vi.clearAllMocks();
      runProcessMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await openInEditor(mockPane, mockContext, { editor });

      expect(runProcessMock).toHaveBeenCalledWith(editor, { args: ['/test'], timeoutMs: 0 });
    }
  });

  it('rejects whitespace-bearing editor command strings without executing them', async () => {
    process.env.EDITOR = `code --wait; $(touch ${sentinelPath})`;
    const mockPane = createMockPane({ worktreePath: '/test/path' });
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'single executable path');
    expect(runProcessMock).not.toHaveBeenCalled();
    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });
});
