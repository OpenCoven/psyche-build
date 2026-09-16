import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Bundles this store wrote, and only those, match this name. Retention deletes
 * by this pattern alone, so an operator's own notes saved beside them — or any
 * file another tool owns — is never a retention candidate.
 */
const BUNDLE_FILENAME = /^psyche-support-\d{8}T\d{6}Z-[a-f0-9]{12}\.json$/;

/** Diagnostics must not grow without bound on a user's disk. */
export const MAX_RETAINED_BUNDLES = 10;

export interface WrittenSupportBundle {
  path: string;
  bytes: number;
  removed: string[];
}

export function supportBundleDirectory(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'runtime', 'support-bundles');
}

export function supportBundleFilename(generatedAt: string, digest: string): string {
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `psyche-support-${stamp}-${digest.slice(0, 12)}.json`;
}

/**
 * Writes one bundle and prunes the oldest beyond {@link MAX_RETAINED_BUNDLES}.
 *
 * The file is written 0600: a bundle is redacted, not public, and it lands in a
 * project directory that may be shared. Retention failures are reported rather
 * than thrown — losing the bundle that was just collected because an old one
 * could not be deleted would defeat the point of collecting it.
 */
export async function writeSupportBundleFile(
  options: {
    directory: string;
    filename: string;
    serialized: string;
    maxRetained?: number;
  },
): Promise<WrittenSupportBundle> {
  const retained = options.maxRetained ?? MAX_RETAINED_BUNDLES;
  await mkdir(options.directory, { recursive: true });
  const filePath = path.join(options.directory, options.filename);
  await writeFile(filePath, options.serialized, { encoding: 'utf8', mode: 0o600 });

  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(options.directory);
  } catch {
    return { path: filePath, bytes: Buffer.byteLength(options.serialized), removed };
  }
  // Filenames lead with a sortable UTC stamp, so lexical order is age order.
  // The bundle just written is never a pruning candidate, whatever the limit:
  // discarding the evidence this run collected would defeat the command.
  const owned = entries
    .filter((entry) => entry !== options.filename && BUNDLE_FILENAME.test(entry))
    .sort();
  const keepAlongside = Math.max(0, retained - 1);
  for (const stale of owned.slice(0, Math.max(0, owned.length - keepAlongside))) {
    try {
      await rm(path.join(options.directory, stale));
      removed.push(stale);
    } catch {
      // A bundle that cannot be pruned is left in place; the new one still landed.
    }
  }

  return { path: filePath, bytes: Buffer.byteLength(options.serialized), removed };
}
