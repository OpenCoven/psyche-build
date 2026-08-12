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
  prepareForPtyStart(): number;
  restoreAfterFailedPtyStart(startAttemptId?: number): void;
  adoptRunningPty(startAttemptId?: number): Promise<boolean>;
  setVisible(visible: boolean): Promise<boolean>;
  markPtyStarted(startAttemptId?: number): Promise<boolean>;
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

type QuarantinedBatch = {
  sequence: number;
  bytes: Uint8Array;
};

type StartQuarantine = {
  nextSequence: number;
  batches: QuarantinedBatch[];
};

type WriteGate = object;

type DeliveryLane = {
  generation: number;
  nextSequence: number;
  activeBatch: ActiveBatch | null;
  queuedBatch: QueuedBatch | null;
  ackRetryTimer: ReturnType<typeof setTimeout> | null;
  ackRetryAttempt: number;
  closed: boolean;
  routable: boolean;
};

type PtyClientState = PtyClientController & {
  disposed: boolean;
  deliveryStopped: boolean;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  write(bytes: Uint8Array, callback: () => void): void;
  delivery: DeliveryLane;
  checkpointDelivery: DeliveryLane | null;
  writeGate: WriteGate | null;
  startQuarantine: StartQuarantine | null;
  visible: boolean;
  ptyStarted: boolean;
  lastVisibilitySent: boolean | null;
  visibilitySyncQueued: boolean;
  visibilitySyncForce: boolean;
  visibilitySyncPromise: Promise<boolean> | null;
  visibilitySyncRestartScheduled: boolean;
  visibilitySyncRevision: number;
  nextStartAttempt: number;
  pendingStartAttempt: number | null;
  pendingStartPtyStarted: boolean | null;
  pendingStartLastVisibilitySent: boolean | null;
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

function createDeliveryLane(generation: number): DeliveryLane {
  return {
    generation,
    nextSequence: 1,
    activeBatch: null,
    queuedBatch: null,
    ackRetryTimer: null,
    ackRetryAttempt: 0,
    closed: false,
    routable: true,
  };
}

function totalAcceptedInFlight(lane: DeliveryLane): number {
  return (lane.activeBatch ? 1 : 0) + (lane.queuedBatch ? 1 : 0);
}

function availableRetainedBatchSlots(state: PtyClientState, lane: DeliveryLane): number {
  if (lane.queuedBatch) return 0;
  if (lane.activeBatch) return 1;
  return state.writeGate ? 1 : MAX_ACCEPTED_IN_FLIGHT;
}

function clearStartQuarantine(state: PtyClientState): void {
  state.startQuarantine = null;
}

function takeStartQuarantine(state: PtyClientState): QuarantinedBatch[] {
  const batches = state.startQuarantine?.batches ?? [];
  state.startQuarantine = null;
  return batches;
}

function clearAckRetry(lane: DeliveryLane): void {
  if (lane.ackRetryTimer) {
    clearTimeout(lane.ackRetryTimer);
    lane.ackRetryTimer = null;
  }
  lane.ackRetryAttempt = 0;
}

function resetVisibilitySyncState(
  state: PtyClientState,
  ptyStarted: boolean,
  lastVisibilitySent: boolean | null,
): void {
  state.ptyStarted = ptyStarted;
  state.lastVisibilitySent = lastVisibilitySent;
  state.visibilitySyncQueued = false;
  state.visibilitySyncForce = false;
  state.visibilitySyncPromise = null;
  state.visibilitySyncRestartScheduled = false;
  state.visibilitySyncRevision += 1;
}

function hasWritingBatch(state: PtyClientState): boolean {
  return state.writeGate != null;
}

function closeDeliveryLane(lane: DeliveryLane): void {
  lane.routable = false;
  lane.closed = true;
  clearAckRetry(lane);
  lane.queuedBatch = null;
  lane.activeBatch = null;
}

function drainQueuedBatch(state: PtyClientState, lane: DeliveryLane): void {
  if (
    state.disposed ||
    state.deliveryStopped ||
    lane.closed ||
    lane.activeBatch ||
    !lane.queuedBatch ||
    hasWritingBatch(state)
  ) {
    return;
  }
  const queued = lane.queuedBatch;
  lane.queuedBatch = null;
  startWrite(state, lane, queued);
}

function drainAnyQueuedBatch(state: PtyClientState): void {
  if (state.disposed || state.deliveryStopped || hasWritingBatch(state)) return;
  drainQueuedBatch(state, state.delivery);
  if (!hasWritingBatch(state) && state.checkpointDelivery) {
    drainQueuedBatch(state, state.checkpointDelivery);
  }
}

function scheduleActiveBatchRetry(state: PtyClientState, lane: DeliveryLane): void {
  if (
    state.disposed ||
    state.deliveryStopped ||
    lane.closed ||
    lane.ackRetryTimer ||
    !lane.activeBatch ||
    (lane === state.checkpointDelivery && state.pendingStartAttempt != null)
  ) {
    return;
  }
  const delay = ACK_RETRY_DELAY_MS * (lane.ackRetryAttempt + 1);
  lane.ackRetryAttempt += 1;
  lane.ackRetryTimer = setTimeout(() => {
    lane.ackRetryTimer = null;
    acknowledgeActiveBatch(state, lane);
  }, delay);
}

function acknowledgeActiveBatch(state: PtyClientState, lane: DeliveryLane): void {
  if (state.disposed || state.deliveryStopped || lane.closed || !lane.activeBatch) return;
  if (lane.activeBatch.phase !== 'ack') return;

  const { sequence, generation } = lane.activeBatch;
  if (generation !== lane.generation) {
    clearAckRetry(lane);
    lane.activeBatch = null;
    drainAnyQueuedBatch(state);
    return;
  }

  void state
    .invoke('pty_ack', acknowledgementArgs(state.threadId, sequence))
    .then(() => {
      if (!lane.activeBatch) return;
      if (
        state.disposed ||
        state.deliveryStopped ||
        lane.closed ||
        lane.activeBatch.phase !== 'ack' ||
        lane.activeBatch.sequence !== sequence ||
        lane.activeBatch.generation !== generation
      ) {
        return;
      }
      clearAckRetry(lane);
      lane.activeBatch = null;
      drainAnyQueuedBatch(state);
    })
    .catch(() => {
      if (!lane.activeBatch) return;
      if (
        state.disposed ||
        state.deliveryStopped ||
        lane.closed ||
        lane.activeBatch.phase !== 'ack' ||
        lane.activeBatch.sequence !== sequence ||
        lane.activeBatch.generation !== generation
      ) {
        return;
      }

      if (lane === state.checkpointDelivery && state.pendingStartAttempt != null) {
        return;
      }

      scheduleActiveBatchRetry(state, lane);
    });
}

function completeActiveBatch(
  state: PtyClientState,
  lane: DeliveryLane,
  sequence: number,
  generation: number,
  writeGate: WriteGate,
): void {
  if (state.writeGate !== writeGate) return;
  state.writeGate = null;
  if (state.disposed) return;
  if (
    !lane.activeBatch ||
    lane.activeBatch.sequence !== sequence ||
    lane.activeBatch.generation !== generation
  ) {
    drainAnyQueuedBatch(state);
    return;
  }

  clearAckRetry(lane);
  if (state.deliveryStopped || lane.closed || generation !== lane.generation) {
    lane.activeBatch = null;
    drainAnyQueuedBatch(state);
    return;
  }

  lane.activeBatch.phase = 'ack';
  if (lane === state.checkpointDelivery && state.pendingStartAttempt != null) {
    drainAnyQueuedBatch(state);
    return;
  }
  acknowledgeActiveBatch(state, lane);
}

function clearAllQueuedBatches(state: PtyClientState): void {
  state.delivery.queuedBatch = null;
  if (state.checkpointDelivery) state.checkpointDelivery.queuedBatch = null;
  clearStartQuarantine(state);
}

function startWrite(state: PtyClientState, lane: DeliveryLane, batch: QueuedBatch): boolean {
  if (state.writeGate) return false;
  lane.activeBatch = {
    ...batch,
    phase: 'writing',
  };
  const writeGate: WriteGate = {};
  const { sequence, generation } = batch;
  state.writeGate = writeGate;
  try {
    state.write(batch.bytes, () => {
      completeActiveBatch(state, lane, sequence, generation, writeGate);
    });
    return true;
  } catch {
    if (state.writeGate === writeGate) state.writeGate = null;
    clearAckRetry(lane);
    lane.activeBatch = null;
    state.deliveryStopped = true;
    clearAllQueuedBatches(state);
    return false;
  }
}

function acceptBatchForLane(
  state: PtyClientState,
  lane: DeliveryLane,
  batch: QuarantinedBatch,
): boolean {
  if (
    state.disposed ||
    state.deliveryStopped ||
    lane.closed ||
    !lane.routable ||
    batch.sequence !== lane.nextSequence ||
    totalAcceptedInFlight(lane) >= MAX_ACCEPTED_IN_FLIGHT
  ) {
    return false;
  }

  const queued: QueuedBatch = {
    ...batch,
    generation: lane.generation,
  };

  let accepted = false;
  if (lane.activeBatch || hasWritingBatch(state)) {
    if (lane.queuedBatch) return false;
    lane.queuedBatch = queued;
    accepted = true;
  } else {
    accepted = startWrite(state, lane, queued);
  }

  if (!accepted) return false;
  lane.nextSequence += 1;
  return true;
}

function quarantinePendingStartBatch(
  state: PtyClientState,
  batch: PtyDataBatch,
): boolean | null {
  const checkpoint = state.checkpointDelivery;
  if (
    state.pendingStartAttempt == null ||
    !checkpoint ||
    checkpoint.closed ||
    !checkpoint.routable
  ) {
    return null;
  }

  let quarantine = state.startQuarantine;
  if (!quarantine) {
    if (
      batch.sequence !== state.delivery.nextSequence ||
      batch.sequence !== checkpoint.nextSequence
    ) {
      return null;
    }
    quarantine = {
      nextSequence: batch.sequence,
      batches: [],
    };
    state.startQuarantine = quarantine;
  }

  if (batch.sequence !== quarantine.nextSequence) return false;
  if (quarantine.batches.length >= MAX_ACCEPTED_IN_FLIGHT) return false;
  if (
    quarantine.batches.length >= availableRetainedBatchSlots(state, state.delivery) ||
    quarantine.batches.length >= availableRetainedBatchSlots(state, checkpoint)
  ) {
    return false;
  }

  quarantine.batches.push({
    sequence: batch.sequence,
    bytes: normalizeBatchBytes(batch),
  });
  quarantine.nextSequence += 1;
  return true;
}

function feedQuarantinedBatches(
  state: PtyClientState,
  lane: DeliveryLane,
  batches: QuarantinedBatch[],
): void {
  for (const batch of batches) {
    if (!acceptBatchForLane(state, lane, batch)) return;
  }
}

async function syncVisibility(
  state: PtyClientState,
  force: boolean,
  visible: boolean,
  revision: number,
): Promise<boolean> {
  if (state.disposed || !state.ptyStarted) return false;
  if (!force && state.lastVisibilitySent === visible) return false;
  await state.invoke('pty_set_visibility', visibilityArgs(state.threadId, visible));
  if (state.disposed || state.visibilitySyncRevision !== revision || !state.ptyStarted) return false;
  state.lastVisibilitySent = visible;
  return true;
}

function requestVisibilitySync(state: PtyClientState, force: boolean): Promise<boolean> {
  if (state.disposed) return Promise.resolve(false);
  state.visibilitySyncQueued = true;
  state.visibilitySyncForce ||= force;
  if (state.visibilitySyncPromise) return state.visibilitySyncPromise;

  const revision = state.visibilitySyncRevision;
  const promise = (async () => {
    let synced = false;
    while (state.visibilitySyncQueued) {
      const nextForce = state.visibilitySyncForce;
      const nextVisible = state.visible;
      state.visibilitySyncQueued = false;
      state.visibilitySyncForce = false;
      try {
        synced = (await syncVisibility(state, nextForce, nextVisible, revision)) || synced;
      } catch (error) {
        if (state.visibilitySyncRevision === revision && state.visibilitySyncQueued) {
          state.visibilitySyncRestartScheduled = true;
        }
        throw error;
      }
      if (state.visibilitySyncRevision !== revision) break;
    }
    return synced;
  })().finally(() => {
    if (state.visibilitySyncPromise === promise) {
      state.visibilitySyncPromise = null;
    }
    if (state.visibilitySyncRestartScheduled) {
      state.visibilitySyncRestartScheduled = false;
      if (!state.disposed && state.visibilitySyncQueued && !state.visibilitySyncPromise) {
        void requestVisibilitySync(state, false).catch(() => {});
      }
    }
  });

  state.visibilitySyncPromise = promise;
  return promise;
}

function restorePreparedPtyStart(state: PtyClientState, startAttemptId?: number): boolean {
  if (state.pendingStartAttempt == null) return false;
  if (startAttemptId != null && startAttemptId !== state.pendingStartAttempt) return false;
  const quarantine = takeStartQuarantine(state);
  closeDeliveryLane(state.delivery);
  if (state.checkpointDelivery) {
    state.delivery = state.checkpointDelivery;
    state.delivery.closed = false;
    state.delivery.routable = true;
  }
  state.checkpointDelivery = null;

  resetVisibilitySyncState(
    state,
    Boolean(state.pendingStartPtyStarted),
    state.pendingStartLastVisibilitySent ?? null,
  );
  state.pendingStartAttempt = null;
  state.pendingStartPtyStarted = null;
  state.pendingStartLastVisibilitySent = null;
  feedQuarantinedBatches(state, state.delivery, quarantine);
  if (state.delivery.activeBatch?.phase === 'ack') {
    acknowledgeActiveBatch(state, state.delivery);
  } else {
    drainAnyQueuedBatch(state);
  }
  return true;
}

function commitPreparedPtyStart(
  state: PtyClientState,
  startAttemptId?: number,
): QuarantinedBatch[] | null {
  if (state.pendingStartAttempt == null) return startAttemptId == null ? [] : null;
  if (startAttemptId != null && startAttemptId !== state.pendingStartAttempt) return null;

  const quarantine = takeStartQuarantine(state);
  if (state.checkpointDelivery) {
    closeDeliveryLane(state.checkpointDelivery);
    state.checkpointDelivery = null;
  }
  state.pendingStartAttempt = null;
  state.pendingStartPtyStarted = null;
  state.pendingStartLastVisibilitySent = null;
  return quarantine;
}

function createClientState(options: PtyClientOptions): PtyClientState {
  const state: PtyClientState = {
    threadId: options.threadId,
    disposed: false,
    deliveryStopped: false,
    invoke: options.invoke,
    write: options.write,
    delivery: createDeliveryLane(0),
    checkpointDelivery: null,
    writeGate: null,
    startQuarantine: null,
    visible: options.visible !== false,
    ptyStarted: false,
    lastVisibilitySent: null,
    visibilitySyncQueued: false,
    visibilitySyncForce: false,
    visibilitySyncPromise: null,
    visibilitySyncRestartScheduled: false,
    visibilitySyncRevision: 0,
    nextStartAttempt: 0,
    pendingStartAttempt: null,
    pendingStartPtyStarted: null,
    pendingStartLastVisibilitySent: null,
    prepareForPtyStart() {
      clearStartQuarantine(state);
      state.nextStartAttempt += 1;
      state.pendingStartAttempt = state.nextStartAttempt;
      state.pendingStartPtyStarted = state.ptyStarted;
      state.pendingStartLastVisibilitySent = state.lastVisibilitySent;
      if (state.checkpointDelivery) closeDeliveryLane(state.checkpointDelivery);
      state.checkpointDelivery = state.delivery;
      state.checkpointDelivery.closed = false;
      state.checkpointDelivery.routable = true;
      clearAckRetry(state.checkpointDelivery);
      state.delivery = createDeliveryLane(state.checkpointDelivery.generation + 1);
      state.deliveryStopped = false;
      resetVisibilitySyncState(state, false, null);
      return state.pendingStartAttempt;
    },
    restoreAfterFailedPtyStart(startAttemptId) {
      restorePreparedPtyStart(state, startAttemptId);
    },
    async adoptRunningPty(startAttemptId) {
      if (state.disposed) return false;
      state.deliveryStopped = false;
      restorePreparedPtyStart(state, startAttemptId);
      state.ptyStarted = true;
      return requestVisibilitySync(state, true);
    },
    async setVisible(visible: boolean) {
      if (state.disposed) return false;
      state.visible = visible;
      return requestVisibilitySync(state, false);
    },
    async markPtyStarted(startAttemptId) {
      if (state.disposed) return false;
      const quarantine = commitPreparedPtyStart(state, startAttemptId);
      if (!quarantine) return false;
      state.deliveryStopped = false;
      state.ptyStarted = true;
      feedQuarantinedBatches(state, state.delivery, quarantine);
      return requestVisibilitySync(state, true);
    },
    stopPtyDelivery() {
      state.deliveryStopped = true;
      clearStartQuarantine(state);
      clearAckRetry(state.delivery);
      state.delivery.queuedBatch = null;
      if (state.checkpointDelivery) {
        clearAckRetry(state.checkpointDelivery);
        state.checkpointDelivery.queuedBatch = null;
      }
    },
    dispose() {
      state.disposed = true;
      state.deliveryStopped = true;
      clearStartQuarantine(state);
      closeDeliveryLane(state.delivery);
      if (state.checkpointDelivery) {
        closeDeliveryLane(state.checkpointDelivery);
      }
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

  const quarantined = quarantinePendingStartBatch(state, batch);
  if (quarantined != null) return quarantined;

  const targetLane =
    batch.sequence === state.delivery.nextSequence
      ? state.delivery
      : state.checkpointDelivery &&
          state.checkpointDelivery.routable &&
          batch.sequence === state.checkpointDelivery.nextSequence
        ? state.checkpointDelivery
        : null;
  if (!targetLane) return false;
  return acceptBatchForLane(state, targetLane, {
    sequence: batch.sequence,
    bytes: normalizeBatchBytes(batch),
  });
}

export function disposePtyClient(threadId: string): boolean {
  const state = clients.get(threadId);
  if (!state) return false;
  state.dispose();
  return true;
}
