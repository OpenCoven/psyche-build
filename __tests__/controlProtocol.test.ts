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
});
