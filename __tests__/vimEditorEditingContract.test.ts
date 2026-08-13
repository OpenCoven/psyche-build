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

  it.each([
    { name: 'insert', text: 'ab', cursor: 0, input: ['3', 'i', 'X', 'Escape'] as EditorInput[], expected: 'XXXab' },
    { name: 'append', text: 'ab', cursor: 0, input: ['3', 'a', 'X', 'Escape'] as EditorInput[], expected: 'aXXXb' },
    { name: 'append line', text: 'ab', cursor: 0, input: ['3', 'A', 'X', 'Escape'] as EditorInput[], expected: 'abXXX' },
    { name: 'replace', text: 'abcdefghi', cursor: 0, input: ['3', 'R', 'x', 'y', 'Escape'] as EditorInput[], expected: 'xyxyxyghi' },
    { name: 'open below', text: 'one\ntwo', cursor: 0, input: ['3', 'o', 'X', 'Escape'] as EditorInput[], expected: 'one\nX\nX\nX\ntwo' },
    { name: 'open above', text: 'one\ntwo', cursor: 4, input: ['3', 'O', 'X', 'Escape'] as EditorInput[], expected: 'one\nX\nX\nX\ntwo' },
  ])('applies counted $name sessions as one repeat unit', async ({ text, cursor, input, expected }) => {
    const document = new ContractDocument(text, cursor);
    const machine = createEditorMachine(document);
    const result = await send(machine, ...input);
    expect(document.value).toBe(expected);
    expect(result).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)
      .map((transaction) => transaction.history)).toEqual(['new', 'join']);

    await machine.handle('.');
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0).at(-1)?.history).toBe('join');
  });

  it('treats 0 as a motion, bounds exact insert counts, and substitutes counted graphemes', async () => {
    const zero = new ContractDocument('ab', 1);
    await send(createEditorMachine(zero), ...keys('0iX'), 'Escape');
    expect(zero.value).toBe('Xab');

    const edge = new ContractDocument('');
    const edgeResult = await send(createEditorMachine(edge), ...keys('10000iX'), 'Escape');
    expect(edge.value).toBe('X'.repeat(10_000));
    expect(edgeResult).toMatchObject({ pending: '', count: undefined });

    const unicode = new ContractDocument('👩‍💻e\u0301Ztail');
    const unicodeMachine = createEditorMachine(unicode);
    await send(unicodeMachine, ...keys('3s'), { kind: 'text', text: 'å' }, 'Escape');
    expect(unicode.value).toBe('åtail');
    await unicodeMachine.handle('.');
    expect(unicode.value).toBe('åil');
  });

  it('preserves counted operator-find semantics in dot repeat and clears count state', async () => {
    const document = new ContractDocument('aXaXaXaX');
    const machine = createEditorMachine(document);

    const changed = await send(machine, ...keys('d2fX'));
    expect(document.value).toBe('aXaX');
    expect(changed).toMatchObject({ pending: '', count: undefined });

    const repeated = await machine.handle('.');
    expect(document.value).toBe('');
    expect(repeated).toMatchObject({ pending: '', count: undefined });
  });

  it.each([
    { name: 'F', text: 'XaXaXaXaXaXaXaXa', cursor: 15, command: 'd2FX' },
    { name: 't', text: 'aXaXaXaXaXaXaXaX', cursor: 0, command: 'd2tX' },
    { name: 'T', text: 'XaXaXaXaXaXaXaXa', cursor: 15, command: 'd2TX' },
    { name: 'gg', text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n', cursor: 24, command: 'd2gg' },
    { name: 'operator-first composition', text: 'aXaXaXaXaXaXaXaXaXaXaXaX', cursor: 0, command: '2d3fX' },
    { name: 'motion-first composition', text: 'aXaXaXaXaXaXaXaXaXaXaXaX', cursor: 0, command: '3d2fX' },
  ])('replays counted operator+$name changes as the same semantic command', async ({ text, cursor, command }) => {
    const dottedDocument = new ContractDocument(text, cursor);
    const dotted = createEditorMachine(dottedDocument);
    await send(dotted, ...keys(command), '.');

    const explicitDocument = new ContractDocument(text, cursor);
    const explicit = createEditorMachine(explicitDocument);
    await send(explicit, ...keys(command), ...keys(command));

    expect(dottedDocument.value).toBe(explicitDocument.value);
    expect(dotted.snapshot()).toMatchObject({ pending: '', count: undefined });
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

  it('applies and clears named-register paste counts atomically and repeats them deterministically', async () => {
    const document = new ContractDocument('ab');
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'X');

    await send(machine, ...keys('3"ap'));
    expect(document.value).toBe('aXXXb');
    expect(machine.snapshot()).toMatchObject({ pending: '', count: undefined });
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)).toHaveLength(1);

    await send(machine, 'l', '.');
    expect(document.value).toBe('aXXXbXXX');
    expect(document.transactions.filter((transaction) => transaction.changes.length > 0)).toHaveLength(2);
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
    { input: keys('>j'), text: 'one\ntwo\nthree', expected: '  one\n  two\nthree', repeated: '  one\n  two\n  three' },
    { input: keys('<j'), text: '  one\n  two\n  three', expected: 'one\ntwo\n  three', repeated: 'one\ntwo\nthree' },
  ])('composes line transform $input with a motion and dot repeat', async ({ input, text, expected, repeated }) => {
    const document = new ContractDocument(text);
    const machine = createEditorMachine(document);
    await send(machine, ...input);
    expect(document.value).toBe(expected);
    await send(machine, 'j', 'j', '.');
    expect(document.value).toBe(repeated);
  });

  it('formats motion and current-line ranges through the typed capability and repeats deterministically', async () => {
    const document = new ContractDocument('one two\nthree');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('gqw'));
    await send(machine, '.');
    await send(machine, ...keys('gqq'));

    expect(document.commands).toEqual([
      { action: 'format', argument: JSON.stringify({ from: 0, to: 4, linewise: false }) },
      { action: 'format', argument: JSON.stringify({ from: 0, to: 4, linewise: false }) },
      { action: 'format', argument: JSON.stringify({ from: 0, to: 7 }) },
    ]);
  });

  it('repeats case-transform operators on the next motion target', async () => {
    const document = new ContractDocument('ONE TWO');
    const machine = createEditorMachine(document);
    await send(machine, ...keys('guw'), 'w', '.');
    expect(document.value).toBe('one two');
  });

  it.each([
    { input: keys('>2j'), text: 'one\ntwo\nthree\nfour', expected: '  one\n  two\n  three\nfour' },
    { input: keys('<2j'), text: '  one\n  two\n  three\nfour', expected: 'one\ntwo\nthree\nfour' },
    { input: keys('gu2w'), text: 'ONE TWO THREE', expected: 'one two THREE' },
    { input: keys('2>2j'), text: '1\n2\n3\n4\n5', expected: '  1\n  2\n  3\n  4\n  5' },
  ])('accepts and consumes a motion count after operator prefix: $input', async ({ input, text, expected }) => {
    const document = new ContractDocument(text);
    const machine = createEditorMachine(document);
    const result = await send(machine, ...input);
    expect(document.value).toBe(expected);
    expect(result).toMatchObject({ pending: '', count: undefined });
  });

  it('accepts and consumes a format motion count after gq', async () => {
    const document = new ContractDocument('one two three');
    const machine = createEditorMachine(document);
    const result = await send(machine, ...keys('gq2w'));
    expect(document.commands).toEqual([
      { action: 'format', argument: JSON.stringify({ from: 0, to: 8, linewise: false }) },
    ]);
    expect(result).toMatchObject({ pending: '', count: undefined });
  });

  it('applies command counts exactly and never leaks a stale count', async () => {
    const changed = new ContractDocument('one two three four');
    const changeMachine = createEditorMachine(changed);
    await send(changeMachine, ...keys('dw2.'));
    expect(changed.value).toBe('four');
    expect(changeMachine.snapshot().count).toBeUndefined();

    const joined = new ContractDocument('one\ntwo\nthree\nfour');
    const joinMachine = createEditorMachine(joined);
    await send(joinMachine, ...keys('3J'));
    expect(joined.value).toBe('one two three\nfour');
    expect(joinMachine.snapshot().count).toBeUndefined();

    const numbered = new ContractDocument('1');
    const numberMachine = createEditorMachine(numbered);
    await send(numberMachine, '3', { key: 'a', ctrlKey: true }, '2', { key: 'x', ctrlKey: true });
    expect(numbered.value).toBe('2');
    expect(numberMachine.snapshot().count).toBeUndefined();

    const capability = new ContractDocument('one');
    const capabilityMachine = createEditorMachine(capability);
    await send(capabilityMachine, ...keys('3u'), '2', { key: 'r', ctrlKey: true });
    expect(capability.commands.map((command) => command.action)).toEqual([
      'undo', 'undo', 'undo', 'redo', 'redo',
    ]);
    expect(capabilityMachine.snapshot().count).toBeUndefined();
  });

  it('counts whole-word star searches in both directions and clears errors', async () => {
    const document = new ContractDocument('cat cat cat');
    const machine = createEditorMachine(document);
    await send(machine, ...keys('2*'));
    expect(document.ranges[0]?.head).toBe(8);
    await send(machine, ...keys('2#'));
    expect(document.ranges[0]?.head).toBe(0);

    const failed = await send(createEditorMachine(new ContractDocument('only')), ...keys('2J'));
    expect(failed).toMatchObject({ pending: '', count: undefined });

    const noNumber = await send(
      createEditorMachine(new ContractDocument('none')),
      '2', { key: 'a', ctrlKey: true },
    );
    expect(noNumber).toMatchObject({ pending: '', count: undefined });

    const noMacro = await send(createEditorMachine(new ContractDocument('none')), ...keys('2@z'));
    expect(noMacro).toMatchObject({ pending: '', count: undefined });
  });

  it('composes operator counts with text objects and accepts closing angle aliases', async () => {
    const counted = new ContractDocument('one two three');
    await send(createEditorMachine(counted), ...keys('2diw'));
    expect(counted.value).toBe(' three');

    const angle = new ContractDocument('<one>', 2);
    await send(createEditorMachine(angle), ...keys('di>'));
    expect(angle.value).toBe('<>');
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

  it.each([
    { name: 'throwing', object: () => { throw new Error('syntax failed'); }, message: 'Tag text object provider failed' },
    { name: 'negative', object: () => ({ from: -1, to: 2 }), message: 'Invalid tag text object range' },
    { name: 'past-end', object: () => ({ from: 0, to: 99 }), message: 'Invalid tag text object range' },
  ])('contains $name tag-object provider results', async ({ object, message }) => {
    const document = new ContractDocument('<p>one</p>', 4);
    const machine = createEditorMachine(document, { syntaxTagObject: object });
    const result = await send(machine, ...keys('2dit'));
    expect(result).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(result.actions.at(-1)).toEqual({ type: 'status', level: 'error', message });
    expect(document.value).toBe('<p>one</p>');
  });

  it('rejects tag-object ranges whose endpoints split a grapheme', async () => {
    const document = new ContractDocument('👩‍💻x');
    const machine = createEditorMachine(document, { syntaxTagObject: () => ({ from: 1, to: 2 }) });
    const result = await send(machine, ...keys('dit'));
    expect(result).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(result.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Invalid tag text object range',
    });
    expect(document.value).toBe('👩‍💻x');
  });

  it.each(['=', '%', '+', '*'] as const)('bounds provider-backed %s register exposure and paste', async (name) => {
    const exactValue = 'x'.repeat(1024 * 1024);
    const overflowValue = `${exactValue}x`;
    const optionsFor = (value: string) => ({
      expressionResult: () => value,
      currentFilename: () => value,
      clipboardRegisters: true,
      clipboard: { read: () => value, write: () => undefined },
    });
    const exact = createEditorMachine(new ContractDocument(''), optionsFor(exactValue));
    expect(new TextEncoder().encode(exact.register(name)?.text ?? '')).toHaveLength(1024 * 1024);

    const overflowDocument = new ContractDocument('ab');
    const overflow = createEditorMachine(overflowDocument, optionsFor(overflowValue));
    expect(overflow.register(name)).toBeUndefined();
    expect(overflow.snapshot().actions).toEqual([]);
    const paste = await send(overflow, '"', name, 'p');
    expect(paste.actions).toContainEqual({
      type: 'status', level: 'error', message: `Register ${name} exceeds limit (1048576 bytes)`,
    });
    expect(overflowDocument.value).toBe('ab');
    const repeat = await overflow.handle('.');
    expect(repeat.actions.at(-1)).toMatchObject({ level: 'error', message: 'No change to repeat' });
  });

  it('rejects oversized counted pastes before allocating the repeated text', async () => {
    const document = new ContractDocument('ab');
    const machine = createEditorMachine(document);
    machine.setRegister('a', 'x'.repeat(1024 * 1024));

    const result = await send(machine, ...keys('11"ap'));

    expect(result.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Paste exceeds limit (10485760 chars)',
    });
    expect(document.value).toBe('ab');
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

  it('bounds public clipboard queries and falls back to local clipboard registers', () => {
    let provided: string | undefined = undefined;
    const machine = createEditorMachine(new ContractDocument(''), {
      clipboardRegisters: true,
      clipboard: { read: () => provided, write: () => undefined },
    });
    expect(machine.setRegister('+', 'local-plus')).toBe(true);
    expect(machine.setRegister('*', 'local-star')).toBe(true);

    expect(machine.register('+')?.text).toBe('local-plus');
    expect(machine.register('*')?.text).toBe('local-star');

    provided = 'x'.repeat(1024 * 1024);
    expect(machine.register('+')?.text).toBe(provided);
    provided += 'x';
    expect(machine.register('+')).toBeUndefined();

    const throwing = createEditorMachine(new ContractDocument(''), {
      clipboardRegisters: true,
      clipboard: { read: () => { throw new Error('unavailable'); }, write: () => undefined },
    });
    throwing.setRegister('+', 'local');
    expect(throwing.register('+')).toBeUndefined();
    expect(throwing.snapshot().actions).toEqual([]);
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
    await send(machine, 'w', '"', '+', 'y', 'w');
    expect(writes.at(-1)).toEqual({ name: '+', text: 'one' });
  });

  it('preserves committed block-change text in the last-insert register and selection marks', async () => {
    const document = new ContractDocument('ab\ncd');
    const machine = createEditorMachine(document);
    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'c', { kind: 'text', text: '👩‍💻' }, 'Escape');

    expect(machine.register('.')?.text).toBe('👩‍💻');
    expect(machine.mark('<')).toBe(0);
    expect(machine.mark('>')).toBe(12);
  });

  it.each(['d', 'c', 'y'] as const)('sets visual selection marks when %s consumes the selection', async (operation) => {
    const document = new ContractDocument('abc');
    const machine = createEditorMachine(document);
    await send(machine, 'v', 'l', operation);
    expect(machine.mark('<')).toBe(0);
    expect(machine.mark('>')).toBe(operation === 'y' ? 2 : 0);
  });

  it('contains provider failures and modified-key grammar failures inline', async () => {
    const machine = createEditorMachine(new ContractDocument('one'), {
      bufferId: 'buffer-a',
      globalMarks: { get: () => { throw new Error('get'); }, set: () => { throw new Error('set'); } },
      clipboardRegisters: true,
      clipboard: { read: () => { throw new Error('read'); }, write: () => { throw new Error('write'); } },
      currentFilename: () => { throw new Error('filename'); },
      expressionResult: () => { throw new Error('expression'); },
    });

    const setMark = await send(machine, 'm', 'A');
    expect(setMark.actions.at(-1)).toMatchObject({ level: 'error', message: 'Global mark A provider failed' });
    const getMark = await send(machine, '`', 'A');
    expect(getMark.actions.at(-1)).toMatchObject({ level: 'error', message: 'Global mark A provider failed' });
    const clipboard = await send(machine, '"', '+', 'p');
    expect(clipboard.actions).toContainEqual({
      type: 'status', level: 'error', message: 'Clipboard register + read failed',
    });
    const filename = await send(machine, '"', '%', 'p');
    expect(filename.actions).toContainEqual({
      type: 'status', level: 'error', message: 'Current filename provider failed',
    });
    const expression = await send(machine, '"', '=', 'p');
    expect(expression.actions).toContainEqual({
      type: 'status', level: 'error', message: 'Expression result provider failed',
    });

    const write = await send(machine, '"', '+', 'y', 'w');
    expect(write.actions).toContainEqual({
      type: 'status', level: 'error', message: 'Clipboard register + write failed',
    });
    expect(machine.register('+')).toBeUndefined();

    const modified = await send(machine, '2', { key: 'w', ctrlKey: true });
    expect(modified).toMatchObject({ mode: 'normal', pending: '', count: undefined });
    expect(modified.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Unsupported modified key Ctrl-w',
    });
    const chordVariant = await machine.handle({ key: 'V', ctrlKey: true, shiftKey: true });
    expect(chordVariant.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Unsupported modified key Ctrl-Shift-v',
    });
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
