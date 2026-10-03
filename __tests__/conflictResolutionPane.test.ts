import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSlugAllocationState } from '../src/services/PaneSlugRegistry.js';
import type { CrashSafePaneSlugReservationOptions } from '../src/services/PaneSlugReservation.js';
import type { TmuxServerIdentity } from '../src/services/TmuxServerIdentity.js';
import type { PsychePane } from '../src/types.js';
import type { AgentName, PermissionMode } from '../src/utils/agentLaunch.js';

type SendShellCommandCall = [paneId: string, command: string];

const tmuxService = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getServerIdentity: vi.fn(),
  paneExists: vi.fn(async () => true),
  setPaneTitle: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
  getPaneCurrentCommand: vi.fn(async (): Promise<string> => 'zsh'),
}));
const splitPaneMock = vi.hoisted(() => vi.fn(() => '%9'));
const persistExactMock = vi.hoisted(() => vi.fn());
const beginReservationMock = vi.hoisted(() => vi.fn());
const capturePaneInsertionMock = vi.hoisted(() => vi.fn(async () => undefined));
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn(async () => ({})));
const reserveCrashSafePaneSlugMock = vi.hoisted(() => vi.fn());
const settlePaneSlugReservationAfterFailureMock = vi.hoisted(() => vi.fn());
const buildAgentCommandMock = vi.hoisted(() => vi.fn<(
  agent: AgentName,
  permissionMode: PermissionMode | undefined,
) => string>(() => 'opencode'));
const buildInitialPromptCommandMock = vi.hoisted(() => vi.fn(() => 'opencode --prompt'));
const getPromptTransportMock = vi.hoisted(() => vi.fn(() => 'inline'));
const buildPromptReadAndDeleteSnippetMock = vi.hoisted(() => vi.fn(() => 'read-prompt'));
const writePromptFileMock = vi.hoisted(() => vi.fn(async (): Promise<string> => {
  throw new Error('use inline prompt');
}));
const sendPromptViaTmuxMock = vi.hoisted(() => vi.fn(async (): Promise<
  { delivered: true } | { delivered: false; reason: 'agent_not_ready' | 'prompt_paste_failed' }
> => ({ delivered: true })));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => tmuxService },
}));
vi.mock('../src/utils/tmux.js', () => ({
  enforceControlPaneSize: vi.fn(async () => {}),
  ensurePaneBorderStatusForCurrentSession: vi.fn(),
  splitPane: splitPaneMock,
}));
vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
}));
vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(function SettingsManager() { return {
    getSettings: () => ({ permissionMode: 'plan' }),
  }; }),
}));
vi.mock('../src/utils/agentLaunch.js', () => ({
  buildAgentCommand: buildAgentCommandMock,
  buildInitialPromptCommand: buildInitialPromptCommandMock,
  getDefaultEnabledAgents: () => ['opencode'],
  getAgentDefinitions: () => [{
    id: 'opencode',
    name: 'OpenCode',
  }],
  getAgentProcessName: () => 'opencode',
  getPromptTransport: getPromptTransportMock,
  getSendKeysPostPasteDelayMs: () => 0,
  getSendKeysPrePrompt: () => [],
  getSendKeysReadyDelayMs: () => 0,
  getSendKeysSubmit: () => [],
}));
vi.mock('../src/utils/promptStore.js', () => ({
  buildPromptReadAndDeleteSnippet: buildPromptReadAndDeleteSnippetMock,
  deletePromptFile: vi.fn(async () => {}),
  writePromptFile: writePromptFileMock,
}));
vi.mock('../src/utils/agentPromptDispatch.js', () => ({
  sendPromptViaTmux: sendPromptViaTmuxMock,
}));
vi.mock('../src/utils/paneColors.js', () => ({
  resolveProjectColorTheme: () => 'blue',
}));
vi.mock('../src/utils/paneIdentity.js', () => ({
  createPsychePaneId: () => 'conflict-pane-id',
}));
vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: () => ({
      beginWorktreeReuseReservation: beginReservationMock,
    }),
  },
}));
vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  compareAndRemoveProjectPaneConfigPaneIdentities: vi.fn(),
  ensureProjectPaneConfigPane: vi.fn(),
  projectPaneConfigPath: (root: string) => `${root}/.psyche/psyche.config.json`,
  readProjectPaneConfigUnderLock: vi.fn(async () => ({ panes: [] })),
  readProjectPaneConfig: vi.fn(async () => ({ controlPaneId: '%0', panes: [] })),
}));
vi.mock('../src/services/PaneSlugReservation.js', () => ({
  reserveCrashSafePaneSlug: reserveCrashSafePaneSlugMock,
  settlePaneSlugReservationAfterFailure: settlePaneSlugReservationAfterFailureMock,
}));
vi.mock('../src/constants/timing.js', () => ({
  TMUX_LAYOUT_APPLY_DELAY: 0,
  TMUX_SPLIT_DELAY: 0,
}));

describe('conflict resolution pane transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildAgentCommandMock.mockReturnValue('opencode');
    buildInitialPromptCommandMock.mockReturnValue('opencode --prompt');
    getPromptTransportMock.mockReturnValue('inline');
    buildPromptReadAndDeleteSnippetMock.mockReturnValue('read-prompt');
    writePromptFileMock.mockImplementation(async () => {
      throw new Error('use inline prompt');
    });
    const occupiedSlugs = new Set<string>();
    reserveCrashSafePaneSlugMock.mockImplementation(async (
      options: CrashSafePaneSlugReservationOptions,
    ) => {
      const allocationState: PaneSlugAllocationState = {
        config: { panes: [] },
        occupiedSlugs,
        persistedSlugs: new Set<string>(),
        ownershipRecords: [],
      };
      const candidate = await options.allocate(allocationState);
      occupiedSlugs.add(candidate.slug);
      let effect:
        | { paneId: string; tmuxServerIdentity?: TmuxServerIdentity }
        | undefined;
      return {
        recoveryId: 'recovery-conflict',
        sessionProjectRoot: options.sessionProjectRoot,
        projectRoot: options.projectRoot,
        paneId: options.paneId,
        worktreePath: candidate.worktreePath,
        slug: candidate.slug,
        get effect() {
          return effect;
        },
        recordPaneEffect: vi.fn(async (
          paneId: string,
          tmuxServerIdentity?: TmuxServerIdentity,
        ) => {
          effect = { paneId, tmuxServerIdentity };
        }),
        completeAfterPanePersisted: vi.fn(async () => {
          occupiedSlugs.delete(candidate.slug);
        }),
        clearBeforeEffect: vi.fn(async () => {
          occupiedSlugs.delete(candidate.slug);
        }),
        clearAfterConfirmedTeardown: vi.fn(async () => {
          occupiedSlugs.delete(candidate.slug);
        }),
      };
    });
    settlePaneSlugReservationAfterFailureMock.mockResolvedValue({
      released: true,
      quarantined: false,
    });
    beginReservationMock.mockResolvedValue({
      canonicalWorktreePath: '/repo/.psyche/worktrees/feature',
      retain: vi.fn(),
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });
    tmuxService.paneExists.mockResolvedValue(true);
    tmuxService.getServerIdentity.mockReturnValue({
      pid: 4242,
      processStartIdentity: 'test-tmux-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$test',
    });
    tmuxService.sendShellCommand.mockResolvedValue(undefined);
    tmuxService.sendTmuxKeys.mockResolvedValue(undefined);
    tmuxService.selectPane.mockResolvedValue(undefined);
    tmuxService.getPaneCurrentCommand.mockReset();
    tmuxService.getPaneCurrentCommand.mockResolvedValue('zsh');
  });

  it('persists the exact conflict pane before issuing merge or agent commands', async () => {
    const order: string[] = [];
    const { createConflictResolutionPane } = await import(
      '../src/utils/conflictResolutionPane.js'
    );
    (tmuxService.sendShellCommand as any).mockImplementation(async (
      _paneId: string,
      command: string,
    ) => {
      order.push(`command:${command}`);
    });

    const pane = await createConflictResolutionPane({
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/repo/.psyche/worktrees/feature',
      sessionProjectRoot: '/repo',
      targetProjectRoot: '/repo',
      projectName: 'repo',
      existingPanes: [] as PsychePane[],
      agent: 'opencode',
      persistConflictPane: async (record) => {
        order.push(`persist:${record.id}:${record.paneId}`);
        persistExactMock(record);
      },
    });

    const firstMergeCommand = order.findIndex((entry) => entry.startsWith('command:git merge'));
    expect(order[0]).toBe('persist:conflict-pane-id:%9');
    expect(firstMergeCommand).toBeGreaterThan(0);
    expect(persistExactMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'conflict-pane-id',
      paneId: '%9',
      worktreePath: '/repo/.psyche/worktrees/feature',
    }));
    expect(pane.worktreePath).toBe('/repo/.psyche/worktrees/feature');
    expect(beginReservationMock).toHaveBeenCalledWith(
      '/repo/.psyche/worktrees/feature',
      '/repo',
    );
  });

  it('reserves distinct slugs when conflict pane producers race', async () => {
    const { createConflictResolutionPane } = await import(
      '../src/utils/conflictResolutionPane.js'
    );
    let paneNumber = 8;
    splitPaneMock.mockImplementation(() => `%${++paneNumber}`);
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persisted: PsychePane[] = [];
    const persistConflictPane = vi.fn(async (pane: PsychePane) => {
      persisted.push(pane);
      if (persisted.length === 2) {
        releasePersist();
      }
      await persistGate;
    });
    const options = {
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/target/.psyche/worktrees/feature',
      sessionProjectRoot: '/session',
      targetProjectRoot: '/target',
      projectName: 'target',
      existingPanes: [] as PsychePane[],
      agent: 'opencode' as const,
      persistConflictPane,
    };

    const [first, second] = await Promise.all([
      createConflictResolutionPane(options),
      createConflictResolutionPane(options),
    ]);

    expect([first.slug, second.slug].sort()).toEqual([
      'merge-feature-into-main',
      'merge-feature-into-main-2',
    ]);
    expect(reserveCrashSafePaneSlugMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionProjectRoot: '/session',
        projectRoot: '/target',
        operation: 'conflict-resolution-pane',
      }),
    );
  });

  it('launches coven-code bare without prompt bootstrap files when permission mode is plan', async () => {
    const { buildAgentCommand: buildRealAgentCommand } = await vi.importActual<
      typeof import('../src/utils/agentLaunch.js')
    >('../src/utils/agentLaunch.js');
    buildAgentCommandMock.mockImplementation((
      agent: AgentName,
      permissionMode: PermissionMode | undefined,
    ) => (
      buildRealAgentCommand(agent, permissionMode)
    ));
    getPromptTransportMock.mockReturnValue('launch-only');

    const { createConflictResolutionPane } = await import(
      '../src/utils/conflictResolutionPane.js'
    );

    await createConflictResolutionPane({
      sourceBranch: 'feature',
      targetBranch: 'main',
      targetRepoPath: '/repo/.psyche/worktrees/feature',
      sessionProjectRoot: '/repo',
      targetProjectRoot: '/repo',
      projectName: 'repo',
      existingPanes: [] as PsychePane[],
      agent: 'coven-code',
      persistConflictPane: async () => {},
    });

    expect(writePromptFileMock).not.toHaveBeenCalled();
    expect(buildPromptReadAndDeleteSnippetMock).not.toHaveBeenCalled();
    expect(buildInitialPromptCommandMock).not.toHaveBeenCalled();
    expect(buildAgentCommandMock).toHaveBeenCalledWith('coven-code', 'plan');
    expect(sendPromptViaTmuxMock).not.toHaveBeenCalled();
    const lastSendShellCommandCall = tmuxService.sendShellCommand.mock.calls.at(-1) as
      | SendShellCommandCall
      | undefined;
    expect(lastSendShellCommandCall?.[1]).toBe('coven');
  });

  describe('prompt bootstrap follows the pane shell (#508)', () => {
    const savedShell = process.env.SHELL;
    const newReport = () => ({
      logWarn: vi.fn<(message: string, source: string, paneId: string) => void>(),
      showToast: vi.fn<(message: string) => void>(),
    });
    let report = newReport();
    beforeEach(() => {
      report = newReport();
      writePromptFileMock.mockImplementation(async () => '/repo/.psyche/prompts/p.txt');
      getPromptTransportMock.mockReturnValue('option');
    });
    afterEach(() => {
      process.env.SHELL = savedShell;
    });

    async function createPane() {
      const { createConflictResolutionPane } = await import(
        '../src/utils/conflictResolutionPane.js'
      );
      let t = 0;
      await createConflictResolutionPane({
        sourceBranch: 'feature',
        targetBranch: 'main',
        targetRepoPath: '/repo/.psyche/worktrees/feature',
        sessionProjectRoot: '/repo',
        targetProjectRoot: '/repo',
        projectName: 'repo',
        existingPanes: [] as PsychePane[],
        agent: 'opencode',
        persistConflictPane: async () => {},
        paneShellProbe: { now: () => t, sleep: async (ms: number) => { t += ms; } },
        promptSkipReport: report,
      });
      const last = tmuxService.sendShellCommand.mock.calls.at(-1) as SendShellCommandCall | undefined;
      return last?.[1];
    }

    it('uses the posix dialect in a zsh pane even when $SHELL is fish', async () => {
      process.env.SHELL = '/opt/homebrew/bin/fish';
      tmuxService.getPaneCurrentCommand.mockResolvedValue('zsh');
      await createPane();
      expect(buildPromptReadAndDeleteSnippetMock).toHaveBeenCalledWith('/repo/.psyche/prompts/p.txt', 'posix');
    });

    it('uses the fish dialect in a fish pane even when $SHELL is zsh', async () => {
      process.env.SHELL = '/bin/zsh';
      tmuxService.getPaneCurrentCommand.mockResolvedValue('fish');
      await createPane();
      expect(buildPromptReadAndDeleteSnippetMock).toHaveBeenCalledWith('/repo/.psyche/prompts/p.txt', 'fish');
    });

    // A slow merge or hook still running when the shell was read used to
    // report `git`, silently dropping the conflict brief. The shell is read
    // before the pane is given any command.
    it('reads the pane shell before typing the cd and merge lines', async () => {
      const order: string[] = [];
      tmuxService.getPaneCurrentCommand.mockImplementation(async () => {
        order.push('read-shell');
        return order.some((entry) => entry.startsWith('command:git merge')) ? 'git' : 'zsh';
      });
      (tmuxService.sendShellCommand as any).mockImplementation(async (_paneId: string, command: string) => {
        order.push(`command:${command}`);
      });
      await createPane();
      expect(order[0]).toBe('read-shell');
      expect(order.filter((entry) => entry === 'read-shell')).toHaveLength(1);
      expect(buildPromptReadAndDeleteSnippetMock).toHaveBeenCalledWith('/repo/.psyche/prompts/p.txt', 'posix');
      expect(report.logWarn).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown shell', 'unrecognized_shell', () => tmuxService.getPaneCurrentCommand.mockResolvedValue('nu')],
      ['a read error', 'unreadable_shell', () => tmuxService.getPaneCurrentCommand.mockRejectedValue(new Error('no pane'))],
    ])('launches bare without a prompt file or inline prompt for %s', async (_label, reason, arrange) => {
      arrange();
      const line = await createPane();
      expect(writePromptFileMock).not.toHaveBeenCalled();
      expect(buildPromptReadAndDeleteSnippetMock).not.toHaveBeenCalled();
      expect(buildInitialPromptCommandMock).not.toHaveBeenCalled();
      expect(line).toBe('opencode');
      expect(report.logWarn).toHaveBeenCalledTimes(1);
      expect(report.logWarn.mock.calls[0][0]).toContain(`[initial_prompt_skipped:${reason}]`);
      expect(report.logWarn.mock.calls[0][1]).toBe('conflictResolutionPane');
      expect(report.showToast).toHaveBeenCalledTimes(1);
      expect(report.showToast.mock.calls[0][0]).toContain('without its initial prompt');
    });

    // #523: a send-keys agent that never took the foreground is not pasted
    // into blindly; the skip is reported like any other withheld prompt.
    it('reports a send-keys paste that was not delivered', async () => {
      tmuxService.getPaneCurrentCommand.mockResolvedValue('zsh');
      getPromptTransportMock.mockReturnValue('send-keys');
      sendPromptViaTmuxMock.mockResolvedValueOnce({ delivered: false, reason: 'agent_not_ready' });
      await createPane();
      expect(sendPromptViaTmuxMock).toHaveBeenCalledTimes(1);
      expect(report.logWarn).toHaveBeenCalledTimes(1);
      expect(report.logWarn.mock.calls[0][0]).toContain('[initial_prompt_skipped:agent_not_ready]');
      expect(report.logWarn.mock.calls[0][0]).not.toContain('conflicts merging');
      expect(report.showToast).toHaveBeenCalledTimes(1);
    });

    // AGENTS.md: the prompt is never inlined into the typed line or argv.
    it('launches bare and reports instead of inlining when the prompt file cannot be written', async () => {
      tmuxService.getPaneCurrentCommand.mockResolvedValue('zsh');
      writePromptFileMock.mockImplementation(async () => {
        throw new Error('disk full');
      });
      const line = await createPane();
      expect(buildInitialPromptCommandMock).not.toHaveBeenCalled();
      expect(line).toBe('opencode');
      expect(report.logWarn.mock.calls[0][0]).toContain('[initial_prompt_skipped:prompt_file_unwritable]');
      expect(report.showToast).toHaveBeenCalledTimes(1);
    });
  });
});
