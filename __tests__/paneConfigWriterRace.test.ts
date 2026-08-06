import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsycheConfig, PsychePane } from '../src/types.js';

const fsSyncMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
const fsPromisesMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  open: vi.fn(async () => ({ close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) })),
  unlink: vi.fn(async () => {}),
}));
const atomicWriteMock = vi.hoisted(() => ({
  atomicWriteJson: vi.fn(),
  atomicWriteJsonSync: vi.fn(),
}));
const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  paneExists: vi.fn(async (_paneId: string) => true),
  setSessionOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  getAllPaneInfo: vi.fn(async () => [
    { paneId: '%0', title: 'psyche' },
    { paneId: '%1', title: 'worker' },
  ]),
  getAllPaneIds: vi.fn(async () => ['%1']),
  getTerminalDimensions: vi.fn(async () => ({ width: 160, height: 40 })),
}));
const setupSidebarLayoutMock = vi.hoisted(() => vi.fn(() => '%new'));
const capturePaneInsertionMock = vi.hoisted(() => vi.fn(async () => undefined));
const insertPaneIntoStoredLayoutMock = vi.hoisted(() =>
  vi.fn(async (_options?: { pane: PsychePane }) => ({}))
);

vi.mock('fs', () => ({
  default: fsSyncMock,
  ...fsSyncMock,
}));

vi.mock('fs/promises', () => ({
  default: fsPromisesMock,
  ...fsPromisesMock,
}));

vi.mock('../src/utils/atomicWrite.js', () => atomicWriteMock);

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  ensurePaneBorderStatusForCurrentSession: vi.fn(),
  setupSidebarLayout: setupSidebarLayoutMock,
  getTerminalDimensions: vi.fn(() => ({ width: 160, height: 40 })),
  splitPane: vi.fn(() => '%new'),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
  applyStoredPaneLayout: vi.fn(async () => ({})),
  applyStoredPaneLayoutWithinConfigWriteLock: vi.fn(async () => ({})),
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enableAutopilotByDefault: false,
      enabledAgents: [],
    })),
  })),
}));

vi.mock('../src/utils/hooks.js', () => ({
  triggerHook: vi.fn(async () => {}),
  triggerHookSync: vi.fn(async () => ({ success: true })),
  initializeHooksDirectory: vi.fn(),
}));

vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

vi.mock('../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => ({
      getState: vi.fn(() => ({ projectRoot: '/project' })),
    })),
  },
}));

vi.mock('../src/utils/agentLaunch.js', () => ({
  AGENT_IDS: [],
  appendSlugSuffix: vi.fn((slug: string) => slug),
  launchAgentInPane: vi.fn(async () => {}),
  buildAgentResumeOrLaunchCommand: vi.fn(() => 'agent resume'),
}));

vi.mock('../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn((slug: string) => slug),
  getPaneTmuxTitle: vi.fn((pane: PsychePane) => pane.slug),
  getPaneTitleCandidates: vi.fn((pane: PsychePane) => [pane.slug]),
}));

vi.mock('../src/utils/git.js', () => ({
  isValidBranchName: vi.fn(() => true),
  getCurrentBranch: vi.fn(() => 'feature/worker'),
}));

vi.mock('../src/utils/gitignore.js', () => ({
  ensurePsycheRuntimeIgnored: vi.fn(() => ({ addedEntries: [] })),
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  readWorktreeMetadata: vi.fn(() => undefined),
  writeWorktreeMetadata: vi.fn(),
}));

vi.mock('../src/utils/codexHooks.js', () => ({
  installCodexPaneHooks: vi.fn(() => ({ eventFile: undefined })),
  buildCodexHookedCommand: vi.fn((command: string) => command),
}));

vi.mock('../src/utils/paneColors.js', () => ({
  resolveProjectColorTheme: vi.fn(() => 'violet'),
  syncPaneColorThemes: vi.fn((panes: PsychePane[]) => panes),
}));

vi.mock('../src/utils/sidebarProjects.js', () => ({
  getSidebarProjectDisplayName: vi.fn(() => 'project'),
  normalizeSidebarProjects: vi.fn((projects: unknown) => projects || []),
}));

vi.mock('../src/utils/welcomePaneManager.js', () => ({
  destroyWelcomePaneCoordinated: vi.fn(),
}));

vi.mock('../src/utils/agentDetection.js', () => ({
  getInstalledAgents: vi.fn(async () => []),
  filterEnabledAgents: vi.fn(() => []),
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

function pane(id: string, paneId: string, hidden = false): PsychePane {
  return {
    id,
    slug: id,
    prompt: id,
    paneId,
    hidden,
    type: id === 'removed-shell' ? 'shell' : undefined,
    worktreePath: id === 'removed-shell' ? undefined : `/project/.psyche/worktrees/${id}`,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type TestConfig = PsycheConfig & { preservedField?: string };

describe.each([
  {
    name: 'createPane',
    create: async (existingPanes: PsychePane[]) => {
      const { createPane } = await import('../src/utils/paneCreation.js');
      return createPane({
        prompt: '',
        projectName: 'project',
        existingPanes,
        existingWorktree: {
          slug: 'new-worker',
          worktreePath: '/project/.psyche/worktrees/new-worker',
          branchName: 'feature/new-worker',
        },
        skipAgentSelection: true,
        sessionProjectRoot: '/project',
        sessionConfigPath: '/project/.psyche/psyche.config.json',
      }, []);
    },
  },
  {
    name: 'reopenWorktree',
    create: async (existingPanes: PsychePane[]) => {
      const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');
      return reopenWorktree({
        slug: 'new-worker',
        worktreePath: '/project/.psyche/worktrees/new-worker',
        projectRoot: '/project',
        existingPanes,
        sessionProjectRoot: '/project',
        sessionConfigPath: '/project/.psyche/psyche.config.json',
      });
    },
  },
])('$name config writer', ({ create }) => {
  let config: TestConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      projectName: 'project',
      projectRoot: '/project',
      controlPaneId: '%stale',
      panes: [
        pane('worker', '%1', true),
        pane('removed-shell', '%dead'),
      ],
      settings: {},
      lastUpdated: 'before',
      preservedField: 'preserved',
    };
    fsSyncMock.readFileSync.mockImplementation(() => JSON.stringify(config));
    fsPromisesMock.readFile.mockImplementation(async () => JSON.stringify(config));
    atomicWriteMock.atomicWriteJsonSync.mockImplementation((_path, next) => {
      config = clone(next as TestConfig);
    });
    atomicWriteMock.atomicWriteJson.mockImplementation(async (_path, next) => {
      config = clone(next as TestConfig);
    });
    tmuxServiceMock.paneExists.mockImplementation(async () => true);
    insertPaneIntoStoredLayoutMock.mockImplementation(async (options) => {
      if (!options) {
        return {};
      }
      config = {
        ...config,
        panes: [...config.panes, options.pane],
      };
      return {};
    });
  });

  it('rebases after queued loader metadata reconciliation without pane loss or resurrection', async () => {
    let releaseStalePaneCheck: ((exists: boolean) => void) | undefined;
    const stalePaneCheck = new Promise<boolean>((resolve) => {
      releaseStalePaneCheck = resolve;
    });
    tmuxServiceMock.paneExists.mockImplementation((paneId: string) =>
      paneId === '%stale' ? stalePaneCheck : Promise.resolve(true)
    );

    const creation = create([]);
    await vi.waitFor(() => {
      expect(tmuxServiceMock.paneExists).toHaveBeenCalledWith('%stale');
    });

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    await loadAndProcessPanes('/project/.psyche/psyche.config.json', true);
    releaseStalePaneCheck?.(false);
    await creation;

    expect(config.panes.map((entry) => entry.id)).toEqual(['worker', expect.stringMatching(/^psyche-/)]);
    expect(config.panes[0]?.hidden).toBe(false);
    expect(config.preservedField).toBe('preserved');
  });
});
