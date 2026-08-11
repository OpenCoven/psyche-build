import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PromptDispatcher } from '../src/control/promptDispatch.js';

function envelope() {
  const utf8 = 'Continue with the failing test';
  return {
    promptId: 'prompt-1',
    paneId: '%3',
    harness: 'codex',
    utf8,
    contentHash: createHash('sha256').update(utf8).digest('hex'),
    submitMode: 'text-and-enter' as const,
    leaseRevision: 2,
  };
}

describe('PromptDispatcher', () => {
  it('dispatches a valid prompt once per runtime invocation', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new PromptDispatcher(send);
    expect(await dispatcher.dispatch(envelope())).toMatchObject({
      status: 'dispatched',
      promptId: 'prompt-1',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('marks a dispatch unknown when tmux acceptance is ambiguous', async () => {
    const dispatcher = new PromptDispatcher(async () => {
      throw Object.assign(new Error('socket closed'), { ambiguous: true });
    });
    expect(await dispatcher.dispatch(envelope())).toMatchObject({
      status: 'unknown',
      code: 'prompt_dispatch_ambiguous',
    });
  });

  it('fails a dispatch whose content hash does not match', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new PromptDispatcher(send);
    const tampered = { ...envelope(), contentHash: 'deadbeef' };
    expect(await dispatcher.dispatch(tampered)).toMatchObject({
      status: 'failed',
      code: 'prompt_hash_mismatch',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves to a failed outcome instead of throwing when envelope.utf8 is not a string', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new PromptDispatcher(send);
    const malformed = { ...envelope(), utf8: undefined as never };
    await expect(dispatcher.dispatch(malformed)).resolves.toMatchObject({
      status: 'failed',
      code: 'prompt_envelope_invalid',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves to a failed outcome instead of throwing when send rejects with undefined', async () => {
    const dispatcher = new PromptDispatcher(async () => {
      throw undefined;
    });
    await expect(dispatcher.dispatch(envelope())).resolves.toMatchObject({
      status: 'failed',
      code: 'prompt_dispatch_failed',
    });
  });

  it('confirms a dispatch when send resolves with a receiptId', async () => {
    const dispatcher = new PromptDispatcher(async () => ({ receiptId: 'receipt-9' }));
    expect(await dispatcher.dispatch(envelope())).toEqual({
      status: 'confirmed',
      promptId: 'prompt-1',
      receiptId: 'receipt-9',
    });
  });

  it('fails a dispatch when send throws a plain error', async () => {
    const dispatcher = new PromptDispatcher(async () => {
      throw new Error('boom');
    });
    expect(await dispatcher.dispatch(envelope())).toMatchObject({
      status: 'failed',
      code: 'prompt_dispatch_failed',
      message: 'boom',
    });
  });
});
