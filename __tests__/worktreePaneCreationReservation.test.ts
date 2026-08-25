import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const beginWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
const listQuarantinedPaneSlugsMock = vi.hoisted(() => (
  vi.fn<() => Promise<string[]>>(async () => [])
));
const reserveCrashSafePaneSlugMock = vi.hoisted(() => vi.fn());
const settlePaneSlugReservationAfterFailureMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: () => ({
      beginWorktreeReuseReservation: beginWorktreeReuseReservationMock,
    }),
  },
}));

vi.mock('../src/services/ProjectPaneConfig.js', () => ({
  ensureProjectPaneConfigPane: vi.fn(),
  mutateProjectPaneConfig: vi.fn(),
  projectPaneConfigPath: (projectRoot: string) => (
    `${projectRoot}/.psyche/psyche.config.json`
  ),
  readProjectPaneConfigUnderLock: readProjectPaneConfigUnderLockMock,
}));

vi.mock('../src/services/PaneSlugReservation.js', () => ({
  reserveCrashSafePaneSlug: reserveCrashSafePaneSlugMock,
  settlePaneSlugReservationAfterFailure: settlePaneSlugReservationAfterFailureMock,
}));

vi.mock('../src/services/WorktreeRecoveryMarker.js', () => ({
  listQuarantinedPaneSlugs: listQuarantinedPaneSlugsMock,
  writeWorktreeRecoveryMarker: vi.fn(),
}));

describe('worktree pane creation reservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listQuarantinedPaneSlugsMock.mockResolvedValue([]);
    settlePaneSlugReservationAfterFailureMock.mockResolvedValue({
      released: true,
      quarantined: false,
    });
    reserveCrashSafePaneSlugMock.mockImplementation(async (options) => {
      const config = await readProjectPaneConfigUnderLockMock();
      const quarantined = await listQuarantinedPaneSlugsMock();
      const persistedSlugs = new Set(
        (config.panes || []).map((pane: PsychePane) => pane.slug),
      );
      const occupiedSlugs = new Set([...persistedSlugs, ...quarantined]);
      const candidate = await options.allocate({
        config,
        persistedSlugs,
        occupiedSlugs,
        ownershipRecords: [],
      });
      return {
        recoveryId: '00000000-0000-4000-8000-000000000001',
        sessionProjectRoot: options.sessionProjectRoot,
        projectRoot: options.projectRoot,
        slug: candidate.slug,
        paneId: options.paneId,
        worktreePath: candidate.worktreePath,
        effect: undefined,
        recordPaneEffect: vi.fn(async () => {}),
        completeAfterPanePersisted: vi.fn(async () => {}),
        clearBeforeEffect: vi.fn(async () => {}),
        clearAfterConfirmedTeardown: vi.fn(async () => {}),
      };
    });
  });

  it('holds reuse ownership through durable pane persistence', async () => {
    const module = await import('../src/utils/worktreePaneCreationReservation.js');
    const withReservation = (
      module as typeof module & {
        withWorktreePaneCreationReservation?: (
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).withWorktreePaneCreationReservation;
    expect(withReservation).toEqual(expect.any(Function));

    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const complete = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    const order: string[] = [];
    const operation = vi.fn(async () => {
      await persistence;
      order.push('persist-pane');
      return 'created';
    });
    const creation = withReservation!({
      worktreePath: '/repo/.psyche/worktrees/feature',
      projectRoot: '/repo',
      beginReservation: vi.fn(async () => {
        order.push('begin-reservation');
        return {
          canonicalWorktreePath: '/repo/.psyche/worktrees/feature',
          complete: async () => {
            order.push('complete-reservation');
            await complete();
          },
          cancel,
          retain: vi.fn(),
        };
      }),
      operation,
    });

    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    releasePersistence();
    await expect(creation).resolves.toBe('created');
    expect(complete).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(order).toEqual([
      'begin-reservation',
      'persist-pane',
      'complete-reservation',
    ]);
  });

  it('invokes the allocator only after reserving reuse and loading fresh panes', async () => {
    const order: string[] = [];
    beginWorktreeReuseReservationMock.mockImplementationOnce(async () => {
      order.push('begin-reservation');
      return {
        canonicalWorktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
        complete: async () => {
          order.push('complete-reservation');
        },
        cancel: vi.fn(async () => {}),
        retain: vi.fn(),
      };
    });
    readProjectPaneConfigUnderLockMock.mockImplementationOnce(async () => {
      order.push('load-fresh-panes');
      return {
        panes: [
          { slug: 'feature' },
          { slug: 'feature-a2' },
        ],
      };
    });

    const { createPane } = await import('../src/utils/paneCreation.js');
    const result = await createPane({
      prompt: 'review',
      projectName: 'repo',
      projectRoot: process.cwd(),
      sessionProjectRoot: process.cwd(),
      existingPanes: [{ slug: 'feature' } as PsychePane],
      existingWorktree: {
        slug: 'feature',
        worktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
        branchName: 'feature',
      },
      persistReusedPane: vi.fn(async () => {}),
      resolveExistingWorktreeSlug: (freshPanes) => {
        order.push('allocate-slug');
        expect(freshPanes.map((pane) => pane.slug)).toEqual([
          'feature',
          'feature-a2',
        ]);
        return 'feature-a3';
      },
    }, ['claude', 'codex']);

    expect(result.needsAgentChoice).toBe(true);
    expect(order).toEqual([
      'begin-reservation',
      'load-fresh-panes',
      'allocate-slug',
      'complete-reservation',
    ]);
  });

  it('reads cross-project recovery slugs from the session allocation namespace', async () => {
    const sessionProjectRoot = `${process.cwd()}/session-project`;
    const targetProjectRoot = `${process.cwd()}/target-project`;
    beginWorktreeReuseReservationMock.mockResolvedValueOnce({
      canonicalWorktreePath: `${targetProjectRoot}/.psyche/worktrees/feature`,
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      retain: vi.fn(),
    });
    readProjectPaneConfigUnderLockMock.mockResolvedValueOnce({
      panes: [{ slug: 'feature' }],
    });
    listQuarantinedPaneSlugsMock.mockResolvedValueOnce(['feature-a2']);

    const { createPane } = await import('../src/utils/paneCreation.js');
    const resolveExistingWorktreeSlug = vi.fn((freshPanes: readonly PsychePane[]) => {
      expect(freshPanes.map((pane) => pane.slug)).toEqual([
        'feature',
        'feature-a2',
      ]);
      return 'feature-a3';
    });
    await createPane({
      prompt: 'review',
      projectName: 'repo',
      projectRoot: targetProjectRoot,
      sessionConfigPath: `${sessionProjectRoot}/.psyche/psyche.config.json`,
      existingPanes: [{ slug: 'feature' } as PsychePane],
      existingWorktree: {
        slug: 'feature',
        worktreePath: `${targetProjectRoot}/.psyche/worktrees/feature`,
        branchName: 'feature',
      },
      persistReusedPane: vi.fn(async () => {}),
      resolveExistingWorktreeSlug,
    }, ['claude', 'codex']);

    expect(resolveExistingWorktreeSlug).toHaveBeenCalledOnce();
    expect(beginWorktreeReuseReservationMock).toHaveBeenLastCalledWith(
      `${targetProjectRoot}/.psyche/worktrees/feature`,
      targetProjectRoot,
      undefined,
      sessionProjectRoot,
    );
    expect(reserveCrashSafePaneSlugMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionProjectRoot }),
    );
    expect(listQuarantinedPaneSlugsMock).toHaveBeenCalledOnce();
  });

  it('releases the slug lock before cancelling reuse after allocation failure', async () => {
    const order: string[] = [];
    beginWorktreeReuseReservationMock.mockImplementationOnce(async () => ({
      canonicalWorktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
      complete: async () => {
        order.push('complete-reservation');
      },
      cancel: async () => {
        order.push('cancel-reservation');
      },
      retain: vi.fn(),
    }));
    readProjectPaneConfigUnderLockMock.mockImplementationOnce(async () => {
      order.push('load-fresh-panes');
      return { panes: [{ slug: 'feature' }] };
    });

    const { createPane } = await import('../src/utils/paneCreation.js');
    await expect(createPane({
      prompt: 'review',
      projectName: 'repo',
      projectRoot: process.cwd(),
      sessionProjectRoot: process.cwd(),
      existingPanes: [{ slug: 'feature' } as PsychePane],
      existingWorktree: {
        slug: 'feature',
        worktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
        branchName: 'feature',
      },
      persistReusedPane: vi.fn(async () => {}),
      resolveExistingWorktreeSlug: () => {
        order.push('allocate-slug');
        throw new Error('allocation failed');
      },
    }, ['claude'])).rejects.toThrow('allocation failed');

    expect(order).toEqual([
      'load-fresh-panes',
      'allocate-slug',
      'cancel-reservation',
    ]);
  });
});
