import { describe, expect, it, vi } from 'vitest';

describe('GitMutationSupervisorChild', () => {
  it('refuses to spawn Git when the parent disconnects during lease claims', async () => {
    const module = await import('../src/services/GitMutationSupervisorChild.js');
    const supervise = (
      module as typeof module & {
        superviseGitMutation?: (
          request: Record<string, unknown>,
          dependencies: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).superviseGitMutation;
    expect(supervise).toEqual(expect.any(Function));

    let releaseClaim!: () => void;
    let loseParent!: () => void;
    let connected = true;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const startGit = vi.fn();
    const order: string[] = [];
    const supervision = supervise!({
      cwd: process.cwd(),
      args: ['status'],
      mutationNonce: 'mutation',
      leases: [{ lockDir: '/lease', leaseNonce: 'lease' }],
    }, {
      isParentConnected: () => connected,
      installTerminationHandlers: (
        _active: unknown,
        _request: unknown,
        _claimed: unknown,
        onParentLoss: () => void,
      ) => {
        order.push('install');
        loseParent = onParentLoss;
        return () => {};
      },
      claimPendingGitMutationLease: async () => {
        order.push('claim');
        await claimGate;
        return { pid: 303, processStartIdentity: 'supervisor-start' };
      },
      clearPendingGitMutationLease: vi.fn(async () => {}),
      startStoppedGit: startGit,
      report: vi.fn(),
    });

    expect(order).toEqual(['install', 'claim']);
    connected = false;
    loseParent();
    releaseClaim();

    await expect(supervision).rejects.toThrow(/lost its parent/i);
    expect(startGit).not.toHaveBeenCalled();
  });
});
