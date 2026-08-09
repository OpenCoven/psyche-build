import { describe, expect, it } from 'vitest';

import { WORKSPACE_SNAPSHOT_FIXTURE } from '../../protocol-fixtures/fixtures.js';
import { MobileControlGateway } from '../../src/services/bridge/MobileControlGateway.js';
import type { ReadonlyWorkspaceSnapshot } from '../../src/workspace/snapshot.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function context() {
  return {
    ownerId: 'owner-1',
    connectionId: 'connection-1',
    sendBinary: () => {
      throw new Error('sendBinary should not be called by workspace.snapshot');
    },
  };
}

describe('MobileControlGateway', () => {
  it('returns the canonical readonly workspace snapshot and sequence', async () => {
    const workspace = deepFreeze(structuredClone(
      WORKSPACE_SNAPSHOT_FIXTURE.workspace,
    )) as ReadonlyWorkspaceSnapshot;
    const gateway = new MobileControlGateway({
      workspaceSnapshot: () => ({ workspace, sequence: 7 }),
    });

    const result = await gateway.handle(
      { type: 'workspace.snapshot', requestId: 'workspace-1' },
      context(),
    );

    expect(result.type).toBe('mobile.workspace.snapshot.result');
    if (result.type !== 'mobile.workspace.snapshot.result') {
      throw new Error(`unexpected result type: ${result.type}`);
    }
    expect(result).toEqual({
      type: 'mobile.workspace.snapshot.result',
      requestId: 'workspace-1',
      sequence: 7,
      workspace,
    });
    expect(result.workspace).toBe(workspace);
    expect(Object.isFrozen(result.workspace)).toBe(true);
    expect(Object.isFrozen(result.workspace.projects[0])).toBe(true);
  });

  it('supports an async workspace snapshot', async () => {
    const workspace = structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace) as ReadonlyWorkspaceSnapshot;
    const gateway = new MobileControlGateway({
      workspaceSnapshot: async () => ({ workspace, sequence: 11 }),
    });

    await expect(gateway.handle(
      { type: 'workspace.snapshot', requestId: 'workspace-async' },
      context(),
    )).resolves.toEqual({
      type: 'mobile.workspace.snapshot.result',
      requestId: 'workspace-async',
      sequence: 11,
      workspace,
    });
  });

  it('rejects nested hello control requests instead of renegotiating', async () => {
    const gateway = new MobileControlGateway({
      workspaceSnapshot: () => ({
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
        sequence: 0,
      }),
    });

    await expect(gateway.handle({
      type: 'hello',
      requestId: 'nested-hello',
      payload: {
        clientId: 'ios-1',
        clientName: 'iPhone',
        protocolVersion: 3,
        token: null,
      },
    } as any, context())).rejects.toMatchObject({
      code: 'invalid_control_request',
      requestId: 'nested-hello',
    });
  });

  it('rejects a missing requestId at runtime', async () => {
    const gateway = new MobileControlGateway({
      workspaceSnapshot: () => ({
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
        sequence: 0,
      }),
    });

    await expect(gateway.handle(
      { type: 'workspace.snapshot' } as any,
      context(),
    )).rejects.toMatchObject({
      code: 'invalid_control_request',
      requestId: undefined,
    });
  });

  it('rejects unsupported mobile commands with command_not_supported', async () => {
    const gateway = new MobileControlGateway({
      workspaceSnapshot: () => ({
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
        sequence: 0,
      }),
    });

    await expect(gateway.handle({
      type: 'panes.attach',
      requestId: 'attach-1',
      id: '%3',
    }, context())).rejects.toMatchObject({
      code: 'command_not_supported',
      requestId: 'attach-1',
    });
  });
});
