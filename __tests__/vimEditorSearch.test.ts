import {
  createEditorMachine,
  type EditorDocumentPort,
  type EditorInput,
  type EditorTransaction,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class SearchDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];

  constructor(text: string, cursor = 0) {
    this.value = text;
    this.ranges = [{ anchor: cursor, head: cursor }];
  }

  text(): string { return this.value; }
  selections(): readonly { anchor: number; head: number }[] { return this.ranges; }
  apply(transaction: EditorTransaction): void {
    for (const change of [...transaction.changes].reverse()) {
      this.value = `${this.value.slice(0, change.from)}${change.insert}${this.value.slice(change.to)}`;
    }
    this.ranges = transaction.selections.map((selection) => ({ ...selection }));
  }
  async command(): Promise<boolean> { return true; }
}

const keys = (value: string): EditorInput[] => [...value];

async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

function graphemeBoundaries(text: string): number[] {
  return [
    ...[...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.index),
    text.length,
  ];
}

describe('Vim editor bounded safe search', () => {
  it.each([
    '^(a+)+$',
    '(a|aa)+$',
    '(?=a)a',
    '(?<=a)b',
    'a\\1',
    '(?<name>a)\\k<name>',
  ])('rejects unsupported or backtracking-prone pattern %s inline', async (pattern) => {
    const machine = createEditorMachine(new SearchDocument(`${'a'.repeat(20)}!`));

    const result = await send(machine, '/', ...keys(pattern), 'Enter');

    expect(result.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Unsupported search pattern',
    });
  });

  it('supports a bounded regex subset without materializing all matches', async () => {
    const document = new SearchDocument(`${'a'.repeat(250_000)} bbb`);
    const machine = createEditorMachine(document);
    const original = String.prototype.matchAll;
    String.prototype.matchAll = function forbiddenMatchAll(): never {
      throw new Error('matchAll must not be used by search');
    };
    try {
      const result = await send(machine, '/', ...keys('[b]+'), 'Enter');
      expect(result.actions.at(-1)).toMatchObject({ type: 'search', query: '[b]+' });
      expect(document.ranges[0]?.head).toBe(250_001);
    } finally {
      String.prototype.matchAll = original;
    }
  });

  it('advances zero-length matches by grapheme and wraps without looping', async () => {
    const document = new SearchDocument('bbb');
    const machine = createEditorMachine(document);

    await send(machine, '/', 'a', '*', 'Enter');
    expect(document.ranges[0]?.head).toBe(1);
    await machine.handle('n');
    expect(document.ranges[0]?.head).toBe(2);
    await machine.handle('n');
    expect(document.ranges[0]?.head).toBe(3);
    await machine.handle('n');
    expect(document.ranges[0]?.head).toBe(0);
  });

  it('normalizes raw match starts inside combining graphemes to a boundary', async () => {
    const text = 'e\u0301 x e\u0301';
    const document = new SearchDocument(text, 2);
    const machine = createEditorMachine(document);

    await send(machine, '/', '\u0301', 'Enter');

    expect(graphemeBoundaries(text)).toContain(document.ranges[0]?.head);
    expect(document.ranges[0]?.head).toBe(5);
  });

  it('applies ignorecase and smartcase deterministically', async () => {
    const insensitiveDocument = new SearchDocument('FOO foo');
    const insensitive = createEditorMachine(insensitiveDocument, { ignoreCase: true });
    await send(insensitive, '/', ...keys('foo'), 'Enter');
    expect(insensitiveDocument.ranges[0]?.head).toBe(4);
    await insensitive.handle('n');
    expect(insensitiveDocument.ranges[0]?.head).toBe(0);

    const smartDocument = new SearchDocument('foo FOO');
    const smart = createEditorMachine(smartDocument, { ignoreCase: true, smartCase: true });
    await send(smart, '/', ...keys('FOO'), 'Enter');
    expect(smartDocument.ranges[0]?.head).toBe(4);
  });

  it('searches the whole word under the cursor with * and #', async () => {
    const document = new SearchDocument('cat scatter cat', 0);
    const machine = createEditorMachine(document);

    const forward = await machine.handle('*');
    expect(forward.actions.at(-1)).toMatchObject({ type: 'search', query: 'cat', direction: 'forward' });
    expect(document.ranges[0]?.head).toBe(12);

    const backward = await machine.handle('#');
    expect(backward.actions.at(-1)).toMatchObject({ type: 'search', query: 'cat', direction: 'backward' });
    expect(document.ranges[0]?.head).toBe(0);
  });

  it.each([
    { name: 'astral letter backward', text: '𐐀one one', cursor: 6, input: '#', expected: 6 },
    { name: 'astral letter forward', text: 'one 𐐀one', cursor: 0, input: '*', expected: 0 },
    { name: 'emoji boundary forward', text: 'one😀one', cursor: 0, input: '*', expected: 5 },
    { name: 'emoji boundary backward', text: 'one😀one', cursor: 5, input: '#', expected: 0 },
    { name: 'combining word backward', text: 'e\u0301one one', cursor: 6, input: '#', expected: 6 },
  ])('uses Unicode whole-word boundaries for $name', async ({ text, cursor, input, expected }) => {
    const document = new SearchDocument(text, cursor);
    const machine = createEditorMachine(document, { ignoreCase: true });
    await machine.handle(input);
    expect(document.ranges[0]?.head).toBe(expected);
  });

  it('preserves smart-case whole-word boundaries around astral letters', async () => {
    const document = new SearchDocument('ONE 𐐀one one', 0);
    const machine = createEditorMachine(document, { ignoreCase: true, smartCase: true });
    await machine.handle('*');
    expect(document.ranges[0]?.head).toBe(0);
  });

  it('keeps every repeated-search cursor on a grapheme boundary', async () => {
    const text = '👩‍💻 e\u0301 👩‍💻 e\u0301';
    const document = new SearchDocument(text);
    const machine = createEditorMachine(document);
    await send(machine, '/', '.', 'Enter');

    for (let index = 0; index < 12; index += 1) {
      expect(graphemeBoundaries(text)).toContain(document.ranges[0]?.head);
      await machine.handle('n');
    }
  });
});
