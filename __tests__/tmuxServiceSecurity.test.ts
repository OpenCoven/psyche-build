import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
}));

import { TmuxService } from '../src/services/TmuxService.js';

describe('TmuxService command construction', () => {
  beforeEach(() => {
    execSyncMock.mockClear();
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
});
