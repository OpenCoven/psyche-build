import {
  createEditorMachine,
  type EditorDocumentPort,
  type EditorInput,
  type EditorTransaction,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class UnicodeDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];
  readonly transactions: EditorTransaction[] = [];
  readonly commands: string[] = [];

  constructor(text = '', cursor = 0) {
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
    this.transactions.push(transaction);
  }

  async command(action: string): Promise<boolean> {
    this.commands.push(action);
    return true;
  }
}

async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

function expectGraphemeBoundary(text: string, position: number) {
  const boundaries = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .map((part) => part.index);
  boundaries.push(text.length);
  expect(boundaries).toContain(position);
}

describe('Vim editor committed Unicode text', () => {
  it('inserts a composition commit containing multiple code units as one transaction', async () => {
    const document = new UnicodeDocument();
    const machine = createEditorMachine(document);

    await send(machine, 'i', { kind: 'text', source: 'composition', text: '👩‍💻e\u0301' });

    expect(document.value).toBe('👩‍💻e\u0301');
    const content = document.transactions.filter((transaction) => transaction.changes.length > 0);
    expect(content).toHaveLength(1);
    expect(content[0]?.changes).toEqual([{ from: 0, to: 0, insert: '👩‍💻e\u0301' }]);
    expect(document.ranges).toEqual([{ anchor: 7, head: 7 }]);
    expectGraphemeBoundary(document.value, document.ranges[0]!.head);
  });

  it('inserts pasted command-looking content atomically without parsing it as commands', async () => {
    const document = new UnicodeDocument();
    const machine = createEditorMachine(document);

    await send(machine, 'i', { kind: 'paste', text: ':q\n@a' });

    expect(document.value).toBe(':q\n@a');
    expect(document.commands).toEqual([]);
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)).toHaveLength(1);
  });

  it('replaces whole graphemes for a multi-grapheme committed text event', async () => {
    const document = new UnicodeDocument('👩‍💻e\u0301z');
    const machine = createEditorMachine(document);

    await send(machine, 'R', { kind: 'text', text: 'åβ' });

    expect(document.value).toBe('åβz');
    expectGraphemeBoundary(document.value, document.ranges[0]!.head);
  });

  it('applies blockwise committed text to every selection in one atomic transaction', async () => {
    const document = new UnicodeDocument('ab\ncd');
    const machine = createEditorMachine(document);
    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'c');

    await machine.handle({ kind: 'paste', text: '👩‍💻' });

    expect(document.value).toBe('👩‍💻b\n👩‍💻d');
    const transaction = document.transactions.at(-1)!;
    expect(transaction.changes).toHaveLength(2);
    expect(transaction.history).toBe('join');
    for (const selection of document.ranges) expectGraphemeBoundary(document.value, selection.head);
  });

  it('bounds committed search text by UTF-8 bytes rather than UTF-16 length', async () => {
    const document = new UnicodeDocument();
    const machine = createEditorMachine(document);
    await machine.handle('/');

    const result = await machine.handle({ kind: 'text', text: '€'.repeat(1_366) });

    expect(result).toMatchObject({ mode: 'normal' });
    expect(result.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Search pattern exceeds limit (4096 bytes)',
    });
  });

  it.each([
    { name: 'combining forward', text: 'e\u0301 x e\u0301', cursor: 0, motion: 'f', target: 'e\u0301', expected: 5 },
    { name: 'combining backward', text: 'e\u0301 x e\u0301', cursor: 7, motion: 'F', target: 'e\u0301', expected: 5 },
    { name: 'ZWJ forward', text: 'a👩‍💻b👩‍💻', cursor: 0, motion: 'f', target: '👩‍💻', expected: 1 },
    { name: 'ZWJ backward', text: 'a👩‍💻b👩‍💻', cursor: 12, motion: 'F', target: '👩‍💻', expected: 7 },
    { name: 'astral forward', text: 'a𐐀b𐐀', cursor: 0, motion: 'f', target: '𐐀', expected: 1 },
    { name: 'astral backward', text: 'a𐐀b𐐀', cursor: 6, motion: 'F', target: '𐐀', expected: 4 },
    { name: 'till forward', text: 'ab👩‍💻c', cursor: 0, motion: 't', target: '👩‍💻', expected: 1 },
    { name: 'till backward', text: 'a👩‍💻bc', cursor: 8, motion: 'T', target: '👩‍💻', expected: 6 },
  ])('finds whole committed graphemes for $name', async ({ text, cursor, motion, target, expected }) => {
    const document = new UnicodeDocument(text, cursor);
    const machine = createEditorMachine(document);
    await send(machine, motion, { kind: 'text', text: target });
    expect(document.ranges[0]?.head).toBe(expected);
    expectGraphemeBoundary(text, document.ranges[0]!.head);
  });

  it('does not find a combining mark inside a grapheme and keeps the cursor snapped', async () => {
    const document = new UnicodeDocument('e\u0301 x e\u0301');
    const machine = createEditorMachine(document);
    const result = await send(machine, 'f', { kind: 'text', text: '\u0301' });
    expect(result.actions.at(-1)).toMatchObject({ level: 'error' });
    expect(document.ranges[0]?.head).toBe(0);
  });
});
