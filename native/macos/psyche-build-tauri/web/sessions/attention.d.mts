export type AttentionReason = 'question' | 'turn';

export interface AttentionState {
  needsAttention: boolean;
  reason: AttentionReason | null;
}

export interface AttentionTracker {
  observe(id: string, tail: string, now: number): AttentionState;
  bell(id: string): AttentionState;
  userInput(id: string): AttentionState;
  interrupt(id: string): AttentionState;
  clear(id: string): AttentionState;
  state(id: string): AttentionState;
  forget(id: string): void;
  retain(ids: string[]): void;
}

export const DEFAULT_SETTLE_MS: number;

export function hasWorkingIndicators(text: string): boolean;
export function looksLikeQuestion(text: string): boolean;
export function classifySettledTail(
  text: string,
): AttentionReason | 'working';
export function createAttentionTracker(options?: {
  settleMs?: number;
}): AttentionTracker;
export function attentionLabel(reason?: AttentionReason | null): string;
