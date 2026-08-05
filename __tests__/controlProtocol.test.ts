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
});
