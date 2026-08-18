import { describe, expect, it } from 'vitest';
import { shouldMonitorPaneForStatusTracking } from '../src/services/PaneWorkerManager.js';
import { getPaneMonitorSignature } from '../src/hooks/useAgentStatus.js';

describe('pane status monitoring eligibility', () => {
  it('monitors worktree panes with an attached agent', () => {
    expect(
      shouldMonitorPaneForStatusTracking({
        type: 'worktree',
        agent: 'claude',
      })
    ).toBe(true);
  });

  it('does not monitor shell panes', () => {
    expect(
      shouldMonitorPaneForStatusTracking({
        type: 'shell',
        agent: undefined,
      })
    ).toBe(false);
  });

  it('does not monitor worktree panes without an attached agent', () => {
    expect(
      shouldMonitorPaneForStatusTracking({
        type: 'worktree',
        agent: undefined,
      })
    ).toBe(false);
  });

  it('refreshes monitoring when the tmux pane behind the same Psyche pane changes', () => {
    const original = {
      id: 'pane-a',
      paneId: '%1',
    };
    const replacement = {
      id: 'pane-a',
      paneId: '%2',
    };

    expect(getPaneMonitorSignature([original])).not.toBe(
      getPaneMonitorSignature([replacement]),
    );
  });
});
