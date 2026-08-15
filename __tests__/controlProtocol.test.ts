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

  it('decodes and validates optional task scope on state.get requests', () => {
    expect(decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'state.get',
      requestId: 'req-1',
      taskId: 'task-1',
    }))).toMatchObject({
      type: 'state.get',
      taskId: 'task-1',
    });

    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'state.get',
      requestId: 'req-1',
      taskId: '',
    }))).toThrow('invalid state.get request');
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

<<OURS>>
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
      taskId: 'task-1',
    }))).toMatchObject({
      type: 'events.read',
      afterSequence: 0,
      limit: 100,
      taskId: 'task-1',
    });
  });

  it('rejects an unknown request type', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'unknown',
      requestId: 'req-1',
    }))).toThrow('unsupported control request type');
  });

  it('decodes exact version-one provider transport frames', () => {
    expect(decodeControlRequest(JSON.stringify({
      version: 1, type: 'provider.register', requestId: 'register-1', providerId: 'desktop-1',
    }))).toMatchObject({ type: 'provider.register', providerId: 'desktop-1' });
    expect(decodeControlRequest(JSON.stringify({
<<OURS>>
  });
});
