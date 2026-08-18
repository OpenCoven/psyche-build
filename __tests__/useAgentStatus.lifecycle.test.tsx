import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useAgentStatus, { type AgentStatusMap } from '../src/hooks/useAgentStatus.js';
import { getStatusDetector, resetStatusDetector } from '../src/services/StatusDetector.js';
import type { PsychePane } from '../src/types.js';

const panes: PsychePane[] = [{
  id: 'pane-a',
  slug: 'pane-a',
  prompt: '',
  paneId: '%1',
  type: 'worktree',
  agent: 'claude',
}];

function Harness({
  onStatuses,
  onPaneRemoved,
}: {
  onStatuses: (statuses: AgentStatusMap) => void;
  onPaneRemoved: (paneId: string) => void;
}) {
  const statuses = useAgentStatus({
    panes,
    suspend: true,
    onPaneRemoved,
  });
  onStatuses(statuses);
  return <Text>{statuses.has('pane-a') ? 'active' : 'inactive'}</Text>;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('useAgentStatus lifecycle cleanup', () => {
  afterEach(() => {
    resetStatusDetector();
  });

  it('clears status on reset without invoking configuration removal', async () => {
    let statuses = new Map();
    const onPaneRemoved = vi.fn();
    const detector = getStatusDetector();
    const resetListenersBefore = detector.listenerCount('pane-reset');
    const view = render(
      <Harness
        onStatuses={(next) => {
          statuses = next;
        }}
        onPaneRemoved={onPaneRemoved}
      />
    );
    expect(detector.listenerCount('pane-reset')).toBe(resetListenersBefore + 1);

    detector.emit('status-updated', { paneId: 'pane-a', status: 'working' });
    await flush();
    expect(statuses.get('pane-a')).toBe('working');
    expect(view.lastFrame()).toContain('active');

    detector.emit('pane-reset', { paneId: 'pane-a' });
    detector.emit('pane-reset', { paneId: 'pane-a' });
    await flush();

    expect(statuses.has('pane-a')).toBe(false);
    expect(view.lastFrame()).toContain('inactive');
    expect(onPaneRemoved).not.toHaveBeenCalled();
    view.unmount();
    expect(detector.listenerCount('pane-reset')).toBe(resetListenersBefore);
  });

  it('keeps actual removal behavior idempotent', async () => {
    let statuses = new Map();
    const onPaneRemoved = vi.fn();
    const detector = getStatusDetector();
    const view = render(
      <Harness
        onStatuses={(next) => {
          statuses = next;
        }}
        onPaneRemoved={onPaneRemoved}
      />
    );

    detector.emit('status-updated', { paneId: 'pane-a', status: 'idle' });
    await flush();
    detector.emit('pane-removed', { paneId: 'pane-a' });
    detector.emit('pane-removed', { paneId: 'pane-a' });
    await flush();

    expect(statuses.has('pane-a')).toBe(false);
    expect(onPaneRemoved).toHaveBeenCalledTimes(2);
    expect(onPaneRemoved).toHaveBeenNthCalledWith(1, 'pane-a');
    expect(onPaneRemoved).toHaveBeenNthCalledWith(2, 'pane-a');
    view.unmount();
  });
});
