import { describe, expect, it } from 'vitest';
import type { PsychePane } from '../src/types.js';
import { mergePaneSnapshots } from '../src/hooks/usePaneSync.js';

const oldGeneration = {
  pid: 111,
  processStartIdentity: 'old-start',
  socketPath: '/tmux.sock',
  sessionId: '$1',
};
const newGeneration = {
  pid: 222,
  processStartIdentity: 'new-start',
  socketPath: '/tmux.sock',
  sessionId: '$2',
};

function pane(overrides: Partial<PsychePane> = {}): PsychePane {
  return {
    id: 'psyche-1',
    slug: 'feature',
    prompt: '',
    paneId: '%1',
    tmuxServerIdentity: oldGeneration,
    ...overrides,
  };
}

describe('pane snapshot lifecycle CAS', () => {
  it('does not overwrite a replacement record from a stale snapshot update', () => {
    const previous = pane({ testStatus: 'running' });
    const next = pane({ testStatus: 'failed' });
    const replacement = pane({
      paneId: '%2',
      tmuxServerIdentity: newGeneration,
      testStatus: 'passed',
    });

    expect(mergePaneSnapshots([replacement], [previous], [next]))
      .toEqual([replacement]);
  });

  it('does not delete a replacement record from a stale snapshot removal', () => {
    const previous = pane();
    const replacement = pane({
      paneId: '%2',
      tmuxServerIdentity: newGeneration,
    });

    expect(mergePaneSnapshots([replacement], [previous], []))
      .toEqual([replacement]);
  });
});
