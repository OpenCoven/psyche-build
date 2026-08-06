import React, { useEffect } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import usePanes from '../src/hooks/usePanes.js';
import type { PsychePane } from '../src/types.js';

const reconcileStoredPaneLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const savePanesToFileMock = vi.hoisted(() => vi.fn());
const appendPanesToFileMock = vi.hoisted(() => vi.fn());

vi.mock('../src/hooks/usePaneLoading.js', () => ({
  loadAndProcessPanes: vi.fn(),
  loadSidebarProjectsFromFile: vi.fn(async () => []),
  recreateKilledWorktreePanes: vi.fn(),
  fetchTmuxPaneIds: vi.fn(),
  reconcileStoredPaneLayout: reconcileStoredPaneLayoutMock,
}));

vi.mock('../src/hooks/usePaneSync.js', () => ({
  enforcePaneTitles: vi.fn(),
  appendPanesToFile: appendPanesToFileMock,
  savePanesToFile: savePanesToFileMock,
  rebindAndFilterPanes: vi.fn(),
  saveUpdatedPaneConfig: vi.fn(),
  handleLastPaneRemoval: vi.fn(),
  destroyWelcomePaneIfNeeded: vi.fn(),
}));

vi.mock('../src/services/PaneEventService.js', () => ({
  PaneEventService: {
    getInstance: () => ({
      initialize: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      onPanesChanged: vi.fn(() => () => {}),
      forceCheck: vi.fn(),
    }),
  },
}));

vi.mock('../src/utils/panesConfigQueue.js', () => ({
  withPanesConfigFileWriteLock: async <T,>(_: string, operation: () => Promise<T>) => operation(),
}));

function pane(id: string, paneId: string): PsychePane {
  return {
    id,
    slug: id,
    prompt: '',
    paneId,
  };
}

function Harness({
  onReady,
}: {
  onReady: (value: ReturnType<typeof usePanes>) => void;
}) {
  const value = usePanes('/project/.psyche/psyche.config.json', true, undefined, '%0');

  useEffect(() => {
    onReady(value);
  }, [onReady, value]);

  return <Text>psyche</Text>;
}

describe('usePanes layout persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendPanesToFileMock.mockImplementation(async (_: string, panes: PsychePane[]) => panes);
    savePanesToFileMock.mockImplementation(async (_: string, panes: PsychePane[]) => panes);
  });

  it('reconciles the layout after a conflict pane is removed', async () => {
    const conflictPane = pane('psyche-conflict', '%2');
    let hook: ReturnType<typeof usePanes> | undefined;
    const { unmount } = render(<Harness onReady={(value) => { hook = value; }} />);

    await vi.waitFor(() => {
      expect(hook).toBeDefined();
    });
    await hook!.appendPanes([conflictPane]);
    reconcileStoredPaneLayoutMock.mockClear();

    await hook!.savePanes([], { observedPanes: [conflictPane] });

    expect(reconcileStoredPaneLayoutMock).toHaveBeenCalledWith(
      '/project/.psyche/psyche.config.json',
      [],
      '%0',
      undefined,
      expect.any(Function),
    );

    unmount();
  });
});
