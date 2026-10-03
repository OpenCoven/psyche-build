import { describe, expect, it, vi } from 'vitest';
import { sendPromptViaTmux } from '../src/utils/agentPromptDispatch.js';

const PROMPT = "Fix the 'auth' bug\nthen run $(tests)";

/**
 * A fake tmux that records every call with its arguments. Nothing here runs
 * tmux; `foreground` scripts what `#{pane_current_command}` reports per read.
 */
function fakeTmux(foreground: Array<string | Error>, overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let reads = 0;
  const tmux = {
    calls,
    getPaneBracketPasteFlag: vi.fn(async (paneId: string) => {
      calls.push(['getPaneBracketPasteFlag', paneId]);
      return true;
    }),
    getPaneCurrentCommand: vi.fn(async (paneId: string) => {
      calls.push(['getPaneCurrentCommand', paneId]);
      const next = foreground[Math.min(reads, foreground.length - 1)];
      reads += 1;
      if (next instanceof Error) throw next;
      return next;
    }),
    sendTmuxKeys: vi.fn(async (paneId: string, keys: string) => {
      calls.push(['sendTmuxKeys', paneId, keys]);
    }),
    loadBufferFromStdin: vi.fn(async (name: string, content: string) => {
      // The content is the stdin payload, not an argument; record its length only.
      calls.push(['loadBufferFromStdin', name, `<stdin:${content.length}>`]);
    }),
    pasteBufferAndDelete: vi.fn(async (name: string, paneId: string) => {
      calls.push(['pasteBufferAndDelete', name, paneId]);
    }),
    deleteBuffer: vi.fn(async (name: string) => {
      calls.push(['deleteBuffer', name]);
    }),
    ...overrides,
  };
  return tmux;
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

function send(tmux: ReturnType<typeof fakeTmux>, extra: Record<string, unknown> = {}) {
  const clock = fakeClock();
  return sendPromptViaTmux({
    paneId: '%3',
    prompt: PROMPT,
    tmuxService: tmux as never,
    expectedCommand: 'cline',
    baselineCommand: 'zsh',
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  });
}

describe('sendPromptViaTmux (#523)', () => {
  it('loads the prompt over stdin and pastes it with -d; the prompt is in no tmux argument', async () => {
    const tmux = fakeTmux(['zsh', 'cline']);

    await expect(send(tmux)).resolves.toEqual({ delivered: true });

    expect(tmux.loadBufferFromStdin).toHaveBeenCalledWith(expect.stringMatching(/^psyche-prompt-/), PROMPT);
    const bufferName = tmux.loadBufferFromStdin.mock.calls[0][0];
    expect(tmux.pasteBufferAndDelete).toHaveBeenCalledWith(bufferName, '%3');
    expect(tmux.sendTmuxKeys).toHaveBeenCalledWith('%3', 'Enter');
    // Every recorded argument (the stdin payload is recorded only as a length).
    expect(JSON.stringify(tmux.calls)).not.toContain('auth');
    for (const call of tmux.sendTmuxKeys.mock.calls) {
      expect(call[1]).not.toContain('auth');
    }
    // paste-buffer -d already deleted it; no second delete on success.
    expect(tmux.deleteBuffer).not.toHaveBeenCalled();
  });

  it('sends pre-prompt keys, then the paste, then the submit keys, in order', async () => {
    const tmux = fakeTmux(['crush']);

    await send(tmux, {
      expectedCommand: 'crush',
      prePromptKeys: ['Escape', 'Tab'],
      submitKeys: ['Enter'],
    });

    const order = tmux.calls
      .filter(([name]) => name !== 'getPaneCurrentCommand' && name !== 'getPaneBracketPasteFlag')
      .map(([name, ...rest]) => (name === 'sendTmuxKeys' ? rest[1] : name));
    expect(order).toEqual(['Escape', 'Tab', 'loadBufferFromStdin', 'pasteBufferAndDelete', 'Enter']);
  });

  it('does not paste blindly when the agent never takes the foreground', async () => {
    // The shell never hands off: the agent is missing or failed to start.
    const tmux = fakeTmux(['zsh']);

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'agent_not_ready' });

    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
    expect(tmux.pasteBufferAndDelete).not.toHaveBeenCalled();
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalled();
  });

  it('does not paste when the pane cannot be read at all', async () => {
    const tmux = fakeTmux([new Error('no server')]);

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'agent_not_ready' });
    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
  });

  it('bounds the readiness wait', async () => {
    const tmux = fakeTmux(['zsh']);
    const clock = fakeClock();

    await sendPromptViaTmux({
      paneId: '%3',
      prompt: PROMPT,
      tmuxService: tmux as never,
      expectedCommand: 'cline',
      baselineCommand: 'zsh',
      startupTimeoutMs: 1_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(clock.now()).toBeLessThanOrEqual(1_100);
    expect(tmux.getPaneCurrentCommand.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('does not paste into the shell when the agent exits during the ready delay', async () => {
    // Agent appears, then the shell is back by the time the delay ends.
    const tmux = fakeTmux(['cline', 'zsh']);

    await expect(send(tmux, { readyDelayMs: 500 })).resolves.toEqual({
      delivered: false,
      reason: 'agent_not_ready',
    });
    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
  });

  it('deletes the buffer and reports when load-buffer fails, without pasting', async () => {
    const tmux = fakeTmux(['cline'], {
      loadBufferFromStdin: vi.fn(async () => {
        throw new Error('tmux load-buffer failed');
      }),
    });

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'prompt_paste_failed' });
    expect(tmux.pasteBufferAndDelete).not.toHaveBeenCalled();
    expect(tmux.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalledWith('%3', 'Enter');
  });

  it('deletes the buffer and does not submit when paste-buffer fails', async () => {
    const tmux = fakeTmux(['cline'], {
      pasteBufferAndDelete: vi.fn(async () => {
        throw new Error('tmux paste-buffer failed');
      }),
    });

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'prompt_paste_failed' });
    expect(tmux.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalledWith('%3', 'Enter');
  });

  it('still resolves when the cleanup delete also fails', async () => {
    const tmux = fakeTmux(['cline'], {
      loadBufferFromStdin: vi.fn(async () => {
        throw new Error('tmux load-buffer failed');
      }),
      deleteBuffer: vi.fn(async () => {
        throw new Error('tmux delete-buffer failed');
      }),
    });

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'prompt_paste_failed' });
  });
  // #523 review, finding 1: the bridge used to sample the baseline after the
  // launch line, so the baseline could be the agent itself. An agent that then
  // exits to its shell must not count as "changed from baseline".
  it('does not paste when the baseline was the agent and the pane falls back to a shell', async () => {
    const tmux = fakeTmux(['zsh']);

    await expect(send(tmux, { baselineCommand: 'cline', expectedCommand: 'cline' })).resolves.toEqual({
      delivered: false,
      reason: 'agent_not_ready',
    });
    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
    expect(tmux.pasteBufferAndDelete).not.toHaveBeenCalled();
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalled();
  });

  it.each(['sh', 'dash', 'bash', '-zsh', 'fish', 'nu', 'tmux'])(
    'never treats %s as the agent, even when it differs from the baseline',
    async (foreground) => {
      const tmux = fakeTmux([foreground]);
      await expect(send(tmux, { baselineCommand: '2.1.288', expectedCommand: 'claude' })).resolves.toEqual({
        delivered: false,
        reason: 'agent_not_ready',
      });
      expect(tmux.sendTmuxKeys).not.toHaveBeenCalled();
    },
  );

  it('accepts a shell-named foreground only when it is the expected command', async () => {
    const tmux = fakeTmux(['sh']);
    await expect(send(tmux, { expectedCommand: 'sh' })).resolves.toEqual({ delivered: true });
  });

  // Finding 3: the agent can exit after the ready recheck. The foreground is
  // read again right before paste-buffer and before every submit key.
  it('abandons before paste-buffer when the agent exits after load-buffer', async () => {
    // wait, recheck, then the pre-paste read sees the shell.
    const tmux = fakeTmux(['cline', 'cline', 'zsh']);

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'agent_not_ready' });
    expect(tmux.pasteBufferAndDelete).not.toHaveBeenCalled();
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalledWith('%3', 'Enter');
    expect(tmux.sendTmuxKeys).toHaveBeenCalledWith('%3', 'C-u');
    expect(tmux.deleteBuffer).toHaveBeenCalledWith(tmux.loadBufferFromStdin.mock.calls[0][0]);
  });

  it('clears the line and never submits when the agent exits after the paste', async () => {
    // wait, recheck, pre-paste read: agent; pre-submit read: shell.
    const tmux = fakeTmux(['cline', 'cline', 'cline', 'zsh']);

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'agent_not_ready' });
    expect(tmux.pasteBufferAndDelete).toHaveBeenCalledTimes(1);
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalledWith('%3', 'Enter');
    expect(tmux.sendTmuxKeys).toHaveBeenCalledWith('%3', 'C-u');
    expect(tmux.deleteBuffer).toHaveBeenCalledTimes(1);
  });

  it('re-reads the foreground before every submit key', async () => {
    // Two submit keys: the agent exits between them.
    const tmux = fakeTmux(['crush', 'crush', 'crush', 'crush', 'zsh']);

    await expect(send(tmux, { expectedCommand: 'crush', submitKeys: ['Enter', 'Enter'] })).resolves.toEqual({
      delivered: false,
      reason: 'agent_not_ready',
    });
    const enters = tmux.sendTmuxKeys.mock.calls.filter(([, key]) => key === 'Enter');
    expect(enters).toHaveLength(1);
    expect(tmux.sendTmuxKeys).toHaveBeenLastCalledWith('%3', 'C-u');
  });

  // Finding 4: without bracketed paste, tmux turns each LF into CR and every
  // line would be submitted on its own.
  it('withholds a multi-line prompt when the agent has not enabled bracketed paste', async () => {
    const tmux = fakeTmux(['cline'], {
      getPaneBracketPasteFlag: vi.fn(async () => false),
    });

    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'prompt_paste_unsafe_multiline' });
    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
    expect(tmux.pasteBufferAndDelete).not.toHaveBeenCalled();
    expect(tmux.sendTmuxKeys).not.toHaveBeenCalledWith('%3', 'Enter');
  });

  it('treats an unreadable bracketed-paste flag as disabled for a multi-line prompt', async () => {
    const tmux = fakeTmux(['cline'], {
      getPaneBracketPasteFlag: vi.fn(async () => {
        throw new Error('tmux display-message failed');
      }),
    });
    await expect(send(tmux)).resolves.toEqual({ delivered: false, reason: 'prompt_paste_unsafe_multiline' });
    expect(tmux.loadBufferFromStdin).not.toHaveBeenCalled();
  });

  it('pastes a single-line prompt without needing bracketed paste', async () => {
    const tmux = fakeTmux(['cline'], {
      getPaneBracketPasteFlag: vi.fn(async () => false),
    });
    await expect(send(tmux, { prompt: 'one line only' })).resolves.toEqual({ delivered: true });
    expect(tmux.getPaneBracketPasteFlag).not.toHaveBeenCalled();
  });
});
