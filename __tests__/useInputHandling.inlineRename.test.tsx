import React, { useEffect, useState } from 'react';
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

/**
 * These tests used fixed sleeps to let Ink process each keystroke. 20ms was
 * enough on an idle machine and not enough in a full suite run, which is why
 * the rename test failed only when it ran alongside everything else.
 *
 * Two things replace them. Waits poll observable state instead of a clock, and
 * the *first* keystroke is retried: Ink drops input until it has attached its
 * stdin listener, and that moment is not observable -- the testing stdin stub
 * exposes no listener count and no raw-mode flag. Measured, a key written at
 * ~1ms is lost while one at ~120ms lands, and nothing in between reports when
 * the boundary passed. Retrying until the state actually changes is correct at
 * any speed; a delay tuned to this machine is not.
 */
async function waitFor(
  check: () => boolean,
  what: string,
  timeoutMs = 5000,
  describe?: () => string,
) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}${describe ? ` (saw ${describe()})` : ''}`);
    }
    await sleep(5);
  }
}

/** Write `keys` until `check` passes, for input that may precede readiness. */
async function pressUntil(
  stdin: { write: (data: string) => void },
  keys: string,
  check: () => boolean,
  what: string,
  timeoutMs = 5000,
) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    stdin.write(keys);
    await sleep(20);
  }
}

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
  onSettled,
}: {
  panes: PsychePane[];
  savePanes: (...args: any[]) => any;
  selectedIndex?: number;
  setSelectedIndex?: (...args: any[]) => any;
  setStatusMessage?: (...args: any[]) => any;
  ignoreInput?: boolean;
  cleanExit?: (...args: any[]) => any;
  /**
   * Rename state, reported once effects have flushed for it. Input handling is
   * re-registered in an effect keyed on this state, so a keystroke sent before
   * the flush is handled by the previous registration and is either dropped or
   * acts on a stale value. Waiting on state alone races that; waiting on the
   * flush does not.
   */
  onSettled?: (state: InlineRenameState | null) => void;
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

  useEffect(() => {
    if (onSettled) onSettled(inlineRename);
  }, [inlineRename, onSettled]);

  return <Text>psyche</Text>;
}

describe('useInputHandling inline rename', () => {
  it('suppresses global quit while input is ignored', async () => {
    const savePanes = vi.fn(async () => {});
    const cleanExit = vi.fn();
    const { stdin, unmount } = render(
      <Harness panes={[pane()]} savePanes={savePanes} ignoreInput cleanExit={cleanExit} />
    );

    // Nothing to poll for: the assertion is that nothing happens. Settle long
    // enough that a quit would have landed, which a slow machine only helps.
    await sleep(200);
    stdin.write('q');
    await sleep(200);

    expect(cleanExit).not.toHaveBeenCalled();

    unmount();
  });

  it('renames the selected pane from inline input', async () => {
    vi.spyOn(TmuxService, 'getInstance').mockReturnValue({
      setPaneTitle: vi.fn(async () => {}),
    } as unknown as TmuxService);

    const savePanes = vi.fn(async () => {});
    let rename: InlineRenameState | null = null;
    const { stdin, unmount } = render(
      <Harness panes={[pane()]} savePanes={savePanes} onSettled={(s) => { rename = s; }} />
    );

    await pressUntil(stdin, 'e', () => rename !== null, 'rename to open');
    stdin.write('-renamed');
    await waitFor(
      () => String(rename?.value ?? '').includes('-renamed'), 'typed name', 5000,
      () => JSON.stringify(rename),
    );
    stdin.write('\r');
    await waitFor(() => savePanes.mock.calls.length > 0, 'panes to be saved');

    expect(savePanes).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'psyche-1',
        slug: 'thread-a',
        displayName: 'thread-a-renamed',
      }),
    ], [pane()]);

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

    await pressUntil(
      stdin, '\x1b[<0;2;3M',
      () => setSelectedIndex.mock.calls.length > 0, 'row selection',
    );

    expect(setSelectedIndex).toHaveBeenCalledWith(1);
    expect(savePanes).not.toHaveBeenCalled();

    unmount();
  });

  it('renames a clicked thread/worktree row on double-click', async () => {
    vi.spyOn(TmuxService, 'getInstance').mockReturnValue({
      setPaneTitle: vi.fn(async () => {}),
    } as unknown as TmuxService);

    const savePanes = vi.fn(async () => {});
    const setSelectedIndex = vi.fn();
    let rename: InlineRenameState | null = null;
    const { stdin, unmount } = render(
      <Harness
        panes={[
          pane({ id: 'psyche-1', slug: 'thread-a', paneId: '%1' }),
          pane({ id: 'psyche-2', slug: 'thread-b', paneId: '%2' }),
        ]}
        savePanes={savePanes}
        setSelectedIndex={setSelectedIndex}
        onSettled={(s) => { rename = s; }}
      />
    );

    // Retry only the first press until input is live; the second must follow
    // inside SIDEBAR_DOUBLE_CLICK_INTERVAL_MS for the pair to read as a
    // double-click, so it is not retried and not waited on.
    await pressUntil(
      stdin, '\x1b[<0;2;3M',
      () => setSelectedIndex.mock.calls.length > 0, 'first press to land',
    );
    stdin.write('\x1b[<0;2;3M');
    await waitFor(() => rename !== null, 'rename to open');
    stdin.write('-renamed');
    await waitFor(
      () => String(rename?.value ?? '').includes('-renamed'), 'typed name', 5000,
      () => JSON.stringify(rename),
    );
    stdin.write('\r');
    await waitFor(() => savePanes.mock.calls.length > 0, 'panes to be saved');

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
    ], [
      pane({ id: 'psyche-1', slug: 'thread-a', paneId: '%1' }),
      pane({ id: 'psyche-2', slug: 'thread-b', paneId: '%2' }),
    ]);

    unmount();
    vi.restoreAllMocks();
  });
});
