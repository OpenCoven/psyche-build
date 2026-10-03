#!/usr/bin/env node

// Generates the cross-implementation test vectors for the desktop update
// manifest verifier (outcome #477, plan item 3.2, desktop side).
//
// The Node reference in scripts/update-manifest.mjs signs and verifies every
// case here; the Rust verifier in
// native/desktop/psyche-build-tauri/src-tauri/src/update_manifest.rs must reach
// the same outcome for the same bytes. The output is a generated file:
//
//   pnpm generate:update-manifest-vectors
//
// and __tests__/updateManifestVectors.test.ts fails when the checked-in copy
// differs from a fresh run.
//
// TEST KEYS ONLY. Each key is derived from a fixed, public label so the output
// is byte-reproducible. Anyone can recompute these private keys, so they must
// never appear in release/update-manifest-keys.json. The generator refuses to
// run if the checked-in keys file names one of them.

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalFileText,
  parseKeysFile,
  publicKeyEntryFromPrivatePem,
  signManifest,
  verifyManifest,
} from './update-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VECTORS_PATH = path.join(
  repoRoot,
  'native/desktop/psyche-build-tauri/src-tauri/test-fixtures/update-manifest/vectors.json',
);

// RFC 8410 PKCS#8 prefix for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function testKey(label) {
  const seed = createHash('sha256').update(`psyche-build update-manifest TEST VECTOR key ${label}; not a release key`).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { privateKey, pem, entry: publicKeyEntryFromPrivatePem(pem) };
}

const VERSION = '9.8.7';
const PUBLISHED_AT = '2026-09-01T00:00:00Z';
const EXPIRES_AT = '2026-10-01T00:00:00Z';
const NOW = '2026-09-10T00:00:00Z';
// U+FF61 sorts before U+1F600 by code point but after it by UTF-16 code unit
// (0xD83D), which is the order JavaScript's default sort uses.
const HALFWIDTH = String.fromCodePoint(0xff61);
const EMOJI = String.fromCodePoint(0x1f600);

function baseManifest(overrides = {}) {
  return {
    schema: 1,
    version: VERSION,
    tag: `v${VERSION}`,
    source_sha: '0123456789abcdef0123456789abcdef01234567',
    artifacts: {
      aarch64: { file: `Psyche-Build-v${VERSION}-aarch64.dmg`, sha256: 'a'.repeat(64) },
      x86_64: { file: `Psyche-Build-v${VERSION}-x86_64.dmg`, sha256: 'b'.repeat(64) },
    },
    published_at: PUBLISHED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

function envelope(keyId, signature, algorithm = 'ed25519') {
  return canonicalFileText({ algorithm, key_id: keyId, schema: 1, signature: signature.toString('base64') });
}

/** Signs arbitrary bytes, including bytes signManifest would refuse. */
function rawSign(bytes, key, keyId = key.entry.keyId) {
  return Buffer.from(envelope(keyId, sign(null, bytes, key.privateKey)));
}

function flipByte(buffer, index, mask = 0x01) {
  const copy = Buffer.from(buffer);
  copy[index] ^= mask;
  return copy;
}

export function buildVectors() {
  const current = testKey('current');
  const next = testKey('next');
  const stranger = testKey('stranger');
  const keysFile = { schema: 1, current: current.entry, next: next.entry };
  const keys = parseKeysFile(JSON.stringify(keysFile));
  const currentOnlyKeys = parseKeysFile(JSON.stringify({ schema: 1, current: next.entry, next: null }));

  const valid = Buffer.from(canonicalFileText(baseManifest()));
  const validSig = Buffer.from(signManifest(valid, current.pem, keys));
  const nextSig = Buffer.from(signManifest(valid, next.pem, currentOnlyKeys));
  const signedBy = (text) => {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    return { manifest: bytes, signature: rawSign(bytes, current) };
  };
  const canonicalText = valid.toString('utf8');
  const sigEnvelope = JSON.parse(validSig.toString('utf8'));
  const tamperedSignature = flipByte(Buffer.from(sigEnvelope.signature, 'base64'), 10);

  const cases = [
    ['valid_current_key', { manifest: valid, signature: validSig }, 'ok'],
    ['valid_next_key', { manifest: valid, signature: nextSig }, 'ok'],
    ['tampered_manifest', { manifest: flipByte(valid, canonicalText.indexOf('aaaa')), signature: validSig }, 'signature_invalid'],
    ['tampered_signature', { manifest: valid, signature: Buffer.from(envelope(current.entry.keyId, tamperedSignature)) }, 'signature_invalid'],
    ['wrong_key_claims_current_id', { manifest: valid, signature: rawSign(valid, stranger, current.entry.keyId) }, 'signature_invalid'],
    ['unknown_key_id', { manifest: valid, signature: rawSign(valid, stranger) }, 'unknown_key_id'],
    ['signature_envelope_not_canonical', { manifest: valid, signature: Buffer.from(`${JSON.stringify(sigEnvelope, null, 2)}\n`) }, 'signature_malformed'],
    ['signature_wrong_algorithm', { manifest: valid, signature: Buffer.from(envelope(current.entry.keyId, Buffer.from(sigEnvelope.signature, 'base64'), 'ed448')) }, 'signature_malformed'],
    ['signature_short', { manifest: valid, signature: Buffer.from(envelope(current.entry.keyId, Buffer.alloc(63))) }, 'signature_malformed'],
    ['signature_empty', { manifest: valid, signature: Buffer.alloc(0) }, 'signature_malformed'],
    ['manifest_pretty_printed', signedBy(`${JSON.stringify(baseManifest(), null, 2)}\n`), 'manifest_not_canonical'],
    ['manifest_unsorted_keys', signedBy(`${JSON.stringify(baseManifest())}\n`), 'manifest_not_canonical'],
    ['manifest_escaped_digit', signedBy(canonicalText.replace('"version":"9.8.7"', '"version":"\\u0039.8.7"')), 'manifest_not_canonical'],
    ['manifest_no_trailing_lf', signedBy(canonicalText.slice(0, -1)), 'manifest_not_canonical'],
    ['manifest_two_trailing_lf', signedBy(`${canonicalText}\n`), 'manifest_not_canonical'],
    ['manifest_float_schema', signedBy(canonicalText.replace('"schema":1', '"schema":1.0')), 'manifest_not_canonical'],
    ['manifest_exponent_schema', signedBy(canonicalText.replace('"schema":1', '"schema":1e0')), 'manifest_not_canonical'],
    ['manifest_unsafe_integer', signedBy(canonicalText.replace('"schema":1', '"schema":9007199254740993')), 'manifest_not_canonical'],
    ['manifest_negative_zero', signedBy(canonicalText.replace('"schema":1', '"schema":-0')), 'manifest_not_canonical'],
    ['manifest_duplicate_key', signedBy(canonicalText.replace('"schema":1', '"schema":1,"schema":1')), 'manifest_not_canonical'],
    ['manifest_codepoint_key_order', signedBy(canonicalText.replace('"version":"9.8.7"}', `"version":"9.8.7","${HALFWIDTH}":0,"${EMOJI}":0}`)), 'manifest_not_canonical'],
    ['manifest_utf16_key_order_extra_keys', signedBy(canonicalText.replace('"version":"9.8.7"}', `"version":"9.8.7","${EMOJI}":0,"${HALFWIDTH}":0}`)), 'manifest_malformed'],
    ['manifest_lone_surrogate', signedBy(canonicalText.replace('"source_sha":"0123456789abcdef0123456789abcdef01234567"', '"source_sha":"\\ud800"')), 'manifest_malformed'],
    ['manifest_bom', signedBy(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid])), 'manifest_malformed'],
    ['manifest_invalid_utf8', signedBy(Buffer.concat([valid.subarray(0, 20), Buffer.from([0xff]), valid.subarray(20)])), 'manifest_malformed'],
    ['manifest_trailing_garbage', signedBy(`${canonicalText.slice(0, -1)}x\n`), 'manifest_malformed'],
    ['manifest_empty', signedBy(''), 'manifest_malformed'],
    ['manifest_array', signedBy('[]\n'), 'manifest_malformed'],
    ['manifest_extra_field', signedBy(canonicalFileText({ ...baseManifest(), extra: 1 })), 'manifest_malformed'],
    ['manifest_tag_mismatch', signedBy(canonicalFileText(baseManifest({ tag: 'v9.8.8' }))), 'manifest_malformed'],
    ['manifest_prerelease_version', signedBy(canonicalFileText(baseManifest({ version: '9.8.7-rc.1', tag: 'v9.8.7-rc.1' }))), 'manifest_malformed'],
    ['manifest_wrong_schema', signedBy(canonicalFileText(baseManifest({ schema: 2 }))), 'manifest_malformed'],
    ['manifest_validity_over_30_days', signedBy(canonicalFileText(baseManifest({ expires_at: '2026-10-01T00:00:01Z' }))), 'manifest_malformed'],
    ['manifest_calendar_overflow', signedBy(canonicalFileText(baseManifest({ published_at: '2026-09-31T00:00:00Z' }))), 'manifest_malformed'],
    ['manifest_hour_24', signedBy(canonicalFileText(baseManifest({ published_at: '2026-09-01T24:00:00Z' }))), 'manifest_malformed'],
    ['manifest_artifact_name_mismatch', signedBy(canonicalFileText(baseManifest({ artifacts: { ...baseManifest().artifacts, x86_64: { file: 'Psyche-Build-v9.8.6-x86_64.dmg', sha256: 'b'.repeat(64) } } }))), 'manifest_malformed'],
    ['manifest_uppercase_digest', signedBy(canonicalFileText(baseManifest({ artifacts: { ...baseManifest().artifacts, x86_64: { file: `Psyche-Build-v${VERSION}-x86_64.dmg`, sha256: 'B'.repeat(64) } } }))), 'manifest_malformed'],
  ].map(([name, bytes, intended]) => ({ name, now: NOW, ...bytes, intended }));

  cases.push(
    { name: 'expired_at_expiry_instant', now: EXPIRES_AT, manifest: valid, signature: validSig, intended: 'manifest_expired' },
    { name: 'valid_one_second_before_expiry', now: '2026-09-30T23:59:59Z', manifest: valid, signature: validSig, intended: 'ok' },
    { name: 'not_yet_valid_beyond_skew', now: '2026-08-31T23:54:59Z', manifest: valid, signature: validSig, intended: 'manifest_not_yet_valid' },
    { name: 'valid_at_skew_boundary', now: '2026-08-31T23:55:00Z', manifest: valid, signature: validSig, intended: 'ok' },
  );

  const records = cases.map((entry) => {
    const result = verifyManifest({
      manifestBytes: entry.manifest,
      signatureBytes: entry.signature,
      keys,
      now: entry.now,
    });
    const outcome = result.ok ? 'ok' : result.reason;
    if (outcome !== entry.intended) {
      throw new Error(`vector ${entry.name}: reference verifier returned ${outcome}, intended ${entry.intended}`);
    }
    return {
      name: entry.name,
      now: entry.now,
      manifest_base64: entry.manifest.toString('base64'),
      signature_base64: entry.signature.toString('base64'),
      expect: result.ok
        ? { outcome: 'ok', slot: result.slot, key_id: result.keyId, version: result.manifest.version }
        : { outcome: result.reason },
    };
  });

  return `${JSON.stringify(
    {
      comment:
        'GENERATED by `pnpm generate:update-manifest-vectors` from scripts/update-manifest.mjs. TEST KEYS ONLY: derived from public labels; never trust them in a release.',
      keys: keysFile,
      stranger_key: stranger.entry,
      cases: records,
    },
    null,
    2,
  )}\n`;
}

/** Key ids of the public, recomputable test keys. */
export function testKeyIds() {
  return ['current', 'next', 'stranger'].map((label) => testKey(label).entry.keyId);
}

function refuseIfTestKeyIsTrusted() {
  const trusted = parseKeysFile(readFileSync(path.join(repoRoot, 'release/update-manifest-keys.json'), 'utf8'));
  const ids = new Set(testKeyIds());
  for (const slot of [trusted.current, trusted.next]) {
    if (slot && ids.has(slot.keyId)) {
      throw new Error('release/update-manifest-keys.json trusts a public test-vector key');
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  refuseIfTestKeyIsTrusted();
  const text = buildVectors();
  if (check) {
    const existing = readFileSync(VECTORS_PATH, 'utf8');
    if (existing !== text) {
      process.stderr.write('update-manifest vectors are stale; run pnpm generate:update-manifest-vectors\n');
      return 1;
    }
    return 0;
  }
  mkdirSync(path.dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, text);
  process.stdout.write(`wrote ${path.relative(repoRoot, VECTORS_PATH)}\n`);
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main();
}
