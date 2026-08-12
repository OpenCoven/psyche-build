import {
  createEditorMachine,
  type EditorCapabilityCommand,
  type EditorDocumentPort,
  type EditorInput,
  type EditorTransaction,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class ContractDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];
  readonly transactions: EditorTransaction[] = [];
  readonly commands: { action: EditorCapabilityCommand; argument?: string }[] = [];

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
    this.transactions.push(transaction);
  }
  async command(action: EditorCapabilityCommand, argument?: string): Promise<boolean> {
    this.commands.push({ action, argument });
    return true;
  }
}

const keys = (value: string): EditorInput[] => [...value];
async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

describe('Vim practical editing contract', () => {
  it.each([
    { name: 'append', text: 'abc', cursor: 0, input: ['a', 'X', 'Escape'] as EditorInput[], expected: 'aXbc' },
    { name: 'append line', text: 'abc', cursor: 0, input: ['A', 'X', 'Escape'] as EditorInput[], expected: 'abcX' },
    { name: 'open below', text: 'one\ntwo', cursor: 0, input: ['o', 'X', 'Escape'] as EditorInput[], expected: 'one\nX\ntwo' },
    { name: 'open above', text: 'one\ntwo', cursor: 4, input: ['O', 'X', 'Escape'] as EditorInput[], expected: 'one\nX\ntwo' },
    { name: 'substitute grapheme', text: '👩‍💻x', cursor: 0, input: ['s', 'Y', 'Escape'] as EditorInput[], expected: 'Yx' },
    { name: 'substitute line', text: 'one\ntwo', cursor: 0, input: ['S', 'X', 'Escape'] as EditorInput[], expected: 'X\ntwo' },
    { name: 'join', text: 'one  \n  two', cursor: 0, input: ['J'] as EditorInput[], expected: 'one two' },
  ])('$name', async ({ text, cursor, input, expected }) => {
    const document = new ContractDocument(text, cursor);
    await send(createEditorMachine(document), ...input);
    expect(document.value).toBe(expected);
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)[0]?.history).toBe('new');
  });

  it('pastes characterwise registers before and after and linewise registers on line boundaries', async () => {
    const afterDocument = new ContractDocument('ab');
    const after = createEditorMachine(afterDocument);
    after.setRegister('a', 'X');
    await send(after, '"', 'a', 'p');
    expect(afterDocument.value).toBe('aXb');

    const beforeDocument = new ContractDocument('ab', 1);
    const before = createEditorMachine(beforeDocument);
    before.setRegister('a', 'X');
    await send(before, '"', 'a', 'P');
    expect(beforeDocument.value).toBe('aXb');

    const lineDocument = new ContractDocument('one\ntwo');
    const line = createEditorMachine(lineDocument);
    line.setRegister('a', 'new\n', true);
    await send(line, '"', 'a', 'p');
    expect(lineDocument.value).toBe('one\nnew\ntwo');
  });

  it.each([
    { input: ['>', '>'] as EditorInput[], text: 'one\ntwo', expected: '  one\ntwo' },
    { input: ['<', '<'] as EditorInput[], text: '  one\ntwo', expected: 'one\ntwo' },
    { input: ['g', 'u', 'w'] as EditorInput[], text: 'ONE two', expected: 'one two' },
    { input: ['g', 'U', 'w'] as EditorInput[], text: 'one two', expected: 'ONE two' },
    { input: ['g', '~', 'w'] as EditorInput[], text: 'One two', expected: 'oNE two' },
  ])('applies operator $input atomically', async ({ input, text, expected }) => {
    const document = new ContractDocument(text);
    await send(createEditorMachine(document), ...input);
    expect(document.value).toBe(expected);
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)).toHaveLength(1);
  });

  it.each([
    { input: ['V', '>'] as EditorInput[], text: 'one\ntwo', expected: '  one\ntwo' },
    { input: ['V', '<'] as EditorInput[], text: '  one\ntwo', expected: 'one\ntwo' },
    { input: ['v', 'l', '~'] as EditorInput[], text: 'One', expected: 'oNe' },
    { input: ['v', 'l', 'u'] as EditorInput[], text: 'ONE', expected: 'onE' },
    { input: ['v', 'l', 'U'] as EditorInput[], text: 'one', expected: 'ONe' },
  ])('applies visual operator $input atomically', async ({ input, text, expected }) => {
    const document = new ContractDocument(text);
    const result = await send(createEditorMachine(document), ...input);
    expect(document.value).toBe(expected);
    expect(result.mode).toBe('normal');
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)).toHaveLength(1);
  });

  it('uses semantic capabilities for format, undo, and redo', async () => {
    const document = new ContractDocument('one');
    const machine = createEditorMachine(document);

    await send(machine, 'g', 'q', 'q', 'u', { key: 'r', ctrlKey: true });

    expect(document.commands.map((command) => command.action)).toEqual(['format', 'undo', 'redo']);
  });

  it('increments and decrements the next number without evaluating code', async () => {
    const document = new ContractDocument('value 009 and -2');
    const machine = createEditorMachine(document);
    await machine.handle({ key: 'a', ctrlKey: true });
    expect(document.value).toBe('value 010 and -2');
    await machine.handle({ key: 'x', ctrlKey: true });
    expect(document.value).toBe('value 009 and -2');
  });

  it('supports paragraph and capability-gated tag text objects', async () => {
    const paragraphDocument = new ContractDocument('one\ntwo\n\nthree', 1);
    await send(createEditorMachine(paragraphDocument), 'd', 'i', 'p');
    expect(paragraphDocument.value).toBe('\nthree');

    const tagDocument = new ContractDocument('<p>hello</p>', 4);
    const tagMachine = createEditorMachine(tagDocument, {
      syntaxTagObject: (_text, _position, around) => around ? { from: 0, to: 12 } : { from: 3, to: 8 },
    });
    await send(tagMachine, 'd', 'i', 't');
    expect(tagDocument.value).toBe('<p></p>');
  });

  it('exposes bounded special registers without expression evaluation', () => {
    const machine = createEditorMachine(new ContractDocument(''), {
      expressionResult: '42',
      currentFilename: 'src/app.ts',
      clipboardRegisters: true,
      clipboard: { read: () => 'clip', write: () => undefined },
    });
    machine.setRegister('.', 'inserted');

    expect(machine.register('=')?.text).toBe('42');
    expect(machine.register('%')?.text).toBe('src/app.ts');
    expect(machine.register('.')?.text).toBe('inserted');
    expect(machine.register('+')?.text).toBe('clip');
  });

  it('updates the last-insert and enabled clipboard registers through bounded providers', async () => {
    const writes: { name: string; text: string }[] = [];
    const document = new ContractDocument('one');
    const machine = createEditorMachine(document, {
      clipboardRegisters: true,
      clipboard: {
        read: () => undefined,
        write: (name, value) => writes.push({ name, text: value.text }),
      },
    });
    await send(machine, 'i', { kind: 'text', text: '👩‍💻' }, 'Escape');
    expect(machine.register('.')?.text).toBe('👩‍💻');
    await send(machine, '"', '+', 'y', 'w');
    expect(writes.at(-1)).toEqual({ name: '+', text: 'one' });
  });

  it('tracks change/insert/selection positions and jump back/forward', async () => {
    const document = new ContractDocument('one two');
    const machine = createEditorMachine(document);
    await send(machine, 'w', 'i', 'X', 'Escape');
    expect(machine.mark('[')).toBe(4);
    expect(machine.mark(']')).toBe(5);
    expect(machine.mark('.')).toBe(4);
    expect(machine.mark('^')).toBe(5);

    await send(machine, 'v', 'l', 'Escape');
    expect(machine.mark('<')).toBeDefined();
    expect(machine.mark('>')).toBeDefined();

    await send(machine, '0', 'w', { key: 'o', ctrlKey: true });
    expect(document.ranges[0]?.head).toBe(0);
    await machine.handle({ key: 'i', ctrlKey: true });
    expect(document.ranges[0]?.head).toBe(4);
  });
});
