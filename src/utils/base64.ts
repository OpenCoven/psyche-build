/**
 * Strict base64 validation for wire payloads.
 *
 * `Buffer.from(str, 'base64')` is deliberately lenient: it skips characters
 * outside the alphabet and tolerates wrong padding instead of throwing. So
 * `Buffer.from('!!!!', 'base64')` is an empty buffer and
 * `Buffer.from('zz z', 'base64')` is two arbitrary bytes — both silently.
 *
 * A `try`/`catch` around that decode therefore never fires, and both bridge
 * protocols carry *keystrokes* in these payloads. Silently mangling a byte
 * sequence and typing the remains into a terminal is worse than refusing it:
 * a truncated multi-byte sequence can leave stray control characters in the
 * user's shell, and the client never learns its frame was malformed.
 *
 * Callers validate first, then decode.
 */

/**
 * Canonical RFC 4648 base64: groups of four alphabet characters, with padding
 * only in the final group. The shape enforces `length % 4 === 0`, so a
 * truncated payload is rejected rather than rounded down.
 *
 * The empty string is valid and decodes to zero bytes.
 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isCanonicalBase64(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_BASE64.test(value);
}

/**
 * Decode a base64 payload, or return null if it is not canonical base64.
 *
 * Returning null rather than throwing keeps this usable directly inside a
 * protocol handler, where the answer to bad input is an error frame.
 */
export function decodeBase64Payload(value: unknown): Buffer | null {
  return isCanonicalBase64(value) ? Buffer.from(value, 'base64') : null;
}
