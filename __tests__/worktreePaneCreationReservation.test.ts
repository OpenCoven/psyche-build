import { describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';

const beginWorktreeReuseReservationMock = vi.hoisted(() => vi.fn());
const withProjectPaneSlugAllocationLockMock = vi.hoisted(() => vi.fn());
const readProjectPaneConfigUnderLockMock = vi.hoisted(() => vi.fn());
const listQuarantinedPaneSlugsMock = vi.hoisted(() => (
  vi.fn<() => Promise<string[]>>(async () => [])
));

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
  withProjectPaneSlugAllocationLock: withProjectPaneSlugAllocationLockMock,
}));

vi.mock('../src/services/WorktreeRecoveryMarker.js', () => ({
  listQuarantinedPaneSlugs: listQuarantinedPaneSlugsMock,
  writeWorktreeRecoveryMarker: vi.fn(),
}));

describe('worktree pane creation reservation', () => {
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
    withProjectPaneSlugAllocationLockMock.mockImplementationOnce(async (
      _projectRoot: string,
      operation: () => Promise<unknown>,
    ) => {
      order.push('acquire-slug-lock');
      try {
        return await operation();
      } finally {
        order.push('release-slug-lock');
      }
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
      'acquire-slug-lock',
      'load-fresh-panes',
      'allocate-slug',
      'release-slug-lock',
      'complete-reservation',
    ]);
  });

  it('treats durable recovery pane slugs as occupied during local sibling allocation', async () => {
    beginWorktreeReuseReservationMock.mockResolvedValueOnce({
      canonicalWorktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
      complete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      retain: vi.fn(),
    });
    withProjectPaneSlugAllocationLockMock.mockImplementationOnce(async (
      _projectRoot: string,
      operation: () => Promise<unknown>,
    ) => operation());
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
      projectRoot: process.cwd(),
      sessionProjectRoot: process.cwd(),
      existingPanes: [{ slug: 'feature' } as PsychePane],
      existingWorktree: {
        slug: 'feature',
        worktreePath: `${process.cwd()}/.psyche/worktrees/feature`,
        branchName: 'feature',
      },
      persistReusedPane: vi.fn(async () => {}),
      resolveExistingWorktreeSlug,
    }, ['claude', 'codex']);

    expect(resolveExistingWorktreeSlug).toHaveBeenCalledOnce();
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
    withProjectPaneSlugAllocationLockMock.mockImplementationOnce(async (
      _projectRoot: string,
      operation: () => Promise<unknown>,
    ) => {
      try {
        return await operation();
      } finally {
        order.push('release-slug-lock');
      }
    });
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
      'release-slug-lock',
      'cancel-reservation',
    ]);
  });
});
