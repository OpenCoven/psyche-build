import React from 'react';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useInputHandling } from '../src/hooks/useInputHandling.js';
import type { PsychePane } from '../src/types.js';
import type { TrackProjectActivity } from '../src/types/activity.js';
import type { AgentName } from '../src/utils/agentLaunch.js';

const createPaneMock = vi.hoisted(() => vi.fn());
vi.mock('../src/control/resources/panes.js', () => ({
  defaultCreatePane: (...args: unknown[]) => createPaneMock(...args),
}));
vi.mock('../src/utils/remotePaneActions.js', () => ({
  drainRemotePaneActions: vi.fn(async () => []),
  getCurrentTmuxSessionName: vi.fn(() => null),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAIN_BRANCH = 'main';
const ATTACH_BRANCH = 'thread-a';

interface AttachWorktreeFixture {
  projectRoot: string;
  worktreePath: string;
}

let fixture: AttachWorktreeFixture | undefined;

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function requireFixture(): AttachWorktreeFixture {
  if (!fixture) {
    throw new Error('attach warning fixture is not initialized');
  }
  return fixture;
}

beforeAll(() => {
  const projectRoot = fs.mkdtempSync(
    path.join(process.cwd(), '.use-input-handling-attach-warnings-'),
  );
  const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', ATTACH_BRANCH);
  fixture = {
    projectRoot,
    worktreePath,
  };
  try {
    runGit(['init'], projectRoot);
    runGit(['config', 'user.name', 'Test User'], projectRoot);
    runGit(['config', 'user.email', 'test@example.invalid'], projectRoot);
    runGit(['checkout', '-b', MAIN_BRANCH], projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Attach warning test repo\n');
    runGit(['add', 'README.md'], projectRoot);
    runGit(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], projectRoot);

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    runGit(['worktree', 'add', '-b', ATTACH_BRANCH, worktreePath, MAIN_BRANCH], projectRoot);

    fixture = {
      projectRoot: fs.realpathSync.native(projectRoot),
      worktreePath: fs.realpathSync.native(worktreePath),
    };
    fs.mkdirSync(path.join(fixture.projectRoot, '.psyche'), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.projectRoot, '.psyche', 'psyche.config.json'),
      JSON.stringify({ panes: [], sidebarProjects: [] }),
    );
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fixture = undefined;
    throw error;
  }
});

afterAll(() => {
  if (!fixture?.projectRoot) return;
  try {
    runGit(['worktree', 'remove', '--force', fixture.worktreePath], fixture.projectRoot);
  } catch {}
  fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
});

function pane(overrides: Partial<PsychePane> = {}): PsychePane {
  const activeFixture = requireFixture();
  return {
    id: 'psyche-1',
    slug: ATTACH_BRANCH,
    prompt: '',
    paneId: '%1',
    worktreePath: activeFixture.worktreePath,
    branchName: ATTACH_BRANCH,
    projectRoot: activeFixture.projectRoot,
    projectName: 'Repo',
    ...overrides,
  };
}

function Harness({
  savePanes,
  loadPanes,
  setIsCreatingPane,
  setStatusMessage,
}: {
  savePanes: (...args: any[]) => Promise<void>;
  loadPanes: (...args: any[]) => Promise<void>;
  setIsCreatingPane: (...args: any[]) => void;
  setStatusMessage: (...args: any[]) => void;
}) {
  const trackProjectActivity = (async <T,>(
    work: () => Promise<T> | T,
  ): Promise<T> => await work()) as TrackProjectActivity;
  const activeFixture = requireFixture();

  useInputHandling({
    panes: [pane()],
    selectedIndex: 0,
    setSelectedIndex: vi.fn(),
    isCreatingPane: false,
    setIsCreatingPane,
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
    popupManager: {
      launchNewPanePopup: vi.fn(async () => 'Review the lane'),
    } as any,
    actionSystem: {
      actionState: {},
      executeAction: vi.fn(),
      executeCallback: vi.fn(),
      clearDialog: vi.fn(),
      clearStatus: vi.fn(),
      setActionState: vi.fn(),
    },
    controlPaneId: undefined,
    trackProjectActivity,
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
    sidebarProjects: [{ projectRoot: activeFixture.projectRoot, projectName: 'Repo' }],
    saveSidebarProjects: vi.fn(async (projects) => projects),
    loadPanes,
    cleanExit: vi.fn(),
    getAvailableAgentsForProject: vi.fn((): AgentName[] => ['claude']),
    panesFile: `${activeFixture.projectRoot}/.psyche/psyche.config.json`,
    projectRoot: activeFixture.projectRoot,
    projectActionItems: [],
    findCardInDirection: vi.fn(() => null),
  });

  return <Text>psyche</Text>;
}

describe('useInputHandling attach warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPaneMock.mockImplementation(async (options: any) => {
      const attachedPane = pane({
        id: 'psyche-2',
        slug: 'thread-a-claude',
        paneId: '%2',
      });
      await options.persistReusedPane(attachedPane);
      return { pane: attachedPane, needsAgentChoice: false };
    });
  });

  it('reports partial success without retrying or discarding the attached pane', async () => {
    const savePanes = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full\nretry would be unsafe'));
    const loadPanes = vi.fn(async () => {});
    const setIsCreatingPane = vi.fn();
    const setStatusMessage = vi.fn();
    const { stdin, unmount } = render(
      <Harness
        savePanes={savePanes}
        loadPanes={loadPanes}
        setIsCreatingPane={setIsCreatingPane}
        setStatusMessage={setStatusMessage}
      />,
    );

    await sleep(20);
    stdin.write('a');
    await vi.waitFor(() => {
      expect(setIsCreatingPane).toHaveBeenLastCalledWith(false);
      expect(setStatusMessage).toHaveBeenCalledWith(
        'Pane launched, but orchestration metadata was not saved: disk full retry would be unsafe',
      );
    });

    expect(createPaneMock).toHaveBeenCalledTimes(1);
    expect(savePanes).toHaveBeenCalledTimes(2);
    expect(loadPanes).toHaveBeenCalledTimes(1);
    expect(setIsCreatingPane).toHaveBeenNthCalledWith(1, true);
    expect(setIsCreatingPane).toHaveBeenLastCalledWith(false);
    expect(
      setStatusMessage.mock.calls.some(([status]) =>
        String(status).startsWith('Failed to attach')
      ),
    ).toBe(false);

    unmount();
  });

  it('keeps the ordinary attach success message unchanged', async () => {
    const savePanes = vi.fn(async () => {});
    const loadPanes = vi.fn(async () => {});
    const setIsCreatingPane = vi.fn();
    const setStatusMessage = vi.fn();
    const { stdin, unmount } = render(
      <Harness
        savePanes={savePanes}
        loadPanes={loadPanes}
        setIsCreatingPane={setIsCreatingPane}
        setStatusMessage={setStatusMessage}
      />,
    );

    await sleep(20);
    stdin.write('a');
    await vi.waitFor(() => {
      expect(setIsCreatingPane).toHaveBeenLastCalledWith(false);
      expect(setStatusMessage).toHaveBeenCalledWith('Attached 1 agent to thread-a');
    });

    expect(createPaneMock).toHaveBeenCalledTimes(1);
    expect(savePanes).toHaveBeenCalledTimes(2);

    unmount();
  });
});
