import {
  createEditorMachine,
  type EditorDocumentPort,
  type EditorInput,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it, vi } from 'vitest';

class BoundsDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];
  readonly edits: Parameters<EditorDocumentPort['apply']>[0][] = [];
  failNextApply = false;

  constructor(text: string, cursor = 0) {
    this.value = text;
    this.ranges = [{ anchor: cursor, head: cursor }];
  }

  text(): string {
    return this.value;
  }

  selections(): readonly { anchor: number; head: number }[] {
    return this.ranges;
  }

  apply(edit: Parameters<EditorDocumentPort['apply']>[0]): void {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('adapter apply failed');
    }
    for (const change of [...edit.changes].reverse()) {
      this.value = `${this.value.slice(0, change.from)}${change.insert}${this.value.slice(change.to)}`;
    }
    this.ranges = edit.selections.map((selection) => ({ ...selection }));
    this.edits.push(edit);
  }

  async command(): Promise<boolean> {
    return true;
  }
}

async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

const keys = (value: string): EditorInput[] => [...value];

describe('Vim editor count and replay bounds', () => {
  it('accepts the exact 10,000 count edge for motions', async () => {
    const document = new BoundsDocument('x'.repeat(10_001));
    const machine = createEditorMachine(document);

    const result = await send(machine, ...keys('10000l'));

    expect(document.ranges[0]).toEqual({ anchor: 10_000, head: 10_000 });
    expect(result.count).toBeUndefined();
    expect(machine.limits).toMatchObject({ count: 10_000, countDigits: 5 });
  });

  it('reports and resets a count as soon as it exceeds 10,000', async () => {
    const machine = createEditorMachine(new BoundsDocument('abc'));

    const result = await send(machine, ...keys('10001'));

    expect(result.actions).toContainEqual({
      type: 'status',
      level: 'error',
      message: 'Count exceeds limit (10000)',
    });
    expect(result.count).toBeUndefined();
    expect(result.pending).toBe('');
  });

  it('never converts a huge digit stream to Infinity or throws during counted macro playback', async () => {
    const document = new BoundsDocument('x'.repeat(20_000));
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'l');

    let result = machine.snapshot();
    for (const digit of '9'.repeat(309)) result = await machine.handle(digit);
    expect(result.count === undefined || result.count <= machine.limits.count).toBe(true);

    await expect(send(machine, '@', 'a')).resolves.toBeDefined();
  });

  it('plays an exact-edge counted macro lazily', async () => {
    const document = new BoundsDocument('x'.repeat(10_001));
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'l');

    const result = await send(machine, ...keys('10000@a'));

    expect(document.ranges[0]).toEqual({ anchor: 10_000, head: 10_000 });
    expect(result.actions).not.toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('reuses grapheme segmentation across exact-edge counted motion and macro work', async () => {
    const originalSegment = Intl.Segmenter.prototype.segment;
    let segmentationPasses = 0;
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function boundedSegment(
      this: Intl.Segmenter,
      text: string,
    ) {
      segmentationPasses += 1;
      if (segmentationPasses > 4) throw new Error('full-document segmentation budget exceeded');
      return originalSegment.call(this, text);
    });
    try {
      const motionDocument = new BoundsDocument('x'.repeat(10_001));
      await send(createEditorMachine(motionDocument), ...keys('10000l'));

      const macroDocument = new BoundsDocument('x'.repeat(10_001));
      const macro = createEditorMachine(macroDocument);
      macro.setRegister('a', 'l');
      await send(macro, ...keys('10000@a'));

      expect(motionDocument.ranges[0]?.head).toBe(10_000);
      expect(macroDocument.ranges[0]?.head).toBe(10_000);

      const changedDocument = new BoundsDocument('ab');
      const changed = createEditorMachine(changedDocument);
      await send(changed, 'l', 'i', 'X', 'Escape', '0', 'l');
      expect(changedDocument.value).toBe('aXb');
      expect(changedDocument.ranges[0]?.head).toBe(1);
      expect(segmentationPasses).toBeLessThanOrEqual(4);
    } finally {
      segment.mockRestore();
    }
  });

  it('reuses and invalidates one grapheme index across counted word-motion macros', async () => {
    const originalSegment = Intl.Segmenter.prototype.segment;
    let segmentationPasses = 0;
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function boundedSegment(
      this: Intl.Segmenter,
      text: string,
    ) {
      segmentationPasses += 1;
      if (segmentationPasses > 5) throw new Error('word-motion segmentation budget exceeded');
      return originalSegment.call(this, text);
    });
    try {
      const forwardText = 'x '.repeat(10_001);
      const forward = createEditorMachine(new BoundsDocument(forwardText));
      forward.setRegister('a', 'w');
      expect((await send(forward, ...keys('10000@a'))).actions)
        .not.toContainEqual(expect.objectContaining({ level: 'error' }));

      const backwardDocument = new BoundsDocument(forwardText, forwardText.length);
      const backward = createEditorMachine(backwardDocument);
      backward.setRegister('a', 'b');
      expect((await send(backward, ...keys('10000@a'))).actions)
        .not.toContainEqual(expect.objectContaining({ level: 'error' }));

      const end = createEditorMachine(new BoundsDocument('word '.repeat(101)));
      end.setRegister('a', 'e');
      expect((await send(end, ...keys('100@a'))).actions)
        .not.toContainEqual(expect.objectContaining({ level: 'error' }));

      const changedDocument = new BoundsDocument('one two');
      const changed = createEditorMachine(changedDocument);
      await send(changed, 'w', 'i', 'X', 'Escape', 'w');
      expect(changedDocument.value).toBe('one Xtwo');
      expect(segmentationPasses).toBeLessThanOrEqual(5);
    } finally {
      segment.mockRestore();
    }
  });

  it('shares one 10,000-action budget across counted and nested macros', async () => {
    const document = new BoundsDocument('x'.repeat(10_001));
    const machine = createEditorMachine(document);
    machine.setRegister('a', '@b');
    machine.setRegister('b', 'l');

    const result = await send(machine, ...keys('5001@a'));

    expect(result.actions.at(-1)).toEqual({
      type: 'status',
      level: 'error',
      message: 'Macro action limit reached (10000)',
    });
    expect(document.ranges[0]!.head).toBeLessThanOrEqual(10_000);
  });

  it('accepts an exact composed count and rejects multiplied overflow before motion work', async () => {
    const exactDocument = new BoundsDocument(`${'x '.repeat(10_000)}tail`);
    const exact = createEditorMachine(exactDocument);
    const accepted = await send(exact, ...keys('100d100w'));
    expect(exactDocument.value).toBe('tail');
    expect(accepted).toMatchObject({ pending: '', count: undefined });

    for (const input of ['101d100w', '10000d10000w']) {
      const document = new BoundsDocument('one two three');
      const machine = createEditorMachine(document);
      const result = await send(machine, ...keys(input));
      expect(result).toMatchObject({ pending: '', count: undefined });
      expect(result.actions.at(-1)).toEqual({
        type: 'status', level: 'error', message: 'Count exceeds limit (10000)',
      });
      expect(document.value).toBe('one two three');
      expect(document.edits).toHaveLength(0);
    }
  });

  it('bounds recorded macro bytes and does not replace a valid macro with oversized committed input', async () => {
    const exact = createEditorMachine(new BoundsDocument(''));
    await send(exact, 'q', 'b', { kind: 'paste', text: 'x'.repeat(1024 * 1024) }, 'q');
    expect(new TextEncoder().encode(exact.register('b')?.text ?? '')).toHaveLength(1024 * 1024);

    const document = new BoundsDocument('abc');
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'l');
    await send(machine, 'q', 'a');

    const failure = await machine.handle({ kind: 'paste', text: 'x'.repeat(1024 * 1024 + 1) });
    expect(failure.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Macro recording exceeds register limit (1048576 bytes)',
    });
    expect(machine.register('a')?.text).toBe('l');
    await send(machine, '@', 'a');
    expect(document.ranges[0]?.head).toBe(1);
  });

  it('repeats the last macro with @@ counts under the shared replay budget', async () => {
    const unset = await send(createEditorMachine(new BoundsDocument('x')), '@', '@');
    expect(unset.actions.at(-1)).toEqual({ type: 'status', level: 'error', message: 'No previous macro' });

    const document = new BoundsDocument('x'.repeat(10_001));
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'l');
    await send(machine, '@', 'a', ...keys('9999@@'));
    expect(document.ranges[0]?.head).toBe(10_000);

    const overflowDocument = new BoundsDocument('x'.repeat(20_000));
    const overflowMachine = createEditorMachine(overflowDocument);
    overflowMachine.setRegister('b', 'll');
    await send(overflowMachine, '@', 'b');
    const overflow = await send(overflowMachine, ...keys('5001@@'));
    expect(overflow.actions.at(-1)).toMatchObject({
      level: 'error', message: 'Macro action limit reached (10000)',
    });
  });

  it('appends uppercase macro recordings, preserves byte bounds, and selects the appended macro for @@', async () => {
    const document = new BoundsDocument('x'.repeat(10));
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'l');
    await send(machine, 'q', 'A', 'l', 'q');
    expect(machine.register('a')?.text).toBe('ll');

    await send(machine, '@', 'a');
    expect(document.ranges[0]?.head).toBe(3);
    await send(machine, '@', '@');
    expect(document.ranges[0]?.head).toBe(5);

    const bounded = createEditorMachine(new BoundsDocument(''));
    bounded.setRegister('b', 'x'.repeat(1024 * 1024));
    await send(bounded, 'q', 'B');
    const overflow = await bounded.handle({ kind: 'text', text: 'y' });
    expect(overflow.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Macro recording exceeds register limit (1048576 bytes)',
    });
    expect(new TextEncoder().encode(bounded.register('b')?.text ?? '')).toHaveLength(1024 * 1024);
  });

  it('bounds search repeat loops through the same count parser', async () => {
    const document = new BoundsDocument('x');
    const machine = createEditorMachine(document);
    await send(machine, '/', 'x', 'Enter');

    const exact = await send(machine, ...keys('10000n'));
    const selectionTransactions = document.edits.length;
    expect(exact.count).toBeUndefined();
    expect(document.ranges[0]).toEqual({ anchor: 0, head: 0 });
    expect(selectionTransactions).toBe(2);

    const overflow = await send(machine, ...keys('10001'));
    expect(overflow.actions.at(-1)).toMatchObject({ level: 'error', message: 'Count exceeds limit (10000)' });
  });

  it('restores replay mode, pending state, and grouping after a document failure', async () => {
    const document = new BoundsDocument('abc');
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'iXEscape');
    document.failNextApply = true;

    const failure = await send(machine, '@', 'a');
    expect(failure).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(failure.actions.at(-1)).toMatchObject({ level: 'error', message: 'Editor transaction failed' });

    await send(machine, 'i', 'Y');
    expect(document.edits.at(-1)?.history).toBe('new');
  });

  it('restores replay bookkeeping after a global mark store failure', async () => {
    const machine = createEditorMachine(new BoundsDocument('abc'), {
      bufferId: 'buffer-a',
      globalMarks: {
        get: () => undefined,
        set: () => { throw new Error('mark store failed'); },
      },
    });
    machine.setRegister('a', 'mA');

    const failure = await send(machine, '@', 'a');

    expect(failure).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(failure.actions.at(-1)).toMatchObject({ level: 'error', message: 'Global mark A provider failed' });
    const retry = await send(machine, '@', 'a');
    expect(retry.actions.at(-1)).toMatchObject({ level: 'error', message: 'Global mark A provider failed' });
  });
});

describe('Vim editor input byte bounds', () => {
  it('accepts a 4 KiB search pattern and rejects the next byte inline', async () => {
    const exactMachine = createEditorMachine(new BoundsDocument(''));
    await exactMachine.handle('/');
    for (let index = 0; index < 4 * 1024; index += 1) await exactMachine.handle('a');
    const exact = await exactMachine.handle('Enter');
    expect(exact.search?.pattern).toHaveLength(4 * 1024);

    const overflowMachine = createEditorMachine(new BoundsDocument(''));
    await overflowMachine.handle('/');
    let overflow = overflowMachine.snapshot();
    for (let index = 0; index <= 4 * 1024; index += 1) overflow = await overflowMachine.handle('a');
    expect(overflow).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(overflow.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Search pattern exceeds limit (4096 bytes)',
    });
  });

  it('bounds direct Ex commands, history, and rendered errors to 64 KiB', async () => {
    const machine = createEditorMachine(new BoundsDocument(''));

    const exact = await machine.executeEx('x'.repeat(64 * 1024));
    const exactError = exact.actions.at(-1);
    expect(exactError?.type).toBe('status');
    if (exactError?.type === 'status') {
      expect(new TextEncoder().encode(exactError.message).byteLength).toBeLessThanOrEqual(64 * 1024);
    }

    const overflow = await machine.executeEx('x'.repeat(64 * 1024 + 1));
    expect(overflow.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Ex command exceeds limit (65536 bytes)',
    });
    expect(new TextEncoder().encode(machine.exHistory().join('')).byteLength).toBeLessThanOrEqual(64 * 1024);
  });

  it('rejects oversized command-line input immediately with a bounded error', async () => {
    const machine = createEditorMachine(new BoundsDocument(''));
    await machine.handle(':');
    let result = machine.snapshot();
    for (let index = 0; index <= 64 * 1024; index += 1) result = await machine.handle('x');

    expect(result).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(result.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Ex command exceeds limit (65536 bytes)',
    });
  });
});
