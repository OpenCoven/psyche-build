import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%1'),
  getServerIdentity: vi.fn(),
  paneExists: vi.fn(async () => true),
  probePanePresence: vi.fn(async () => 'present'),
  setPaneTitle: vi.fn(async (_paneId?: string, _title?: string) => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
}));
const splitPaneMock = vi.hoisted(() => vi.fn(() => '%2'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const launchAgentInPaneMock = vi.hoisted(() => vi.fn(async () => {}));
const beginWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
const upsertProjectPaneConfigPanesMock = vi.hoisted(() => vi.fn());
const compareAndRemoveProjectPaneConfigPaneIdentitiesMock = vi.hoisted(() => vi.fn());
const transactProjectPaneConfigMock = vi.hoisted(() => vi.fn());
const logServiceMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  splitPane: splitPaneMock,
  getTerminalDimensions: vi.fn(() => ({ width: 160, height: 40 })),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  recalculateAndApplyLayout: recalculateAndApplyLayoutMock,
}));

vi.mock('../src/utils/agentLaunch.js', () => ({
  launchAgentInPane: launchAgentInPaneMock,
}));

vi.mock('../src/utils/paneCreation.js', () => ({
  autoApproveTrustPrompt: vi.fn(async () => {}),
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enableAutopilotByDefault: false,
    })),
  })),
}));

vi.mock('../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn((slug: string) => slug),
}));

vi.mock('../src/utils/codexHooks.js', () => ({
  installCodexPaneHooks: vi.fn(() => ({ eventFile: '/repo/.psyche/codex-events.jsonl' })),
}));

vi.mock('../src/utils/paneColors.js', () => ({
  resolveProjectColorTheme: vi.fn(() => 'blue'),
}));

vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => logServiceMock),
  },
}));

vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      beginWorktreeReuseReservation: beginWorktreeReuseReservationMock,
    })),
  },
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  readProjectPaneConfigUnderLock: readProjectPaneConfigUnderLockMock,
  upsertProjectPaneConfigPanes: upsertProjectPaneConfigPanesMock,
  compareAndRemoveProjectPaneConfigPaneIdentities: compareAndRemoveProjectPaneConfigPaneIdentitiesMock,
  transactProjectPaneConfig: transactProjectPaneConfigMock,
  projectPaneConfigPath: (projectRoot: string) => `${projectRoot}/.psyche/psyche.config.json`,
}));

import {
  attachAgentToWorktree,
  generateSiblingSlugForTargetPane,
} from '../src/utils/attachAgent.js';

const WORKTREE_PATH = '/repo/.psyche/worktrees/feature';

function createTargetPane(): PsychePane {
  return {
    id: 'psyche-source',
    slug: 'feature',
    branchName: 'feature',
    prompt: '',
    paneId: '%source',
    projectRoot: '/repo',
    projectName: 'Repo',
    worktreePath: WORKTREE_PATH,
  };
}

describe('generateSiblingSlugForTargetPane', () => {
  it('increments from existing attached-agent siblings', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
      ],
    );

    expect(slug).toBe('cli-login-a3');
  });

  it('uses worktree directory as base when attaching from a suffixed sibling', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login-a2', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
      ],
    );

    expect(slug).toBe('cli-login-a3');
  });

  it('always uses highest sibling suffix + 1', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'cli-login-a4', worktreePath: '/repo/.psyche/worktrees/cli-login' },
      [
        { slug: 'cli-login' },
        { slug: 'cli-login-a2' },
        { slug: 'cli-login-a4' },
      ],
    );

    expect(slug).toBe('cli-login-a5');
  });

  it('preserves legitimate branch/worktree names that end in -aN', () => {
    const slug = generateSiblingSlugForTargetPane(
      { slug: 'feature-a2', worktreePath: '/repo/.psyche/worktrees/feature-a2' },
      [{ slug: 'feature-a2' }],
    );

    expect(slug).toBe('feature-a2-a2');
  });
});

describe('attachAgentToWorktree', () => {
  let order: string[];
  let paneAlive: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    order = [];
    paneAlive = true;
    splitPaneMock.mockReturnValue('%2');
    tmuxServiceMock.getCurrentPaneIdSync.mockReturnValue('%1');
    tmuxServiceMock.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'test-tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$test',
    });
    tmuxServiceMock.paneExists.mockImplementation(async () => paneAlive);
    tmuxServiceMock.probePanePresence.mockImplementation(async () => (
      paneAlive ? 'present' : 'absent'
    ));
    tmuxServiceMock.setPaneTitle.mockResolvedValue(undefined);
    tmuxServiceMock.refreshClient.mockResolvedValue(undefined);
    tmuxServiceMock.sendShellCommand.mockResolvedValue(undefined);
    tmuxServiceMock.sendTmuxKeys.mockResolvedValue(undefined);
    tmuxServiceMock.selectPane.mockResolvedValue(undefined);
    tmuxServiceMock.killPane.mockImplementation(async () => {
      paneAlive = false;
    });
    readProjectPaneConfigUnderLockMock.mockResolvedValue({ controlPaneId: '%1' });
    upsertProjectPaneConfigPanesMock.mockResolvedValue(undefined);
    compareAndRemoveProjectPaneConfigPaneIdentitiesMock.mockImplementation(async (
      _projectRoot: string,
      _identities: unknown,
      beforeRemove: () => Promise<void>,
    ) => {
      await beforeRemove();
      order.push('record-removed');
    });
    transactProjectPaneConfigMock.mockImplementation(async (
      _projectRoot: string,
      operation: (transaction: {
        config: Record<string, unknown>;
        persist: () => Promise<void>;
      }) => Promise<unknown>,
    ) => {
      const config: Record<string, unknown> = {
        controlPaneId: '%1',
        panes: [createTargetPane()],
      };
      let persisted = false;
      const persist = async () => {
        await upsertProjectPaneConfigPanesMock('/session', config.panes);
        persisted = true;
      };
      const result = await operation({ config, persist });
      if (!persisted) {
        await persist();
      }
      return { config, result };
    });
    launchAgentInPaneMock.mockResolvedValue(undefined);
    beginWorktreeReuseReservationMock.mockImplementation(async (
      worktreePath: string,
    ) => ({
      canonicalWorktreePath: worktreePath,
      retain: () => order.push('lease-retained'),
      complete: async () => { order.push('lease-released'); },
      cancel: async () => { order.push('lease-released'); },
    }));
  });

  function attach(): Promise<{ pane: PsychePane }> {
    const targetPane = createTargetPane();
    return attachAgentToWorktree({
      targetPane,
      prompt: 'Review the changes',
      agent: 'claude',
      existingPanes: [targetPane],
      sessionProjectRoot: '/session',
    });
  }

  it('holds the reuse reservation through durable persistence before launch', async () => {
    let releasePersistence!: () => void;
    let signalPersistenceStarted!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistenceStarted = new Promise<void>((resolve) => {
      signalPersistenceStarted = resolve;
    });
    upsertProjectPaneConfigPanesMock.mockImplementationOnce(async () => {
      order.push('persistence-started');
      signalPersistenceStarted();
      await persistenceGate;
      order.push('persisted');
    });
    launchAgentInPaneMock.mockImplementationOnce(async () => {
      order.push('agent-launched');
    });

    const attachment = attach();
    await persistenceStarted;

    expect(launchAgentInPaneMock).not.toHaveBeenCalled();
    expect(order).not.toContain('lease-released');
    expect(beginWorktreeReuseReservationMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      '/repo',
    );

    releasePersistence();
    await attachment;

    expect(order.indexOf('persisted')).toBeLessThan(order.indexOf('agent-launched'));
    expect(order.indexOf('agent-launched')).toBeLessThan(order.indexOf('lease-released'));
  });

  it('kills an unpersisted pane before releasing its reuse reservation', async () => {
    upsertProjectPaneConfigPanesMock.mockImplementationOnce(async () => {
      order.push('persistence-failed');
      throw new Error('config unavailable');
    });
    tmuxServiceMock.killPane.mockImplementationOnce(async () => {
      order.push('pane-killed');
      paneAlive = false;
    });

    await expect(attach()).rejects.toThrow(/Failed to prepare attached pane/);

    expect(launchAgentInPaneMock).not.toHaveBeenCalled();
    expect(compareAndRemoveProjectPaneConfigPaneIdentitiesMock).not.toHaveBeenCalled();
    expect(order).toEqual([
      'persistence-failed',
      'pane-killed',
      'lease-released',
    ]);
  });

  it('removes the exact persisted record inside the setup transaction after setup fails', async () => {
    const persistedSnapshots: PsychePane[][] = [];
    upsertProjectPaneConfigPanesMock.mockImplementation(async (
      _projectRoot: string,
      panes: PsychePane[],
    ) => {
      persistedSnapshots.push(panes.map((pane) => ({ ...pane })));
      order.push(`persisted-${persistedSnapshots.length}`);
    });
    tmuxServiceMock.sendShellCommand.mockRejectedValueOnce(
      new Error('attached pane cwd setup failed'),
    );
    tmuxServiceMock.killPane.mockImplementationOnce(async () => {
      order.push('pane-killed');
      paneAlive = false;
    });

    await expect(attach()).rejects.toThrow(/Failed to prepare attached pane/);

    expect(launchAgentInPaneMock).not.toHaveBeenCalled();
    expect(persistedSnapshots).toHaveLength(2);
    expect(persistedSnapshots[0]).toHaveLength(2);
    expect(persistedSnapshots[1]).toEqual([
      expect.objectContaining({ id: 'psyche-source', paneId: '%source' }),
    ]);
    expect(order.indexOf('pane-killed')).toBeLessThan(order.indexOf('persisted-2'));
    expect(order.indexOf('persisted-2')).toBeLessThan(order.indexOf('lease-released'));
    expect(compareAndRemoveProjectPaneConfigPaneIdentitiesMock).not.toHaveBeenCalled();
  });

  it('removes the exact persisted record after a launch failure and kills its pane', async () => {
    upsertProjectPaneConfigPanesMock.mockImplementationOnce(async () => {
      order.push('persisted');
    });
    launchAgentInPaneMock.mockImplementationOnce(async () => {
      order.push('launch-failed');
      throw new Error('agent executable unavailable');
    });
    tmuxServiceMock.killPane.mockImplementationOnce(async () => {
      order.push('pane-killed');
      paneAlive = false;
    });
    await expect(attach()).rejects.toThrow(/Failed to launch attached agent/);

    const persistedPane = (
      upsertProjectPaneConfigPanesMock.mock.calls[0][1] as PsychePane[]
    ).find((pane) => pane.id !== 'psyche-source')!;
    expect(compareAndRemoveProjectPaneConfigPaneIdentitiesMock).toHaveBeenCalledWith(
      '/session',
      [{ id: persistedPane.id, paneId: persistedPane.paneId }],
      expect.any(Function),
    );
    expect(order.indexOf('pane-killed')).toBeLessThan(order.indexOf('record-removed'));
    expect(order.indexOf('record-removed')).toBeLessThan(order.indexOf('lease-released'));
  });

  it('retains a durable attached-pane record when teardown is unknown', async () => {
    launchAgentInPaneMock.mockRejectedValueOnce(new Error('agent executable unavailable'));
    tmuxServiceMock.probePanePresence.mockResolvedValueOnce('unknown');

    await expect(attach()).rejects.toThrow(/retained tracked pane record.*Recovery required/);

    expect(compareAndRemoveProjectPaneConfigPaneIdentitiesMock).toHaveBeenCalledWith(
      '/session',
      [expect.objectContaining({ paneId: '%2' })],
      expect.any(Function),
    );
    expect(tmuxServiceMock.killPane).not.toHaveBeenCalled();
  });

  it('allocates concurrent sibling slugs from fresh transaction state with matching pane titles', async () => {
    const config: Record<string, unknown> = {
      controlPaneId: '%1',
      panes: [createTargetPane()],
    };
    let transactionTail = Promise.resolve();
    let paneNumber = 1;
    const titleByPaneId = new Map<string, string>();
    splitPaneMock.mockImplementation(() => `%${++paneNumber}`);
    tmuxServiceMock.setPaneTitle.mockImplementation(async (paneId?: string, title?: string) => {
      if (paneId && title) {
        titleByPaneId.set(paneId, title);
      }
    });
    transactProjectPaneConfigMock.mockImplementation(async (
      _projectRoot: string,
      operation: (transaction: {
        config: Record<string, unknown>;
        persist: () => Promise<void>;
      }) => Promise<unknown>,
    ) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        let persisted = false;
        const result = await operation({
          config,
          persist: async () => {
            persisted = true;
          },
        });
        if (!persisted) {
          throw new Error('attachment transaction did not persist');
        }
        return { config, result };
      } finally {
        release();
      }
    });

    const targetPane = createTargetPane();
    const [first, second] = await Promise.all([
      attachAgentToWorktree({
        targetPane,
        prompt: 'Review A',
        agent: 'claude',
        existingPanes: [targetPane],
        sessionProjectRoot: '/session',
      }),
      attachAgentToWorktree({
        targetPane,
        prompt: 'Review B',
        agent: 'codex',
        existingPanes: [targetPane],
        sessionProjectRoot: '/session',
      }),
    ]);

    expect([first.pane.slug, second.pane.slug].sort()).toEqual([
      'feature-a2',
      'feature-a3',
    ]);
    const panes = config.panes as PsychePane[];
    expect(new Set(panes.map((pane) => pane.slug)).size).toBe(panes.length);
    for (const attached of [first.pane, second.pane]) {
      expect(titleByPaneId.get(attached.paneId)).toBe(attached.slug);
      expect(panes.find((pane) => pane.paneId === attached.paneId)?.slug)
        .toBe(attached.slug);
    }
  });
});
