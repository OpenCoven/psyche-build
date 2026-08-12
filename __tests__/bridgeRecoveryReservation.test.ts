import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bridge recovery reservation', () => {
  it('associates the exact recovery marker generation with the retained reservation', async () => {
    const module = await import('../src/utils/paneLifecycleRecovery.js');
    const retainReservationWithRecoveryMarker = (
      module as typeof module & {
        retainReservationWithRecoveryMarker?: (
          reservation: { retain: () => unknown },
          request: Record<string, unknown>,
        ) => Promise<{ marker: { generation?: string }; path: string }>;
      }
    ).retainReservationWithRecoveryMarker;
    expect(retainReservationWithRecoveryMarker).toEqual(expect.any(Function));
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-bridge-recovery-'));
    roots.push(projectRoot);
    const associateRecoveryMarker = vi.fn();

    const written = await retainReservationWithRecoveryMarker!(
      {
        retain: () => ({ associateRecoveryMarker }),
      },
      {
        projectRoot,
        worktreePath: join(projectRoot, '.psyche', 'worktrees', 'feature'),
        pane: { id: 'psyche-1', paneId: '%7' },
        operation: 'bridge-pane-generation',
        reason: 'tmux generation unavailable',
      },
    );

    expect(associateRecoveryMarker).toHaveBeenCalledWith({
      path: written.path,
      generation: written.marker.generation,
    });
  });
});
