import { AGENT_CONTROL_LIMITS } from '../limits.js';

interface PaneOutputChunk {
  readonly sequence: number;
  data: Buffer;
}

interface PaneOutputState {
  sequence: number;
  bytes: number;
  droppedThroughSequence: number;
  readonly chunks: PaneOutputChunk[];
}

export interface PaneObservationReadOptions {
  readonly afterSequence?: number;
}

export interface PaneObservation {
  readonly paneId: string;
  readonly fromSequence: number;
  readonly nextSequence: number;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export class PaneObservationStore {
  private readonly panes = new Map<string, PaneOutputState>();

  append(paneId: string, data: Buffer): number {
    const state = this.stateFor(paneId);
    if (data.length === 0) return state.sequence;

    const sequence = state.sequence + 1;
    state.sequence = sequence;
    const bounded = data.length > AGENT_CONTROL_LIMITS.paneOutputBytes
      ? dropIncompleteUtf8Prefix(data.subarray(data.length - AGENT_CONTROL_LIMITS.paneOutputBytes))
      : data;
    if (bounded.length !== data.length) state.droppedThroughSequence = sequence;
    const chunk = Buffer.from(bounded);
    state.chunks.push({ sequence, data: chunk });
    state.bytes += chunk.length;

    while (
      state.chunks.length > AGENT_CONTROL_LIMITS.paneOutputChunks
      || state.bytes > AGENT_CONTROL_LIMITS.paneOutputBytes
    ) {
      const removed = state.chunks.shift();
      if (!removed) break;
      state.bytes -= removed.data.length;
      state.droppedThroughSequence = Math.max(state.droppedThroughSequence, removed.sequence);
      const carry = incompleteUtf8Suffix([removed]);
      const next = state.chunks[0];
      if (next && completesUtf8Suffix(carry, next.data)) {
        next.data = Buffer.concat([carry, next.data]);
        state.bytes += carry.length;
      }
    }
    return sequence;
  }

  read(paneId: string, options: PaneObservationReadOptions = {}): PaneObservation {
    const state = this.panes.get(paneId);
    if (!state) {
      return { paneId, fromSequence: 0, nextSequence: 0, text: '', bytes: 0, truncated: false };
    }
    const requestedAfter = normalizeSequence(options.afterSequence);
    const chunks = state.chunks.filter((chunk) => chunk.sequence > requestedAfter);
    const carry = incompleteUtf8Suffix(state.chunks.filter(
      (chunk) => chunk.sequence <= requestedAfter,
    ));
    const data = completeUtf8Bytes(Buffer.concat([
      carry,
      ...chunks.map((chunk) => chunk.data),
    ]));
    return {
      paneId,
      fromSequence: chunks[0]?.sequence ?? state.sequence,
      nextSequence: state.sequence,
      text: data.toString('utf8'),
      bytes: data.length,
      truncated: requestedAfter < state.droppedThroughSequence,
    };
  }

  clear(paneId: string): void {
    this.panes.delete(paneId);
  }

  private stateFor(paneId: string): PaneOutputState {
    const existing = this.panes.get(paneId);
    if (existing) return existing;
    const created: PaneOutputState = {
      sequence: 0,
      bytes: 0,
      droppedThroughSequence: 0,
      chunks: [],
    };
    this.panes.set(paneId, created);
    return created;
  }
}

function normalizeSequence(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function completeUtf8Bytes(data: Buffer): Buffer {
  return dropIncompleteUtf8Prefix(data.subarray(0, completeUtf8PrefixLength(data)));
}

function dropIncompleteUtf8Prefix(data: Buffer): Buffer {
  let start = 0;
  while (start < data.length && isContinuationByte(data[start]!)) start += 1;
  return data.subarray(start);
}

function completeUtf8PrefixLength(data: Buffer): number {
  if (data.length === 0) return 0;
  let lead = data.length - 1;
  while (lead > 0 && isContinuationByte(data[lead]!)) lead -= 1;
  return utf8SequenceBytes(data[lead]!) > data.length - lead ? lead : data.length;
}

function incompleteUtf8Suffix(chunks: readonly PaneOutputChunk[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  const tail = Buffer.concat(chunks.slice(-4).map((chunk) => chunk.data)).subarray(-4);
  for (let offset = Math.max(0, tail.length - 4); offset < tail.length; offset += 1) {
    const expected = utf8SequenceBytes(tail[offset]!);
    if (expected > 1 && tail.length - offset < expected) return tail.subarray(offset);
  }
  return Buffer.alloc(0);
}

function completesUtf8Suffix(suffix: Buffer, next: Buffer): boolean {
  if (suffix.length === 0) return false;
  const missing = utf8SequenceBytes(suffix[0]!) - suffix.length;
  if (missing <= 0 || next.length < missing) return false;
  return next.subarray(0, missing).every(isContinuationByte);
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8SequenceBytes(value: number): number {
  if ((value & 0x80) === 0) return 1;
  if ((value & 0xe0) === 0xc0) return 2;
  if ((value & 0xf0) === 0xe0) return 3;
  if ((value & 0xf8) === 0xf0) return 4;
  return 1;
}
