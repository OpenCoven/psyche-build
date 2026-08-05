import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await mkdir(runtimeDir, { recursive: true });
  const nonce = randomUUID();

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
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await rm(candidateDir, { recursive: true });
      const previous = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      if (isProcessAlive(previous.pid)) {
        throw new Error(`psyche control plane already owned by pid ${previous.pid}`);
      }
      const quarantine = path.join(runtimeDir, `owner.stale.${randomUUID()}`);
      try {
        await rename(lockDir, quarantine);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true });
      await sleep(10);
    }
  }

  const epoch = await nextEpoch(epochPath);
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

  return {
    epoch,
    nonce,
    release: async () => {
      const current = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      if (current.nonce === nonce) await rm(lockDir, { recursive: true });
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
