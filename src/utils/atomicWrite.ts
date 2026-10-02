import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomic replacement for persisted state.
 *
 * The content goes to an exclusively created temporary file in the target's
 * directory, is flushed with fsync, and only then renamed over the target. A
 * failure at any step — including a volume that fills mid-write (ENOSPC,
 * EDQUOT) or one that only reports the shortage at fsync — leaves the previous
 * file byte-for-byte intact, removes the partial temporary file, and rethrows
 * the original error so the caller can never report the write as saved.
 *
 * The fsync matters: without it a rename can publish a file whose data the
 * filesystem has not yet allocated, and a full disk discovered at writeback
 * would then have replaced good state with a truncated file.
 *
 * After the rename the parent directory is fsynced, best effort, so the new
 * directory entry is durable too. Platforms that refuse a directory fsync are
 * tolerated: a crash there can at worst revert to the previous file, which is
 * still whole. On macOS, fsync does not force the drive's write cache to
 * stable media; F_FULLFSYNC is not used here, so a power loss (not a process
 * crash) can still lose the most recent write there.
 */
export interface AtomicWriteOptions {
  /**
   * Mode for the new file. When omitted, an existing regular file's
   * permission bits (masked to 0o777) are kept, so a 0600 file stays 0600; a
   * new file gets 0o666 before umask.
   */
  mode?: number;
  /**
   * Replace the file a symlink points at instead of the symlink itself, so a
   * user's linked config (a dotfiles checkout, say) stays linked. The temp file
   * is written beside the resolved target, keeping the rename on one
   * filesystem. A dangling link creates the file it names; a loop raises ELOOP.
   *
   * `true` is for files under the user's own home. A file inside a project,
   * which a cloned repository controls, must pass `{ within: projectRoot }`:
   * a link resolving outside that root is refused, so a committed link cannot
   * aim the write at an arbitrary user file. Leave unset for Psyche-private
   * state such as tokens and the owner epoch, where a planted link must never
   * be followed.
   */
  followSymlinks?: boolean | { within: string };
}

/**
 * Source-level fault injection for the recovery harness. A full volume cannot
 * be produced portably, so the harness installs a fault that writes the first
 * `afterBytes` bytes of a matching temporary file for real and then fails with
 * the errno a full volume returns. Nothing in the product installs one.
 */
export interface AtomicWriteFault {
  readonly code: 'ENOSPC' | 'EDQUOT';
  readonly afterBytes: number;
  matches(targetPath: string): boolean;
  /** Incremented each time the fault fires, so a harness can prove it landed. */
  landed: number;
}

let recoveryHarnessFault: AtomicWriteFault | undefined;

export function setAtomicWriteFaultForRecoveryHarness(fault: AtomicWriteFault | undefined): void {
  recoveryHarnessFault = fault;
}

function temporaryPathFor(filePath: string): string {
  // Same directory, so the rename never crosses a filesystem.
  const dir = path.dirname(filePath);
  const tempSuffix = randomBytes(8).toString('hex');
  return path.join(dir, `.${path.basename(filePath)}.${tempSuffix}.tmp`);
}

/** Bytes the injected fault lets through, or undefined when no fault applies. */
function injectedAllowance(targetPath: string, length: number): number | undefined {
  const fault = recoveryHarnessFault;
  if (!fault || !fault.matches(targetPath)) return undefined;
  return Math.max(0, Math.min(length, fault.afterBytes));
}

function injectedFaultError(targetPath: string, tempPath: string): NodeJS.ErrnoException {
  const fault = recoveryHarnessFault!;
  fault.landed += 1;
  const error = new Error(`${fault.code}: injected full storage, write '${tempPath}'`) as NodeJS.ErrnoException;
  error.code = fault.code;
  error.syscall = 'write';
  error.path = targetPath;
  return error;
}

const PERMISSION_BITS = 0o777;
/** Symlink hops followed before giving up with ELOOP, matching common SYMLOOP_MAX. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Raised when `followSymlinks.within` is set and the link resolves outside
 * that root. The message names no path; a repository could otherwise use a
 * committed link to make Psyche overwrite any file the user can write.
 */
export class AtomicWriteOutsideRootError extends Error {
  readonly code = 'ATOMIC_WRITE_OUTSIDE_ROOT';

  constructor() {
    super('refusing to write through a symlink that resolves outside its allowed root');
    this.name = 'AtomicWriteOutsideRootError';
  }
}

function errnoError(code: string, syscall: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${syscall} '${filePath}'`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = syscall;
  error.path = filePath;
  return error;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Follows a symlink chain hop by hop. A dangling link resolves to the missing
 * file it names, so the write creates it there, as a plain write would. A
 * chain longer than {@link MAX_SYMLINK_HOPS} (a loop) raises ELOOP rather than
 * quietly replacing the link with a regular file.
 */
function followLinkChain(filePath: string): string {
  let current = path.resolve(filePath);
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return current;
      throw error;
    }
    if (!isLink) return current;
    current = path.resolve(path.dirname(current), readlinkSync(current));
  }
  throw errnoError('ELOOP', 'open', filePath);
}

/** Canonical form of a path whose last component may not exist yet. */
function canonicalize(target: string): string {
  try {
    return realpathSync(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return path.join(realpathSync(path.dirname(target)), path.basename(target));
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where the write lands and which permission bits it keeps.
 *
 * Without `followSymlinks`, the target path itself is replaced; a symlink
 * there is replaced, never followed, and it lends no mode (only an existing
 * regular file's bits are kept). With it, the chain is followed to the real
 * file, optionally confined to `within`.
 */
function resolveWriteTarget(
  filePath: string,
  options: AtomicWriteOptions,
): { targetPath: string; mode: number | undefined } {
  let targetPath = filePath;
  if (options.followSymlinks) {
    targetPath = followLinkChain(filePath);
    const within = typeof options.followSymlinks === 'object' ? options.followSymlinks.within : undefined;
    // Checked on the canonical path, so a symlinked parent directory cannot
    // carry the write out of the root either.
    if (within !== undefined && !isWithin(canonicalize(within), canonicalize(targetPath))) {
      throw new AtomicWriteOutsideRootError();
    }
  }
  if (options.mode !== undefined) return { targetPath, mode: options.mode };
  try {
    const existing = lstatSync(targetPath);
    return { targetPath, mode: existing.isFile() ? existing.mode & PERMISSION_BITS : undefined };
  } catch {
    return { targetPath, mode: undefined };
  }
}

/**
 * Makes the rename's directory entry durable where the platform allows it.
 * The new file is already published when this runs, so a refusal here must not
 * be reported as a failed write.
 */
function syncDirectoryBestEffortSync(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // EISDIR/EINVAL/EPERM on platforms that refuse a directory fsync.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to report.
      }
    }
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // EISDIR/EINVAL/EPERM on platforms that refuse a directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Atomically writes content to a file using write-and-rename pattern
 * This prevents readers from seeing partial/incomplete data
 *
 * @param filePath - The target file path
 * @param content - The content to write
 */
export function atomicWriteFileSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  const { targetPath, mode } = resolveWriteTarget(filePath, options);
  const tempPath = temporaryPathFor(targetPath);
  const buffer = Buffer.from(content, 'utf-8');
  let fd: number | undefined;
  let created = false;

  try {
    // Created no wider than the intended mode, then set exactly, since umask
    // applies at creation. A new file with no requested mode keeps umask.
    fd = openSync(tempPath, 'wx', mode ?? 0o666);
    created = true;
    if (mode !== undefined) fchmodSync(fd, mode);
    const allowed = injectedAllowance(filePath, buffer.length);
    const limit = allowed ?? buffer.length;
    let offset = 0;
    while (offset < limit) {
      offset += writeSync(fd, buffer, offset, limit - offset);
    }
    if (allowed !== undefined && allowed < buffer.length) {
      throw injectedFaultError(filePath, tempPath);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // On POSIX systems, rename() is atomic and will replace the target
    renameSync(tempPath, targetPath);
    created = false;
    syncDirectoryBestEffortSync(path.dirname(targetPath));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write error is the one to report.
      }
    }
    if (created) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Atomically writes content to a file using write-and-rename pattern (async)
 * This prevents readers from seeing partial/incomplete data
 *
 * @param filePath - The target file path
 * @param content - The content to write
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { targetPath, mode } = resolveWriteTarget(filePath, options);
  const tempPath = temporaryPathFor(targetPath);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    // Created no wider than the intended mode, then set exactly, since umask
    // applies at creation. A new file with no requested mode keeps umask.
    handle = await open(tempPath, 'wx', mode ?? 0o666);
    created = true;
    if (mode !== undefined) await handle.chmod(mode);
    const buffer = Buffer.from(content, 'utf-8');
    const allowed = injectedAllowance(filePath, buffer.length);
    if (allowed === undefined) {
      await handle.writeFile(buffer);
    } else {
      if (allowed > 0) await handle.writeFile(buffer.subarray(0, allowed));
      if (allowed < buffer.length) throw injectedFaultError(filePath, tempPath);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    // On POSIX systems, rename() is atomic and will replace the target
    await rename(tempPath, targetPath);
    created = false;
    await syncDirectoryBestEffort(path.dirname(targetPath));
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (created) {
      await unlink(tempPath).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Atomically writes a JSON object to a file (sync)
 *
 * @param filePath - The target file path
 * @param data - The data to serialize and write
 * @param pretty - Whether to pretty-print the JSON (default: true)
 */
export function atomicWriteJsonSync(filePath: string, data: any, pretty: boolean = true): void {
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  atomicWriteFileSync(filePath, content);
}

/**
 * Atomically writes a JSON object to a file (async)
 *
 * @param filePath - The target file path
 * @param data - The data to serialize and write
 * @param pretty - Whether to pretty-print the JSON (default: true)
 */
export async function atomicWriteJson(filePath: string, data: any, pretty: boolean = true): Promise<void> {
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await atomicWriteFile(filePath, content);
}
