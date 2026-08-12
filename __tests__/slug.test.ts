import { beforeEach, describe, expect, it, vi } from 'vitest';

const runProcessMock = vi.fn();
vi.mock('../src/utils/runProcess.js', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args),
}));

import { generateSlug } from '../src/utils/slug.js';

describe('slug generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('falls back to timestamp when no providers available', async () => {
    runProcessMock.mockRejectedValue(new Error('claude unavailable'));

    const slug = await generateSlug('');
    expect(slug.startsWith('psyche-')).toBe(true);
  });

  it('sends a hostile prompt to Claude over stdin without shell interpolation', async () => {
    runProcessMock.mockResolvedValue({
      stdout: 'refactor-psyche\n',
      stderr: '',
      exitCode: 0,
    });
    const hostilePrompt = '$(touch sentinel) `backtick` "quote"; newline\n--leading-dash';

    const slug = await generateSlug(hostilePrompt);

    expect(slug).toBe('refactor-psyche');
    expect(runProcessMock).toHaveBeenCalledWith('claude', expect.objectContaining({
      args: ['--no-interactive', '--max-turns', '1'],
      input: expect.stringContaining(hostilePrompt),
      timeoutMs: 5000,
    }));
  });
});
