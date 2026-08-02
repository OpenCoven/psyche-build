import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useInputHandling } from '../src/hooks/useInputHandling.js';
import { TmuxService } from '../src/services/TmuxService.js';
import type { InlineRenameState } from '../src/utils/inlineRename.js';
import type { PsychePane } from '../src/types.js';
import type { PopupManager } from '../src/services/PopupManager.js';
import type { TrackProjectActivity } from '../src/types/activity.js';

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
  panes,
  savePanes,
  selectedIndex = 0,
  setSelectedIndex = vi.fn(),
  setStatusMessage = vi.fn(),
  ignoreInput = false,
  cleanExit = vi.fn(),
}: {
  panes: PsychePane[];
  savePanes: (...args: any[]) => any;
  selectedIndex?: number;
  setSelectedIndex?: (...args: any[]) => any;
  setStatusMessage?: (...args: any[]) => any;
  ignoreInput?: boolean;
  cleanExit?: (...args: any[]) => any;
}) {
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);

  useInputHandling({
    panes,
    selectedIndex,
    setSelectedIndex,
    isCreatingPane: false,
    setIsCreatingPane: vi.fn(),
    runningCommand: false,
    isUpdating: false,
    isLoading: false,
    ignoreInput,
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
    // Only the one method this test exercises; PopupManager has ~29 members.
    popupManager: {
      launchKebabMenuPopup: vi.fn(async () => null),
    } as unknown as PopupManager,
    actionSystem: {
      actionState: {},
      executeAction: vi.fn(),
      executeCallback: vi.fn(),
      clearDialog: vi.fn(),
      clearStatus: vi.fn(),
      setActionState: vi.fn(),
    },
    controlPaneId: undefined,
    trackProjectActivity: (async (work: () => unknown) => await work()) as TrackProjectActivity,
    setStatusMessage,
    copyNonGitFiles: vi.fn(),
    runCommandInternal: vi.fn(),
    handlePaneCreationWithAgent: vi.fn(),
    openRitual: vi.fn(),
    handleCreateChildWorktree: vi.fn(),
    handleReopenWorktree: vi.fn(),
    setDevSourceFromPane: vi.fn(),
    refreshPsycheSettings: vi.fn(),
    savePanes,
    sidebarProjects: [{ projectRoot: '/repo', projectName: 'Repo' }],
    saveSidebarProjects: vi.fn(async (projects) => projects),
    loadPanes: vi.fn(),
    cleanExit,
    getAvailableAgentsForProject: vi.fn(() => []),
    panesFile: '/tmp/psyche.config.json',
    projectRoot: '/repo',
    projectActionItems: [],
    findCardInDirection: vi.fn(() => null),
    inlineRename,
    setInlineRename,
  });

  return <Text>psyche</Text>;
}

describe('useInputHandling inline rename', () => {
  it('suppresses global quit while input is ignored', async () => {
    const savePanes = vi.fn(async () => {});
    const cleanExit = vi.fn();
    const { stdin, unmount } = render(
      <Harness panes={[pane()]} savePanes={savePanes} ignoreInput cleanExit={cleanExit} />
    );

    await sleep(20);
    stdin.write('q');
    await sleep(20);

    expect(cleanExit).not.toHaveBeenCalled();

    unmount();
  });

  it('renames the selected pane from inline input', async () => {
    vi.spyOn(TmuxService, 'getInstance').mockReturnValue({
      setPaneTitle: vi.fn(async () => {}),
    } as unknown as TmuxService);

    const savePanes = vi.fn(async () => {});
    const { stdin, unmount } = render(
      <Harness panes={[pane()]} savePanes={savePanes} />
    );

    await sleep(20);
    stdin.write('e');
    await sleep(20);
    stdin.write('-renamed');
    await sleep(20);
    stdin.write('\r');
    await sleep(80);

    expect(savePanes).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'psyche-1',
        slug: 'thread-a',
        displayName: 'thread-a-renamed',
      }),
    ]);

    unmount();
    vi.restoreAllMocks();
  });

  it('selects a thread/worktree row on mouse click', async () => {
    const savePanes = vi.fn(async () => {});
    const setSelectedIndex = vi.fn();
    const { stdin, unmount } = render(
      <Harness
        panes={[
          pane({ id: 'psyche-1', slug: 'thread-a', paneId: '%1' }),
          pane({ id: 'psyche-2', slug: 'thread-b', paneId: '%2' }),
        ]}
        savePanes={savePanes}
        setSelectedIndex={setSelectedIndex}
      />
    );

    await sleep(20);
    stdin.write('\x1b[<0;2;3M');
    await sleep(40);

    expect(setSelectedIndex).toHaveBeenCalledWith(1);
    expect(savePanes).not.toHaveBeenCalled();

    unmount();
  });

  it('renames a clicked thread/worktree row on double-click', async () => {
    vi.spyOn(TmuxService, 'getInstance').mockReturnValue({
      setPaneTitle: vi.fn(async () => {}),
    } as unknown as TmuxService);

    const savePanes = vi.fn(async () => {});
    const { stdin, unmount } = render(
      <Harness
        panes={[
          pane({ id: 'psyche-1', slug: 'thread-a', paneId: '%1' }),
          pane({ id: 'psyche-2', slug: 'thread-b', paneId: '%2' }),
        ]}
        savePanes={savePanes}
      />
    );

    await sleep(20);
    stdin.write('\x1b[<0;2;3M');
    await sleep(20);
    stdin.write('\x1b[<0;2;3M');
    await sleep(120);
    stdin.write('-renamed');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);

    expect(savePanes).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'psyche-1',
        slug: 'thread-a',
      }),
      expect.objectContaining({
        id: 'psyche-2',
        slug: 'thread-b',
        displayName: 'thread-b-renamed',
      }),
    ]);

    unmount();
    vi.restoreAllMocks();
  });
});
