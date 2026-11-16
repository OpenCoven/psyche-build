import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

const execSyncMock = vi.hoisted(() => vi.fn());
const launchMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
}));

vi.mock('../src/utils/mergeConflictAgentLaunch.js', () => ({
  launchMergeConflictAgent: launchMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: class {
    getSettings() {
      return {};
    }
  },
}));

import MergePane from '../src/components/panes/MergePane.js';

const ESC = String.fromCharCode(27);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WAIT = { timeout: 5_000, interval: 20 };

afterEach(() => {
  vi.restoreAllMocks();
  execSyncMock.mockReset();
  launchMock.mockReset();
});

describe('MergePane agent resolution', () => {
  // Between submit and the agent taking over the terminal, the launch is in
  // flight; Esc there must not cancel the pane while the agent still starts.
  it('ignores Esc once the agent launch has started', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    execSyncMock.mockImplementation((command: string) => {
      if (command.startsWith('git merge')) {
        throw Object.assign(new Error('merge failed'), { stderr: 'Automatic merge failed; fix conflicts' });
      }
      if (command === 'git status --porcelain') return '';
      return '';
    });
    launchMock.mockImplementation(() => new Promise(() => {}));
    const onCancel = vi.fn();

    const { stdin, lastFrame, unmount } = render(
      <MergePane
        pane={{
          id: 'p1',
          slug: 'feature-x',
          prompt: 'build x',
          paneId: '%3',
          worktreePath: '/repo/.psyche/worktrees/feature-x',
        }}
        onComplete={vi.fn()}
        onCancel={onCancel}
        mainBranch="main"
      />,
    );
    try {
      // Each step waits for what it needs instead of for a fixed 30 ms, which a
      // loaded runner does not always give the render. A key that arrives
      // before the pane is ready for it is dropped, so it is sent again.
      await vi.waitFor(() => {
        if (!lastFrame()?.includes('Enter prompt for agent')) {
          stdin.write('a');
          throw new Error('the agent prompt is not shown yet');
        }
      }, WAIT);
      await vi.waitFor(() => {
        if (launchMock.mock.calls.length === 0) {
          stdin.write('\r');
          throw new Error('the agent launch has not started yet');
        }
      }, WAIT);
      expect(launchMock).toHaveBeenCalledTimes(1);

      stdin.write(ESC);
      // Nothing to wait for: the assertion is that nothing happens.
      await sleep(60);
      expect(onCancel).not.toHaveBeenCalled();
      expect(launchMock).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });
});
