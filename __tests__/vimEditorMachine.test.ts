import {
  createEditorMachine,
  type EditorDocumentPort,
  type EditorInput,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class TestDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];
  readonly edits: Parameters<EditorDocumentPort['apply']>[0][] = [];
  readonly commands: { action: Parameters<EditorDocumentPort['command']>[0]; argument?: string }[] = [];

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
    this.value = `${this.value.slice(0, edit.from)}${edit.insert}${this.value.slice(edit.to)}`;
    this.ranges = edit.selections.map((selection) => ({ ...selection }));
    this.edits.push(edit);
  }

  async command(action: Parameters<EditorDocumentPort['command']>[0], argument?: string): Promise<boolean> {
    this.commands.push({ action, argument });
    return true;
  }
}

async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

function keys(sequence: string): EditorInput[] {
  return [...sequence];
}

describe('Vim editor modes and motions', () => {
  it.each([
    { keys: ['i'], mode: 'insert' },
    { keys: ['R'], mode: 'replace' },
    { keys: ['v'], mode: 'visual-character' },
    { keys: ['V'], mode: 'visual-line' },
    { keys: [{ key: 'v', ctrlKey: true }], mode: 'visual-block' },
    { keys: [':'], mode: 'command-line' },
    { keys: ['/'], mode: 'search' },
  ] as const)('enters $mode mode', async ({ keys: input, mode }) => {
    const document = new TestDocument('one two\nthree');
    const machine = createEditorMachine(document);

    const result = await send(machine, ...input);

    expect(result.mode).toBe(mode);
  });

  it.each([
    { name: 'right by grapheme', start: 0, input: ['l'], cursor: 1 },
    { name: 'left by grapheme', start: 3, input: ['h'], cursor: 2 },
    { name: 'line start', start: 5, input: ['0'], cursor: 0 },
    { name: 'first nonblank', start: 0, input: ['^'], cursor: 2, text: '  one\n' },
    { name: 'line end', start: 0, input: ['$'], cursor: 6 },
    { name: 'next word', start: 0, input: ['w'], cursor: 4 },
    { name: 'previous word', start: 6, input: ['b'], cursor: 4 },
    { name: 'word end', start: 0, input: ['e'], cursor: 2 },
    { name: 'next WORD', start: 0, input: ['W'], cursor: 4, text: 'a.b c\n' },
    { name: 'next line', start: 1, input: ['j'], cursor: 9 },
    { name: 'previous line', start: 9, input: ['k'], cursor: 1 },
    { name: 'first document line', start: 10, input: ['g', 'g'], cursor: 0 },
    { name: 'last document line', start: 0, input: ['G'], cursor: 14 },
    { name: 'find character', start: 0, input: ['f', 't'], cursor: 4 },
    { name: 'till character', start: 0, input: ['t', 't'], cursor: 3 },
    { name: 'next paragraph', start: 0, input: ['}'], cursor: 8, text: 'one\ntwo\n\nlast' },
    { name: 'previous paragraph', start: 10, input: ['{'], cursor: 5, text: 'one\n\ntwo\nthree' },
    { name: 'matching delimiter', start: 0, input: ['%'], cursor: 5, text: '(a[b])' },
  ])('$name', async ({ start, input, cursor, text = 'one two\nthree\nfour' }) => {
    const document = new TestDocument(text, start);
    const machine = createEditorMachine(document);

    await send(machine, ...input);

    expect(document.ranges).toEqual([{ anchor: cursor, head: cursor }]);
  });

  it.each([
    { input: keys('3l'), cursor: 3 },
    { input: keys('2w'), cursor: 8 },
    { input: keys('2j'), cursor: 8 },
    { input: keys('2gg'), cursor: 4 },
    { input: keys('2G'), cursor: 4 },
  ])('composes count for $input', async ({ input, cursor }) => {
    const document = new TestDocument('one\ntwo\nthree\nfour');
    const machine = createEditorMachine(document);

    await send(machine, ...input);

    expect(document.ranges[0]).toEqual({ anchor: cursor, head: cursor });
  });

  it('returns a visible error instead of throwing for an invalid structural motion', async () => {
    const document = new TestDocument('plain text');
    const machine = createEditorMachine(document);

    const result = await machine.handle('%');

    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: 'No matching delimiter' });
    expect(document.ranges[0]).toEqual({ anchor: 0, head: 0 });
  });
});

describe('Vim editor operators, text objects, and visual selections', () => {
  it.each([
    { name: 'delete word', text: 'one two', cursor: 0, input: keys('dw'), expected: 'two', mode: 'normal' },
    { name: 'count before operator', text: 'one two three', cursor: 0, input: keys('2dw'), expected: 'three', mode: 'normal' },
    { name: 'operator and motion counts compose', text: 'one two three four five', cursor: 0, input: keys('2d2w'), expected: 'five', mode: 'normal' },
    { name: 'delete line', text: 'one\ntwo\n', cursor: 0, input: keys('dd'), expected: 'two\n', mode: 'normal' },
    { name: 'change line', text: 'one\ntwo\n', cursor: 0, input: keys('cc'), expected: 'two\n', mode: 'insert' },
    { name: 'operator with document motion', text: 'one\ntwo\nthree', cursor: 4, input: keys('dgg'), expected: 'three', mode: 'normal' },
    { name: 'operator with find motion', text: 'one two', cursor: 0, input: keys('dft'), expected: 'wo', mode: 'normal' },
    { name: 'operator with till motion', text: 'one two', cursor: 0, input: keys('dtt'), expected: 'two', mode: 'normal' },
    { name: 'change inner word', text: 'one two', cursor: 1, input: keys('ciw'), expected: ' two', mode: 'insert' },
    { name: 'delete inner WORD', text: 'a.b c', cursor: 1, input: keys('diW'), expected: ' c', mode: 'normal' },
    { name: 'delete inner double quotes', text: 'say "hello" now', cursor: 6, input: keys('di"'), expected: 'say "" now', mode: 'normal' },
    { name: 'delete around single quotes', text: "say 'hello' now", cursor: 6, input: keys("da'"), expected: 'say  now', mode: 'normal' },
    { name: 'delete inner parentheses', text: 'call(one)', cursor: 6, input: keys('di('), expected: 'call()', mode: 'normal' },
    { name: 'delete inner brackets', text: 'list[one]', cursor: 6, input: keys('di['), expected: 'list[]', mode: 'normal' },
    { name: 'delete inner braces', text: 'map{one}', cursor: 5, input: keys('di{'), expected: 'map{}', mode: 'normal' },
  ])('$name', async ({ text, cursor, input, expected, mode }) => {
    const document = new TestDocument(text, cursor);
    const machine = createEditorMachine(document);

    const result = await send(machine, ...input);

    expect(document.value).toBe(expected);
    expect(result.mode).toBe(mode);
  });

  it('yanks doubled lines without changing the document', async () => {
    const document = new TestDocument('one\ntwo\n');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('yy'));

    expect(document.value).toBe('one\ntwo\n');
    expect(machine.register('0')).toEqual({ text: 'one\n', linewise: true });
    expect(machine.register('"')).toEqual({ text: 'one\n', linewise: true });
  });

  it.each([
    { name: 'find', text: 'abc def', cursor: 0, input: keys('dfb'), expected: 'c def' },
    { name: 'till', text: 'abc def', cursor: 0, input: keys('dtc'), expected: 'c def' },
    { name: 'counted find', text: 'a-b-c-d', cursor: 0, input: keys('d2f-'), expected: 'c-d' },
    { name: 'document start', text: 'one\ntwo\nthree\n', cursor: 8, input: keys('dgg'), expected: '' },
  ])('composes delete with $name motion', async ({ text, cursor, input, expected }) => {
    const document = new TestDocument(text, cursor);
    const machine = createEditorMachine(document);

    await send(machine, ...input);

    expect(document.value).toBe(expected);
  });

  it('tracks inclusive forward and reverse character and line selections', async () => {
    const characterDocument = new TestDocument('abc\ndef');
    await send(createEditorMachine(characterDocument), 'v', 'l');
    expect(characterDocument.ranges).toEqual([{ anchor: 0, head: 2 }]);

    const reverseCharacterDocument = new TestDocument('abc\ndef', 2);
    await send(createEditorMachine(reverseCharacterDocument), 'v', 'h');
    expect(reverseCharacterDocument.ranges).toEqual([{ anchor: 3, head: 1 }]);

    const lineDocument = new TestDocument('abc\ndef');
    await send(createEditorMachine(lineDocument), 'V', 'j');
    expect(lineDocument.ranges).toEqual([{ anchor: 0, head: 7 }]);

    const reverseLineDocument = new TestDocument('one\n\nthree', 4);
    await send(createEditorMachine(reverseLineDocument), 'V', 'k');
    expect(reverseLineDocument.ranges).toEqual([{ anchor: 5, head: 0 }]);
  });

  it('uses inclusive grapheme columns for visual-block selections', async () => {
    const document = new TestDocument('👩‍💻xy\ne\u0301yz');
    await send(createEditorMachine(document), { key: 'v', ctrlKey: true }, 'j', 'l');

    expect(document.ranges).toEqual([
      { anchor: 0, head: 6 },
      { anchor: 8, head: 11 },
    ]);
  });

  it('keeps reverse visual-block endpoints inclusive', async () => {
    const document = new TestDocument('abc\ndef', 5);
    await send(createEditorMachine(document), { key: 'v', ctrlKey: true }, 'k', 'h');

    expect(document.ranges).toEqual([
      { anchor: 6, head: 4 },
      { anchor: 2, head: 0 },
    ]);
  });

  it.each([
    { name: 'character', text: 'abcd', cursor: 2, input: keys('vhd'), expected: 'ad' },
    { name: 'line', text: 'one\n\nthree', cursor: 4, input: keys('Vkd'), expected: 'three' },
    { name: 'block', text: 'abc\ndef', cursor: 5, input: [{ key: 'v', ctrlKey: true }, ...keys('khd')], expected: 'c\nf' },
  ])('applies reverse visual-$name operators to the active-end span', async ({ text, cursor, input, expected }) => {
    const document = new TestDocument(text, cursor);

    await send(createEditorMachine(document), ...input);

    expect(document.value).toBe(expected);
  });

  it('applies visual-block deletes bottom-up as one undo group', async () => {
    const document = new TestDocument('abc\ndef');
    const machine = createEditorMachine(document);

    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l', 'd');

    expect(document.value).toBe('c\nf');
    expect(document.edits.filter((edit) => edit.to > edit.from).map((edit) => edit.history)).toEqual([
      'new', 'join',
    ]);
  });

  it.each([
    {
      name: 'forward',
      cursor: 0,
      selection: [{ key: 'v', ctrlKey: true }, ...keys('jly')] as EditorInput[],
    },
    {
      name: 'reverse',
      cursor: 5,
      selection: [{ key: 'v', ctrlKey: true }, ...keys('khy')] as EditorInput[],
    },
  ])('collapses a $name visual-block yank to its origin before the next normal command', async ({ cursor, selection }) => {
    const document = new TestDocument('abc\ndef', cursor);
    const machine = createEditorMachine(document);

    const yank = await send(machine, ...selection);

    expect(yank.mode).toBe('normal');
    expect(document.ranges).toEqual([{ anchor: 0, head: 0 }]);
    expect(machine.register('"')?.text).toBe('ab\nde');

    await send(machine, ...keys('dl'));
    expect(document.value).toBe('bc\ndef');
    expect(machine.snapshot().pending).toBe('');
  });

  it('deletes inclusive character selections', async () => {
    const document = new TestDocument('abcd');

    await send(createEditorMachine(document), ...keys('vld'));

    expect(document.value).toBe('cd');
  });

  it.each([
    { name: 'character grapheme', text: '👩‍💻x', cursor: 0, input: ['v'] as EditorInput[], ranges: [{ anchor: 0, head: 5 }] },
    { name: 'middle line', text: 'one\ntwo\nthree', cursor: 4, input: ['V'] as EditorInput[], ranges: [{ anchor: 4, head: 8 }] },
    { name: 'block grapheme cell', text: 'e\u0301x', cursor: 0, input: [{ key: 'v', ctrlKey: true }] as EditorInput[], ranges: [{ anchor: 0, head: 2 }] },
  ])('materializes the current $name on visual entry', async ({ text, cursor, input, ranges }) => {
    const document = new TestDocument(text, cursor);

    await send(createEditorMachine(document), ...input);

    expect(document.ranges).toEqual(ranges);
  });

  it.each([
    { name: 'character delete', text: '👩‍💻x', cursor: 0, input: keys('vd'), expected: 'x', register: '👩‍💻' },
    { name: 'character change', text: 'a👩‍💻z', cursor: 1, input: [...keys('vcX'), 'Escape'], expected: 'aXz', register: '👩‍💻' },
    { name: 'character yank', text: 'e\u0301x', cursor: 0, input: keys('vy'), expected: 'e\u0301x', register: 'e\u0301' },
    { name: 'line delete', text: 'one\ntwo\nthree', cursor: 4, input: keys('Vd'), expected: 'one\nthree', register: 'two\n' },
    { name: 'line change', text: 'one\ntwo\nthree', cursor: 4, input: [...keys('VcX'), 'Escape'], expected: 'one\nX\nthree', register: 'two\n' },
    { name: 'line yank', text: 'one\ntwo', cursor: 0, input: keys('Vy'), expected: 'one\ntwo', register: 'one\n' },
    { name: 'block delete', text: '👩‍💻x', cursor: 0, input: [{ key: 'v', ctrlKey: true }, 'd'], expected: 'x', register: '👩‍💻' },
    { name: 'block change', text: 'ae\u0301z', cursor: 1, input: [{ key: 'v', ctrlKey: true }, 'c', 'X', 'Escape'], expected: 'aXz', register: 'e\u0301' },
    { name: 'block yank', text: 'e\u0301x', cursor: 0, input: [{ key: 'v', ctrlKey: true }, 'y'], expected: 'e\u0301x', register: 'e\u0301' },
  ])('applies zero-motion visual $name to the materialized selection', async ({ text, cursor, input, expected, register }) => {
    const document = new TestDocument(text, cursor);
    const machine = createEditorMachine(document);

    await send(machine, ...input);

    expect(document.value).toBe(expected);
    expect(machine.register('"')?.text).toBe(register);
  });
});

describe('Vim editor registers and marks', () => {
  it('maintains unnamed, small-delete, numbered-delete, yank, named append, and black-hole registers', async () => {
    const small = createEditorMachine(new TestDocument('one two'));
    await send(small, ...keys('dw'));
    expect(small.register('-')?.text).toBe('one ');
    expect(small.register('"')?.text).toBe('one ');

    const line = createEditorMachine(new TestDocument('one\ntwo\n'));
    await send(line, ...keys('dd'));
    expect(line.register('1')).toEqual({ text: 'one\n', linewise: true });

    const namedDocument = new TestDocument('one two three');
    const named = createEditorMachine(namedDocument);
    await send(named, ...keys('"adw'), ...keys('"Adw'));
    expect(named.register('a')?.text).toBe('one two ');
    await send(named, ...keys('"_dw'));
    expect(named.register('"')?.text).toBe('two ');
  });

  it('rejects clipboard registers unless adapter policy enables them', async () => {
    const machine = createEditorMachine(new TestDocument('one'));

    const result = await send(machine, '"', '+');

    expect(result.actions).toContainEqual({
      type: 'status',
      level: 'error',
      message: 'Clipboard register + is disabled',
    });
  });

  it('uses clipboard registers only when adapter policy enables them', async () => {
    const machine = createEditorMachine(new TestDocument('one'), { clipboardRegisters: true });

    await send(machine, ...keys('"+yw'));

    expect(machine.register('+')).toEqual({ text: 'one', linewise: false });
  });

  it('enforces the 64-entry and 1 MiB global register bounds', () => {
    const machine = createEditorMachine(new TestDocument(''));
    for (let index = 0; index < 64; index += 1) {
      expect(machine.setRegister(`test-${index}`, 'x')).toBe(true);
    }
    expect(machine.setRegister('overflow', 'x')).toBe(false);

    const bytes = createEditorMachine(new TestDocument(''));
    expect(bytes.setRegister('a', 'x'.repeat(1024 * 1024))).toBe(true);
    expect(bytes.setRegister('b', 'x')).toBe(false);
  });

  it('keeps lowercase marks local and emits semantic uppercase global references', async () => {
    const document = new TestDocument('one\ntwo\nthree');
    const globals = new Map<string, { buffer: string; position: number }>();
    const machine = createEditorMachine(document, {
      bufferId: 'buffer-a',
      globalMarks: {
        get: (name) => globals.get(name),
        set: (name, reference) => globals.set(name, reference),
      },
    });
    await send(machine, ...keys('maw`a'));
    expect(document.ranges[0]).toEqual({ anchor: 0, head: 0 });
    expect(machine.mark('a')).toBe(0);

    const setGlobal = await send(machine, ...keys('mG'));
    expect(setGlobal.actions).toContainEqual({
      type: 'mark.set-global', mark: 'G', reference: { buffer: 'buffer-a', position: 0 },
    });
    expect(machine.mark('G')).toBeUndefined();
    await send(machine, 'w');
    const jumpGlobal = await send(machine, '`', 'G');
    expect(jumpGlobal.actions).toContainEqual({
      type: 'mark.jump-global', mark: 'G', reference: { buffer: 'buffer-a', position: 0 }, linewise: false,
    });
    expect(document.ranges[0]).toEqual({ anchor: 4, head: 4 });

    globals.set('H', { buffer: 'buffer-b', position: 7 });
    const crossBuffer = await send(machine, '`', 'H');
    expect(crossBuffer.actions).toContainEqual({
      type: 'mark.jump-global', mark: 'H', reference: { buffer: 'buffer-b', position: 7 }, linewise: false,
    });
    expect(document.ranges[0]).toEqual({ anchor: 4, head: 4 });

    const result = await send(machine, '`', 'z');
    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: 'Mark z is not set' });
  });

  it('reports unresolved uppercase global marks without treating them as local offsets', async () => {
    const machine = createEditorMachine(new TestDocument('one'), {
      bufferId: 'buffer-a',
      globalMarks: { get: () => undefined, set: () => undefined },
    });

    const result = await send(machine, '`', 'G');

    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: 'Global mark G is not set' });
    expect(machine.mark('G')).toBeUndefined();
  });
});

describe('Vim editor editing, repeat, macros, Unicode, and undo grouping', () => {
  it('groups one insert session and one replace session deterministically', async () => {
    const document = new TestDocument('abc');
    const machine = createEditorMachine(document);

    await send(machine, 'i', 'x', 'y', 'Escape', 'R', 'z', 'Escape');

    expect(document.value).toBe('xyzbc');
    expect(document.edits.filter((edit) => edit.insert).map((edit) => edit.history)).toEqual([
      'new', 'join', 'new',
    ]);
  });

  it('repeats the last change as a fresh undo group', async () => {
    const document = new TestDocument('one two three');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('dw.'));

    expect(document.value).toBe('three');
    expect(document.edits.filter((edit) => edit.to > edit.from).map((edit) => edit.history)).toEqual(['new', 'new']);
  });

  it('retains composed operator counts when repeating a change', async () => {
    const document = new TestDocument('one two three four five');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('2dw.'));

    expect(document.value).toBe('five');
  });

  it.each([
    { name: 'character', text: 'abcdef', input: keys('vld.'), expected: 'ef' },
    { name: 'line', text: 'one\ntwo\nthree\nfour\nfive\n', input: keys('Vjd.'), expected: 'five\n' },
    { name: 'block', text: 'abc\ndef\nghi', input: [{ key: 'v', ctrlKey: true }, ...keys('jld.')], expected: '\n\nghi' },
  ])('repeats a visual-$name delete deterministically', async ({ text, input, expected }) => {
    const document = new TestDocument(text);
    const machine = createEditorMachine(document);

    await send(machine, ...input);

    expect(document.value).toBe(expected);
    expect(machine.snapshot().pending).toBe('');
  });

  it('repeats a visual change including its insert text', async () => {
    const document = new TestDocument('abcdef');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('vlcxy'), 'Escape', '.');

    expect(document.value).toBe('xyxyef');
    expect(machine.snapshot().pending).toBe('');
  });

  it('applies visual-block change text to every row and repeats the same grouped edit later', async () => {
    const document = new TestDocument('abcd\nefgh\nijkl\nmnop');
    const machine = createEditorMachine(document);

    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l', 'c');
    expect(document.value).toBe('cd\ngh\nijkl\nmnop');
    expect(document.ranges).toEqual([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]);

    await send(machine, 'X', 'Y');
    expect(document.value).toBe('XYcd\nXYgh\nijkl\nmnop');
    expect(document.ranges).toEqual([{ anchor: 2, head: 2 }, { anchor: 7, head: 7 }]);
    expect(document.edits.filter((edit) => edit.to > edit.from || edit.insert).map((edit) => edit.history)).toEqual([
      'new', 'join', 'join', 'join', 'join', 'join',
    ]);

    await send(machine, 'Escape', 'j', 'j', '0', '.');
    expect(document.value).toBe('XYcd\nXYgh\nXYkl\nXYop');
    expect(document.edits.filter((edit) => edit.to > edit.from || edit.insert).slice(-2).map((edit) => edit.history)).toEqual([
      'new', 'join',
    ]);
  });

  it('preserves line separators for visual-line change and dot replay', async () => {
    const document = new TestDocument('one\ntwo\nthree\nfour\nfive\n');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('VjcX'), 'Escape');
    expect(document.value).toBe('X\nthree\nfour\nfive\n');

    await send(machine, 'j', '.');

    expect(document.value).toBe('X\nX\nfive\n');
    expect(document.edits.filter((edit) => edit.to > edit.from || edit.insert).map((edit) => edit.history)).toEqual([
      'new', 'join', 'new',
    ]);
  });

  it('learns line change on a terminated line and replays cleanly on the final line', async () => {
    const document = new TestDocument('one\ntwo\nlast');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('VcX'), 'Escape', 'G', '.');

    expect(document.value).toBe('X\ntwo\nX');
  });

  it('learns line change on the final line and preserves a middle target separator', async () => {
    const document = new TestDocument('one\ntwo\nlast', 8);
    const machine = createEditorMachine(document);

    await send(machine, ...keys('VcX'), 'Escape', ...keys('ggj.'));

    expect(document.value).toBe('one\nX\nX');
  });

  it('records and replays a named macro as one deterministic undo group', async () => {
    const document = new TestDocument('abc');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('qaix'), 'Escape', 'q', ...keys('@a'));

    expect(document.value).toBe('xxabc');
    const inserts = document.edits.filter((edit) => edit.insert === 'x');
    expect(inserts.map((edit) => edit.history)).toEqual(['new', 'new']);
  });

  it('applies counts to macro playback', async () => {
    const document = new TestDocument('abc');
    const machine = createEditorMachine(document);

    await send(machine, ...keys('qaix'), 'Escape', 'q', ...keys('2@a'));

    expect(document.value).toBe('xxxabc');
  });

  it('stops recursive macros at depth 16 and exposes the 10,000 action cap', async () => {
    const machine = createEditorMachine(new TestDocument('abc'));
    await send(machine, ...keys('qa@a'), 'q');

    const result = await send(machine, ...keys('@a'));

    expect(result.actions.at(-1)).toEqual({
      type: 'status',
      level: 'error',
      message: 'Macro recursion limit reached (16)',
    });
    expect(machine.limits).toMatchObject({ macroDepth: 16, macroActions: 10_000 });
  });

  it('stops macro expansion after 10,000 emitted actions', async () => {
    const machine = createEditorMachine(new TestDocument('abc'));
    machine.setRegister('b', 'l'.repeat(10_000));
    machine.setRegister('a', '@b@b');

    const result = await send(machine, ...keys('@a'));

    expect(result.actions.at(-1)).toEqual({
      type: 'status',
      level: 'error',
      message: 'Macro action limit reached (10000)',
    });
  });

  it('never splits Unicode grapheme clusters during navigation or deletion', async () => {
    const document = new TestDocument('a👩‍💻e\u0301z');
    const machine = createEditorMachine(document);

    await send(machine, 'l');
    expect(document.ranges[0]?.head).toBe(1);
    await send(machine, 'l');
    expect(document.ranges[0]?.head).toBe(6);
    await send(machine, ...keys('dl'));

    expect(document.value).toBe('a👩‍💻z');
  });
});

describe('Vim editor search', () => {
  it('searches forward and repeats with n/N direction semantics', async () => {
    const document = new TestDocument('one two one two');
    const machine = createEditorMachine(document);

    await send(machine, '/', ...keys('two'), 'Enter');
    expect(document.ranges[0]?.head).toBe(4);
    await send(machine, 'n');
    expect(document.ranges[0]?.head).toBe(12);
    await send(machine, 'N');
    expect(document.ranges[0]?.head).toBe(4);
    expect(machine.snapshot().search).toMatchObject({ pattern: 'two', direction: 'forward', highlight: true });
  });

  it('applies and clears composed counts for n and N while preserving direction', async () => {
    const document = new TestDocument('x one x two x three x four');
    const machine = createEditorMachine(document);
    await send(machine, '/', 'x', 'Enter');

    const forward = await send(machine, ...keys('3n'));
    expect(document.ranges[0]?.head).toBe(0);
    expect(forward.count).toBeUndefined();

    const reverse = await send(machine, ...keys('2N'));
    expect(document.ranges[0]?.head).toBe(12);
    expect(reverse.count).toBeUndefined();
    expect(machine.snapshot().search?.direction).toBe('forward');
  });

  it('clears search counts when a repeated pattern has no match', async () => {
    const machine = createEditorMachine(new TestDocument('one two'));
    await send(machine, '/', 'z', 'Enter');

    const result = await send(machine, ...keys('3n'));

    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: 'Pattern not found' });
    expect(result.count).toBeUndefined();
    expect(result.pending).toBe('');
  });

  it('reports malformed patterns inline without throwing', async () => {
    const machine = createEditorMachine(new TestDocument('one [ two'));

    const result = await send(machine, '/', '[', 'Enter');

    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: 'Invalid search pattern' });
  });
});

async function executeEx(machine: ReturnType<typeof createEditorMachine>, command: string) {
  return machine.executeEx(command);
}

describe('Vim editor bounded Ex commands', () => {
  it.each([
    { command: 'w', calls: ['save'] },
    { command: 'write', calls: ['save'] },
    { command: 'save', calls: ['save'] },
    { command: 'wa', calls: ['save-all'] },
    { command: 'write-all', calls: ['save-all'] },
    { command: 'save-all', calls: ['save-all'] },
    { command: 'q', calls: ['close'] },
    { command: 'quit', calls: ['close'] },
    { command: 'q!', calls: ['force-close'] },
    { command: 'force-quit', calls: ['force-close'] },
    { command: 'wq', calls: ['save', 'close'] },
    { command: 'write-quit', calls: ['save', 'close'] },
    { command: 'x', calls: ['save', 'close'] },
    { command: 'bn', calls: ['next-buffer'] },
    { command: 'next', calls: ['next-buffer'] },
    { command: 'bp', calls: ['previous-buffer'] },
    { command: 'previous', calls: ['previous-buffer'] },
  ])('maps :$command only to approved document commands', async ({ command, calls }) => {
    const document = new TestDocument('one');
    const machine = createEditorMachine(document);

    const result = await executeEx(machine, command);

    expect(document.commands.map((call) => call.action)).toEqual(calls);
    expect(result.mode).toBe('normal');
  });

  it('jumps to a bounded numeric line and clears search highlighting', async () => {
    const document = new TestDocument('one\ntwo\nthree');
    const machine = createEditorMachine(document);
    await send(machine, '/', ...keys('two'), 'Enter');

    await executeEx(machine, '3');
    expect(document.ranges[0]?.head).toBe(8);
    const result = await executeEx(machine, 'nohlsearch');
    expect(result.actions).toContainEqual({ type: 'search', query: 'two', direction: 'forward', active: false });
    expect(machine.snapshot().search?.highlight).toBe(false);
  });

  it('accepts the :noh alias and command-line key path', async () => {
    const document = new TestDocument('one');
    const machine = createEditorMachine(document);
    await send(machine, ':', 'w', 'Enter');
    expect(document.commands.map((call) => call.action)).toEqual(['save']);

    const result = await executeEx(machine, 'noh');
    expect(result.actions).toContainEqual({
      type: 'search', query: '', direction: 'forward', active: false,
    });
  });

  it.each([
    { command: 'w | quit', reason: 'Pipes are not allowed' },
    { command: '!echo pwned', reason: 'Shell commands are not allowed' },
    { command: 'source ~/.vimrc', reason: 'Source commands are not allowed' },
    { command: 's/one/two/', reason: 'Substitute and global commands are not supported' },
    { command: 'global/one/delete', reason: 'Substitute and global commands are not supported' },
    { command: 'w /tmp/file', reason: 'Filesystem arguments are not allowed' },
    { command: 'edit /tmp/file', reason: 'Filesystem arguments are not allowed' },
    { command: 'totally-unknown', reason: 'Unknown Ex command: totally-unknown' },
  ])('rejects :$command inline without side effects', async ({ command, reason }) => {
    const document = new TestDocument('one');
    const machine = createEditorMachine(document);

    const result = await executeEx(machine, command);

    expect(result.actions).toContainEqual({ type: 'status', level: 'error', message: reason });
    expect(document.value).toBe('one');
    expect(document.commands).toEqual([]);
  });

  it('bounds Ex history to 100 entries and 64 KiB', async () => {
    const machine = createEditorMachine(new TestDocument('one'));
    for (let index = 0; index < 105; index += 1) await executeEx(machine, `unknown-${index}`);

    expect(machine.exHistory()).toHaveLength(100);
    expect(machine.exHistory()[0]).toBe('unknown-5');

    await executeEx(machine, `unknown-${'x'.repeat(70 * 1024)}`);
    expect(new TextEncoder().encode(machine.exHistory().join('')).byteLength).toBeLessThanOrEqual(64 * 1024);
  });
});
