import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn(() => ''));
const execFileSyncMock = vi.hoisted(() => vi.fn(
  (_file: string, _args: readonly string[], _options?: unknown): string => '',
));
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
  execFile: execFileMock,
}));

import { TmuxService } from '../src/services/TmuxService.js';

describe('TmuxService command construction', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('');
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('');
    execFileMock.mockReset();
  });

  const SYNC_OPTIONS = expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' });

  /** The argv of every synchronous tmux call, in order. */
  const tmuxArgv = (): string[][] => execFileSyncMock.mock.calls.map(
    ([file, args]) => {
      expect(file).toBe('tmux');
      return [...args];
    },
  );

  it('passes pane titles and pane IDs as whole arguments across async and sync title APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const title = "title'; $(touch /tmp/title-injection) `id`; #";
    const expectedArgs = ['select-pane', '-t', paneId, '-T', title];

    await TmuxService.getInstance().setPaneTitle(paneId, title);
    TmuxService.getInstance().setPaneTitleSync(paneId, title);

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  // The pane-shell probe polls this read; one hung tmux call must not stall a
  // launch past the probe's bound (#508), and must not block the daemon's
  // event loop while it waits (#519).
  describe('pane current-command read', () => {
    it('runs tmux without a shell, passing the pane id as one argv entry, with a one-second timeout', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, 'zsh\n', '');
      });
      const paneId = "%1'; touch /tmp/id-injection; #";
      await expect(TmuxService.getInstance().getPaneCurrentCommand(paneId)).resolves.toBe('zsh');
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['display-message', '-t', paneId, '-p', '#{pane_current_command}'],
        expect.objectContaining({ timeout: 1_000 }),
        expect.any(Function),
      );
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('does not retry a timed-out read, so one read costs at most its timeout', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        const error = Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT', killed: true });
        cb(error, '', '');
      });
      await expect(TmuxService.getInstance().getPaneCurrentCommand('%1')).rejects.toThrow(/ETIMEDOUT/);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('lets timers fire while the read is outstanding', async () => {
      let finish: ExecFileCallback | undefined;
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        finish = cb;
      });
      let timerFired = false;
      const read = TmuxService.getInstance().getPaneCurrentCommand('%1');
      await new Promise<void>((resolve) => setTimeout(() => {
        timerFired = true;
        resolve();
      }, 5));
      expect(timerFired).toBe(true);
      expect(finish).toBeDefined();
      finish?.(null, 'bash\n', '');
      await expect(read).resolves.toBe('bash');
    });
  });

  it('passes pane IDs as whole arguments across async and sync pane selection APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const expectedArgs = ['select-pane', '-t', paneId];

    await TmuxService.getInstance().selectPane(paneId);
    TmuxService.getInstance().selectPaneSync(paneId);

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('passes pane IDs as whole arguments across async and sync pane kill APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const expectedArgs = ['kill-pane', '-t', paneId];

    await TmuxService.getInstance().killPane(paneId);
    TmuxService.getInstance().killPaneSync(paneId);

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'tmux', expectedArgs, SYNC_OPTIONS);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  // Every value below would run a command if a shell parsed it. Each must
  // reach tmux as one argument, byte for byte, and no shell may run at all.
  describe('shell-free command construction', () => {
    const HOSTILE = "x'; $(touch /tmp/psyche-injected) `id` \"; #";

    it('types a shell command as one send-keys argument after the end-of-flags marker', async () => {
      await TmuxService.getInstance().sendShellCommand('%1', HOSTILE);

      expect(tmuxArgv()).toEqual([['send-keys', '-t', '%1', '--', HOSTILE]]);
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('sends each key or text element as its own argument', async () => {
      await TmuxService.getInstance().sendKeys('%1', [HOSTILE, 'Enter']);
      await TmuxService.getInstance().sendTmuxKeys('%1', 'C-c  Enter');

      expect(tmuxArgv()).toEqual([
        ['send-keys', '-t', '%1', '--', HOSTILE, 'Enter'],
        ['send-keys', '-t', '%1', '--', 'C-c', 'Enter'],
      ]);
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('escapes a trailing semicolon so tmux cannot read it as a command separator', async () => {
      await TmuxService.getInstance().sendKeys('%1', ['echo done;', ';', 'kill-server']);
      TmuxService.getInstance().setPaneOptionSync('%1', '@psyche_title', 'value;');

      expect(tmuxArgv()).toEqual([
        ['send-keys', '-t', '%1', '--', 'echo done\\;', '\\;', 'kill-server'],
        ['set-option', '-p', '-t', '%1', '@psyche_title', 'value\\;'],
      ]);
    });

    it('passes a working directory and a start command to split-window as arguments', async () => {
      const cwd = '/tmp/dir $(touch /tmp/psyche-injected)';

      await TmuxService.getInstance().splitPane({ targetPane: '%1', cwd, command: HOSTILE });
      TmuxService.getInstance().splitPaneSync({ cwd });

      expect(tmuxArgv()).toEqual([
        ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', '%1', '-c', cwd, '--', HOSTILE],
        ['split-window', '-h', '-P', '-F', '#{pane_id}', '-c', cwd],
      ]);
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('passes names, layouts, option values, formats and commands as arguments', async () => {
      const service = TmuxService.getInstance();

      await service.newWindow({ name: HOSTILE, detached: true });
      await service.respawnPane('%1', HOSTILE);
      await service.selectLayout(HOSTILE);
      service.selectLayoutSync(HOSTILE);
      await service.setOption('@psyche_option', HOSTILE);
      service.setGlobalOptionSync('@psyche_option', HOSTILE);
      service.setWindowOptionSync('@psyche_option', HOSTILE);
      service.setSessionOptionSync(HOSTILE, '@psyche_option', HOSTILE);
      service.getSessionOptionSync(HOSTILE, '@psyche_option');
      service.listPanesSync(HOSTILE);
      await service.loadBufferFromFile('psyche-buffer', HOSTILE);

      expect(tmuxArgv()).toEqual([
        ['new-window', '-d', '-n', HOSTILE, '-P', '-F', '#{window_id}'],
        ['respawn-pane', '-k', '-t', '%1', '--', HOSTILE],
        ['select-layout', HOSTILE],
        ['select-layout', HOSTILE],
        ['set-option', '-g', '@psyche_option', HOSTILE],
        ['set-option', '-g', '@psyche_option', HOSTILE],
        ['set-window-option', '@psyche_option', HOSTILE],
        ['set', '-t', HOSTILE, '@psyche_option', HOSTILE],
        ['show', '-t', HOSTILE, '@psyche_option'],
        ['list-panes', '-F', HOSTILE],
        ['load-buffer', '-b', 'psyche-buffer', HOSTILE],
      ]);
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('checks for a window and counts panes without a shell pipeline', async () => {
      execFileSyncMock.mockImplementation((_file: string, args: readonly string[]) => (
        args[0] === 'list-windows' ? '@1\n@10\n' : '0: [80x24] %0 (active)\n1: [80x24] %1\n'
      ));
      const service = TmuxService.getInstance();

      await expect(service.windowExists('@10')).resolves.toBe(true);
      await expect(service.windowExists('@100')).resolves.toBe(false);
      await expect(service.windowExists('@')).resolves.toBe(false);
      await expect(service.getPaneCount()).resolves.toBe(2);
      expect(execSyncMock).not.toHaveBeenCalled();
    });
  });

  it('stops a send-keys retry when ownership is lost during the retry delay', async () => {
    vi.useFakeTimers();
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('transient tmux failure');
    });
    const capturedTarget = '%old';
    let currentTarget = capturedTarget;

    try {
      const result = TmuxService.getInstance().sendKeys(capturedTarget, ['Enter'], {
        isCurrent: () => currentTarget === capturedTarget,
      });
      await Promise.resolve();
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);

      currentTarget = '%new';
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toBe(false);
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      expect(tmuxArgv().flat()).not.toContain('%new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps normal send-keys retry behavior without an ownership guard', async () => {
    vi.useFakeTimers();
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('transient tmux failure');
      })
      .mockReturnValue('');

    try {
      const result = TmuxService.getInstance().sendKeys('%1', ['Enter']);
      await Promise.resolve();
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toBeUndefined();
      expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A shell reported a missing tmux as `command not found`, which was never
  // retried. Without a shell the same condition is a spawn ENOENT.
  it('does not retry when there is no tmux binary to run', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' });
    });

    await expect(TmuxService.getInstance().getCurrentPaneId()).rejects.toThrow(/ENOENT/);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('reports aggregate pane option write failure instead of returning success-shaped output', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('invalid pane');
    });

    const success = TmuxService.getInstance().setPaneOptionsSync([
      { paneId: '%1', option: '@psyche_title_prefix', value: 'first' },
      { paneId: '%invalid', option: '@psyche_title_prefix', value: 'middle' },
      { paneId: '%3', option: '@psyche_title_prefix', value: 'later' },
    ]);

    expect(success).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('batches set and unset pane option mutations into one successful tmux call', () => {
    const success = TmuxService.getInstance().updatePaneOptionsSync([
      { paneId: '%1', option: '@psyche_title_prefix', value: "one's" },
      { paneId: '%2', option: '@psyche_title_label', unset: true },
    ]);

    expect(success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'tmux',
      [
        'set-option', '-p', '-t', '%1', '@psyche_title_prefix', "one's",
        ';',
        'set-option', '-u', '-p', '-t', '%2', '@psyche_title_label',
      ],
      SYNC_OPTIONS,
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });
  // #523: an agent prompt is protected data. The paste path must never place
  // it in the argv of tmux or of a shell, nor in a logged command line.
  describe('argv-free prompt paste', () => {
    const PROMPT = "secret prompt with 'quotes' and\nnewlines $(whoami)";

    function stdinCapturingChild(stdinChunks: string[]) {
      return {
        stdin: {
          on: vi.fn(),
          end: vi.fn((chunk?: string) => {
            if (chunk !== undefined) stdinChunks.push(String(chunk));
          }),
        },
      };
    }

    it('loads the buffer from stdin: the prompt is in no argv and no shell runs', async () => {
      const stdinChunks: string[] = [];
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        setImmediate(() => cb(null, '', ''));
        return stdinCapturingChild(stdinChunks);
      });

      await TmuxService.getInstance().loadBufferFromStdin('psyche-prompt-1', PROMPT);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(file).toBe('tmux');
      expect(args).toEqual(['load-buffer', '-b', 'psyche-prompt-1', '-']);
      expect(JSON.stringify(execFileMock.mock.calls)).not.toContain('secret prompt');
      expect(stdinChunks.join('')).toBe(PROMPT);
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('rejects without echoing the prompt when load-buffer fails', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        setImmediate(() => cb(new Error('Command failed: tmux load-buffer -b psyche-prompt-1 -'), '', ''));
        return stdinCapturingChild([]);
      });

      const error = await TmuxService.getInstance()
        .loadBufferFromStdin('psyche-prompt-1', PROMPT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain('secret prompt');
    });

    it('pastes with bracketed-paste markers and deletes the buffer in the same tmux command', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        setImmediate(() => cb(null, '', ''));
        return stdinCapturingChild([]);
      });

      await TmuxService.getInstance().pasteBufferAndDelete('psyche-prompt-1', '%7');

      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['paste-buffer', '-d', '-p', '-b', 'psyche-prompt-1', '-t', '%7'],
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function),
      );
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('deletes a named buffer without a shell', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        setImmediate(() => cb(null, '', ''));
        return stdinCapturingChild([]);
      });

      await TmuxService.getInstance().deleteBuffer('psyche-prompt-1');

      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['delete-buffer', '-b', 'psyche-prompt-1'],
        expect.anything(),
        expect.any(Function),
      );
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('reads #{bracket_paste_flag} without a shell and treats only "1" as enabled', async () => {
      for (const [stdout, expected] of [['1\n', true], ['0\n', false], ['\n', false]] as const) {
        execFileMock.mockReset();
        execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
          cb(null, stdout, '');
        });
        await expect(TmuxService.getInstance().getPaneBracketPasteFlag('%7')).resolves.toBe(expected);
        expect(execFileMock).toHaveBeenCalledWith(
          'tmux',
          ['display-message', '-t', '%7', '-p', '#{bracket_paste_flag}'],
          expect.objectContaining({ timeout: 1_000 }),
          expect.any(Function),
        );
      }
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('no longer offers set-buffer, which put the content on a shell command line', () => {
      expect((TmuxService.getInstance() as unknown as Record<string, unknown>).setBuffer).toBeUndefined();
    });
  });
});
