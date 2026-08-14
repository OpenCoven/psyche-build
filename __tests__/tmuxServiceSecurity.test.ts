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

  it('shell-quotes pane titles and pane IDs', async () => {
    await TmuxService.getInstance().setPaneTitle(
      "%1'; touch /tmp/id-injection; #",
      "title'; touch /tmp/title-injection; #",
    );

    expect(execSyncMock).toHaveBeenCalledWith(
      "tmux select-pane -t '%1'\\''; touch /tmp/id-injection; #' -T 'title'\\''; touch /tmp/title-injection; #'",
      expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
    );
  });
});
