/**
 * Deterministic full-storage fault injection at the fs boundary.
 *
 * A real full volume cannot be produced portably in CI, so a test installs a
 * fault here and mocks `node:fs/promises` (and, for synchronous writers,
 * `node:fs`) with the wrappers below. Matching writes then put the first
 * `afterBytes` bytes on disk for real — a genuinely partial file — and throw an
 * `ENOSPC` or `EDQUOT` errno error, exactly as a volume that fills mid-write
 * does. `at: 'sync'` instead fails the fsync, which is where delayed-allocation
 * and network filesystems report a full disk.
 *
 * This module must not import `fs` itself: the mock factories hand it the real
 * module, and importing the mocked one here would recurse.
 *
 * Usage in a test file:
 *
 *   vi.mock('node:fs/promises', async (importOriginal) =>
 *     (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));
 */

export type StorageFaultCode = 'ENOSPC' | 'EDQUOT';

export interface StorageFaultSpec {
  code: StorageFaultCode;
  /** Bytes a matching write may put on disk before the fault fires. */
  afterBytes?: number;
  /** `write` fails mid-write; `sync` fails the fsync after a full write. */
  at?: 'write' | 'sync';
  /** Which paths the fault applies to. Defaults to every path. */
  match?: (filePath: string) => boolean;
}

interface ActiveFault extends Required<Omit<StorageFaultSpec, 'match'>> {
  match: (filePath: string) => boolean;
  bytesWritten: number;
  landed: number;
}

const state: { fault?: ActiveFault } = {};

export interface InstalledStorageFault {
  /** How many times the fault fired. Zero means the injection did not land. */
  readonly landed: number;
  /** Bytes matching writes really put on disk before the fault. */
  readonly bytesWritten: number;
  remove(): void;
}

export function injectStorageFault(spec: StorageFaultSpec): InstalledStorageFault {
  const fault: ActiveFault = {
    code: spec.code,
    afterBytes: spec.afterBytes ?? 0,
    at: spec.at ?? 'write',
    match: spec.match ?? (() => true),
    bytesWritten: 0,
    landed: 0,
  };
  state.fault = fault;
  return {
    get landed() {
      return fault.landed;
    },
    get bytesWritten() {
      return fault.bytesWritten;
    },
    remove() {
      if (state.fault === fault) state.fault = undefined;
    },
  };
}

export function clearStorageFaults(): void {
  state.fault = undefined;
}

export function storageFaultError(code: StorageFaultCode, syscall: string, filePath: string): NodeJS.ErrnoException {
  const message = code === 'ENOSPC' ? 'no space left on device' : 'disk quota exceeded';
  const error = new Error(`${code}: ${message}, ${syscall} '${filePath}'`) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = code === 'ENOSPC' ? -28 : -69;
  error.syscall = syscall;
  error.path = filePath;
  return error;
}

function activeFaultFor(filePath: string): ActiveFault | undefined {
  const fault = state.fault;
  return fault && fault.match(filePath) ? fault : undefined;
}

function toBuffer(data: unknown, encoding?: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const enc = typeof encoding === 'string'
    ? encoding
    : (encoding && typeof encoding === 'object' && 'encoding' in encoding
      ? (encoding as { encoding?: BufferEncoding }).encoding
      : undefined);
  return Buffer.from(String(data), (enc as BufferEncoding | undefined) ?? 'utf8');
}

/** How many of `length` bytes may land before the fault fires (`length` means all). */
function allowance(fault: ActiveFault, length: number): number {
  if (fault.at !== 'write') return length;
  return Math.max(0, Math.min(length, fault.afterBytes - fault.bytesWritten));
}

type FsPromises = typeof import('node:fs/promises');
type FileHandle = import('node:fs/promises').FileHandle;

function wrapHandle(handle: FileHandle, filePath: string): FileHandle {
  const writeFile = async (data: unknown, options?: unknown): Promise<void> => {
    const fault = activeFaultFor(filePath);
    if (!fault) return handle.writeFile(data as string, options as BufferEncoding);
    const buffer = toBuffer(data, options);
    const allowed = allowance(fault, buffer.length);
    let offset = 0;
    while (offset < allowed) {
      const { bytesWritten } = await handle.write(buffer, offset, allowed - offset);
      offset += bytesWritten;
    }
    fault.bytesWritten += allowed;
    if (allowed < buffer.length) {
      fault.landed += 1;
      throw storageFaultError(fault.code, 'write', filePath);
    }
  };
  const write = async (data: unknown, ...rest: unknown[]): Promise<unknown> => {
    const fault = activeFaultFor(filePath);
    if (!fault || fault.at !== 'write') return (handle.write as (...args: unknown[]) => Promise<unknown>)(data, ...rest);
    const buffer = toBuffer(data);
    const offset = typeof rest[0] === 'number' ? rest[0] : 0;
    const length = typeof rest[1] === 'number' ? rest[1] : buffer.length - offset;
    const allowed = allowance(fault, length);
    if (allowed > 0) await handle.write(buffer, offset, allowed);
    fault.bytesWritten += allowed;
    if (allowed < length) {
      fault.landed += 1;
      throw storageFaultError(fault.code, 'write', filePath);
    }
    return { bytesWritten: allowed, buffer };
  };
  const sync = async (): Promise<void> => {
    const fault = activeFaultFor(filePath);
    if (fault && fault.at === 'sync') {
      fault.landed += 1;
      throw storageFaultError(fault.code, 'fsync', filePath);
    }
    return handle.sync();
  };
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'writeFile') return writeFile;
      if (property === 'appendFile') return writeFile;
      if (property === 'write') return write;
      if (property === 'sync' || property === 'datasync') return sync;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A `node:fs/promises` whose matching writes fail as a full volume would. */
export function faultyFsPromises(actual: FsPromises): FsPromises {
  const open = (async (filePath: unknown, flags?: unknown, mode?: unknown) => {
    const handle = await actual.open(filePath as string, flags as string, mode as number);
    return wrapHandle(handle, String(filePath));
  }) as FsPromises['open'];

  const writeOrAppend = (defaultFlag: string) => async (
    filePath: unknown,
    data: unknown,
    options?: unknown,
  ): Promise<void> => {
    const target = String(filePath);
    if (!activeFaultFor(target)) {
      const fn = defaultFlag === 'a' ? actual.appendFile : actual.writeFile;
      return fn(filePath as string, data as string, options as BufferEncoding);
    }
    const flag = options && typeof options === 'object' && 'flag' in options
      ? String((options as { flag?: string }).flag ?? defaultFlag)
      : defaultFlag;
    const mode = options && typeof options === 'object' && 'mode' in options
      ? (options as { mode?: number }).mode
      : undefined;
    const handle = await open(target, flag, mode);
    try {
      await handle.writeFile(toBuffer(data, options));
    } finally {
      await handle.close();
    }
  };

  const wrapped = {
    ...actual,
    open,
    writeFile: writeOrAppend('w') as FsPromises['writeFile'],
    appendFile: writeOrAppend('a') as FsPromises['appendFile'],
  };
  return { ...wrapped, default: wrapped } as unknown as FsPromises;
}

type Fs = typeof import('node:fs');

/** A `node:fs` whose matching `writeSync`/`fsyncSync` calls fail as a full volume would. */
export function faultyFs(actual: Fs): Fs {
  const paths = new Map<number, string>();
  const openSync = ((filePath: unknown, ...rest: unknown[]) => {
    const fd = (actual.openSync as (...args: unknown[]) => number)(filePath, ...rest);
    paths.set(fd, String(filePath));
    return fd;
  }) as Fs['openSync'];
  const closeSync = ((fd: number) => {
    paths.delete(fd);
    actual.closeSync(fd);
  }) as Fs['closeSync'];
  const writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    const filePath = paths.get(fd);
    const fault = filePath ? activeFaultFor(filePath) : undefined;
    if (!fault || fault.at !== 'write' || typeof data === 'string') {
      return (actual.writeSync as (...args: unknown[]) => number)(fd, data, ...rest);
    }
    const buffer = toBuffer(data);
    const offset = typeof rest[0] === 'number' ? rest[0] : 0;
    const length = typeof rest[1] === 'number' ? rest[1] : buffer.length - offset;
    const allowed = allowance(fault, length);
    if (allowed > 0) actual.writeSync(fd, buffer, offset, allowed);
    fault.bytesWritten += allowed;
    if (allowed < length) {
      fault.landed += 1;
      throw storageFaultError(fault.code, 'write', filePath!);
    }
    return allowed;
  }) as Fs['writeSync'];
  const fsyncSync = ((fd: number) => {
    const filePath = paths.get(fd);
    const fault = filePath ? activeFaultFor(filePath) : undefined;
    if (fault && fault.at === 'sync') {
      fault.landed += 1;
      throw storageFaultError(fault.code, 'fsync', filePath!);
    }
    actual.fsyncSync(fd);
  }) as Fs['fsyncSync'];

  const wrapped = { ...actual, openSync, closeSync, writeSync, fsyncSync };
  return { ...wrapped, default: wrapped } as unknown as Fs;
}

/** Entries in `directory` that look like leftover temporary files. */
export function temporaryLeftovers(entries: readonly string[]): string[] {
  return entries.filter((entry) => /\.tmp$/.test(entry));
}
