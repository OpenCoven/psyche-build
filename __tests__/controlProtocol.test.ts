import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PROTOCOL_VERSION,
  decodeControlRequest,
  decodeControlWelcome,
  encodeControlMessage,
  type ControlResponse,
} from '../src/control/protocol.js';

function welcomeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    type: 'welcome',
    requestId: 'welcome',
    projectRoot: '/repo',
    ownerEpoch: 7,
    principal: {
      id: 'agent',
      kind: 'agent',
      capabilities: ['read', 'mutate'],
    },
    ...overrides,
  };
}

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

  it('allows welcome responses to carry an authenticated task binding', () => {
    const welcome: Extract<ControlResponse, { type: 'welcome' }> = {
      version: CONTROL_PROTOCOL_VERSION,
      type: 'welcome',
      requestId: 'welcome',
      projectRoot: '/repo',
      ownerEpoch: 7,
      principal: {
        id: 'agent',
        kind: 'agent',
        capabilities: ['read', 'mutate'],
      },
      taskBinding: { taskId: 'task-alpha' },
    };

    expect(JSON.parse(encodeControlMessage(welcome))).toMatchObject({
      type: 'welcome',
      taskBinding: { taskId: 'task-alpha' },
    });
    expect(decodeControlWelcome(encodeControlMessage(welcome))).toEqual(welcome);
  });

  it.each([
    ['version', { version: 2 }],
    ['requestId', { requestId: 'not-welcome' }],
    ['projectRoot', { projectRoot: '   ' }],
    ['principal', {
      principal: { id: 'agent', kind: 'unknown', capabilities: ['read', 'mutate'] },
    }],
    ['principal capabilities', {
      principal: { id: 'agent', kind: 'agent', capabilities: ['read', 'delegate'] },
    }],
    ['taskBinding blank taskId', { taskBinding: { taskId: '   ' } }],
    ['taskBinding oversized taskId', { taskBinding: { taskId: 't'.repeat(257) } }],
    ['taskBinding container', { taskBinding: { taskId: 'task-alpha', injected: true } }],
  ])('rejects a welcome with malformed %s', (_field, overrides) => {
    expect(() => decodeControlWelcome(JSON.stringify(welcomeFrame(overrides))))
      .toThrow('invalid welcome frame');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed welcome owner epoch %s',
    (ownerEpoch) => {
      expect(() => decodeControlWelcome(JSON.stringify(welcomeFrame({ ownerEpoch }))))
        .toThrow('invalid welcome frame');
    },
  );

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

  it('rejects surface actions missing common authorization fields or generation', () => {
    const base = {
      id: 'cmd-1', idempotencyKey: 'idem-1', kind: 'browser.action', projectRoot: '/repo',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
        tabId: 'tab-1', generation: 2, action: { kind: 'reload' },
      },
    };
    for (const field of ['taskId', 'leaseId', 'leaseRevision', 'generation'] as const) {
      const payload = { ...base.payload };
      delete payload[field];
      expect(() => decodeControlRequest(JSON.stringify({
        version: 1, type: 'command.submit', requestId: 'req-1', command: { ...base, payload },
      }))).toThrow('invalid surface authorization');
    }
  });

  it('rejects events.read requests with a non-number afterSequence', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'events.read',
      requestId: 'req-1',
      afterSequence: '0',
    }))).toThrow('invalid events.read request');
  });

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

  it('decodes bounded typed provider frames', () => {
    expect(decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.register', requestId: 'register-1', providerId: 'desktop-1',
    }))).toMatchObject({ type: 'provider.register', providerId: 'desktop-1' });
    expect(decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.effect.result', requestId: 'effect-1',
      result: { actionId: 'action-1', status: 'succeeded', value: { ok: true } },
    }))).toMatchObject({ type: 'provider.effect.result', result: { actionId: 'action-1' } });
  });

  it('rejects malformed provider resources and effect results', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.resource.upsert', requestId: 'upsert-1',
      resource: { id: 'tab-1', kind: 'browser_tab', generation: 1 },
    }))).toThrow('invalid provider resource');
    expect(() => decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.effect.result', requestId: 'effect-1',
      result: { actionId: 'action-1', status: 'invented' },
    }))).toThrow('invalid provider effect result');
    for (const result of [
      { actionId: 'action-1', status: 'succeeded', value: null, injected: true },
      { actionId: 'action-1', status: 'failed', code: 'failed', message: 'failed', value: 'secret' },
      { actionId: 'action-1', status: 'unknown', code: 'effect_unknown', injected: true },
    ]) {
      expect(() => decodeControlRequest(JSON.stringify({
        version: 1, type: 'provider.effect.result', requestId: 'effect-1', result,
      }))).toThrow('invalid provider effect result');
    }
  });

  it('bounds nested provider results and browser script arguments at the protocol boundary', () => {
    let deep: Record<string, unknown> = { value: true };
    for (let index = 0; index < 70; index += 1) deep = { child: deep };
    expect(() => decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.effect.result', requestId: 'effect-1',
      result: { actionId: 'action-1', status: 'succeeded', value: deep },
    }))).toThrow('invalid provider effect result');

    const command = {
      id: 'script-1', idempotencyKey: 'script-1', kind: 'browser.script', projectRoot: '/repo',
      createdAt: '2026-08-12T12:00:00.000Z', payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
        tabId: 'tab-1', generation: 1, source: 'return args;',
        args: { text: 'x'.repeat(256 * 1024 + 1) },
      },
    };
    expect(() => decodeControlRequest(JSON.stringify({
      version: 1, type: 'command.submit', requestId: 'script-1', command,
    }))).toThrow('invalid browser script arguments');
  });
});
