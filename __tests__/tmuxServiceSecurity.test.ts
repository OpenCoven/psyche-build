import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn(() => ''));
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
  execFile: execFileMock,
}));

import { TmuxService } from '../src/services/TmuxService.js';

describe('TmuxService command construction', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('');
    execFileMock.mockReset();
  });

  it('shell-quotes pane titles and pane IDs across async and sync title APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const title = "title'; touch /tmp/title-injection; #";
    const expectedCommand =
      "tmux select-pane -t '%1'\\''; touch /tmp/id-injection; #' -T 'title'\\''; touch /tmp/title-injection; #'";

    await TmuxService.getInstance().setPaneTitle(paneId, title);
    TmuxService.getInstance().setPaneTitleSync(paneId, title);

    expect(execSyncMock).toHaveBeenNthCalledWith(
      1,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      2,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
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

  it('shell-quotes pane IDs across async and sync pane selection APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const expectedCommand =
      "tmux select-pane -t '%1'\\''; touch /tmp/id-injection; #'";

    await TmuxService.getInstance().selectPane(paneId);
    TmuxService.getInstance().selectPaneSync(paneId);

    expect(execSyncMock).toHaveBeenNthCalledWith(
      1,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      2,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
  });

  it('shell-quotes pane IDs across async and sync pane kill APIs', async () => {
    const paneId = "%1'; touch /tmp/id-injection; #";
    const expectedCommand =
      "tmux kill-pane -t '%1'\\''; touch /tmp/id-injection; #'";

    await TmuxService.getInstance().killPane(paneId);
    TmuxService.getInstance().killPaneSync(paneId);

    expect(execSyncMock).toHaveBeenNthCalledWith(
      1,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      2,
      expectedCommand,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
  });

  it('stops a send-keys retry when ownership is lost during the retry delay', async () => {
    vi.useFakeTimers();
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('transient tmux failure');
    });
    const capturedTarget = '%old';
    let currentTarget = capturedTarget;

    try {
      const result = TmuxService.getInstance().sendKeys(capturedTarget, "'Enter'", {
        isCurrent: () => currentTarget === capturedTarget,
      });
      await Promise.resolve();
      expect(execSyncMock).toHaveBeenCalledTimes(1);

      currentTarget = '%new';
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toBe(false);
      expect(execSyncMock).toHaveBeenCalledTimes(1);
      expect(execSyncMock).not.toHaveBeenCalledWith(
        expect.stringContaining('%new'),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps normal send-keys retry behavior without an ownership guard', async () => {
    vi.useFakeTimers();
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('transient tmux failure');
      })
      .mockReturnValue('');

    try {
      const result = TmuxService.getInstance().sendKeys('%1', "'Enter'");
      await Promise.resolve();
      expect(execSyncMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toBeUndefined();
      expect(execSyncMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports aggregate pane option write failure instead of returning success-shaped output', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('invalid pane');
    });

    const success = TmuxService.getInstance().setPaneOptionsSync([
      { paneId: '%1', option: '@psyche_title_prefix', value: 'first' },
      { paneId: '%invalid', option: '@psyche_title_prefix', value: 'middle' },
      { paneId: '%3', option: '@psyche_title_prefix', value: 'later' },
    ]);

    expect(success).toBe(false);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('batches set and unset pane option mutations into one successful tmux call', () => {
    const success = TmuxService.getInstance().updatePaneOptionsSync([
      { paneId: '%1', option: '@psyche_title_prefix', value: "one's" },
      { paneId: '%2', option: '@psyche_title_label', unset: true },
    ]);

    expect(success).toBe(true);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).toHaveBeenCalledWith(
      "tmux set-option -p -t '%1' @psyche_title_prefix 'one'\\''s' \\; set-option -u -p -t '%2' @psyche_title_label",
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
  });
});
