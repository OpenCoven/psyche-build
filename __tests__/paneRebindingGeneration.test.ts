import { describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const replacementGeneration = {
  pid: 222,
  processStartIdentity: 'replacement-start',
  socketPath: '/tmux.sock',
  sessionId: '$2',
};

vi.mock('../src/services/TmuxServerIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/services/TmuxServerIdentity.js')
  >();
  return {
    ...actual,
    getCurrentTmuxServerIdentity: vi.fn(() => replacementGeneration),
  };
});

describe('pane rebinding generation', () => {
  it('treats a reused existing pane ID from a replacement server as missing', async () => {
    const { rebindAndFilterPanes } = await import('../src/hooks/usePaneSync.js');
    const pane: PsychePane = {
      id: 'psyche-1',
      slug: 'feature',
      prompt: '',
      paneId: '%7',
      tmuxServerIdentity: {
        pid: 111,
        processStartIdentity: 'original-start',
        socketPath: '/tmux.sock',
        sessionId: '$1',
      },
      worktreePath: '/repo/.psyche/worktrees/feature',
      type: 'worktree',
    };

    const result = rebindAndFilterPanes(
      [pane],
      new Map([['feature', '%7']]),
      ['%7'],
      false,
    );

    expect(result.worktreePanesToRecreate).toEqual([pane]);
  });

  it('rebinds repeated managed labels by their distinct reserved slugs after reload', async () => {
    const { rebindAndFilterPanes } = await import('../src/hooks/usePaneSync.js');
    const panes: PsychePane[] = [
      {
        id: 'psyche-1',
        slug: 'fix-bug',
        displayName: 'Fix bug · fix-bug',
        prompt: '',
        paneId: '%7',
        worktreePath: '/repo/.psyche/worktrees/fix-bug',
        type: 'worktree',
      },
      {
        id: 'psyche-2',
        slug: 'fix-bug-2',
        displayName: 'Fix bug · fix-bug-2',
        prompt: '',
        paneId: '%8',
        worktreePath: '/repo/.psyche/worktrees/fix-bug-2',
        type: 'worktree',
      },
    ];

    const result = rebindAndFilterPanes(
      panes,
      new Map([
        ['Fix bug · fix-bug', '%17'],
        ['Fix bug · fix-bug-2', '%18'],
      ]),
      ['%17', '%18'],
      true,
    );

    expect(result.activePanes.map((pane) => pane.paneId)).toEqual(['%17', '%18']);
    expect(result.worktreePanesToRecreate).toEqual([]);
  });
});
