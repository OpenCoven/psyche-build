import PQueue from 'p-queue';

export type PanesConfigWriteLock = <T>(
  operation: () => Promise<T>
) => Promise<T>;

const configQueue = new PQueue({ concurrency: 1 });

export const withPanesConfigWriteLock: PanesConfigWriteLock = (operation) =>
  configQueue.add(operation);
