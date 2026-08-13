import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PROTOCOL_VERSION,
  decodeControlRequest,
  encodeControlMessage,
} from '../src/control/protocol.js';

describe('control protocol v1', () => {
  it('decodes the checked-in command fixture', () => {
    const raw = readFileSync(
      new URL('../protocol-fixtures/control-v1/command-submit.json', import.meta.url),
      'utf8',
    );
    expect(decodeControlRequest(raw)).toMatchObject({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'command.submit',
      requestId: 'req-1',
      command: {
        id: 'cmd-1',
        idempotencyKey: 'idem-1',
        kind: 'pane.takeover',
      },
    });
  });

  it('rejects an unsupported protocol version', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: 99,
      type: 'state.get',
      requestId: 'req-1',
    }))).toThrow('unsupported control protocol version');
  });

  it('uses stable JSON key ordering', () => {
    expect(encodeControlMessage({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'ack',
      requestId: 'req-1',
    })).toBe('{"requestId":"req-1","type":"ack","version":1}');
  });

  it('encodes the checked-in result fixture with stable key ordering', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../protocol-fixtures/control-v1/command-result.json', import.meta.url),
      'utf8',
    ));
    expect(fixture).toMatchObject({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'command.result',
      requestId: 'req-1',
      commandId: 'cmd-1',
      outcome: { status: 'succeeded' },
    });
    expect(encodeControlMessage(fixture)).toBe(
      '{"commandId":"cmd-1","outcome":{"status":"succeeded"},"requestId":"req-1","type":"command.result","version":1}',
    );
  });

  it('decodes a valid hello request', () => {
    expect(decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello',
      token: 'token-1',
      clientName: 'client-1',
      projectRoot: '/repo',
    }))).toMatchObject({
      type: 'hello',
      token: 'token-1',
      clientName: 'client-1',
      projectRoot: '/repo',
    });
  });

  it('rejects a malformed hello request', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello',
      clientName: 'client-1',
      projectRoot: '/repo',
    }))).toThrow('invalid hello request');
  });

  it('rejects command.submit requests missing required command fields', () => {
    const command = {
      id: 'cmd-1',
      idempotencyKey: 'idem-1',
      kind: 'pane.takeover',
      projectRoot: '/repo',
      createdAt: '2026-08-03T20:00:00.000Z',
      payload: { paneId: '%3' },
    };

    for (const field of ['idempotencyKey', 'projectRoot', 'createdAt', 'payload'] as const) {
      const malformedCommand = { ...command };
      delete malformedCommand[field];
      expect(() => decodeControlRequest(JSON.stringify({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'command.submit',
        requestId: 'req-1',
        command: malformedCommand,
      }))).toThrow('invalid command.submit payload');
    }
  });

  it('rejects agent surface commands with missing generations or unsafe authority revisions', () => {
    const base = {
      id: 'cmd-click', idempotencyKey: 'idem-click', kind: 'browser.action',
      projectRoot: '/repo', createdAt: '2026-08-12T12:00:00.000Z',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
        tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
        action: { kind: 'click', elementRef: 'e17' },
      },
    };
    for (const payload of [
      { ...base.payload, generation: undefined },
      { ...base.payload, generation: -1 },
      { ...base.payload, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...base.payload, leaseRevision: Number.NaN },
    ]) {
      expect(() => decodeControlRequest(JSON.stringify({
        version: 1, type: 'command.submit', requestId: 'req-agent',
        command: { ...base, payload },
      }))).toThrow('invalid command.submit payload');
    }
  });

  it('accepts every version-one agent control command kind without changing the protocol version', () => {
    const payloads = {
      'lease.request': { taskId: 'task-1', ttlMs: 1000, grants: [] },
      'lease.grant': { requestId: 'request-1', actorId: 'agent-1', taskId: 'task-1', ttlMs: 1000, grants: [] },
      'lease.release': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1 },
      'lease.revoke': { leaseId: 'lease-1' },
      'pane.observe': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, paneId: 'pane-1', generation: 1 },
      'pane.action': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, paneId: 'pane-1', generation: 1, action: { kind: 'focus' } },
      'browser.inspect': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, tabId: 'tab-1', generation: 1 },
      'browser.action': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, tabId: 'tab-1', generation: 1, action: { kind: 'reload' } },
      'browser.script': { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1, tabId: 'tab-1', generation: 1, source: '1' },
      'approval.resolve': { approvalId: 'approval-1', payloadDigest: '0'.repeat(64), decision: 'deny' },
      'provider.resource.remove': { id: 'tab-1', generation: 1 },
    } as const;
    for (const [kind, payload] of Object.entries(payloads)) {
      expect(decodeControlRequest(JSON.stringify({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'command.submit', requestId: `req-${kind}`,
        command: {
          id: `cmd-${kind}`, idempotencyKey: `idem-${kind}`, kind,
          projectRoot: '/repo', createdAt: '2026-08-12T12:00:00.000Z', payload,
        },
      }))).toMatchObject({ version: 1, command: { kind } });
    }
  });

  it.each([
    [{ kind: 'future', id: 'x', generation: 1 }, 'unknown target kind'],
    [{ kind: 'project', id: '/repo', generation: 1 }, 'project generation'],
    [{ kind: 'pane', id: 'pane-1' }, 'missing pane generation'],
    [{ kind: 'browser_tab', id: 'tab-1', generation: -1 }, 'negative generation'],
    [{ kind: 'browser_tab', id: 'tab-1', generation: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe generation'],
    [{ kind: 'pane', id: 'pane-1', generation: 1, path: '/secret' }, 'extra pane path'],
    [{ kind: 'project', id: '/repo', extra: true }, 'extra project key'],
  ])('rejects malformed lease targets: %s (%s)', (target, _label) => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: 1, type: 'command.submit', requestId: 'req-target',
      command: {
        id: 'cmd-target', idempotencyKey: 'idem-target', kind: 'lease.request',
        projectRoot: '/repo', createdAt: '2026-08-12T12:00:00.000Z',
        payload: {
          taskId: 'task-1', ttlMs: 1000,
          grants: [{ target, capabilities: ['browser.inspect'] }],
        },
      },
    }))).toThrow('invalid command.submit payload');
  });

  it('rejects events.read requests with a non-number afterSequence', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'events.read',
      requestId: 'req-1',
      afterSequence: '0',
    }))).toThrow('invalid events.read request');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsupported events.read afterSequence: %s',
    (afterSequence) => {
      expect(() => decodeControlRequest(JSON.stringify({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'events.read',
        requestId: 'req-range',
        afterSequence,
      }))).toThrow('invalid events.read request');
    },
  );

  it('decodes a valid events.read request', () => {
    expect(decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'events.read',
      requestId: 'req-1',
      afterSequence: 0,
      limit: 100,
    }))).toMatchObject({
      type: 'events.read',
      afterSequence: 0,
      limit: 100,
    });
  });

  it('rejects an unknown request type', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'unknown',
      requestId: 'req-1',
    }))).toThrow('unsupported control request type');
  });
});
