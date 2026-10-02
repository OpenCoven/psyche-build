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

    const { stdin, unmount } = render(
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
      await sleep(30);
      stdin.write('a');
      await sleep(30);
      stdin.write('\r');
      await sleep(30);
      expect(launchMock).toHaveBeenCalledTimes(1);

      stdin.write(ESC);
      await sleep(60);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
