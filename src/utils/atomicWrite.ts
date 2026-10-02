import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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
 */
export interface AtomicWriteOptions {
  /** Mode for the newly created file. Defaults to 0o666 before umask. */
  mode?: number;
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

/**
 * Atomically writes content to a file using write-and-rename pattern
 * This prevents readers from seeing partial/incomplete data
 *
 * @param filePath - The target file path
 * @param content - The content to write
 */
export function atomicWriteFileSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  const tempPath = temporaryPathFor(filePath);
  const buffer = Buffer.from(content, 'utf-8');
  let fd: number | undefined;
  let created = false;

  try {
    fd = openSync(tempPath, 'wx', options.mode ?? 0o666);
    created = true;
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
    renameSync(tempPath, filePath);
    created = false;
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
  const tempPath = temporaryPathFor(filePath);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    handle = await open(tempPath, 'wx', options.mode ?? 0o666);
    created = true;
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
    await rename(tempPath, filePath);
    created = false;
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
