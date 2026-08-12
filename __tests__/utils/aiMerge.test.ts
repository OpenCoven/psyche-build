import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const runProcessMock = vi.fn();
vi.mock('../../src/utils/runProcess.js', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args),
}));

import { generateCommitMessage } from '../../src/utils/aiMerge.js';

describe('AI merge utilities', () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENROUTER_API_KEY;
    execFileSyncMock.mockReturnValue('diff --git a/file.ts b/file.ts\n+change');
    runProcessMock.mockResolvedValue({
      stdout: 'fix: preserve literal input\n',
      stderr: '',
      exitCode: 0,
    });
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  it('passes the commit-message prompt to Claude over stdin', async () => {
    const message = await generateCommitMessage('/repo');

    expect(message).toBe('fix: preserve literal input');
    expect(runProcessMock).toHaveBeenCalledWith('claude', expect.objectContaining({
      args: ['--no-interactive', '--max-turns', '1'],
      input: expect.stringContaining('diff --git a/file.ts b/file.ts'),
      timeoutMs: 15000,
    }));
  });
});
