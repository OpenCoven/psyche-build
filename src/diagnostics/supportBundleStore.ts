import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SUPPORT_BUNDLE_SCHEMA } from './supportBundle.js';

/**
 * Bundles this store wrote, and only those, match this name. Retention starts
 * from this pattern and then confirms the file's content before deleting, so a
 * file another tool happened to name this way is still not a candidate.
 */
const BUNDLE_FILENAME = /^psyche-support-\d{8}T\d{6}Z-[a-f0-9]{12}\.json$/;

/** Diagnostics must not grow without bound on a user's disk. */
export const MAX_RETAINED_BUNDLES = 10;

/** A bundle is capped at 64 KiB, so anything larger was not written by us. */
const MAX_VERIFIABLE_BUNDLE_BYTES = 256 * 1024;

export interface WrittenSupportBundle {
  path: string;
  bytes: number;
  removed: string[];
  /** Candidates retention could not delete or could not confirm as ours. */
  retentionFailures: number;
}

export function supportBundleDirectory(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'runtime', 'support-bundles');
}

export function supportBundleFilename(generatedAt: string, digest: string): string {
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `psyche-support-${stamp}-${digest.slice(0, 12)}.json`;
}

/**
 * Writes one bundle and, when retention is enabled, prunes the oldest beyond
 * {@link MAX_RETAINED_BUNDLES}.
 *
 * The file is created exclusively at `0600` under a random temporary name and
 * then renamed into place. `writeFile`'s `mode` applies only when it creates
 * the path, so writing straight to the target would inherit a pre-existing
 * file's permissions and would follow a pre-existing symlink out of this
 * directory. Exclusive creation refuses both, and `rename` replaces a symlink
 * at the destination rather than following it.
 *
 * Retention failures are counted and returned rather than thrown: losing the
 * bundle this run just collected because an old one could not be deleted would
 * defeat the command.
 */
export async function writeSupportBundleFile(
  options: {
    directory: string;
    filename: string;
    serialized: string;
    maxRetained?: number;
    /** `--out` exports a single file; it must never prune its destination. */
    retain?: boolean;
  },
): Promise<WrittenSupportBundle> {
  await mkdir(options.directory, { recursive: true });
  const filePath = path.join(options.directory, options.filename);
  const tempPath = path.join(
    options.directory,
    `.${options.filename}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tempPath, options.serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const written: WrittenSupportBundle = {
    path: filePath,
    bytes: Buffer.byteLength(options.serialized),
    removed: [],
    retentionFailures: 0,
  };
  if (options.retain === false) {
    return written;
  }

  const retained = options.maxRetained ?? MAX_RETAINED_BUNDLES;
  let entries: string[];
  try {
    entries = await readdir(options.directory);
  } catch {
    written.retentionFailures += 1;
    return written;
  }

  // Filenames lead with a sortable UTC stamp, so lexical order is age order.
  // The bundle just written is never a candidate, whatever the limit, and a
  // concurrent run's newer bundle sorts after ours and is never reached.
  const owned = entries
    .filter((entry) => entry !== options.filename && BUNDLE_FILENAME.test(entry))
    .sort();
  const keepAlongside = Math.max(0, retained - 1);
  for (const stale of owned.slice(0, Math.max(0, owned.length - keepAlongside))) {
    const stalePath = path.join(options.directory, stale);
    if (!await isSupportBundleFile(stalePath)) {
      written.retentionFailures += 1;
      continue;
    }
    try {
      await rm(stalePath);
      written.removed.push(stale);
    } catch {
      written.retentionFailures += 1;
    }
  }

  return written;
}

/**
 * Confirms a retention candidate is a bundle before deleting it. The filename
 * pattern alone cannot tell a bundle from a file a person named the same way.
 */
async function isSupportBundleFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile() || stats.size > MAX_VERIFIABLE_BUNDLE_BYTES) return false;
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return !!parsed
      && typeof parsed === 'object'
      && (parsed as { schema?: unknown }).schema === SUPPORT_BUNDLE_SCHEMA;
  } catch {
    return false;
  }
}
