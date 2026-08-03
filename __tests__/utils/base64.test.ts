import { describe, expect, it } from 'vitest';
import { decodeBase64Payload, isCanonicalBase64 } from '../../src/utils/base64.js';

describe('isCanonicalBase64', () => {
  it('accepts canonical encodings, including each padding length', () => {
    expect(isCanonicalBase64('')).toBe(true);           // zero bytes
    expect(isCanonicalBase64('bHM=')).toBe(true);       // "ls"  — one pad
    expect(isCanonicalBase64('bA==')).toBe(true);       // "l"   — two pads
    expect(isCanonicalBase64('bHNhCg==')).toBe(true);
    expect(isCanonicalBase64(Buffer.from('whoami\r').toString('base64'))).toBe(true);
  });

  it('rejects payloads Buffer.from would silently mangle', () => {
    // Each of these decodes without throwing today, to empty or garbage.
    expect(isCanonicalBase64('!!!!')).toBe(false);
    expect(isCanonicalBase64('zz z')).toBe(false);
    expect(isCanonicalBase64('ab==cd')).toBe(false);
    expect(isCanonicalBase64('a')).toBe(false);         // length not a multiple of 4
    expect(isCanonicalBase64('bHM')).toBe(false);       // missing padding
    expect(isCanonicalBase64('bHM==')).toBe(false);     // over-padded
    expect(isCanonicalBase64('bH-M')).toBe(false);      // base64url, not base64
    expect(isCanonicalBase64(' bHM=')).toBe(false);     // leading whitespace
    expect(isCanonicalBase64('bHM=\n')).toBe(false);    // trailing newline
  });

  it('rejects non-strings rather than coercing', () => {
    expect(isCanonicalBase64(undefined)).toBe(false);
    expect(isCanonicalBase64(null)).toBe(false);
    expect(isCanonicalBase64(42)).toBe(false);
    expect(isCanonicalBase64({ evil: true })).toBe(false);
  });
});

describe('decodeBase64Payload', () => {
  it('round-trips arbitrary bytes, including control characters', () => {
    const raw = Buffer.from([0x00, 0x1b, 0x5b, 0x41, 0x0d, 0xff]);
    expect(decodeBase64Payload(raw.toString('base64'))).toEqual(raw);
  });

  it('returns null instead of a mangled buffer for malformed input', () => {
    // Buffer.from('!!!!', 'base64') is an empty buffer, and
    // Buffer.from('zz z', 'base64') is two arbitrary bytes — both silently.
    expect(Buffer.from('!!!!', 'base64').length).toBe(0);
    expect(Buffer.from('zz z', 'base64').length).toBeGreaterThan(0);

    expect(decodeBase64Payload('!!!!')).toBeNull();
    expect(decodeBase64Payload('zz z')).toBeNull();
    expect(decodeBase64Payload(undefined)).toBeNull();
  });

  it('decodes the empty payload to zero bytes rather than rejecting it', () => {
    expect(decodeBase64Payload('')).toEqual(Buffer.alloc(0));
  });
});
