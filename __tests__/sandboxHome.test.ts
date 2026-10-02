import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('test home sandbox', () => {
  it('resolves the home directory to the throwaway sandbox', () => {
    const sandbox = process.env.PSYCHE_TEST_HOME;
    expect(sandbox).toBeTruthy();
    expect(os.homedir()).toBe(sandbox);
    expect(os.homedir()).not.toBe(process.env.PSYCHE_REAL_HOME);
  });

  it('keeps per-user config directories inside the sandbox', () => {
    const sandbox = process.env.PSYCHE_TEST_HOME as string;
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      const value = process.env[key] as string;
      expect(path.relative(sandbox, value).startsWith('..'), key).toBe(false);
    }
  });

  it('detaches tests from a live tmux session', () => {
    expect(process.env.TMUX).toBeUndefined();
  });
});
