import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useInputHandling } from '../src/hooks/useInputHandling.js';
import type { PopupManager } from '../src/services/PopupManager.js';
import type { PsychePane } from '../src/types.js';
import type { CovenSessionsLoadState } from '../src/utils/covenSessions.js';

vi.mock('../src/utils/remotePaneActions.js', () => ({
  drainRemotePaneActions: vi.fn(async () => []),
  getCurrentTmuxSessionName: vi.fn(() => null),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pane(overrides: Partial<PsychePane> = {}): PsychePane {
  return {
    id: 'psyche-1',
    slug: 'thread-a',
    prompt: '',
    paneId: '%1',
    projectRoot: '/repo',
    projectName: 'Repo',
    ...overrides,
  };
}

function Harness({
  onToggleSidePanel,
  sidePanelCollapsed = false,
  sidePanelWidth = 40,
  setStatusMessage = vi.fn(),
  covenSessionsState,
}: {
  onToggleSidePanel: (...args: any[]) => any;
  sidePanelCollapsed?: boolean;
  sidePanelWidth?: number;
  setStatusMessage?: (...args: any[]) => any;
  covenSessionsState?: CovenSessionsLoadState;
}) {
  const params = {
    panes: [pane()],
    selectedIndex: 0,
    setSelectedIndex: vi.fn(),
    isCreatingPane: false,
    setIsCreatingPane: vi.fn(),
    runningCommand: false,
    isUpdating: false,
    isLoading: false,
    ignoreInput: false,
    isDevMode: false,
    quitConfirmMode: false,
    setQuitConfirmMode: vi.fn(),
    showCommandPrompt: null,
    setShowCommandPrompt: vi.fn(),
    commandInput: '',
    setCommandInput: vi.fn(),
    showFileCopyPrompt: false,
    setShowFileCopyPrompt: vi.fn(),
    currentCommandType: null,
    setCurrentCommandType: vi.fn(),
    projectSettings: {},
    saveSettings: vi.fn(),
    settingsManager: {},
    // Only the methods this test exercises; PopupManager has ~29 members.
    popupManager: {
      launchKebabMenuPopup: vi.fn(async () => null),
      launchSettingsPopup: vi.fn(async () => null),
    } as unknown as PopupManager,
    actionSystem: {
      actionState: {},
      executeAction: vi.fn(),
      executeCallback: vi.fn(),
      clearDialog: vi.fn(),
      clearStatus: vi.fn(),
      setActionState: vi.fn(),
    },
    controlPaneId: '%0',
    trackProjectActivity: vi.fn(async (work: () => unknown) => await work()),
    setStatusMessage,
    copyNonGitFiles: vi.fn(),
    runCommandInternal: vi.fn(),
    handlePaneCreationWithAgent: vi.fn(),
    openRitual: vi.fn(),
    handleCreateChildWorktree: vi.fn(),
    handleReopenWorktree: vi.fn(),
    setDevSourceFromPane: vi.fn(),
    refreshPsycheSettings: vi.fn(),
    savePanes: vi.fn(),
    sidebarProjects: [{ projectRoot: '/repo', projectName: 'Repo' }],
    saveSidebarProjects: vi.fn(async (projects) => projects),
    loadPanes: vi.fn(),
    cleanExit: vi.fn(),
    getAvailableAgentsForProject: vi.fn(() => []),
    panesFile: '/tmp/psyche.config.json',
    projectRoot: '/repo',
    projectActionItems: [],
    covenSessionsState,
    findCardInDirection: vi.fn(() => null),
    onToggleSidePanel,
    sidePanelCollapsed,
    sidePanelWidth,
  } as Parameters<typeof useInputHandling>[0] & {
    onToggleSidePanel: () => void;
    sidePanelCollapsed: boolean;
    sidePanelWidth: number;
  };

  useInputHandling(params as Parameters<typeof useInputHandling>[0]);

  return <Text>psyche</Text>;
}

function StatefulHarness({
  initialCollapsed = false,
  onStateChange,
}: {
  initialCollapsed?: boolean;
  onStateChange: (...args: any[]) => any;
}) {
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(initialCollapsed);
  const onToggleSidePanel = () => {
    setSidePanelCollapsed((current) => {
      const next = !current;
      onStateChange(next);
      return next;
    });
  };

  return (
    <Harness
      onToggleSidePanel={vi.fn(onToggleSidePanel)}
      sidePanelCollapsed={sidePanelCollapsed}
    />
  );
}

describe('useInputHandling side panel toggle', () => {
  it('toggles the side panel with the z shortcut', async () => {
    const onToggleSidePanel = vi.fn();
    const { stdin, unmount } = render(<Harness onToggleSidePanel={onToggleSidePanel} />);

    await sleep(20);
    stdin.write('z');
    await sleep(40);

    expect(onToggleSidePanel).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('expands a collapsed side panel when any compact rail row is clicked', async () => {
    const onToggleSidePanel = vi.fn();
    const { stdin, unmount } = render(
      <Harness onToggleSidePanel={onToggleSidePanel} sidePanelCollapsed />
    );

    await sleep(20);
    stdin.write('\x1b[<0;1;3M');
    await sleep(40);

    expect(onToggleSidePanel).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('toggles the expanded side panel from the collapse chevron only', async () => {
    const onToggleSidePanel = vi.fn();
    const { stdin, unmount } = render(
      <Harness onToggleSidePanel={onToggleSidePanel} sidePanelWidth={40} />
    );

    await sleep(20);
    stdin.write('\x1b[<0;40;1M');
    await sleep(40);

    expect(onToggleSidePanel).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does not toggle the expanded panel when clicking a different top-row cell', async () => {
    const onToggleSidePanel = vi.fn();
    const { stdin, unmount } = render(
      <Harness onToggleSidePanel={onToggleSidePanel} sidePanelWidth={40} />
    );

    await sleep(20);
    stdin.write('\x1b[<0;1;1M');
    await sleep(40);

    expect(onToggleSidePanel).not.toHaveBeenCalled();

    unmount();
  });

  it('toggles open and closed freely with repeated shortcut presses', async () => {
    const onStateChange = vi.fn();
    const { stdin, unmount } = render(
      <StatefulHarness initialCollapsed onStateChange={onStateChange} />
    );

    await sleep(20);
    stdin.write('z');
    await sleep(40);
    stdin.write('z');
    await sleep(40);
    stdin.write('z');
    await sleep(40);

    expect(onStateChange).toHaveBeenNthCalledWith(1, false);
    expect(onStateChange).toHaveBeenNthCalledWith(2, true);
    expect(onStateChange).toHaveBeenNthCalledWith(3, false);

    unmount();
  });

  it('does not keep toggling from compact rail coordinates once expanded', async () => {
    const onStateChange = vi.fn();
    const { stdin, unmount } = render(
      <StatefulHarness initialCollapsed onStateChange={onStateChange} />
    );

    await sleep(20);
    stdin.write('\x1b[<0;1;3M');
    await sleep(40);
    stdin.write('\x1b[<0;1;4M');
    await sleep(40);
    stdin.write('\x1b[<0;1;5M');
    await sleep(40);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenNthCalledWith(1, false);

    unmount();
  });

  it('shows a friendly status message when opening unavailable Coven sessions', async () => {
    const setStatusMessage = vi.fn();
    const unavailableState: CovenSessionsLoadState = {
      status: 'unavailable',
      sessions: [],
      reason: 'coven CLI not found',
      loadedAt: '2026-04-28T12:00:00.000Z',
    };
    const { stdin, unmount } = render(
      <Harness
        onToggleSidePanel={vi.fn()}
        setStatusMessage={setStatusMessage}
        covenSessionsState={unavailableState}
      />
    );

    await sleep(20);
    stdin.write('o');
    await sleep(40);

    expect(setStatusMessage).toHaveBeenCalledWith('Coven not running — start it with: coven start');

    unmount();
  });
});
