export interface PtyDataBatch {
  threadId: string;
  sequence: number;
  bytes: number[];
  byteCount: number;
  enqueuedAtMicros?: number;
  emittedAtMicros?: number;
  queuedBytes?: number;
  queueDepth?: number;
}

export interface PtyClientOptions {
  threadId: string;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  write(bytes: Uint8Array, callback: () => void): void;
  visible?: boolean;
}

export interface PtyClientController {
  threadId: string;
  prepareForPtyStart(): void;
  setVisible(visible: boolean): Promise<boolean>;
  markPtyStarted(): Promise<boolean>;
  stopPtyDelivery(): void;
  dispose(): void;
}

type QueuedBatch = {
  sequence: number;
  bytes: Uint8Array;
  generation: number;
};

type ActiveBatch = QueuedBatch & {
  phase: 'writing' | 'ack';
};

type PtyClientState = PtyClientController & {
  disposed: boolean;
  deliveryStopped: boolean;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  write(bytes: Uint8Array, callback: () => void): void;
  generation: number;
  nextSequence: number;
  activeBatch: ActiveBatch | null;
  queuedBatch: QueuedBatch | null;
  visible: boolean;
  ptyStarted: boolean;
  lastVisibilitySent: boolean | null;
  visibilitySyncQueued: boolean;
  visibilitySyncForce: boolean;
  visibilitySyncPromise: Promise<boolean> | null;
  ackRetryTimer: ReturnType<typeof setTimeout> | null;
  ackRetryAttempt: number;
};

const MAX_ACCEPTED_IN_FLIGHT = 2;
const ACK_RETRY_DELAY_MS = 25;
const clients = new Map<string, PtyClientState>();

function normalizeBatchBytes(batch: PtyDataBatch): Uint8Array {
  const count = Number.isFinite(batch.byteCount) ? Math.max(0, batch.byteCount) : batch.bytes.length;
  return Uint8Array.from(batch.bytes.slice(0, count));
}

function visibilityArgs(threadId: string, visible: boolean): Record<string, unknown> {
  return {
    threadId,
    thread_id: threadId,
    visible,
  };
}

function acknowledgementArgs(threadId: string, sequence: number): Record<string, unknown> {
  return {
    threadId,
    thread_id: threadId,
    sequence,
  };
}

function totalAcceptedInFlight(state: PtyClientState): number {
  return (state.activeBatch ? 1 : 0) + (state.queuedBatch ? 1 : 0);
}

function clearAckRetry(state: PtyClientState): void {
  if (state.ackRetryTimer) {
    clearTimeout(state.ackRetryTimer);
    state.ackRetryTimer = null;
  }
  state.ackRetryAttempt = 0;
}

function drainQueuedBatch(state: PtyClientState): void {
  if (state.disposed || state.deliveryStopped || state.activeBatch || !state.queuedBatch) return;
  const queued = state.queuedBatch;
  state.queuedBatch = null;
  startWrite(state, queued);
}

function scheduleActiveBatchRetry(state: PtyClientState): void {
  if (state.disposed || state.deliveryStopped || state.ackRetryTimer || !state.activeBatch) return;
  const delay = ACK_RETRY_DELAY_MS * (state.ackRetryAttempt + 1);
  state.ackRetryAttempt += 1;
  state.ackRetryTimer = setTimeout(() => {
    state.ackRetryTimer = null;
    acknowledgeActiveBatch(state);
  }, delay);
}

function acknowledgeActiveBatch(state: PtyClientState): void {
  if (state.disposed || state.deliveryStopped || !state.activeBatch) return;
  if (state.activeBatch.phase !== 'ack') return;

  const { sequence, generation } = state.activeBatch;
  if (generation !== state.generation) {
    clearAckRetry(state);
    state.activeBatch = null;
    drainQueuedBatch(state);
    return;
  }

  void state
    .invoke('pty_ack', acknowledgementArgs(state.threadId, sequence))
    .then(() => {
      if (!state.activeBatch) return;
      if (
        state.disposed ||
        state.deliveryStopped ||
        state.activeBatch.phase !== 'ack' ||
        state.activeBatch.sequence !== sequence ||
        state.activeBatch.generation !== generation
      ) {
        return;
      }

      clearAckRetry(state);
      state.activeBatch = null;
      drainQueuedBatch(state);
    })
    .catch(() => {
      if (!state.activeBatch) return;
      if (
        state.disposed ||
        state.deliveryStopped ||
        state.activeBatch.phase !== 'ack' ||
        state.activeBatch.sequence !== sequence ||
        state.activeBatch.generation !== generation
      ) {
        return;
      }

      scheduleActiveBatchRetry(state);
    });
}

function completeActiveBatch(state: PtyClientState, sequence: number, generation: number): void {
  if (state.disposed) return;
  if (!state.activeBatch) return;
  if (state.activeBatch.sequence !== sequence || state.activeBatch.generation !== generation) return;

  clearAckRetry(state);
  if (state.deliveryStopped || generation !== state.generation) {
    state.activeBatch = null;
    drainQueuedBatch(state);
    return;
  }

  state.activeBatch.phase = 'ack';
  acknowledgeActiveBatch(state);
}

function startWrite(state: PtyClientState, batch: QueuedBatch): boolean {
  state.activeBatch = {
    ...batch,
    phase: 'writing',
  };
  try {
    state.write(batch.bytes, () => {
      completeActiveBatch(state, batch.sequence, batch.generation);
    });
    return true;
  } catch {
    clearAckRetry(state);
    state.activeBatch = null;
    state.deliveryStopped = true;
    state.queuedBatch = null;
    return false;
  }
}

async function syncVisibility(
  state: PtyClientState,
  force: boolean,
  visible: boolean,
): Promise<boolean> {
  if (state.disposed || !state.ptyStarted) return false;
  if (!force && state.lastVisibilitySent === visible) return false;
  await state.invoke('pty_set_visibility', visibilityArgs(state.threadId, visible));
  state.lastVisibilitySent = visible;
  return true;
}

function requestVisibilitySync(state: PtyClientState, force: boolean): Promise<boolean> {
  if (state.disposed) return Promise.resolve(false);
  state.visibilitySyncQueued = true;
  state.visibilitySyncForce ||= force;
  if (state.visibilitySyncPromise) return state.visibilitySyncPromise;

  const promise = (async () => {
    let synced = false;
    while (state.visibilitySyncQueued) {
      const nextForce = state.visibilitySyncForce;
      const nextVisible = state.visible;
      state.visibilitySyncQueued = false;
      state.visibilitySyncForce = false;
      synced = (await syncVisibility(state, nextForce, nextVisible)) || synced;
    }
    return synced;
  })().finally(() => {
    if (state.visibilitySyncPromise === promise) {
      state.visibilitySyncPromise = null;
    }
  });

  state.visibilitySyncPromise = promise;
  return promise;
}

function createClientState(options: PtyClientOptions): PtyClientState {
  const state: PtyClientState = {
    threadId: options.threadId,
    disposed: false,
    deliveryStopped: false,
    invoke: options.invoke,
    write: options.write,
    generation: 0,
    nextSequence: 1,
    activeBatch: null,
    queuedBatch: null,
    visible: options.visible !== false,
    ptyStarted: false,
    lastVisibilitySent: null,
    visibilitySyncQueued: false,
    visibilitySyncForce: false,
    visibilitySyncPromise: null,
    ackRetryTimer: null,
    ackRetryAttempt: 0,
    prepareForPtyStart() {
      state.generation += 1;
      state.deliveryStopped = false;
      clearAckRetry(state);
      if (state.activeBatch?.phase === 'ack') {
        state.activeBatch = null;
      }
      state.queuedBatch = null;
      state.nextSequence = 1;
      state.ptyStarted = false;
      state.lastVisibilitySent = null;
      state.visibilitySyncQueued = false;
      state.visibilitySyncForce = false;
    },
    async setVisible(visible: boolean) {
      if (state.disposed) return false;
      state.visible = visible;
      return requestVisibilitySync(state, false);
    },
    async markPtyStarted() {
      if (state.disposed) return false;
      state.deliveryStopped = false;
      state.ptyStarted = true;
      return requestVisibilitySync(state, true);
    },
    stopPtyDelivery() {
      state.deliveryStopped = true;
      clearAckRetry(state);
      state.queuedBatch = null;
    },
    dispose() {
      state.disposed = true;
      state.deliveryStopped = true;
      clearAckRetry(state);
      state.activeBatch = null;
      state.queuedBatch = null;
      if (clients.get(state.threadId) === state) clients.delete(state.threadId);
    },
  };
  return state;
}

export function createPtyClient(options: PtyClientOptions): PtyClientController {
  clients.get(options.threadId)?.dispose();
  const state = createClientState(options);
  clients.set(options.threadId, state);
  return state;
}

export function routePtyBatch(batch: PtyDataBatch): boolean {
  const state = clients.get(batch.threadId);
  if (!state || state.disposed || state.deliveryStopped) return false;
  if (batch.sequence !== state.nextSequence) return false;
  if (totalAcceptedInFlight(state) >= MAX_ACCEPTED_IN_FLIGHT) return false;

  const queued = {
    sequence: batch.sequence,
    bytes: normalizeBatchBytes(batch),
    generation: state.generation,
  };

  let accepted = false;
  if (state.activeBatch) {
    if (state.queuedBatch) return false;
    state.queuedBatch = queued;
    accepted = true;
  } else {
    accepted = startWrite(state, queued);
  }

  if (!accepted) return false;
  state.nextSequence += 1;
  return true;
}

export function disposePtyClient(threadId: string): boolean {
  const state = clients.get(threadId);
  if (!state) return false;
  state.dispose();
  return true;
}
