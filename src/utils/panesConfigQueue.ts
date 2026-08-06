import PQueue from 'p-queue';
import fs from 'fs/promises';

export type PanesConfigWriteLock = <T>(
  operation: () => Promise<T>
) => Promise<T>;

export type PanesConfigFileWriteLock = <T>(
  configPath: string,
  operation: () => Promise<T>
) => Promise<T>;

const configQueue = new PQueue({ concurrency: 1 });
const MAX_CONFIG_FILE_LOCK_AGE_MS = 60_000;

export const withPanesConfigWriteLock: PanesConfigWriteLock = (operation) =>
  configQueue.add(operation);

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lockOwnerExited(lockPath: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as { pid?: unknown };
    return typeof lock.pid === 'number' && !isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

async function acquireConfigFileLock(configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${configPath}.lock`;
  const recoveryLockPath = `${lockPath}.recovery`;
  const deadline = Date.now() + 10_000;

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error: unknown) {
      if (
        !error
        || typeof error !== 'object'
        || !('code' in error)
        || error.code !== 'EEXIST'
      ) {
        throw error;
      }
      try {
        const lockStat = await fs.stat(lockPath);
        const ownerExited = await lockOwnerExited(lockPath);
        if (ownerExited || Date.now() - lockStat.mtimeMs > MAX_CONFIG_FILE_LOCK_AGE_MS) {
          let recoveryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            recoveryHandle = await fs.open(recoveryLockPath, 'wx');
            await recoveryHandle.close();
            const latestLockStat = await fs.stat(lockPath);
            if (
              await lockOwnerExited(lockPath)
              || Date.now() - latestLockStat.mtimeMs > MAX_CONFIG_FILE_LOCK_AGE_MS
            ) {
              await fs.unlink(lockPath).catch(() => undefined);
            }
          } catch (recoveryError: unknown) {
            if (
              recoveryError
              && typeof recoveryError === 'object'
              && 'code' in recoveryError
              && recoveryError.code !== 'EEXIST'
            ) {
              throw recoveryError;
            }
            try {
              const recoveryLockStat = await fs.stat(recoveryLockPath);
              if (Date.now() - recoveryLockStat.mtimeMs > MAX_CONFIG_FILE_LOCK_AGE_MS) {
                await fs.unlink(recoveryLockPath).catch(() => undefined);
              }
            } catch {
              // Another recovery process released the marker; retry acquisition.
            }
          } finally {
            if (recoveryHandle) {
              await fs.unlink(recoveryLockPath).catch(() => undefined);
            }
          }
          continue;
        }
      } catch {
        // The lock was released between open and stat; retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for pane config lock: ${configPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export const withPanesConfigFileWriteLock: PanesConfigFileWriteLock = (
  configPath,
  operation
) => withPanesConfigWriteLock(async () => {
  const release = await acquireConfigFileLock(configPath);
  try {
    return await operation();
  } finally {
    await release();
  }
});
