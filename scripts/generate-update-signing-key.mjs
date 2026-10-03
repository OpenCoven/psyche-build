#!/usr/bin/env node

// Creates an Ed25519 key pair for signing update manifests. The OWNER runs
// this locally; CI never does. See docs/RELEASE.md "Update manifest signing".
//
// The private key is written as a PKCS#8 PEM to --out, created with mode 0600,
// refusing to overwrite an existing file and refusing any location inside a
// Git working tree (so it cannot be committed by accident). The private key is
// never printed. Only the public key entry for release/update-manifest-keys.json
// is printed.

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { publicKeyEntryFromPrivatePem } from './update-manifest.mjs';

const USAGE = `usage: generate-update-signing-key.mjs --out <path-outside-any-git-checkout>`;

class UsageError extends Error {}

function insideGitWorkTree(directory) {
  try {
    const output = execFileSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Generates a key pair, writes the private PEM to `outPath` with mode 0600,
 * and returns only the public entry `{ keyId, publicKey }`.
 */
export function generateSigningKey(outPath) {
  const target = path.resolve(outPath);
  const directory = path.dirname(target);
  if (!existsSync(directory)) throw new UsageError('The output directory does not exist');
  if (insideGitWorkTree(realpathSync(directory))) {
    throw new UsageError('Refusing to write a private key inside a Git working tree');
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  // 'wx' refuses to follow or replace an existing path, and the mode applies
  // at creation so the key is never readable by anyone else, even briefly.
  const descriptor = openSync(target, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, pem);
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error('Private key file mode is not 0600');
    }
  } finally {
    closeSync(descriptor);
  }
  return publicKeyEntryFromPrivatePem(pem);
}

export function main(
  argv = process.argv.slice(2),
  {
    io = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  } = {},
) {
  try {
    if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) {
      throw new UsageError('Pass exactly --out <path>');
    }
    const entry = generateSigningKey(argv[1]);
    io.stdout(
      [
        `Wrote the private key (mode 0600) to ${path.resolve(argv[1])}.`,
        'It is not printed. Keep it out of every repository, chat, and log.',
        '',
        'Public key entry for release/update-manifest-keys.json (safe to commit):',
        JSON.stringify(entry, null, 2),
        '',
        `Key id: ${entry.keyId}`,
        'Next: follow docs/RELEASE.md "Update manifest signing" to upload the',
        'private key as UPDATE_MANIFEST_SIGNING_KEY in the release environment.',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`generate-update-signing-key: ${error.message}\n${USAGE}\n`);
      return 64;
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal_error';
    io.stderr(`generate-update-signing-key: failed (${code})\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
