import { createHash } from 'node:crypto';
import type { PromptEnvelope } from './types.js';

export type PromptDispatchOutcome =
  | { status: 'dispatched'; promptId: string }
  | { status: 'confirmed'; promptId: string; receiptId: string }
  | { status: 'failed'; promptId: string; code: string; message: string }
  | { status: 'unknown'; promptId: string; code: string; message: string };

export class PromptDispatcher {
  constructor(
    private readonly send: (envelope: PromptEnvelope) => Promise<{ receiptId?: string } | void>,
  ) {}

  async dispatch(envelope: PromptEnvelope): Promise<PromptDispatchOutcome> {
    const hash = createHash('sha256').update(envelope.utf8).digest('hex');
    if (hash !== envelope.contentHash) {
      return {
        status: 'failed',
        promptId: envelope.promptId,
        code: 'prompt_hash_mismatch',
        message: 'prompt content does not match its declared hash',
      };
    }
    try {
      const result = await this.send(envelope);
      return result?.receiptId
        ? { status: 'confirmed', promptId: envelope.promptId, receiptId: result.receiptId }
        : { status: 'dispatched', promptId: envelope.promptId };
    } catch (error) {
      const ambiguous = (error as { ambiguous?: boolean }).ambiguous === true;
      return {
        status: ambiguous ? 'unknown' : 'failed',
        promptId: envelope.promptId,
        code: ambiguous ? 'prompt_dispatch_ambiguous' : 'prompt_dispatch_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
