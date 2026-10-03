import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateSigningKey, main as generateMain } from '../scripts/generate-update-signing-key.mjs';
import {
  VERIFY_REASONS,
  buildManifest,
  canonicalFileText,
  canonicalJson,
  isSigningActive,
  keyIdForPublicKey,
  main,
  parseKeysFile,
  parseSha256Sums,
  publicKeyEntryFromPrivatePem,
  signManifest,
  verifyManifest,
  type TrustedKeys,
} from '../scripts/update-manifest.mjs';

const VERSION = '1.2.3';
const TAG = 'v1.2.3';
const SHA = 'a'.repeat(40);
const ARM_DIGEST = '1'.repeat(64);
const INTEL_DIGEST = '2'.repeat(64);
const SUMS = `${ARM_DIGEST}  Psyche-Build-v1.2.3-aarch64.dmg\n${INTEL_DIGEST}  Psyche-Build-v1.2.3-x86_64.dmg\n`;
const PUBLISHED = '2026-10-01T12:00:00Z';
const NOW = '2026-10-02T00:00:00Z';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'psyche-update-manifest-'));
  temporaryRoots.push(root);
  return root;
}

// Ephemeral keys only: generated in memory per test, never written to the repo
// and never printed.
function ephemeralKey(): { pem: string; keyId: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { pem, ...publicKeyEntryFromPrivatePem(pem) };
}

function keysText(current: { keyId: string; publicKey: string } | null, next: { keyId: string; publicKey: string } | null = null): string {
  const strip = (entry: typeof current) => (entry ? { keyId: entry.keyId, publicKey: entry.publicKey } : null);
  return JSON.stringify({ schema: 1, current: strip(current), next: strip(next) }, null, 2);
}

function manifestBytes(overrides: Partial<Parameters<typeof buildManifest>[0]> = {}): Buffer {
  return Buffer.from(
    canonicalFileText(
      buildManifest({
        version: VERSION,
        tag: TAG,
        sourceSha: SHA,
        sha256sums: SUMS,
        publishedAt: PUBLISHED,
        expiresInDays: 30,
        now: NOW,
        ...overrides,
      }),
    ),
  );
}

function signed(key = ephemeralKey(), keys: TrustedKeys = parseKeysFile(keysText(key))) {
  const manifest = manifestBytes();
  const signature = Buffer.from(signManifest(manifest, key.pem, keys));
  return { key, keys, manifest, signature };
}

describe('canonical JSON', () => {
  it('sorts keys, removes whitespace, and ends the file with exactly one LF', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[3,"x"]},"b":1}');
    expect(canonicalFileText({ z: true, a: 'é' })).toBe('{"a":"é","z":true}\n');
    expect(canonicalJson({ s: 'quote " slash \\ nl \n' })).toBe('{"s":"quote \\" slash \\\\ nl \\n"}');
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('rejects values without one unambiguous encoding', () => {
    for (const value of [1.5, Number.NaN, Infinity, -0, 2 ** 60, undefined, () => 1, new Date(0), 1n]) {
      expect(() => canonicalJson({ value })).toThrow();
    }
  });

  it('builds a manifest whose file bytes are canonical and UTF-8', () => {
    const bytes = manifestBytes();
    const text = bytes.toString('utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toMatch(/\r|\n(?!$)/);
    expect(text).toBe(canonicalFileText(JSON.parse(text)));
    expect(JSON.parse(text)).toEqual({
      artifacts: {
        aarch64: { file: 'Psyche-Build-v1.2.3-aarch64.dmg', sha256: ARM_DIGEST },
        x86_64: { file: 'Psyche-Build-v1.2.3-x86_64.dmg', sha256: INTEL_DIGEST },
      },
      expires_at: '2026-10-31T12:00:00Z',
      published_at: PUBLISHED,
      schema: 1,
      source_sha: SHA,
      tag: TAG,
      version: VERSION,
    });
  });

  it('is byte-for-byte reproducible from the same inputs', () => {
    expect(manifestBytes().equals(manifestBytes())).toBe(true);
    const key = ephemeralKey();
    const keys = parseKeysFile(keysText(key));
    expect(signManifest(manifestBytes(), key.pem, keys)).toBe(signManifest(manifestBytes(), key.pem, keys));
  });
});

describe('manifest build', () => {
  it('accepts shasum binary markers but only the two release DMGs', () => {
    expect(parseSha256Sums(SUMS.replaceAll('  ', ' *'), VERSION).x86_64.sha256).toBe(INTEL_DIGEST);
    const bad = [
      '',
      `${ARM_DIGEST}  Psyche-Build-v1.2.3-aarch64.dmg\n`,
      `${SUMS}${'3'.repeat(64)}  extra.dmg\n`,
      `${SUMS}${ARM_DIGEST}  Psyche-Build-v1.2.3-aarch64.dmg\n`,
      SUMS.replace(ARM_DIGEST, 'G'.repeat(64)),
      SUMS.replace(ARM_DIGEST, ARM_DIGEST.slice(1)),
      SUMS.replace('1.2.3-aarch64', '1.2.4-aarch64'),
      SUMS.replace('\n', '\r\n'),
      `${SUMS}\n`,
    ];
    for (const sums of bad) {
      expect(() => parseSha256Sums(sums, VERSION), JSON.stringify(sums)).toThrow(/SHA256SUMS/);
    }
  });

  it('rejects malformed identities', () => {
    expect(() => manifestBytes({ version: '1.2' })).toThrow(/Version/);
    expect(() => manifestBytes({ version: '1.2.3-rc.1', tag: 'v1.2.3-rc.1' })).toThrow(/Version/);
    expect(() => manifestBytes({ tag: 'v1.2.4' })).toThrow(/Tag/);
    expect(() => manifestBytes({ sourceSha: 'A'.repeat(40) })).toThrow(/Source commit/);
    expect(() => manifestBytes({ sourceSha: 'a'.repeat(39) })).toThrow(/Source commit/);
  });

  it('rejects an expiry beyond 30 days, at or before publication, or already past', () => {
    expect(() => manifestBytes({ expiresInDays: 31 })).toThrow(/expiresInDays/);
    expect(() => manifestBytes({ expiresInDays: 0 })).toThrow(/expiresInDays/);
    expect(() => manifestBytes({ expiresInDays: undefined, expiresAt: '2026-10-31T12:00:01Z' })).toThrow(/at most 30 days/);
    expect(() => manifestBytes({ expiresInDays: undefined, expiresAt: PUBLISHED })).toThrow(/after publication/);
    expect(() => manifestBytes({ now: '2026-11-01T00:00:00Z' })).toThrow(/already be expired/);
    expect(() => manifestBytes({ expiresAt: '2026-10-05T00:00:00Z' })).toThrow(/exactly one/);
    expect(() => manifestBytes({ expiresInDays: undefined })).toThrow(/exactly one/);
    expect(() => manifestBytes({ publishedAt: 'yesterday' })).toThrow(/Timestamp/);
    const exact = JSON.parse(manifestBytes({ expiresInDays: undefined, expiresAt: '2026-10-31T12:00:00Z' }).toString());
    expect(exact.expires_at).toBe('2026-10-31T12:00:00Z');
  });

  it('normalizes publication time to whole UTC seconds', () => {
    const manifest = JSON.parse(manifestBytes({ publishedAt: '2026-10-01T14:00:00.987+02:00' }).toString());
    expect(manifest.published_at).toBe('2026-10-01T12:00:00Z');
  });
});

describe('keys file', () => {
  it('starts empty in the repository, which disables signing', () => {
    const keys = parseKeysFile(readFileSync('release/update-manifest-keys.json', 'utf8'));
    expect(keys).toEqual({ current: null, next: null });
    expect(isSigningActive(keys)).toBe(false);
  });

  it('derives the key id from the first 8 bytes of SHA-256 over the raw public key', () => {
    const key = ephemeralKey();
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdForPublicKey(Buffer.from(key.publicKey, 'base64'))).toBe(key.keyId);
    expect(Buffer.from(key.publicKey, 'base64')).toHaveLength(32);
  });

  it('rejects malformed, inconsistent, or duplicated entries', () => {
    const a = ephemeralKey();
    const b = ephemeralKey();
    const malformed = [
      'not json',
      '{}',
      JSON.stringify({ schema: 2, current: null, next: null }),
      JSON.stringify({ schema: 1, current: null, next: null, extra: 1 }),
      keysText(null, a),
      keysText(a, a),
      keysText({ keyId: b.keyId, publicKey: a.publicKey }),
      keysText({ keyId: a.keyId.toUpperCase(), publicKey: a.publicKey }),
      keysText({ keyId: a.keyId, publicKey: a.publicKey.replace(/=*$/, '') }),
      JSON.stringify({ schema: 1, current: { keyId: a.keyId, publicKey: a.publicKey, pem: 'x' }, next: null }),
    ];
    for (const text of malformed) {
      expect(() => parseKeysFile(text), text).toThrow(expect.objectContaining({ reason: 'keys_malformed' }));
    }
    expect(isSigningActive(parseKeysFile(keysText(a, b)))).toBe(true);
  });
});

describe('sign and verify', () => {
  it('round-trips and writes a canonical envelope naming the key id', () => {
    const { key, keys, manifest, signature } = signed();
    const envelope = JSON.parse(signature.toString());
    expect(signature.toString()).toBe(canonicalFileText(envelope));
    expect(Object.keys(envelope).sort()).toEqual(['algorithm', 'key_id', 'schema', 'signature']);
    expect(envelope.algorithm).toBe('ed25519');
    expect(envelope.key_id).toBe(key.keyId);
    expect(Buffer.from(envelope.signature, 'base64')).toHaveLength(64);
    const result = verifyManifest({
      manifestBytes: manifest,
      signatureBytes: signature,
      keys,
      now: NOW,
      expect: { tag: TAG, sourceSha: SHA, sha256sums: SUMS },
    });
    expect(result).toMatchObject({ ok: true, keyId: key.keyId, slot: 'current' });
  });

  it('signs only with the current key and only canonical, valid manifests', () => {
    const current = ephemeralKey();
    const other = ephemeralKey();
    const keys = parseKeysFile(keysText(current, other));
    expect(() => signManifest(manifestBytes(), other.pem, keys)).toThrow(
      expect.objectContaining({ reason: 'signing_key_not_current' }),
    );
    expect(() => signManifest(manifestBytes(), current.pem, { current: null, next: null })).toThrow(
      expect.objectContaining({ reason: 'no_trusted_keys' }),
    );
    const pretty = Buffer.from(`${JSON.stringify(JSON.parse(manifestBytes().toString()), null, 2)}\n`);
    expect(() => signManifest(pretty, current.pem, keys)).toThrow(
      expect.objectContaining({ reason: 'manifest_not_canonical' }),
    );
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() =>
      signManifest(manifestBytes(), rsa.export({ format: 'pem', type: 'pkcs8' }).toString(), keys),
    ).toThrow(expect.objectContaining({ reason: 'invalid_private_key' }));
  });

  it('fails with bounded reasons for tampering, wrong keys, expiry, and mismatches', () => {
    const { key, keys, manifest, signature } = signed();
    const verifyWith = (overrides: Partial<Parameters<typeof verifyManifest>[0]>) =>
      verifyManifest({ manifestBytes: manifest, signatureBytes: signature, keys, now: NOW, ...overrides });

    const flipped = Buffer.from(manifest);
    flipped[10] ^= 0x01;
    expect(verifyWith({ manifestBytes: flipped })).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(verifyWith({ manifestBytes: Buffer.concat([manifest, Buffer.from('\n')]) })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });

    const envelope = JSON.parse(signature.toString());
    const sig = Buffer.from(envelope.signature, 'base64');
    sig[0] ^= 0x01;
    const tamperedSig = canonicalFileText({ ...envelope, signature: sig.toString('base64') });
    expect(verifyWith({ signatureBytes: Buffer.from(tamperedSig) })).toEqual({ ok: false, reason: 'signature_invalid' });

    const stranger = ephemeralKey();
    const impostor = canonicalFileText({ ...envelope, key_id: stranger.keyId });
    expect(verifyWith({ signatureBytes: Buffer.from(impostor) })).toEqual({ ok: false, reason: 'unknown_key_id' });

    // A key file that trusts a different key under the signer's id is caught
    // by key-id derivation when parsed; a forged in-memory slot still fails.
    const forged: TrustedKeys = { current: { keyId: key.keyId, publicKey: stranger.publicKey }, next: null };
    expect(verifyWith({ keys: forged })).toEqual({ ok: false, reason: 'signature_invalid' });

    // Signed by a key that is trusted nowhere.
    const strangerKeys = parseKeysFile(keysText(stranger));
    const strangerSig = Buffer.from(signManifest(manifest, stranger.pem, strangerKeys));
    expect(verifyWith({ signatureBytes: strangerSig })).toEqual({ ok: false, reason: 'unknown_key_id' });

    expect(verifyWith({ keys: { current: null, next: null } })).toEqual({ ok: false, reason: 'no_trusted_keys' });
    expect(verifyWith({ signatureBytes: Buffer.from('garbage') })).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(verifyWith({ signatureBytes: Buffer.from(JSON.stringify(envelope, null, 1)) })).toEqual({
      ok: false,
      reason: 'signature_malformed',
    });
    expect(verifyWith({ signatureBytes: Buffer.from(canonicalFileText({ ...envelope, algorithm: 'rsa' })) })).toEqual({
      ok: false,
      reason: 'signature_malformed',
    });

    expect(verifyWith({ now: '2026-10-31T12:00:00Z' })).toEqual({ ok: false, reason: 'manifest_expired' });
    expect(verifyWith({ now: '2026-09-30T00:00:00Z' })).toEqual({ ok: false, reason: 'manifest_not_yet_valid' });
    expect(verifyWith({ expect: { tag: 'v9.9.9' } })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(verifyWith({ expect: { sourceSha: 'b'.repeat(40) } })).toEqual({ ok: false, reason: 'manifest_mismatch' });
    expect(verifyWith({ expect: { sha256sums: SUMS.replace(ARM_DIGEST, '3'.repeat(64)) } })).toEqual({
      ok: false,
      reason: 'manifest_mismatch',
    });
  });

  it('rejects a validly signed manifest that is not canonical or not well formed', () => {
    const key = ephemeralKey();
    const keys = parseKeysFile(keysText(key));
    // Sign arbitrary bytes directly so the signature is valid but the content is not.
    const signBytes = (bytes: Buffer) =>
      Buffer.from(
        canonicalFileText({
          algorithm: 'ed25519',
          key_id: key.keyId,
          schema: 1,
          signature: sign(null, bytes, createPrivateKey(key.pem)).toString('base64'),
        }),
      );
    const valid = JSON.parse(manifestBytes().toString());
    const cases: Array<[Buffer, string]> = [
      [Buffer.from(`${JSON.stringify(valid, null, 2)}\n`), 'manifest_not_canonical'],
      [Buffer.from(canonicalJson(valid)), 'manifest_not_canonical'],
      [Buffer.from(`﻿${canonicalFileText(valid)}`), 'manifest_malformed'],
      [Buffer.from(canonicalFileText({ ...valid, extra: 1 })), 'manifest_malformed'],
      [Buffer.from(canonicalFileText({ ...valid, tag: 'v1.2.4' })), 'manifest_malformed'],
      [Buffer.from(canonicalFileText({ ...valid, expires_at: '2026-11-01T12:00:00Z' })), 'manifest_malformed'],
      [Buffer.from(canonicalFileText({ ...valid, expires_at: '2026-02-31T12:00:00Z' })), 'manifest_malformed'],
      [Buffer.from([0xff, 0xfe, 0x0a]), 'manifest_malformed'],
    ];
    for (const [bytes, reason] of cases) {
      expect(
        verifyManifest({ manifestBytes: bytes, signatureBytes: signBytes(bytes), keys, now: NOW }),
        bytes.toString('utf8'),
      ).toEqual({ ok: false, reason });
    }
  });

  it('accepts a manifest signed by the next key during rotation, and drops a removed key', () => {
    const oldKey = ephemeralKey();
    const newKey = ephemeralKey();
    // Before rotation: the app trusts current=old, next=new.
    const preRotation = parseKeysFile(keysText(oldKey, newKey));
    // After rotation the release side signs with new (now current).
    const postRotation = parseKeysFile(keysText(newKey));
    const manifest = manifestBytes();
    const newSig = Buffer.from(signManifest(manifest, newKey.pem, postRotation));
    const oldSig = Buffer.from(signManifest(manifest, oldKey.pem, preRotation));

    expect(verifyManifest({ manifestBytes: manifest, signatureBytes: newSig, keys: preRotation, now: NOW })).toMatchObject({
      ok: true,
      slot: 'next',
      keyId: newKey.keyId,
    });
    expect(verifyManifest({ manifestBytes: manifest, signatureBytes: oldSig, keys: preRotation, now: NOW })).toMatchObject({
      ok: true,
      slot: 'current',
    });
    // Revocation: once old is removed from every slot, its signatures are refused.
    expect(verifyManifest({ manifestBytes: manifest, signatureBytes: oldSig, keys: postRotation, now: NOW })).toEqual({
      ok: false,
      reason: 'unknown_key_id',
    });
  });

  it('exposes only the documented reasons', () => {
    expect([...VERIFY_REASONS].sort()).toEqual(
      [
        'keys_malformed',
        'manifest_expired',
        'manifest_malformed',
        'manifest_mismatch',
        'manifest_not_canonical',
        'manifest_not_yet_valid',
        'no_trusted_keys',
        'signature_invalid',
        'signature_malformed',
        'unknown_key_id',
      ].sort(),
    );
  });
});

describe('update-manifest CLI', () => {
  function capture() {
    const out = { stdout: '', stderr: '' };
    return {
      out,
      io: { stdout: (text: string) => void (out.stdout += text), stderr: (text: string) => void (out.stderr += text) },
    };
  }

  function writeFixture(key = ephemeralKey(), keys = keysText(key)) {
    const root = temporaryRoot();
    const files = {
      sums: path.join(root, 'SHA256SUMS'),
      keys: path.join(root, 'keys.json'),
      manifest: path.join(root, 'update-manifest.json'),
      signature: path.join(root, 'update-manifest.json.sig'),
    };
    writeFileSync(files.sums, SUMS);
    writeFileSync(files.keys, keys);
    return { root, files, key };
  }

  it('builds, signs from a named environment variable, and self-verifies', () => {
    const { files, key } = writeFixture();
    const env = { TEST_UPDATE_KEY: key.pem };
    const run = (argv: string[]) => {
      const { out, io } = capture();
      const status = main(argv, { env, io });
      return { status, ...out };
    };

    expect(run(['status', '--keys', files.keys])).toMatchObject({
      status: 0,
      stdout: `active=true\ncurrent_key_id=${key.keyId}\n`,
    });
    const build = run([
      'build', '--version', VERSION, '--tag', TAG, '--source-sha', SHA, '--sha256sums', files.sums,
      '--published-at', PUBLISHED, '--expires-in-days', '30', '--now', NOW, '--out', files.manifest,
    ]);
    expect(build.status, build.stderr).toBe(0);
    expect(readFileSync(files.manifest).equals(manifestBytes())).toBe(true);

    const signResult = run(['sign', '--manifest', files.manifest, '--keys', files.keys, '--key-env', 'TEST_UPDATE_KEY', '--out', files.signature]);
    expect(signResult.status, signResult.stderr).toBe(0);
    expect(signResult.stdout + signResult.stderr).not.toContain('PRIVATE KEY');

    const verifyArgs = [
      'verify', '--manifest', files.manifest, '--signature', files.signature, '--keys', files.keys,
      '--expect-tag', TAG, '--expect-source-sha', SHA, '--sha256sums', files.sums, '--now', NOW,
    ];
    const ok = run(verifyArgs);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`^verify: ok key_id=${key.keyId} slot=current version=1\\.2\\.3 `));

    const expired = run([...verifyArgs.slice(0, -2), '--now', '2026-12-01T00:00:00Z']);
    expect(expired).toMatchObject({ status: 1, stderr: 'verify: fail reason=manifest_expired\n' });

    writeFileSync(files.manifest, readFileSync(files.manifest, 'utf8').replace(ARM_DIGEST, '9'.repeat(64)));
    expect(run(verifyArgs)).toMatchObject({ status: 1, stderr: 'verify: fail reason=signature_invalid\n' });
  });

  it('refuses key material on argv and never echoes it', () => {
    const { files, key } = writeFixture();
    writeFileSync(files.manifest, manifestBytes());
    const { out, io } = capture();
    const status = main(['sign', '--manifest', files.manifest, '--keys', files.keys, '--key-env', key.pem, '--out', files.signature], {
      env: {},
      io,
    });
    expect(status).toBe(64);
    expect(out.stderr).toContain('NAME of an environment variable');
    expect(out.stdout + out.stderr).not.toContain('PRIVATE KEY');
    expect(out.stdout + out.stderr).not.toContain(key.pem.split('\n')[1]);
  });

  it('fails closed when the signing secret is missing or is not the current key', () => {
    const { files } = writeFixture();
    writeFileSync(files.manifest, manifestBytes());
    const missing = capture();
    expect(main(['sign', '--manifest', files.manifest, '--keys', files.keys, '--key-env', 'ABSENT_KEY', '--out', files.signature], { env: { ABSENT_KEY: '' }, io: missing.io })).toBe(1);
    expect(missing.out.stderr).toContain('reason=missing_signing_key');

    const wrong = ephemeralKey();
    const mismatch = capture();
    expect(main(['sign', '--manifest', files.manifest, '--keys', files.keys, '--key-env', 'K', '--out', files.signature], { env: { K: wrong.pem }, io: mismatch.io })).toBe(1);
    expect(mismatch.out.stderr).toContain('reason=signing_key_not_current');
    expect(mismatch.out.stderr).not.toContain('PRIVATE KEY');

    const garbage = capture();
    expect(main(['sign', '--manifest', files.manifest, '--keys', files.keys, '--key-env', 'K', '--out', files.signature], { env: { K: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n' }, io: garbage.io })).toBe(1);
    expect(garbage.out.stderr).toContain('reason=invalid_private_key');
    expect(garbage.out.stderr).not.toContain('nope');
  });

  it('reports an empty keys file as inactive and rejects unknown options', () => {
    const { files } = writeFixture(undefined, keysText(null));
    const status = capture();
    expect(main(['status', '--keys', files.keys], { io: status.io })).toBe(0);
    expect(status.out.stdout).toBe('active=false\n');
    const verify = capture();
    writeFileSync(files.manifest, manifestBytes());
    writeFileSync(files.signature, 'x');
    expect(main(['verify', '--manifest', files.manifest, '--signature', files.signature, '--keys', files.keys], { io: verify.io })).toBe(1);
    expect(verify.out.stderr).toBe('verify: fail reason=no_trusted_keys\n');
    const unknown = capture();
    expect(main(['status', '--keys', files.keys, '--private-key', 'x'], { io: unknown.io })).toBe(64);
    expect(main(['nope'], { io: capture().io })).toBe(64);
  });

  it('runs as a standalone Node script with only built-ins', () => {
    const { files } = writeFixture(undefined, keysText(null));
    const result = spawnSync(process.execPath, ['scripts/update-manifest.mjs', 'status', '--keys', files.keys], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('active=false\n');
  });
});

describe('generate-update-signing-key', () => {
  it('writes a 0600 PKCS#8 PEM, prints only the public entry, and refuses to overwrite', () => {
    const root = temporaryRoot();
    const out = path.join(root, 'update-manifest-signing-key.pem');
    const captured = { stdout: '', stderr: '' };
    const io = {
      stdout: (text: string) => void (captured.stdout += text),
      stderr: (text: string) => void (captured.stderr += text),
    };
    expect(generateMain(['--out', out], { io }), captured.stderr).toBe(0);

    expect((statSync(out).mode & 0o777).toString(8)).toBe('600');
    const pem = readFileSync(out, 'utf8');
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const entry = publicKeyEntryFromPrivatePem(pem);
    expect(captured.stdout).toContain(JSON.stringify(entry, null, 2));
    expect(captured.stdout).toContain(`Key id: ${entry.keyId}`);
    expect(captured.stdout).not.toContain('PRIVATE KEY-----');
    for (const line of pem.trim().split('\n').slice(1, -1)) {
      expect(captured.stdout + captured.stderr).not.toContain(line);
    }

    const again = { stdout: '', stderr: '' };
    expect(
      generateMain(['--out', out], {
        io: { stdout: (t: string) => void (again.stdout += t), stderr: (t: string) => void (again.stderr += t) },
      }),
    ).toBe(1);
    expect(again.stderr).toContain('EEXIST');
    expect(readFileSync(out, 'utf8')).toBe(pem);
  });

  it('refuses to write inside a Git working tree and requires an explicit --out', () => {
    const insideRepo = path.resolve('update-manifest-signing-key.pem');
    expect(() => generateSigningKey(insideRepo)).toThrow(/Git working tree/);
    const captured = { stdout: '', stderr: '' };
    const io = {
      stdout: (text: string) => void (captured.stdout += text),
      stderr: (text: string) => void (captured.stderr += text),
    };
    expect(generateMain([], { io })).toBe(64);
    expect(generateMain(['--print-private'], { io })).toBe(64);
    expect(captured.stdout).toBe('');
  });

  it('produces a key the signer accepts once it is the current key', () => {
    const root = temporaryRoot();
    const out = path.join(root, 'k.pem');
    const entry = generateSigningKey(out);
    const keys = parseKeysFile(keysText(entry));
    const manifest = manifestBytes();
    const signature = signManifest(manifest, readFileSync(out, 'utf8'), keys);
    expect(verifyManifest({ manifestBytes: manifest, signatureBytes: signature, keys, now: NOW })).toMatchObject({ ok: true });
  });
});
