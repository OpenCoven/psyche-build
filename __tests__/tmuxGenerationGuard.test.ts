import { describe, expect, it, vi } from 'vitest';
import { tearDownGenerationBoundPane } from '../src/utils/TmuxGenerationGuard.js';

describe('tmux generation guard', () => {
  it('treats allocation-time generation mismatch as uncertain', async () => {
    const expected = {
      pid: 111,
      processStartIdentity: 'old-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    };
    const current = {
      pid: 222,
      processStartIdentity: 'new-start',
      socketPath: '/tmux.sock',
      sessionId: '$2',
    };
    const killPane = vi.fn();

    const result = await tearDownGenerationBoundPane({
      getServerIdentity: () => current,
      probePanePresence: vi.fn(async () => 'present'),
      killPane,
    }, '%7', expected, { generationMismatch: 'unknown' } as never);

    expect(result.presence).toBe('unknown');
    expect(killPane).not.toHaveBeenCalled();
  });
});
