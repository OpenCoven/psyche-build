#!/usr/bin/env node

// Builds, signs, and verifies the signed update manifest published with each
// GitHub Release (outcome #477, plan item 3.2, release side).
//
// The desktop app will only NOTIFY about a newer release; it never installs
// one. This script therefore signs one small file that names the release and
// the digests of both DMGs, and nothing else.
//
// Format (see docs/RELEASE.md "Update manifest signing"):
//
// - `update-manifest.json` is canonical JSON: object keys sorted by UTF-16
//   code unit, no insignificant whitespace, strings escaped exactly as
//   JSON.stringify escapes them, integers only, UTF-8 without a BOM, and
//   exactly one trailing LF. The bytes signed are exactly the file bytes.
// - `update-manifest.json.sig` is a canonical JSON envelope (same rules)
//   carrying `algorithm: "ed25519"`, the signer's `key_id`, `schema: 1` and
//   the base64 (RFC 4648, padded) 64-byte Ed25519 signature.
// - A key id is the lowercase hex of the first 8 bytes of SHA-256 over the
//   raw 32-byte Ed25519 public key.
//
// Only Node built-ins are used, so the release job needs no dependency install.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST_SCHEMA = 1;
export const SIGNATURE_SCHEMA = 1;
export const KEYS_SCHEMA = 1;
export const MAX_VALIDITY_DAYS = 30;
export const MANIFEST_FILE = 'update-manifest.json';
export const SIGNATURE_FILE = 'update-manifest.json.sig';
export const ARCHITECTURES = Object.freeze(['aarch64', 'x86_64']);

/** Every reason `verify` can report. Reasons never echo input or key material. */
export const VERIFY_REASONS = Object.freeze([
  'keys_malformed',
  'no_trusted_keys',
  'signature_malformed',
  'unknown_key_id',
  'signature_invalid',
  'manifest_malformed',
  'manifest_not_canonical',
  'manifest_not_yet_valid',
  'manifest_expired',
  'manifest_mismatch',
]);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Allowed clock difference between the tagger and a verifier, in both directions. */
export const CLOCK_SKEW_SECONDS = 300;
const CLOCK_SKEW_MS = CLOCK_SKEW_SECONDS * 1000;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class UpdateManifestError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'UpdateManifestError';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new UpdateManifestError(reason, message);
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Canonical JSON without a trailing newline. Rejects anything whose
 * serialization would be ambiguous: non-integers, non-plain objects,
 * undefined, functions, symbols, and bigints.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('Canonical JSON permits only safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

/** The exact file bytes for a canonical document: canonical JSON plus one LF. */
export function canonicalFileText(value) {
  return `${canonicalJson(value)}\n`;
}

function toBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * Parses canonical file bytes. Returns undefined when the bytes are not valid
 * UTF-8 JSON, and `{ value, canonical }` otherwise.
 */
function parseCanonical(bytes) {
  const buffer = toBuffer(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  let canonical;
  try {
    canonical = canonicalFileText(value);
  } catch {
    return { value, canonical: false };
  }
  return { value, canonical: Buffer.from(canonical, 'utf8').equals(buffer) };
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  // Reject calendar overflow such as 2026-02-31, which Date.parse normalizes.
  if (formatTimestamp(millis) !== value) return undefined;
  return millis;
}

function formatTimestamp(millis) {
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Normalizes any ISO-8601 instant to the manifest's second-precision UTC form. */
export function normalizeTimestamp(value) {
  const millis = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(millis)) fail('invalid_timestamp', 'Timestamp is not a valid ISO-8601 instant');
  return formatTimestamp(Math.floor(millis / 1000) * 1000);
}

export function dmgFileName(version, architecture) {
  return `Psyche-Build-v${version}-${architecture}.dmg`;
}

/**
 * Parses `shasum -a 256` output for exactly the two release DMGs. Any other
 * line, duplicate, malformed digest, or missing architecture is rejected.
 */
export function parseSha256Sums(text, version) {
  if (typeof text !== 'string') fail('invalid_sha256sums', 'SHA256SUMS must be text');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const expected = new Map(ARCHITECTURES.map((arch) => [dmgFileName(version, arch), arch]));
  const artifacts = {};
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (!match) fail('invalid_sha256sums', 'SHA256SUMS contains a malformed line');
    const [, digest, fileName] = match;
    const arch = expected.get(fileName);
    if (!arch) fail('invalid_sha256sums', 'SHA256SUMS names a file outside the release DMG set');
    if (artifacts[arch]) fail('invalid_sha256sums', 'SHA256SUMS names a release DMG more than once');
    artifacts[arch] = { file: fileName, sha256: digest };
  }
  for (const arch of ARCHITECTURES) {
    if (!artifacts[arch]) fail('invalid_sha256sums', `SHA256SUMS is missing the ${arch} DMG`);
  }
  return artifacts;
}

function validateManifestShape(manifest) {
  if (
    !hasExactKeys(manifest, [
      'artifacts',
      'expires_at',
      'published_at',
      'schema',
      'source_sha',
      'tag',
      'version',
    ])
  ) {
    return false;
  }
  if (manifest.schema !== MANIFEST_SCHEMA) return false;
  if (typeof manifest.version !== 'string' || !STABLE_VERSION.test(manifest.version)) return false;
  if (manifest.tag !== `v${manifest.version}`) return false;
  if (typeof manifest.source_sha !== 'string' || !SOURCE_SHA.test(manifest.source_sha)) return false;
  if (!hasExactKeys(manifest.artifacts, ARCHITECTURES)) return false;
  for (const arch of ARCHITECTURES) {
    const artifact = manifest.artifacts[arch];
    if (!hasExactKeys(artifact, ['file', 'sha256'])) return false;
    if (artifact.file !== dmgFileName(manifest.version, arch)) return false;
    if (typeof artifact.sha256 !== 'string' || !SHA256_HEX.test(artifact.sha256)) return false;
  }
  const publishedAt = parseTimestamp(manifest.published_at);
  const expiresAt = parseTimestamp(manifest.expires_at);
  if (publishedAt === undefined || expiresAt === undefined) return false;
  if (expiresAt <= publishedAt || expiresAt - publishedAt > MAX_VALIDITY_DAYS * DAY_MS) return false;
  return true;
}

/**
 * Builds a manifest object. `publishedAt` is required so a retried release job
 * reproduces byte-identical output; `now` only guards against building a
 * manifest that is already expired.
 */
export function buildManifest({
  version,
  tag,
  sourceSha,
  sha256sums,
  publishedAt,
  expiresAt,
  expiresInDays,
  now = Date.now(),
}) {
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    fail('invalid_version', 'Version must be a stable MAJOR.MINOR.PATCH value');
  }
  if (tag !== `v${version}`) fail('invalid_tag', 'Tag must equal v<version>');
  if (typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha)) {
    fail('invalid_source_sha', 'Source commit must be a 40-character lowercase hex SHA');
  }
  const artifacts = parseSha256Sums(sha256sums, version);
  if (publishedAt === undefined) fail('invalid_timestamp', 'publishedAt is required');
  const published = parseTimestamp(normalizeTimestamp(publishedAt));
  if ((expiresAt === undefined) === (expiresInDays === undefined)) {
    fail('invalid_expiry', 'Pass exactly one of expiresAt or expiresInDays');
  }
  let expires;
  if (expiresInDays !== undefined) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_VALIDITY_DAYS) {
      fail('invalid_expiry', `expiresInDays must be an integer from 1 to ${MAX_VALIDITY_DAYS}`);
    }
    expires = published + expiresInDays * DAY_MS;
  } else {
    expires = parseTimestamp(normalizeTimestamp(expiresAt));
  }
  if (expires <= published) fail('invalid_expiry', 'Expiry must be after publication');
  if (expires - published > MAX_VALIDITY_DAYS * DAY_MS) {
    fail('invalid_expiry', `Expiry must be at most ${MAX_VALIDITY_DAYS} days after publication`);
  }
  const nowMillis = typeof now === 'number' ? now : Date.parse(String(now));
  if (!Number.isFinite(nowMillis)) fail('invalid_timestamp', 'now is not a valid instant');
  // A tagger clock running ahead would produce a manifest every verifier
  // rejects as manifest_not_yet_valid; refuse it here with a clear reason.
  if (published - nowMillis > CLOCK_SKEW_MS) {
    fail(
      'published_at_in_future',
      `publishedAt is more than ${CLOCK_SKEW_SECONDS} seconds in the future; check the tagger's clock`,
    );
  }
  if (expires <= nowMillis) fail('invalid_expiry', 'Manifest would already be expired');

  const manifest = {
    schema: MANIFEST_SCHEMA,
    version,
    tag,
    source_sha: sourceSha,
    artifacts,
    published_at: formatTimestamp(published),
    expires_at: formatTimestamp(expires),
  };
  if (!validateManifestShape(manifest)) fail('invalid_manifest', 'Built manifest failed validation');
  return manifest;
}

export function keyIdForPublicKey(rawPublicKey) {
  const raw = toBuffer(rawPublicKey);
  if (raw.length !== 32) fail('invalid_public_key', 'An Ed25519 public key has 32 bytes');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function rawPublicKeyFromKeyObject(publicKey) {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  if (spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    fail('invalid_public_key', 'Key is not an Ed25519 public key');
  }
  return spki.subarray(12);
}

function publicKeyObjectFromRaw(raw) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function loadPrivateKey(privateKeyPem) {
  let key;
  try {
    key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    fail('invalid_private_key', 'Signing key is not a readable PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('invalid_private_key', 'Signing key is not an Ed25519 private key');
  }
  return key;
}

/** Public half and key id of an Ed25519 private key, for the keys file. */
export function publicKeyEntryFromPrivatePem(privateKeyPem) {
  const raw = rawPublicKeyFromKeyObject(createPublicKey(loadPrivateKey(privateKeyPem)));
  return { keyId: keyIdForPublicKey(raw), publicKey: raw.toString('base64') };
}

function parseKeyEntry(entry) {
  if (entry === null) return null;
  if (!hasExactKeys(entry, ['keyId', 'publicKey'])) return undefined;
  if (typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId)) return undefined;
  if (typeof entry.publicKey !== 'string' || !BASE64.test(entry.publicKey)) return undefined;
  const raw = Buffer.from(entry.publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== entry.publicKey) return undefined;
  if (keyIdForPublicKey(raw) !== entry.keyId) return undefined;
  let keyObject;
  try {
    keyObject = publicKeyObjectFromRaw(raw);
  } catch {
    return undefined;
  }
  return { keyId: entry.keyId, publicKey: entry.publicKey, keyObject };
}

/**
 * Parses `release/update-manifest-keys.json`:
 * `{ "schema": 1, "current": {keyId, publicKey} | null, "next": ... | null }`.
 * A `next` slot without a `current` slot, or the same key in both, is malformed.
 */
export function parseKeysFile(text) {
  let value;
  try {
    value = JSON.parse(typeof text === 'string' ? text : toBuffer(text).toString('utf8'));
  } catch {
    fail('keys_malformed', 'Keys file is not valid JSON');
  }
  if (!hasExactKeys(value, ['current', 'next', 'schema']) || value.schema !== KEYS_SCHEMA) {
    fail('keys_malformed', 'Keys file must contain exactly schema, current, and next');
  }
  const current = parseKeyEntry(value.current);
  const next = parseKeyEntry(value.next);
  if (current === undefined || next === undefined) {
    fail('keys_malformed', 'Keys file contains a malformed key entry');
  }
  if (current === null && next !== null) {
    fail('keys_malformed', 'Keys file has a next key without a current key');
  }
  if (current && next && current.keyId === next.keyId) {
    fail('keys_malformed', 'Keys file repeats the same key in current and next');
  }
  return { current, next };
}

/** Whether the release workflow must publish a signed manifest. */
export function isSigningActive(keys) {
  return keys.current !== null;
}

/**
 * Signs exact canonical manifest bytes. The private key must be the keys
 * file's `current` key, so a release never signs with a key that installed
 * apps were not told to trust as current.
 */
export function signManifest(manifestBytes, privateKeyPem, keys) {
  const bytes = toBuffer(manifestBytes);
  const parsed = parseCanonical(bytes);
  if (!parsed) fail('manifest_malformed', 'Manifest is not valid UTF-8 JSON');
  if (!parsed.canonical) fail('manifest_not_canonical', 'Manifest bytes are not canonical');
  if (!validateManifestShape(parsed.value)) fail('manifest_malformed', 'Manifest failed validation');
  if (!keys || !keys.current) fail('no_trusted_keys', 'Keys file has no current key');
  const privateKey = loadPrivateKey(privateKeyPem);
  const raw = rawPublicKeyFromKeyObject(createPublicKey(privateKey));
  const keyId = keyIdForPublicKey(raw);
  if (keyId !== keys.current.keyId || raw.toString('base64') !== keys.current.publicKey) {
    fail('signing_key_not_current', 'Signing key does not match the current key in the keys file');
  }
  const signature = sign(null, bytes, privateKey);
  return canonicalFileText({
    algorithm: 'ed25519',
    key_id: keyId,
    schema: SIGNATURE_SCHEMA,
    signature: signature.toString('base64'),
  });
}

function parseSignatureEnvelope(signatureBytes) {
  const parsed = parseCanonical(signatureBytes);
  if (!parsed || !parsed.canonical) return undefined;
  const envelope = parsed.value;
  if (!hasExactKeys(envelope, ['algorithm', 'key_id', 'schema', 'signature'])) return undefined;
  if (envelope.algorithm !== 'ed25519' || envelope.schema !== SIGNATURE_SCHEMA) return undefined;
  if (typeof envelope.key_id !== 'string' || !KEY_ID.test(envelope.key_id)) return undefined;
  if (typeof envelope.signature !== 'string' || !BASE64.test(envelope.signature)) return undefined;
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) return undefined;
  return { keyId: envelope.key_id, signature };
}

function reject(reason) {
  return { ok: false, reason };
}

/**
 * Verifies a manifest. The signature is checked over the raw bytes BEFORE the
 * manifest is parsed. Returns `{ ok: true, keyId, slot, manifest }` or
 * `{ ok: false, reason }` where reason is one of VERIFY_REASONS.
 *
 * `expect` optionally pins the tag, source commit, and SHA256SUMS text the
 * release job just produced.
 */
export function verifyManifest({ manifestBytes, signatureBytes, keys, now = Date.now(), expect }) {
  if (!keys || keys.current === undefined || keys.next === undefined) return reject('keys_malformed');
  const trusted = [
    ['current', keys.current],
    ['next', keys.next],
  ].filter(([, entry]) => entry);
  if (trusted.length === 0) return reject('no_trusted_keys');

  const envelope = parseSignatureEnvelope(signatureBytes);
  if (!envelope) return reject('signature_malformed');
  const match = trusted.find(([, entry]) => entry.keyId === envelope.keyId);
  if (!match) return reject('unknown_key_id');
  const [slot, entry] = match;
  const bytes = toBuffer(manifestBytes);
  let valid = false;
  try {
    valid = verify(null, bytes, entry.keyObject ?? publicKeyObjectFromRaw(Buffer.from(entry.publicKey, 'base64')), envelope.signature);
  } catch {
    valid = false;
  }
  if (!valid) return reject('signature_invalid');

  const parsed = parseCanonical(bytes);
  if (!parsed) return reject('manifest_malformed');
  if (!parsed.canonical) return reject('manifest_not_canonical');
  const manifest = parsed.value;
  if (!validateManifestShape(manifest)) return reject('manifest_malformed');

  const nowMillis = typeof now === 'number' ? now : Date.parse(String(now));
  if (!Number.isFinite(nowMillis)) return reject('manifest_malformed');
  if (nowMillis < parseTimestamp(manifest.published_at) - CLOCK_SKEW_MS) {
    return reject('manifest_not_yet_valid');
  }
  if (nowMillis >= parseTimestamp(manifest.expires_at)) return reject('manifest_expired');

  if (expect) {
    if (expect.tag !== undefined && manifest.tag !== expect.tag) return reject('manifest_mismatch');
    if (expect.sourceSha !== undefined && manifest.source_sha !== expect.sourceSha) {
      return reject('manifest_mismatch');
    }
    if (expect.sha256sums !== undefined) {
      let expected;
      try {
        expected = parseSha256Sums(expect.sha256sums, manifest.version);
      } catch {
        return reject('manifest_mismatch');
      }
      if (canonicalJson(expected) !== canonicalJson(manifest.artifacts)) return reject('manifest_mismatch');
    }
  }
  return { ok: true, keyId: envelope.keyId, slot, manifest };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `usage:
  update-manifest.mjs status --keys <keys.json>
  update-manifest.mjs build --version <x.y.z> --tag <vx.y.z> --source-sha <sha>
      --sha256sums <path> --published-at <iso> (--expires-in-days <n> | --expires-at <iso>)
      --out <path> [--now <iso>]
  update-manifest.mjs sign --manifest <path> --keys <keys.json> --key-env <ENV_NAME> --out <path>
  update-manifest.mjs verify --manifest <path> --signature <path> --keys <keys.json>
      [--expect-tag <tag>] [--expect-source-sha <sha>] [--sha256sums <path>] [--now <iso>]`;

const COMMAND_OPTIONS = {
  status: { required: ['keys'], optional: [] },
  build: {
    required: ['version', 'tag', 'source-sha', 'sha256sums', 'published-at', 'out'],
    optional: ['expires-in-days', 'expires-at', 'now'],
  },
  sign: { required: ['manifest', 'keys', 'key-env', 'out'], optional: [] },
  verify: {
    required: ['manifest', 'signature', 'keys'],
    optional: ['expect-tag', 'expect-source-sha', 'sha256sums', 'now'],
  },
};

class UsageError extends Error {}

function parseOptions(command, args) {
  const spec = COMMAND_OPTIONS[command];
  const allowed = new Set([...spec.required, ...spec.optional]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith('--')) throw new UsageError(`Unexpected argument for ${command}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new UsageError(`Unknown option --${name} for ${command}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`Option --${name} was given twice`);
    const value = args[index + 1];
    if (value === undefined || /^--[a-z]/.test(value)) throw new UsageError(`Option --${name} needs a value`);
    options[name] = value;
  }
  for (const name of spec.required) {
    if (!Object.hasOwn(options, name)) throw new UsageError(`Missing --${name} for ${command}`);
  }
  return options;
}

function readKeys(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    fail('keys_malformed', 'Keys file could not be read');
  }
  return parseKeysFile(text);
}

function readFileOrFail(filePath, reason, label) {
  try {
    return readFileSync(filePath);
  } catch {
    fail(reason, `${label} could not be read`);
  }
}

function runStatus(options, io) {
  const keys = readKeys(options.keys);
  if (isSigningActive(keys)) {
    io.stdout(`active=true\ncurrent_key_id=${keys.current.keyId}\n`);
  } else {
    io.stdout('active=false\n');
  }
  return 0;
}

function runBuild(options, io) {
  let expiresInDays;
  if (options['expires-in-days'] !== undefined) {
    if (!/^\d+$/.test(options['expires-in-days'])) {
      fail('invalid_expiry', '--expires-in-days must be an integer');
    }
    expiresInDays = Number(options['expires-in-days']);
  }
  const manifest = buildManifest({
    version: options.version,
    tag: options.tag,
    sourceSha: options['source-sha'],
    sha256sums: readFileOrFail(options.sha256sums, 'invalid_sha256sums', 'SHA256SUMS').toString('utf8'),
    publishedAt: options['published-at'],
    expiresAt: options['expires-at'],
    expiresInDays,
    now: options.now ?? Date.now(),
  });
  writeFileSync(options.out, canonicalFileText(manifest));
  io.stdout(`built ${path.basename(options.out)} version=${manifest.version} expires_at=${manifest.expires_at}\n`);
  return 0;
}

function runSign(options, io, env) {
  const envName = options['key-env'];
  // The key is only ever read from the environment. Refusing anything that is
  // not an environment variable NAME stops a PEM from being passed on argv,
  // where it would be visible to every process on the host.
  if (!ENV_NAME.test(envName)) {
    throw new UsageError('--key-env takes the NAME of an environment variable, never key material');
  }
  const privateKeyPem = env[envName];
  if (typeof privateKeyPem !== 'string' || privateKeyPem.trim() === '') {
    fail('missing_signing_key', `Environment variable ${envName} is empty or unset`);
  }
  const keys = readKeys(options.keys);
  const manifestBytes = readFileOrFail(options.manifest, 'manifest_malformed', 'Manifest');
  const envelope = signManifest(manifestBytes, privateKeyPem, keys);
  writeFileSync(options.out, envelope);
  io.stdout(`signed ${path.basename(options.manifest)} key_id=${keys.current.keyId}\n`);
  return 0;
}

function runVerify(options, io) {
  let keys;
  try {
    keys = readKeys(options.keys);
  } catch {
    io.stderr('verify: fail reason=keys_malformed\n');
    return 1;
  }
  let manifestBytes;
  let signatureBytes;
  try {
    manifestBytes = readFileSync(options.manifest);
  } catch {
    io.stderr('verify: fail reason=manifest_malformed\n');
    return 1;
  }
  try {
    signatureBytes = readFileSync(options.signature);
  } catch {
    io.stderr('verify: fail reason=signature_malformed\n');
    return 1;
  }
  let sha256sums;
  if (options.sha256sums !== undefined) {
    try {
      sha256sums = readFileSync(options.sha256sums, 'utf8');
    } catch {
      io.stderr('verify: fail reason=manifest_mismatch\n');
      return 1;
    }
  }
  const result = verifyManifest({
    manifestBytes,
    signatureBytes,
    keys,
    now: options.now ?? Date.now(),
    expect: {
      tag: options['expect-tag'],
      sourceSha: options['expect-source-sha'],
      sha256sums,
    },
  });
  if (!result.ok) {
    io.stderr(`verify: fail reason=${result.reason}\n`);
    return 1;
  }
  io.stdout(
    `verify: ok key_id=${result.keyId} slot=${result.slot} version=${result.manifest.version} expires_at=${result.manifest.expires_at}\n`,
  );
  return 0;
}

export function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    io = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  } = {},
) {
  const [command, ...args] = argv;
  if (!command || !Object.hasOwn(COMMAND_OPTIONS, command)) {
    io.stderr(`${USAGE}\n`);
    return 64;
  }
  try {
    const options = parseOptions(command, args);
    if (command === 'status') return runStatus(options, io);
    if (command === 'build') return runBuild(options, io);
    if (command === 'sign') return runSign(options, io, env);
    return runVerify(options, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`update-manifest: ${error.message}\n${USAGE}\n`);
      return 64;
    }
    if (error instanceof UpdateManifestError) {
      io.stderr(`update-manifest: ${command} failed reason=${error.reason}: ${error.message}\n`);
      return 1;
    }
    // Never print an unknown error's message or stack: it could carry key
    // material from a crypto failure.
    io.stderr(`update-manifest: ${command} failed reason=internal_error\n`);
    return 1;
  }
}

// Node resolves the entry module through symlinks (for example /var ->
// /private/var on macOS runners), so compare against the real path.
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
