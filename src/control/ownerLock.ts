import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface OwnerRecord {
  pid: number;
  nonce: string;
  epoch: number;
  acquiredAt: string;
}

export interface OwnerLock {
  epoch: number;
  nonce: string;
  release: () => Promise<void>;
}

export interface OwnerLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export async function acquireOwnerLock(
  projectRoot: string,
  options: OwnerLockOptions = {},
): Promise<OwnerLock> {
  const runtimeDir = path.join(projectRoot, '.psyche', 'runtime');
  const lockDir = path.join(runtimeDir, 'owner.lock');
  const recordPath = path.join(lockDir, 'owner.json');
  const epochPath = path.join(runtimeDir, 'owner-epoch.json');
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const processStartedAt = options.processStartedAt;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await mkdir(runtimeDir, { recursive: true });
  const nonce = randomUUID();

  const isReusedPid = (previous: OwnerRecord): boolean => {
    if (!processStartedAt) return false;
    const startedAt = processStartedAt(previous.pid);
    if (typeof startedAt !== 'number') return false;
    const acquiredAt = Date.parse(previous.acquiredAt);
    if (Number.isNaN(acquiredAt)) return false;
    return startedAt > acquiredAt;
  };

  while (true) {
    const candidateDir = path.join(runtimeDir, `owner.candidate.${nonce}`);
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, 'owner.json'), JSON.stringify({
      pid,
      nonce,
      epoch: 0,
      acquiredAt: new Date().toISOString(),
    }));
    try {
      await rename(candidateDir, lockDir);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await sleep(10);
        continue;
      }
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await rm(candidateDir, { recursive: true, force: true });
      const previous = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      if (isProcessAlive(previous.pid) && !isReusedPid(previous)) {
        throw new Error(`psyche control plane already owned by pid ${previous.pid}`);
      }
      const quarantine = path.join(runtimeDir, `owner.stale.${randomUUID()}`);
      try {
        await rename(lockDir, quarantine);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true, force: true });
      await sleep(10);
    }
  }

  let epoch: number;
  try {
    epoch = await nextEpoch(epochPath);
    const record: OwnerRecord = {
      pid,
      nonce,
      epoch,
      acquiredAt: new Date().toISOString(),
    };
    const recordTemp = path.join(lockDir, `owner.${nonce}.tmp`);
    const handle = await open(recordTemp, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(recordTemp, recordPath);
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true });
    throw error;
  }

  await reapOrphans(runtimeDir, nonce);

  return {
    epoch,
    nonce,
    release: async () => {
      let current: OwnerRecord;
      try {
        current = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (current.nonce === nonce) await rm(lockDir, { recursive: true, force: true });
    },
  };
}

async function nextEpoch(epochPath: string): Promise<number> {
  let epoch = 0;
  try {
    epoch = (JSON.parse(await readFile(epochPath, 'utf8')) as { epoch: number }).epoch;
  } catch {
    epoch = 0;
  }
  const next = epoch + 1;
  const temporary = `${epochPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ epoch: next })}\n`, 'utf8');
  await rename(temporary, epochPath);
  return next;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reapOrphans(runtimeDir: string, ownNonce: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runtimeDir);
  } catch {
    return;
  }
  const ownCandidate = `owner.candidate.${ownNonce}`;
  await Promise.all(entries
    .filter((entry) =>
      (entry.startsWith('owner.candidate.') || entry.startsWith('owner.stale.'))
      && entry !== ownCandidate)
    .map((entry) => rm(path.join(runtimeDir, entry), { recursive: true, force: true })));
}
