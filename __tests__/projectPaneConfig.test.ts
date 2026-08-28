import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProjectPaneConfigLock,
  acquireProjectPaneSlugAllocationLock,
  mutateProjectPaneConfig,
  mutateProjectPaneSettings,
  readProjectPaneConfigUnderLock,
  removeProjectPaneConfigPaneIdentities,
  replaceProjectPaneConfigPaneIdentity,
  upsertProjectPaneConfigPanes,
} from '../src/services/ProjectPaneConfig.js';
import { generateSiblingSlugForTargetPane } from '../src/utils/attachAgent.js';
import {
  savePanesToFile,
  saveUpdatedPaneConfig,
} from '../src/hooks/usePaneSync.js';
import * as paneCreation from '../src/utils/paneCreation.js';
import {
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from '../src/utils/worktreeMetadata.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(join(process.cwd(), '.psyche-project-config-test-'));
  roots.push(root);
  return root;
}

describe('project pane config mutation', () => {
  it('serializes sibling slug allocation across distinct same-basename worktrees', async () => {
    expect(acquireProjectPaneSlugAllocationLock).toEqual(expect.any(Function));
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ slug: 'feature' }];
    });
    let firstAllocationEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstAllocationEntered = resolve;
    });
    let releaseFirstAllocation!: () => void;
    const firstCanPersist = new Promise<void>((resolve) => {
      releaseFirstAllocation = resolve;
    });
    let allocationCount = 0;

    const allocate = async (
      worktreePath: string,
      lockOptions: {
        pollIntervalMs?: number;
        sleep?: (ms: number) => Promise<void>;
      } = {},
    ): Promise<string> => {
      const lock = await acquireProjectPaneSlugAllocationLock(projectRoot, {
        pollIntervalMs: 1,
        ...lockOptions,
      });
      try {
        const config = await readProjectPaneConfigUnderLock(projectRoot);
        const freshPanes = (config.panes || []).filter(
          (pane): pane is { slug: string } => typeof pane.slug === 'string',
        );
        const slug = generateSiblingSlugForTargetPane(
          { slug: 'feature', worktreePath },
          freshPanes,
        );
        allocationCount += 1;
        if (allocationCount === 1) {
          firstAllocationEntered();
          await firstCanPersist;
        }
        await mutateProjectPaneConfig(projectRoot, (freshConfig) => {
          freshConfig.panes = [...(freshConfig.panes || []), { slug }];
        });
        return slug;
      } finally {
        await lock.release();
      }
    };

    const first = allocate(join(projectRoot, 'first', 'feature'));
    await firstEntered;

    let secondAllocationBlocked!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      secondAllocationBlocked = resolve;
    });
    let retrySecondAllocation!: () => void;
    const secondCanRetry = new Promise<void>((resolve) => {
      retrySecondAllocation = resolve;
    });
    const second = allocate(join(projectRoot, 'second', 'feature'), {
      sleep: async () => {
        secondAllocationBlocked();
        await secondCanRetry;
      },
    });
    await expect(Promise.race([
      secondBlocked.then(() => 'blocked'),
      second.then(() => 'allocated'),
    ])).resolves.toBe('blocked');

    releaseFirstAllocation();
    retrySecondAllocation();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'feature-a2',
      'feature-a3',
    ]);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes.map(
      (pane: { slug: string }) => pane.slug,
    )).toEqual([
      'feature',
      'feature-a2',
      'feature-a3',
    ]);
  });

  it('allocates concurrent attached-pane sibling slugs under the durable config lock', async () => {
    const projectRoot = createProject();
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ id: 'source', paneId: '%1', slug: 'feature', worktreePath }];
    });
    const persist = (paneCreation as Record<string, unknown>).persistPaneBeforeAgentLaunch;
    expect(persist).toBeTypeOf('function');

    const options = {
      prompt: 'review',
      existingWorktree: {
        slug: 'feature-a2',
        worktreePath,
        branchName: 'feature',
      },
      projectName: 'repo',
      existingPanes: [],
      projectRoot,
      sessionProjectRoot: projectRoot,
    };
    const pane = (id: string, paneId: string) => ({
      id,
      paneId,
      slug: 'feature-a2',
      prompt: 'review',
      worktreePath,
    });

    await Promise.all([
      (persist as Function)(options, projectRoot, pane('attached-1', '%2'), undefined),
      (persist as Function)(options, projectRoot, pane('attached-2', '%3'), undefined),
    ]);

    const config = JSON.parse(
      readFileSync(join(projectRoot, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    expect(config.panes.map((candidate: { slug: string }) => candidate.slug)).toEqual([
      'feature',
      'feature-a2',
      'feature-a3',
    ]);
  });

  it('skips worktree creation hooks and preserves metadata when attaching', async () => {
    const projectRoot = createProject();
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    writeWorktreeMetadata(worktreePath, {
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      displayName: 'Existing metadata',
      branchName: 'feature',
    });
    const runEffects = (paneCreation as Record<string, unknown>).runWorktreeCreationEffects;
    expect(runEffects).toBeTypeOf('function');
    const triggerWorktreeCreated = vi.fn(async () => ({ success: true }));
    const writeMetadata = vi.fn();
    const initializeHooks = vi.fn();

    await (runEffects as Function)({
      attaching: true,
      projectRoot,
      worktreePath,
      pane: { id: 'attached', paneId: '%2', slug: 'feature-a2', prompt: 'review' },
      metadata: { agent: 'claude', permissionMode: 'plan' },
      hooksEditingSession: true,
      triggerWorktreeCreated,
      writeMetadata,
      initializeHooks,
    });

    expect(triggerWorktreeCreated).not.toHaveBeenCalled();
    expect(writeMetadata).not.toHaveBeenCalled();
    expect(initializeHooks).not.toHaveBeenCalled();
    expect(readWorktreeMetadata(worktreePath)).toEqual({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      displayName: 'Existing metadata',
      branchName: 'feature',
    });
  });

  it('rejects a duplicate pane ID instead of replacing the existing record', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const original = {
      id: 'psyche-duplicate',
      paneId: '%1',
      slug: 'original',
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [original];
    });

    await expect(upsertProjectPaneConfigPanes(projectRoot, [{
      id: 'psyche-duplicate',
      paneId: '%2',
      slug: 'replacement',
    }])).rejects.toThrow(/Duplicate pane ID/);

    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([original]);
  });

  it('loads and atomically migrates legacy sidebar panes with duplicate slugs', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const fixturePath = join(
      process.cwd(),
      '__tests__',
      'fixtures',
      'sidebar-duplicate-slugs.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    mkdirSync(join(projectRoot, '.psyche'), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(fixture, null, 2)}\n`);

    const loaded = await readProjectPaneConfigUnderLock(projectRoot);
    expect(loaded.panes).toMatchObject([
      {
        id: 'pane-primary',
        slug: 'fix-auth',
        displayName: 'Fix auth',
      },
      {
        id: 'pane-api',
        slug: 'fix-auth-api-service',
        branchName: 'fix-auth',
        displayName: 'Fix auth · fix-auth-api-service',
      },
      {
        id: 'pane-web',
        slug: 'fix-auth-web-client',
        branchName: 'fix-auth',
        displayName: 'Fix auth · fix-auth-web-client',
      },
    ]);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes.map(
      (pane: { slug: string }) => pane.slug,
    )).toEqual(['fix-auth', 'fix-auth', 'fix-auth']);

    await upsertProjectPaneConfigPanes(projectRoot, [{
      id: 'pane-created-after-migration',
      paneId: '%4',
      slug: 'follow-up',
      displayName: 'Follow up',
      prompt: '',
    }]);

    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.panes.map((pane: { id: string }) => pane.id)).toEqual([
      'pane-primary',
      'pane-api',
      'pane-web',
      'pane-created-after-migration',
    ]);
    expect(new Set(persisted.panes.map(
      (pane: { slug: string }) => pane.slug,
    )).size).toBe(4);
  });

  it('removes a pane only when its exact tmux identity remains current', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const original = {
      id: 'psyche-exact',
      paneId: '%1',
      slug: 'original',
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [original];
    });

    await expect(removeProjectPaneConfigPaneIdentities(projectRoot, [{
      id: 'psyche-exact',
      paneId: '%2',
    }])).rejects.toThrow(/identity conflict/);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([original]);

    await removeProjectPaneConfigPaneIdentities(projectRoot, [{
      id: 'psyche-exact',
      paneId: '%1',
    }]);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([]);
  });

  it('does not remove a same-ID replacement from another tmux generation', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const oldGeneration = {
      pid: 111,
      processStartIdentity: 'old-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    };
    const replacement = {
      id: 'psyche-exact',
      paneId: '%1',
      slug: 'replacement',
      tmuxServerIdentity: {
        pid: 222,
        processStartIdentity: 'new-start',
        socketPath: '/tmux.sock',
        sessionId: '$2',
      },
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [replacement];
    });

    await expect(removeProjectPaneConfigPaneIdentities(projectRoot, [{
      id: 'psyche-exact',
      paneId: '%1',
      tmuxServerIdentity: oldGeneration,
    }])).rejects.toThrow(/identity conflict/);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([replacement]);
  });

  it('does not let a generation-less identity remove a generation-tagged replacement', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const replacement = {
      id: 'psyche-exact',
      paneId: '%1',
      slug: 'replacement',
      tmuxServerIdentity: {
        pid: 222,
        processStartIdentity: 'new-start',
        socketPath: '/tmux.sock',
        sessionId: '$2',
      },
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [replacement];
    });

    await expect(removeProjectPaneConfigPaneIdentities(projectRoot, [{
      id: 'psyche-exact',
      paneId: '%1',
    }])).rejects.toThrow(/identity conflict/);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([replacement]);
  });

  it('does not let a canonical-root alias bypass generation-safe replacement', async () => {
    const projectRoot = createProject();
    const aliasRoot = `${projectRoot}-alias`;
    symlinkSync(projectRoot, aliasRoot, 'dir');
    roots.push(aliasRoot);
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const oldGeneration = {
      pid: 111,
      processStartIdentity: 'old-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    };
    const newGeneration = {
      pid: 222,
      processStartIdentity: 'new-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$2',
    };
    const original = {
      id: 'psyche-restored',
      paneId: '%1',
      slug: 'restored',
      prompt: '',
      tmuxServerIdentity: oldGeneration,
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [original];
    });

    await expect(replaceProjectPaneConfigPaneIdentity(
      aliasRoot,
      { id: 'psyche-restored', paneId: '%1' },
      {
        id: 'psyche-restored',
        paneId: '%9',
        slug: 'restored',
        prompt: '',
        tmuxServerIdentity: newGeneration,
      },
    )).rejects.toThrow(/identity conflict/);

    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([original]);
  });

  it('rebinds a restored pane to its new tmux generation without inheriting stale background resources', async () => {
    const projectRoot = createProject();
    const oldGeneration = {
      pid: 111,
      processStartIdentity: 'old-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$1',
    };
    const newGeneration = {
      pid: 222,
      processStartIdentity: 'new-server-start',
      socketPath: '/tmux.sock',
      sessionId: '$2',
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{
        id: 'psyche-restored',
        paneId: '%1',
        slug: 'restored',
        prompt: '',
        tmuxServerIdentity: oldGeneration,
        testPaneId: '%old-test',
        testWindowId: '@old-test',
        testTmuxServerIdentity: oldGeneration,
        testStatus: 'running',
        devPaneId: '%old-dev',
        devWindowId: '@old-dev',
        devTmuxServerIdentity: oldGeneration,
        devStatus: 'running',
        backgroundWindowRecoveries: [{
          type: 'test',
          paneId: '%old-recovery',
          windowId: '@old-recovery',
          tmuxServerIdentity: oldGeneration,
          reason: 'old server',
        }],
      }];
    });

    const replacement = await replaceProjectPaneConfigPaneIdentity(
      projectRoot,
      {
        id: 'psyche-restored',
        paneId: '%1',
        tmuxServerIdentity: oldGeneration,
      },
      {
        id: 'psyche-restored',
        paneId: '%9',
        slug: 'restored',
        prompt: '',
        tmuxServerIdentity: newGeneration,
      },
    );

    expect(replacement.result).toMatchObject({
      id: 'psyche-restored',
      paneId: '%9',
      tmuxServerIdentity: newGeneration,
    });
    expect(replacement.result).not.toHaveProperty('testPaneId');
    expect(replacement.result).not.toHaveProperty('testWindowId');
    expect(replacement.result).not.toHaveProperty('devPaneId');
    expect(replacement.result).not.toHaveProperty('devWindowId');
    expect(replacement.result).not.toHaveProperty('backgroundWindowRecoveries');
  });

  it('keeps a daemon pane when a stale TUI closes a different pane', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    let releaseDaemonMutation!: () => void;
    let daemonMutationEntered!: () => void;
    const daemonCanPersist = new Promise<void>((resolve) => {
      releaseDaemonMutation = resolve;
    });
    const daemonEntered = new Promise<void>((resolve) => {
      daemonMutationEntered = resolve;
    });

    const daemonPersist = mutateProjectPaneConfig(projectRoot, async (config) => {
      config.panes = [{
        id: 'tui-close',
        paneId: '%1',
        slug: 'tui-close',
      }];
      daemonMutationEntered();
      await daemonCanPersist;
      config.panes = [
        ...(config.panes || []),
        {
          id: 'daemon-pane',
          paneId: '%2',
          slug: 'daemon-pane',
          worktreePath: join(projectRoot, '.psyche', 'worktrees', 'daemon-pane'),
        },
      ];
    });

    await daemonEntered;
    const staleTuiClose = mutateProjectPaneConfig(projectRoot, (config) => {
      // The TUI only knows its own stale snapshot. It must remove this exact
      // ID from the fresh config instead of writing its stale array back.
      config.panes = (config.panes || []).filter((pane) => pane.id !== 'tui-close');
    });

    releaseDaemonMutation();
    await Promise.all([daemonPersist, staleTuiClose]);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual([
      expect.objectContaining({ id: 'daemon-pane', paneId: '%2' }),
    ]);
  });

  it('preserves a daemon pane while applying a stale TUI update', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const renderedPane = {
      id: 'tui-pane',
      paneId: '%1',
      slug: 'tui-pane',
      prompt: '',
    };
    const daemonPane = {
      id: 'daemon-pane',
      paneId: '%2',
      slug: 'daemon-pane',
      prompt: '',
      daemonOnlyField: 'keep-me',
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [renderedPane];
    });

    // The daemon writes after React rendered `renderedPane`, so the TUI's
    // next save cannot infer deletion from its stale whole-array snapshot.
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [...(config.panes || []), daemonPane];
    });

    const updatedPane = {
      ...renderedPane,
      displayName: 'Renamed in TUI',
    };
    const createdPane = {
      id: 'tui-created',
      paneId: '%3',
      slug: 'tui-created',
      prompt: '',
    };
    await savePanesToFile(
      configPath,
      [updatedPane, createdPane] as any,
      async (operation) => operation(),
      [renderedPane] as any,
    );

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tui-pane',
        displayName: 'Renamed in TUI',
      }),
      expect.objectContaining({
        id: 'tui-created',
        paneId: '%3',
      }),
      expect.objectContaining({
        id: 'daemon-pane',
        daemonOnlyField: 'keep-me',
      }),
    ]));
  });

  it('preserves concurrent pane fields while applying a stale local property change', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const stalePane = {
      id: 'tui-pane',
      paneId: '%1',
      slug: 'tui-pane',
      prompt: '',
      autopilot: false,
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [stalePane];
    });
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{
        ...stalePane,
        agentSession: {
          agent: 'codex',
          id: 'session-123',
          updatedAt: '2026-08-07T00:00:00.000Z',
        },
      }];
    });

    await savePanesToFile(
      configPath,
      [{ ...stalePane, autopilot: true }] as any,
      async (operation) => operation(),
      [stalePane] as any,
    );

    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([
      expect.objectContaining({
        id: 'tui-pane',
        autopilot: true,
        agentSession: {
          agent: 'codex',
          id: 'session-123',
          updatedAt: '2026-08-07T00:00:00.000Z',
        },
      }),
    ]);
  });

  it('clears a locally deleted pane property without discarding concurrent fields', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const stalePane = {
      id: 'tui-pane',
      paneId: '%1',
      slug: 'tui-pane',
      prompt: '',
      displayName: 'Original name',
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [stalePane];
    });
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{
        ...stalePane,
        displayName: 'Concurrent name',
        agentSession: {
          agent: 'claude',
          id: 'session-456',
          updatedAt: '2026-08-07T00:00:00.000Z',
        },
      }];
    });

    await savePanesToFile(
      configPath,
      [{ ...stalePane, displayName: undefined }] as any,
      async (operation) => operation(),
      [stalePane] as any,
    );

    const [persistedPane] = JSON.parse(readFileSync(configPath, 'utf8')).panes;
    expect(persistedPane).not.toHaveProperty('displayName');
    expect(persistedPane).toMatchObject({
      id: 'tui-pane',
      agentSession: {
        agent: 'claude',
        id: 'session-456',
      },
    });
  });

  it('uses local intent deterministically when both writers change one pane property', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const stalePane = {
      id: 'tui-pane',
      paneId: '%1',
      slug: 'tui-pane',
      prompt: 'Original prompt',
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [stalePane];
    });
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ ...stalePane, prompt: 'Concurrent prompt' }];
    });

    await savePanesToFile(
      configPath,
      [{ ...stalePane, prompt: 'Local prompt' }] as any,
      async (operation) => operation(),
      [stalePane] as any,
    );

    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([
      expect.objectContaining({
        id: 'tui-pane',
        prompt: 'Local prompt',
      }),
    ]);
  });

  it('does not resurrect a pane concurrently deleted after the originating snapshot', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const originalPane = {
      id: 'deleted-pane',
      paneId: '%1',
      slug: 'deleted-pane',
      prompt: '',
    };
    const staleUpdate = {
      ...originalPane,
      displayName: 'Stale TUI rename',
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [originalPane];
    });
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [];
    });

    await savePanesToFile(
      configPath,
      [staleUpdate] as any,
      async (operation) => operation(),
      [originalPane] as any,
    );

    let config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual([]);

    // A caller whose originating snapshot reflects the deletion can explicitly
    // add the pane again; a stale update cannot.
    await savePanesToFile(
      configPath,
      [staleUpdate] as any,
      async (operation) => operation(),
      [],
    );

    config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual([
      expect.objectContaining({
        id: 'deleted-pane',
        displayName: 'Stale TUI rename',
      }),
    ]);
  });

  it('persists periodic stale-shell removals without dropping daemon panes', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const trackedPane = {
      id: 'tracked-pane',
      paneId: '%1',
      slug: 'tracked-pane',
      prompt: '',
    };
    const staleShellPane = {
      id: 'stale-shell',
      paneId: '%2',
      slug: 'stale-shell',
      prompt: '',
      type: 'shell',
    };
    const daemonPane = {
      id: 'daemon-pane',
      paneId: '%3',
      slug: 'daemon-pane',
      prompt: '',
      daemonOnlyField: 'keep-me',
    };
    const previousPanes = [trackedPane, staleShellPane];

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = previousPanes;
    });
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [...(config.panes || []), daemonPane];
    });

    await saveUpdatedPaneConfig(
      configPath,
      [trackedPane] as any,
      async (operation) => operation(),
      previousPanes as any,
    );

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tracked-pane' }),
      expect.objectContaining({
        id: 'daemon-pane',
        daemonOnlyField: 'keep-me',
      }),
    ]));
    expect(config.panes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-shell' }),
    ]));
  });

  it('mutates settings without replacing pane records or unknown fields', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ id: 'keep-pane', paneId: '%1', slug: 'keep-pane' }];
      config.settings = { thirdPartySetting: 'preserve-me' };
      config.unknownTopLevelField = { retained: true };
    });

    await mutateProjectPaneSettings(projectRoot, (settings) => {
      settings.testCommand = 'pnpm test';
    });

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      panes: [expect.objectContaining({ id: 'keep-pane', paneId: '%1' })],
      settings: {
        thirdPartySetting: 'preserve-me',
        testCommand: 'pnpm test',
      },
      unknownTopLevelField: { retained: true },
    });
  });

  it('recovers a config lock from a reused live PID with a different start identity', async () => {
    const projectRoot = createProject();
    let ownerIdentity = 'owner-start';
    const first = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 101,
      isProcessAlive: () => true,
      getProcessStartIdentity: () => ownerIdentity,
      createNonce: () => 'first-owner',
    });

    ownerIdentity = 'reused-pid-start';
    const recovered = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 202,
      isProcessAlive: () => true,
      getProcessStartIdentity: (pid) => (
        pid === 101 ? ownerIdentity : 'second-start'
      ),
      createNonce: () => 'second-owner',
    });

    expect(recovered.nonce).toBe('second-owner');
    await first.release();
    await recovered.release();
  });

  it('does not steal a live config lock when process identity is unavailable', async () => {
    const projectRoot = createProject();
    const first = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 101,
      isProcessAlive: () => true,
      getProcessStartIdentity: () => 'first-owner-start',
      createNonce: () => 'first-owner',
    });

    await expect(acquireProjectPaneConfigLock(projectRoot, {
      pid: 202,
      isProcessAlive: () => true,
      // A failed ps lookup is uncertainty, not evidence of PID reuse.
      getProcessStartIdentity: (pid) => (pid === 101 ? undefined : 'second-owner-start'),
      pollIntervalMs: 5,
      timeoutMs: 25,
      createNonce: () => 'second-owner',
    })).rejects.toThrow(/Timed out waiting for project pane config lock/);

    await first.release();
  });
});
