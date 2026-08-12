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
};

type PtyClientState = PtyClientController & {
  disposed: boolean;
  deliveryStopped: boolean;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  write(bytes: Uint8Array, callback: () => void): void;
  nextSequence: number;
  activeBatch: QueuedBatch | null;
  queuedBatch: QueuedBatch | null;
  visible: boolean;
  ptyStarted: boolean;
  lastVisibilitySent: boolean | null;
};

const MAX_ACCEPTED_IN_FLIGHT = 2;
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

function drainQueuedBatch(state: PtyClientState): void {
  if (state.disposed || state.deliveryStopped || state.activeBatch || !state.queuedBatch) return;
  const queued = state.queuedBatch;
  state.queuedBatch = null;
  startWrite(state, queued);
}

function completeActiveBatch(state: PtyClientState, sequence: number): void {
  if (state.disposed || state.deliveryStopped) return;
  if (!state.activeBatch || state.activeBatch.sequence !== sequence) return;

  state.activeBatch = null;
  void state.invoke('pty_ack', acknowledgementArgs(state.threadId, sequence)).catch(() => {});
  drainQueuedBatch(state);
}

function startWrite(state: PtyClientState, batch: QueuedBatch): boolean {
  state.activeBatch = batch;
  try {
    state.write(batch.bytes, () => {
      completeActiveBatch(state, batch.sequence);
    });
    return true;
  } catch {
    state.activeBatch = null;
    state.deliveryStopped = true;
    state.queuedBatch = null;
    return false;
  }
}

async function syncVisibility(
  state: PtyClientState,
  force: boolean,
): Promise<boolean> {
  if (state.disposed || !state.ptyStarted) return false;
  if (!force && state.lastVisibilitySent === state.visible) return false;
  await state.invoke('pty_set_visibility', visibilityArgs(state.threadId, state.visible));
  state.lastVisibilitySent = state.visible;
  return true;
}

function createClientState(options: PtyClientOptions): PtyClientState {
  const state: PtyClientState = {
    threadId: options.threadId,
    disposed: false,
    deliveryStopped: false,
    invoke: options.invoke,
    write: options.write,
    nextSequence: 1,
    activeBatch: null,
    queuedBatch: null,
    visible: options.visible !== false,
    ptyStarted: false,
    lastVisibilitySent: null,
    prepareForPtyStart() {
      state.deliveryStopped = false;
      state.activeBatch = null;
      state.queuedBatch = null;
      state.nextSequence = 1;
      state.ptyStarted = false;
      state.lastVisibilitySent = null;
    },
    async setVisible(visible: boolean) {
      if (state.disposed) return false;
      if (state.visible === visible) return false;
      state.visible = visible;
      return syncVisibility(state, false);
    },
    async markPtyStarted() {
      if (state.disposed) return false;
      state.deliveryStopped = false;
      state.ptyStarted = true;
      return syncVisibility(state, true);
    },
    stopPtyDelivery() {
      state.deliveryStopped = true;
      state.queuedBatch = null;
    },
    dispose() {
      state.disposed = true;
      state.deliveryStopped = true;
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
