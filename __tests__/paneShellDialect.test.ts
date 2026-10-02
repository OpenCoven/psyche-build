import { describe, expect, it, vi } from 'vitest';
import {
  describePromptBootstrapSkipped,
  paneShellDialectForCommand,
  reportPromptBootstrapSkipped,
  resolvePaneShell,
  type PaneShellProbeOptions,
} from '../src/utils/paneShellDialect.js';

/** A fake clock that advances only when the probe sleeps. */
function fakeClock(): PaneShellProbeOptions & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}
import { exitRecorderSyntaxForPaneCommand } from '../src/utils/agentLaunchOutcome.js';

const PANE_COMMANDS = [
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash', '-zsh', '/bin/bash', 'ZSH', ' fish ', 'fish', '-fish',
  'nu', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'node', 'claude', '', undefined,
];

describe('paneShellDialectForCommand', () => {
  it.each(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash', '-zsh', '/bin/bash', 'ZSH'])('reads %j as posix', (command) => {
    expect(paneShellDialectForCommand(command)).toBe('posix');
  });

  it.each(['fish', '-fish', ' fish '])('reads %j as fish', (command) => {
    expect(paneShellDialectForCommand(command)).toBe('fish');
  });

  it.each(['nu', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'node', '', undefined])(
    'has no dialect for %j',
    (command) => {
      expect(paneShellDialectForCommand(command)).toBeNull();
    },
  );

  // The exit recorder and the prompt bootstrap must agree on every pane.
  it.each(PANE_COMMANDS.map((command) => [command]))('agrees with the exit recorder for %j', (command) => {
    expect(exitRecorderSyntaxForPaneCommand(command)).toBe(paneShellDialectForCommand(command));
  });
});

describe('resolvePaneShell', () => {
  it('resolves a known shell on the first read without sleeping', async () => {
    const clock = fakeClock();
    await expect(resolvePaneShell(async () => 'zsh', clock)).resolves.toEqual({ dialect: 'posix', paneCommand: 'zsh' });
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    ['nu'], ['tcsh'], ['xonsh'],
  ])('reports %j as an unrecognized shell at once, without polling', async (command) => {
    const clock = fakeClock();
    const read = vi.fn(async () => command);
    await expect(resolvePaneShell(read, clock)).resolves.toMatchObject({
      dialect: null,
      reason: 'unrecognized_shell',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    ['vim', 'not_a_shell'],
    ['claude', 'not_a_shell'],
    ['', 'unreadable_shell'],
  ])('reports %j as %s after polling for a bounded time', async (command, reason) => {
    const clock = fakeClock();
    const read = vi.fn(async () => command);
    await expect(resolvePaneShell(read, { ...clock, timeoutMs: 1_000, intervalMs: 200 })).resolves.toMatchObject({
      dialect: null,
      reason,
    });
    expect(clock.sleeps).toEqual([200, 200, 200, 200, 200]);
    expect(read).toHaveBeenCalledTimes(6);
  });

  // An rc file running a foreground program (fastfetch) hides the shell for a
  // moment; the probe must wait it out and stop at the first real shell.
  it('waits out an rc-file program and stops at the first recognized shell', async () => {
    const clock = fakeClock();
    const read = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('fastfetch')
      .mockResolvedValueOnce('fastfetch')
      .mockResolvedValueOnce('fish')
      .mockResolvedValue('zsh');
    await expect(resolvePaneShell(read, clock)).resolves.toEqual({ dialect: 'fish', paneCommand: 'fish' });
    expect(read).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toHaveLength(2);
  });

  // A frozen or stalled clock (tests freeze Date.now) must not turn the probe
  // into an endless loop: the attempt count bounds it on its own.
  it('stops after a bounded number of reads even when the clock never moves', async () => {
    const sleeps: number[] = [];
    const read = vi.fn(async () => 'fastfetch');
    await resolvePaneShell(read, {
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps.length).toBe(15);
    expect(read).toHaveBeenCalledTimes(16);
  });

  it('never polls past the default three-second bound', async () => {
    const clock = fakeClock();
    await resolvePaneShell(async () => 'fastfetch', clock);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(3_000);
    expect(clock.sleeps.every((ms) => ms >= 150 && ms <= 250)).toBe(true);
  });

  it('reports a persistent read error as unreadable without throwing', async () => {
    const clock = fakeClock();
    await expect(resolvePaneShell(async () => {
      throw new Error('tmux busy');
    }, clock)).resolves.toMatchObject({ dialect: null, reason: 'unreadable_shell' });
  });

  it('recovers from a transient read error', async () => {
    const clock = fakeClock();
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('tmux busy'))
      .mockResolvedValue('bash');
    await expect(resolvePaneShell(read, clock)).resolves.toMatchObject({ dialect: 'posix' });
  });

  // A hung or slow tmux read must neither stall the probe past its bound nor
  // block the event loop while it waits (#519).
  it('bounds a hung read and lets other work run while it waits', async () => {
    const read = vi.fn(() => new Promise<string>(() => {}));
    const started = Date.now();
    let timerFiredDuringRead = false;
    let settled = false;
    setTimeout(() => {
      timerFiredDuringRead = !settled;
    }, 10);
    const result = await resolvePaneShell(read, {
      timeoutMs: 300,
      intervalMs: 50,
      readTimeoutMs: 100,
    });
    settled = true;
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ dialect: null, reason: 'unreadable_shell' });
    expect(timerFiredDuringRead).toBe(true);
    // Total bound: probe window plus at most one read's budget.
    expect(elapsed).toBeLessThan(300 + 100 + 250);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('abandons a slow read at its budget and resolves from the next one', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve('vim'), 5_000).unref?.();
      }))
      .mockResolvedValue('zsh');
    const started = Date.now();
    await expect(resolvePaneShell(read, {
      timeoutMs: 1_000,
      intervalMs: 20,
      readTimeoutMs: 50,
    })).resolves.toEqual({ dialect: 'posix', paneCommand: 'zsh' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports a missing reader as unreadable', async () => {
    await expect(resolvePaneShell(undefined)).resolves.toMatchObject({
      dialect: null,
      reason: 'unreadable_shell',
    });
  });
});

describe('reportPromptBootstrapSkipped', () => {
  it('logs once and shows one warning toast with the bounded message', async () => {
    const logWarn = vi.fn();
    const showToast = vi.fn();
    await reportPromptBootstrapSkipped('opencode', 'not_a_shell', 'agentLaunch', '%1', { logWarn, showToast });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('[initial_prompt_skipped:not_a_shell]'),
      'agentLaunch',
      '%1',
    );
    expect(showToast).toHaveBeenCalledWith(describePromptBootstrapSkipped('opencode', 'not_a_shell'));
  });

  it('never throws when reporting fails', async () => {
    await expect(reportPromptBootstrapSkipped('opencode', 'unreadable_shell', 'x', '%1', {
      logWarn: () => {
        throw new Error('log down');
      },
    })).resolves.toBeUndefined();
  });
});

describe('describePromptBootstrapSkipped', () => {
  it('is bounded to the agent id and closed reason', () => {
    const message = describePromptBootstrapSkipped('opencode', 'unrecognized_shell');
    expect(message).toContain('opencode');
    expect(message.length).toBeLessThan(300);
    expect(describePromptBootstrapSkipped('x'.repeat(500), 'unreadable_shell').length).toBeLessThan(300);
    for (const reason of ['unrecognized_shell', 'not_a_shell', 'unreadable_shell', 'prompt_file_unwritable'] as const) {
      expect(describePromptBootstrapSkipped('opencode', reason)).toMatch(/^opencode was launched without its initial prompt: .+\.$/u);
    }
  });
});
