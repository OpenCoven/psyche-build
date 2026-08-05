import { describe, expect, it } from 'vitest';
import { encodeBinaryFrame, decodeBinaryFrame } from '../../src/daemon/protocol.js';

/**
 * The daemon's own wire framing. TmuxControl used to be exercised from this
 * file too, back when src/daemon/ carried its own copy of it; those tests
 * moved to __tests__/services/tmuxControl.test.ts along with the module.
 */
describe('binary frame codec', () => {
  it('round-trips a streamId + payload', () => {
    const payload = Buffer.from('hello pane output');
    const encoded = encodeBinaryFrame('abc123', payload);
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.streamId).toBe('abc123');
    expect(decoded.payload).toEqual(payload);
  });

  it('handles an empty payload', () => {
    const encoded = encodeBinaryFrame('xyz', Buffer.alloc(0));
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.streamId).toBe('xyz');
    expect(decoded.payload.length).toBe(0);
  });

  it('throws on a streamId longer than 255 bytes', () => {
    const longId = 'x'.repeat(256);
    expect(() => encodeBinaryFrame(longId, Buffer.alloc(0))).toThrow();
  });
});
