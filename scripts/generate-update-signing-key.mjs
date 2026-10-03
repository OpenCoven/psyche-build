#!/usr/bin/env node

// Creates an Ed25519 key pair for signing update manifests. The OWNER runs
// this locally; CI never does. See docs/RELEASE.md "Update manifest signing".
//
// The private key is written as a PKCS#8 PEM to --out, created with mode 0600,
// refusing to overwrite an existing file and refusing any location inside a
// Git working tree (so it cannot be committed by accident). The private key is
// never printed. Only the public key entry for release/update-manifest-keys.json
// is printed.

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { publicKeyEntryFromPrivatePem } from './update-manifest.mjs';

const USAGE = `usage: generate-update-signing-key.mjs --out <path-outside-any-git-checkout>`;

class UsageError extends Error {}

function hasGitSegment(filePath) {
  return filePath.split(path.sep).includes('.git');
}

// Git-independent backstop: any ancestor holding a `.git` file or directory
// means the target is inside (or beside the metadata of) a checkout.
function ancestorHasGitMarker(directory) {
  let current = directory;
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// Asks Git itself, with every GIT_* variable removed so GIT_DIR,
// GIT_CEILING_DIRECTORIES, GIT_WORK_TREE and friends cannot redirect the
// answer. Only Git's own "not a git repository" verdict counts as outside;
// every other outcome (Git missing, dubious ownership, a .git directory, any
// unexpected status) fails closed.
function assertGitSaysOutside(directory, env) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new UsageError('Git is unavailable, so the output location cannot be proven to be outside a Git checkout');
  }
  if (result.status === 128 && /not a git repository/i.test(result.stderr ?? '')) return;
  if (result.status === 0) {
    throw new UsageError('Refusing to write a private key inside a Git working tree or Git directory');
  }
  throw new UsageError('Git could not confirm the output location is outside a Git checkout; refusing');
}

function assertOutsideGit(target, directory, env) {
  if (hasGitSegment(target) || hasGitSegment(directory)) {
    throw new UsageError('Refusing to write a private key inside a .git directory');
  }
  if (ancestorHasGitMarker(directory)) {
    throw new UsageError('Refusing to write a private key inside a Git working tree');
  }
  assertGitSaysOutside(directory, env);
}

const defaultFileOps = { openSync, fchmodSync, writeSync, fstatSync, closeSync, unlinkSync };

// Writes every byte, looping over short writes; a write that makes no
// progress is an error rather than a silent truncation.
function writeFully(fileOps, descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileOps.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw Object.assign(new Error('Private key write made no progress'), { code: 'ESHORTWRITE' });
    }
    offset += written;
  }
  return offset;
}

/**
 * Generates a key pair, writes the private PEM to `outPath` with mode 0600,
 * and returns only the public entry `{ keyId, publicKey }`. Any failure after
 * the file is created removes it, so no partial key is ever left behind.
 * `fileOps` exists only so tests can inject write failures.
 */
export function generateSigningKey(outPath, { env = process.env, fileOps: overrides = {} } = {}) {
  const fileOps = { ...defaultFileOps, ...overrides };
  const target = path.resolve(outPath);
  const directory = path.dirname(target);
  if (!existsSync(directory)) throw new UsageError('The output directory does not exist');
  const realDirectory = realpathSync(directory);
  assertOutsideGit(path.join(realDirectory, path.basename(target)), realDirectory, env);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  // Derive the public entry before touching the disk, so nothing that can
  // fail remains once the key file exists.
  const entry = publicKeyEntryFromPrivatePem(pem);
  const bytes = Buffer.from(pem, 'utf8');
  // 'wx' refuses to follow or replace an existing path, and the mode applies
  // at creation so the key is never readable by anyone else, even briefly.
  const descriptor = fileOps.openSync(target, 'wx', 0o600);
  let failure;
  try {
    fileOps.fchmodSync(descriptor, 0o600);
    if (writeFully(fileOps, descriptor, bytes) !== bytes.length) {
      throw Object.assign(new Error('Private key was only partially written'), { code: 'ESHORTWRITE' });
    }
    const stat = fileOps.fstatSync(descriptor);
    if ((stat.mode & 0o777) !== 0o600) {
      throw Object.assign(new Error('Private key file mode is not 0600'), { code: 'EKEYMODE' });
    }
    if (stat.size !== bytes.length) {
      throw Object.assign(new Error('Private key file size does not match'), { code: 'ESHORTWRITE' });
    }
  } catch (error) {
    failure = error;
  }
  try {
    fileOps.closeSync(descriptor);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    // Never leave a truncated or unverified key behind for someone to upload.
    try {
      fileOps.unlinkSync(target);
    } catch {
      throw Object.assign(new Error('Key generation failed and the partial key file could not be removed'), {
        code: 'EKEYCLEANUP',
      });
    }
    throw failure;
  }
  return entry;
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
