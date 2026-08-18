import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
}));

import { TmuxService } from '../src/services/TmuxService.js';

describe('TmuxService command construction', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('');
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
