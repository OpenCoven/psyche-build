import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_EXIT_PANE_OPTION,
  buildAgentExitRecorderSuffix,
  classifyAgentLaunchExit,
  createAgentExitRecorder,
  describeAgentLaunchFailure,
  exitRecorderSyntaxForPaneCommand,
  observeAgentLaunch,
  parseRecordedAgentExit,
  watchAgentLaunch,
} from '../src/utils/agentLaunchOutcome.js';

const NONCE = '0a1b2c3d';

describe('agent exit recorder', () => {
  it('records the agent exit status on the pane after a POSIX shell runs it', () => {
    const suffix = buildAgentExitRecorderSuffix({ nonce: NONCE }, 'posix');

    expect(suffix).toBe(
      `; tmux set-option -p -t "$TMUX_PANE" ${AGENT_EXIT_PANE_OPTION} "${NONCE}:$?" 2>/dev/null`,
    );
  });

  it('uses $status under fish, which has no $?', () => {
    const suffix = buildAgentExitRecorderSuffix({ nonce: NONCE }, 'fish');

    expect(suffix).toContain(`"${NONCE}:$status"`);
    expect(suffix).not.toContain('$?');
  });

  it('refuses a nonce that could escape the typed command', () => {
    expect(() => buildAgentExitRecorderSuffix({ nonce: '"; rm -rf ~; "' }, 'posix')).toThrow();
  });

  it('creates an eight-hex-digit nonce per launch', () => {
    const first = createAgentExitRecorder();
    const second = createAgentExitRecorder();

    expect(first.nonce).toMatch(/^[a-f0-9]{8}$/u);
    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe('exitRecorderSyntaxForPaneCommand', () => {
  it.each(['sh', 'bash', 'zsh', 'dash', 'ksh', '-zsh', '/bin/bash', 'ZSH'])(
    'uses $? for the POSIX-status shell %j',
    (paneCommand) => {
      expect(exitRecorderSyntaxForPaneCommand(paneCommand)).toBe('posix');
    },
  );

  it('uses $status for fish', () => {
    expect(exitRecorderSyntaxForPaneCommand('fish')).toBe('fish');
    expect(exitRecorderSyntaxForPaneCommand('-fish')).toBe('fish');
  });

  // A shell that would reject the suffix must get none, or the whole typed
  // line fails and the agent never starts.
  it.each(['nu', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'node', 'claude', '', undefined])(
    'refuses to arm the recorder for %j',
    (paneCommand) => {
      expect(exitRecorderSyntaxForPaneCommand(paneCommand)).toBeNull();
    },
  );
});

describe('parseRecordedAgentExit', () => {
  it('reads an exit status recorded by this launch', () => {
    expect(parseRecordedAgentExit(`${NONCE}:127\n`, NONCE)).toBe(127);
  });

  it('ignores a status recorded by a different launch in the same pane', () => {
    expect(parseRecordedAgentExit('ffffffff:1', NONCE)).toBeNull();
  });

  it.each([undefined, '', 'garbage', `${NONCE}:`, `${NONCE}:256`, `${NONCE}:-1`, `${NONCE}:1 extra`])(
    'fails closed on %j',
    (raw) => {
      expect(parseRecordedAgentExit(raw, NONCE)).toBeNull();
    },
  );
});

describe('classifyAgentLaunchExit', () => {
  it('does not classify a clean exit as a launch failure', () => {
    expect(classifyAgentLaunchExit(0)).toBeNull();
  });

  // Raw-mode TUIs receive Ctrl-C as a keystroke and exit 130 themselves, so
  // the recorder does run; an operator cancelling is not a failed launch.
  it('does not classify an operator cancel (exit 130) as a launch failure', () => {
    expect(classifyAgentLaunchExit(130)).toBeNull();
  });

  it.each([
    [127, 'command_not_found', 'check_agent_install'],
    [126, 'not_executable', 'check_agent_install'],
    [1, 'failed', 'retry_launch'],
    [2, 'failed', 'retry_launch'],
    [137, 'terminated_by_signal', 'retry_launch'],
  ] as const)('classifies exit %i as %s with next action %s', (code, exit, nextAction) => {
    expect(classifyAgentLaunchExit(code)).toEqual({
      state: 'agent_launch_failed',
      exit,
      exitCode: code,
      nextAction,
      shellPreserved: true,
    });
  });
});

describe('describeAgentLaunchFailure', () => {
  it('names the agent, the bounded cause, and the next action without terminal content', () => {
    const failure = classifyAgentLaunchExit(127)!;
    const message = describeAgentLaunchFailure(failure, 'Claude Code');

    expect(message).toContain('Claude Code');
    expect(message).toContain('not found');
    expect(message).toContain('shell is still open');
    expect(message.length).toBeLessThanOrEqual(256);
    expect(message).not.toMatch(/\//u);
  });

  it('tells the operator to retry for an ordinary failure', () => {
    const message = describeAgentLaunchFailure(classifyAgentLaunchExit(1)!, 'Codex');

    expect(message).toContain('exit 1');
    expect(message.toLowerCase()).toContain('relaunch');
  });
});

describe('observeAgentLaunch', () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: vi.fn(async (ms: number) => {
        now += ms;
      }),
    };
  }

  it('classifies an exit recorded inside the launch window', async () => {
    const time = clock();
    const reads = [undefined, '', `${NONCE}:127`];
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption: async () => reads.shift(),
      windowMs: 5_000,
      intervalMs: 500,
      ...time,
    });

    expect(result?.exit).toBe('command_not_found');
    expect(time.sleep).toHaveBeenCalledTimes(2);
  });

  it('reports nothing for an agent still running when the window closes', async () => {
    const time = clock();
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption: async () => undefined,
      windowMs: 2_000,
      intervalMs: 500,
      ...time,
    });

    expect(result).toBeNull();
    expect(time.now()).toBeGreaterThanOrEqual(2_000);
  });

  it('reports nothing for an agent that exits cleanly', async () => {
    const time = clock();
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption: async () => `${NONCE}:0`,
      ...time,
    });

    expect(result).toBeNull();
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it('ignores an exit that a slow read only returns after the window', async () => {
    const time = clock();
    const readExitOption = vi.fn(async () => {
      // The read itself takes longer than the whole window.
      await time.sleep(6_000);
      return `${NONCE}:127`;
    });
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption,
      windowMs: 5_000,
      intervalMs: 500,
      now: time.now,
      sleep: async () => {},
    });

    expect(result).toBeNull();
    expect(readExitOption).toHaveBeenCalledTimes(1);
  });

  it('starts no read once the clock has passed the deadline', async () => {
    const time = clock();
    const readExitOption = vi.fn(async () => undefined);
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption,
      windowMs: 1_000,
      intervalMs: 400,
      now: time.now,
      // A late wake-up jumps the clock past the deadline.
      sleep: async () => {
        await time.sleep(5_000);
      },
    });

    expect(result).toBeNull();
    expect(readExitOption).toHaveBeenCalledTimes(1);
  });

  it('accepts an exit read at the deadline itself', async () => {
    const time = clock();
    const reads = [undefined, undefined, `${NONCE}:1`];
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption: async () => reads.shift(),
      windowMs: 1_000,
      intervalMs: 500,
      ...time,
    });

    expect(result?.exit).toBe('failed');
    expect(time.now()).toBe(1_000);
  });

  it('stops early once the pane no longer exists', async () => {
    const time = clock();
    const readExitOption = vi.fn(async () => {
      throw new Error("Command failed: tmux show-options\ncan't find pane: %9");
    });
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption,
      windowMs: 20_000,
      ...time,
    });

    expect(result).toBeNull();
    expect(readExitOption).toHaveBeenCalledTimes(1);
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it('keeps observing through a failed read rather than guessing', async () => {
    const time = clock();
    let calls = 0;
    const result = await observeAgentLaunch({
      nonce: NONCE,
      readExitOption: async () => {
        calls += 1;
        if (calls === 1) throw new Error('tmux busy');
        return `${NONCE}:1`;
      },
      ...time,
    });

    expect(result?.exit).toBe('failed');
  });
});

describe('watchAgentLaunch', () => {
  const instant = { sleep: async () => {} };

  it('reports a failed launch once with its bounded message', async () => {
    const onFailure = vi.fn();
    await watchAgentLaunch({
      nonce: NONCE,
      agentLabel: 'OpenCode',
      readExitOption: async () => `${NONCE}:1`,
      onFailure,
      ...instant,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    const [failure, message] = onFailure.mock.calls[0];
    expect(failure).toMatchObject({ state: 'agent_launch_failed', exit: 'failed' });
    expect(message).toContain('OpenCode did not start');
  });

  it('stays silent for a clean exit', async () => {
    const onFailure = vi.fn();
    await watchAgentLaunch({
      nonce: NONCE,
      agentLabel: 'OpenCode',
      readExitOption: async () => `${NONCE}:0`,
      onFailure,
      ...instant,
    });

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('swallows a reporter failure instead of rejecting into pane creation', async () => {
    await expect(watchAgentLaunch({
      nonce: NONCE,
      agentLabel: 'OpenCode',
      readExitOption: async () => `${NONCE}:127`,
      onFailure: () => {
        throw new Error('toast unavailable');
      },
      ...instant,
    })).resolves.toBeUndefined();
  });
});
