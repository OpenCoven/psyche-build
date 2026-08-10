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

describe('MobileControlGateway terminal streams', () => {
  type Frame = { streamId: string; sequence: number; payload: Uint8Array };

  function streamContext(frames: Frame[] = []) {
    return {
      ownerId: 'owner-1',
      connectionId: 'connection-1',
      sendBinary: (streamId: string, sequence: number, payload: Uint8Array) => {
        frames.push({ streamId, sequence, payload });
      },
    };
  }

  function streamGateway(overrides: Record<string, unknown> = {}) {
    return new MobileControlGateway({
      workspaceSnapshot: () => ({
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
        sequence: 0,
      }),
      attachPane: async () => ({
        streamId: 'stream-1',
        latestSeq: 4,
        hasReplay: true,
        replayMode: 'replace' as const,
      }),
      detachPane: async () => {},
      sendPaneInput: async () => {},
      resizePane: async () => {},
      ...overrides,
    });
  }

  it('returns stream and replay metadata for an attach', async () => {
    const gateway = streamGateway();

    await expect(gateway.handle(
      { type: 'panes.attach', requestId: 'attach-1', id: '%3', sinceSeq: 2 },
      streamContext(),
    )).resolves.toEqual({
      type: 'mobile.panes.attach.result',
      requestId: 'attach-1',
      id: '%3',
      streamId: 'stream-1',
      latestSeq: 4,
      hasReplay: true,
      replayMode: 'replace',
    });
  });

  it('passes the requested resume point through to the host', async () => {
    const seen: Array<number | undefined> = [];
    const gateway = streamGateway({
      attachPane: async (_c: unknown, _p: string, sinceSeq?: number) => {
        seen.push(sinceSeq);
        return { streamId: 's', latestSeq: 0, hasReplay: false, replayMode: 'replace' as const };
      },
    });

    await gateway.handle({ type: 'panes.attach', requestId: 'a', id: '%1', sinceSeq: 9 }, streamContext());
    await gateway.handle({ type: 'panes.attach', requestId: 'b', id: '%1' }, streamContext());

    expect(seen).toEqual([9, undefined]);
  });

  it('rejects a negative resume point rather than resuming from nowhere', async () => {
    const gateway = streamGateway();

    await expect(gateway.handle(
      { type: 'panes.attach', requestId: 'attach-bad', id: '%3', sinceSeq: -1 } as any,
      streamContext(),
    )).rejects.toMatchObject({ code: 'invalid_control_request', requestId: 'attach-bad' });
  });

  it('scopes detach, input, and resize to the requesting connection', async () => {
    const calls: string[] = [];
    const gateway = streamGateway({
      detachPane: async (connectionId: string, streamId: string) => {
        calls.push(`detach:${connectionId}:${streamId}`);
      },
      sendPaneInput: async (connectionId: string, streamId: string, data: Buffer) => {
        calls.push(`input:${connectionId}:${streamId}:${data.toString('utf8')}`);
      },
      resizePane: async (connectionId: string, streamId: string, cols: number, rows: number) => {
        calls.push(`resize:${connectionId}:${streamId}:${cols}x${rows}`);
      },
    });

    await gateway.handle({ type: 'panes.detach', requestId: 'd', streamId: 's1' }, streamContext());
    await gateway.handle({
      type: 'panes.input',
      requestId: 'i',
      streamId: 's1',
      data: Buffer.from('ls\r', 'utf8').toString('base64'),
    }, streamContext());
    await gateway.handle({
      type: 'panes.resize',
      requestId: 'r',
      streamId: 's1',
      cols: 80,
      rows: 24,
    }, streamContext());

    expect(calls).toEqual([
      'detach:connection-1:s1',
      'input:connection-1:s1:ls\r',
      'resize:connection-1:s1:80x24',
    ]);
  });

  it('acknowledges detach, input, and resize only after the host op succeeds', async () => {
    const gateway = streamGateway();

    for (const request of [
      { type: 'panes.detach' as const, requestId: 'd', streamId: 's1' },
      { type: 'panes.input' as const, requestId: 'i', streamId: 's1', data: 'bHM=' },
      { type: 'panes.resize' as const, requestId: 'r', streamId: 's1', cols: 80, rows: 24 },
    ]) {
      await expect(gateway.handle(request, streamContext()))
        .resolves.toEqual({ type: 'ack', requestId: request.requestId, ok: true });
    }
  });

  it('surfaces a failed host operation instead of acknowledging it', async () => {
    const gateway = streamGateway({
      detachPane: async () => {
        throw Object.assign(new Error('unknown stream'), { code: 'no_stream' });
      },
    });

    await expect(gateway.handle(
      { type: 'panes.detach', requestId: 'd', streamId: 'gone' },
      streamContext(),
    )).rejects.toThrow('unknown stream');
  });

  it('rejects malformed base64 input rather than typing mangled bytes', async () => {
    const gateway = streamGateway();

    await expect(gateway.handle(
      { type: 'panes.input', requestId: 'i', streamId: 's1', data: 'not base64!!' },
      streamContext(),
    )).rejects.toMatchObject({ code: 'invalid_input', requestId: 'i' });
  });

  it('rejects a stream id that is missing or blank', async () => {
    const gateway = streamGateway();

    for (const streamId of [undefined, '', '   ']) {
      await expect(gateway.handle(
        { type: 'panes.detach', requestId: 'd', streamId } as any,
        streamContext(),
      )).rejects.toMatchObject({ code: 'invalid_control_request' });
    }
  });

  it('rejects resize dimensions that are not positive integers', async () => {
    const gateway = streamGateway();

    for (const [cols, rows] of [[0, 24], [80, 0], [-1, 24], [80.5, 24], [80, 20_000]]) {
      await expect(gateway.handle(
        { type: 'panes.resize', requestId: 'r', streamId: 's1', cols, rows } as any,
        streamContext(),
      )).rejects.toMatchObject({ code: 'invalid_control_request', requestId: 'r' });
    }
  });

  it('reports terminal commands as unsupported when the host did not wire them', async () => {
    const gateway = new MobileControlGateway({
      workspaceSnapshot: () => ({
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
        sequence: 0,
      }),
    });

    for (const request of [
      { type: 'panes.detach' as const, requestId: 'd', streamId: 's1' },
      { type: 'panes.input' as const, requestId: 'i', streamId: 's1', data: 'bHM=' },
      { type: 'panes.resize' as const, requestId: 'r', streamId: 's1', cols: 80, rows: 24 },
    ]) {
      await expect(gateway.handle(request, streamContext()))
        .rejects.toMatchObject({ code: 'command_not_supported' });
    }
  });
});
