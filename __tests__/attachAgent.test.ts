import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%1'),
  paneExists: vi.fn(async () => true),
  setPaneTitle: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
}));
const splitPaneMock = vi.hoisted(() => vi.fn(() => '%2'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const launchAgentInPaneMock = vi.hoisted(() => vi.fn(async () => {}));
const withWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
const upsertProjectPaneConfigPanesMock = vi.hoisted(() => vi.fn());
const removeProjectPaneConfigPanesMock = vi.hoisted(() => vi.fn());
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
      withWorktreeReuseReservation: withWorktreeReuseReservationMock,
    })),
  },
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  readProjectPaneConfigUnderLock: readProjectPaneConfigUnderLockMock,
  upsertProjectPaneConfigPanes: upsertProjectPaneConfigPanesMock,
  removeProjectPaneConfigPanes: removeProjectPaneConfigPanesMock,
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

  beforeEach(() => {
    vi.clearAllMocks();
    order = [];
    splitPaneMock.mockReturnValue('%2');
    tmuxServiceMock.getCurrentPaneIdSync.mockReturnValue('%1');
    tmuxServiceMock.paneExists.mockResolvedValue(true);
    tmuxServiceMock.setPaneTitle.mockResolvedValue(undefined);
    tmuxServiceMock.refreshClient.mockResolvedValue(undefined);
    tmuxServiceMock.sendShellCommand.mockResolvedValue(undefined);
    tmuxServiceMock.sendTmuxKeys.mockResolvedValue(undefined);
    tmuxServiceMock.selectPane.mockResolvedValue(undefined);
    tmuxServiceMock.killPane.mockResolvedValue(undefined);
    readProjectPaneConfigUnderLockMock.mockResolvedValue({ controlPaneId: '%1' });
    upsertProjectPaneConfigPanesMock.mockResolvedValue(undefined);
    removeProjectPaneConfigPanesMock.mockResolvedValue(undefined);
    launchAgentInPaneMock.mockResolvedValue(undefined);
    withWorktreeReuseReservationMock.mockImplementation(async (
      worktreePath: string,
      operation: (canonicalWorktreePath: string) => Promise<unknown>,
    ) => {
      try {
        return await operation(worktreePath);
      } finally {
        order.push('lease-released');
      }
    });
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
    expect(withWorktreeReuseReservationMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      expect.any(Function),
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
    });

    await expect(attach()).rejects.toThrow(/Failed to persist attached pane/);

    expect(launchAgentInPaneMock).not.toHaveBeenCalled();
    expect(removeProjectPaneConfigPanesMock).not.toHaveBeenCalled();
    expect(order).toEqual([
      'persistence-failed',
      'pane-killed',
      'lease-released',
    ]);
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
    });
    removeProjectPaneConfigPanesMock.mockImplementationOnce(async () => {
      order.push('record-removed');
    });

    await expect(attach()).rejects.toThrow(/Failed to launch attached agent/);

    const persistedPane = upsertProjectPaneConfigPanesMock.mock.calls[0][1][0] as PsychePane;
    expect(removeProjectPaneConfigPanesMock).toHaveBeenCalledWith(
      '/session',
      [persistedPane.id],
    );
    expect(order.indexOf('pane-killed')).toBeLessThan(order.indexOf('record-removed'));
    expect(order.indexOf('record-removed')).toBeLessThan(order.indexOf('lease-released'));
  });
});
