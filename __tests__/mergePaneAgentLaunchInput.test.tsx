import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

const execSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const launchMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  launchMock.mockReset();
});

describe('MergePane agent resolution', () => {
  // Between submit and the agent taking over the terminal, the launch is in
  // flight; Esc there must not cancel the pane while the agent still starts.
  it('ignores Esc once the agent launch has started', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === 'merge') {
        throw Object.assign(new Error('merge failed'), { stderr: 'Automatic merge failed; fix conflicts' });
      }
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

  // The commit message comes back from a model and the branch names come from
  // Git, so a shell must never see either of them.
  it('passes the generated commit message and branch names to Git as argv, never a shell line', async () => {
    const hostileMessage = 'fix: "$(touch /tmp/psyche-injected)" `id` \\';
    const hostileBranch = 'topic-$(id)';
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ choices: [{ message: { content: hostileMessage } }] }),
    })));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => (
      args[0] === 'status' ? ' M src/file.ts\n' : ''
    ));

    const { unmount } = render(
      <MergePane
        pane={{
          id: 'p1',
          slug: 'feature-x',
          branchName: hostileBranch,
          prompt: 'build x',
          paneId: '%3',
          worktreePath: '/repo/.psyche/worktrees/feature-x',
        }}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
        mainBranch="main"
      />,
    );
    try {
      await sleep(60);

      const gitCalls = execFileSyncMock.mock.calls.map(([file, args, options]) => ({
        file,
        args,
        cwd: (options as { cwd?: string }).cwd,
      }));
      expect(gitCalls).toContainEqual({
        file: 'git',
        args: ['commit', '-m', hostileMessage],
        cwd: '/repo/.psyche/worktrees/feature-x',
      });
      expect(gitCalls).toContainEqual({
        file: 'git',
        args: ['checkout', '--end-of-options', 'main'],
        cwd: '/repo',
      });
      expect(gitCalls).toContainEqual({
        file: 'git',
        args: ['merge', '--no-ff', '--end-of-options', hostileBranch],
        cwd: '/repo',
      });
      expect(gitCalls.every((call) => call.file === 'git')).toBe(true);
      expect(execSyncMock).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
