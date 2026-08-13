import { AGENT_CONTROL_LIMITS } from '../limits.js';
import type { PaneObservationResult } from '../types.js';

interface OutputChunk {
  readonly sequence: number;
  data: Buffer;
}

interface PaneOutputState {
  chunks: OutputChunk[];
  bytes: number;
  nextSequence: number;
  headPartial: boolean;
}

export interface PaneObservationStoreOptions {
  initialSequence?: number;
  maxChunks?: number;
  maxBytes?: number;
}

export class PaneObservationStore {
  private readonly panes = new Map<string, PaneOutputState>();
  private readonly initialSequence: number;
  private readonly maxChunks: number;
  private readonly maxBytes: number;

  constructor(options: PaneObservationStoreOptions = {}) {
    const initialSequence = options.initialSequence ?? 1;
    const maxChunks = options.maxChunks ?? AGENT_CONTROL_LIMITS.paneOutputChunks;
    const maxBytes = options.maxBytes ?? AGENT_CONTROL_LIMITS.paneOutputBytes;
    if (
      !Number.isSafeInteger(initialSequence) || initialSequence < 1 || initialSequence >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > AGENT_CONTROL_LIMITS.paneOutputChunks
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > AGENT_CONTROL_LIMITS.paneOutputBytes
    ) {
      throw Object.assign(new Error('pane observation options are invalid'), {
        code: 'invalid_observation_options',
      });
    }
    this.initialSequence = initialSequence;
    this.maxChunks = maxChunks;
    this.maxBytes = maxBytes;
  }

  append(paneId: string, source: Buffer): number {
    const state = this.panes.get(paneId) ?? {
      chunks: [], bytes: 0, nextSequence: this.initialSequence, headPartial: false,
    };
    if (state.nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new Error('pane output sequence is exhausted'), { code: 'sequence_exhausted' });
    }
    const sequence = state.nextSequence;
    state.nextSequence += 1;
    const data = Buffer.from(source);
    state.chunks.push({ sequence, data });
    state.bytes += data.length;

    while (state.chunks.length > this.maxChunks) {
      const removed = state.chunks.shift()!;
      state.bytes -= removed.data.length;
      state.headPartial = false;
    }
    while (state.bytes > this.maxBytes && state.chunks.length > 0) {
      const excess = state.bytes - this.maxBytes;
      const head = state.chunks[0];
      if (head.data.length <= excess) {
        state.chunks.shift();
        state.bytes -= head.data.length;
        state.headPartial = false;
      } else {
        head.data = Buffer.from(head.data.subarray(excess));
        state.bytes -= excess;
        state.headPartial = true;
      }
    }
    this.panes.set(paneId, state);
    return sequence;
  }

  read(paneId: string, options: { afterSequence?: number } = {}): PaneObservationResult {
    const afterSequence = options.afterSequence ?? 0;
    assertCursor(afterSequence);
    const state = this.panes.get(paneId);
    if (!state) return emptyObservation(paneId, afterSequence);

    const selected = state.chunks.filter((chunk) => chunk.sequence > afterSequence);
    if (selected.length === 0) return emptyObservation(paneId, afterSequence);
    const first = state.chunks[0];
    const truncated = afterSequence < first.sequence - 1
      || (state.headPartial && afterSequence < first.sequence);
    const availableBytes = selected.reduce((total, chunk) => total + chunk.data.length, 0);
    const available = Buffer.concat(selected.map((chunk) => chunk.data), availableBytes);
    const decoded = decodeValidUtf8(available);
    let cumulativeBytes = 0;
    let consumedChunks = 0;
    for (const chunk of selected) {
      cumulativeBytes += chunk.data.length;
      if (cumulativeBytes <= decoded.consumableBytes) consumedChunks += 1;
    }
    if (consumedChunks === 0) {
      return Object.freeze({
        paneId,
        fromSequence: afterSequence + 1,
        nextSequence: afterSequence + 1,
        text: '',
        bytes: 0,
        truncated,
      });
    }
    const consumed = selected.slice(0, consumedChunks);
    const bytes = consumed.reduce((total, chunk) => total + chunk.data.length, 0);
    const raw = Buffer.concat(consumed.map((chunk) => chunk.data), bytes);
    return Object.freeze({
      paneId,
      fromSequence: consumed[0].sequence,
      nextSequence: consumed[consumed.length - 1].sequence + 1,
      text: decodeValidUtf8(raw).text,
      bytes,
      truncated,
    });
  }

  reset(paneId: string): void {
    this.panes.delete(paneId);
  }

  remove(paneId: string): void {
    this.panes.delete(paneId);
  }

  sequence(paneId: string): number {
    return (this.panes.get(paneId)?.nextSequence ?? this.initialSequence) - 1;
  }
}

function assertCursor(value: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error('afterSequence must be a finite nonnegative safe integer'), {
      code: 'invalid_cursor',
    });
  }
}

function emptyObservation(paneId: string, afterSequence: number): PaneObservationResult {
  return Object.freeze({
    paneId, fromSequence: afterSequence + 1, nextSequence: afterSequence + 1,
    text: '', bytes: 0, truncated: false,
  });
}

/** Decode complete valid UTF-8 only; malformed or eviction-cut bytes are omitted. */
function decodeValidUtf8(input: Buffer): { text: string; consumableBytes: number } {
  const valid: number[] = [];
  let consumableBytes = input.length;
  for (let i = 0; i < input.length;) {
    const first = input[i];
    let width = 0;
    if (first <= 0x7f) width = 1;
    else if (first >= 0xc2 && first <= 0xdf) width = 2;
    else if (first >= 0xe0 && first <= 0xef) width = 3;
    else if (first >= 0xf0 && first <= 0xf4) width = 4;
    if (width > 0 && i + width > input.length) {
      consumableBytes = i;
      break;
    }
    if (width === 0) {
      i += 1;
      continue;
    }
    const second = input[i + 1];
    const continuations = Array.from(input.subarray(i + 1, i + width));
    const validContinuation = continuations.every((byte) => byte >= 0x80 && byte <= 0xbf);
    const validRange = width < 3
      || (first !== 0xe0 || second >= 0xa0)
        && (first !== 0xed || second <= 0x9f)
        && (first !== 0xf0 || second >= 0x90)
        && (first !== 0xf4 || second <= 0x8f);
    if (!validContinuation || !validRange) {
      i += 1;
      continue;
    }
    for (let offset = 0; offset < width; offset += 1) valid.push(input[i + offset]);
    i += width;
  }
  return { text: Buffer.from(valid).toString('utf8'), consumableBytes };
}
