import { describe, expect, it, vi } from 'vitest';

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
    const operation = vi.fn(async () => {
      await persistence;
      return 'created';
    });
    const creation = withReservation!({
      worktreePath: '/repo/.psyche/worktrees/feature',
      projectRoot: '/repo',
      beginReservation: vi.fn(async () => ({
        canonicalWorktreePath: '/repo/.psyche/worktrees/feature',
        complete,
        cancel,
        retain: vi.fn(),
      })),
      operation,
    });

    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    releasePersistence();
    await expect(creation).resolves.toBe('created');
    expect(complete).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});
