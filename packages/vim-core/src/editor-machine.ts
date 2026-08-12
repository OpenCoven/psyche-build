import { normalizeKeyboardEvent } from './normalize.js';
import { EDITOR_LIMITS } from './editor/limits.js';
import { substituteText } from './editor/ex-executor.js';
import { parseExCommand } from './editor/ex-parser.js';
import { mapPosition, relocateMark } from './editor/marks.js';
import {
  graphemeColumn,
  graphemeCount,
  lastLineStart,
  lineAt,
  lineEnd,
  lineNumber,
  lineStart,
  matchingDelimiter,
  nextGrapheme,
  paragraph,
  positionAtGraphemeColumn,
  previousGrapheme,
  vertical,
  wordBackward,
  wordEnd,
  wordForward,
} from './editor/motions.js';
import { compilePattern, escapePattern } from './editor/patterns.js';
import { objectRange } from './editor/ranges.js';
import { consumeReplayAction, type ReplayBudget } from './editor/replay.js';
import { findMatch, wordAt } from './editor/search.js';
import { editorTransaction, positionsAfterChanges } from './editor/transactions.js';
import type {
  EditorAction,
  EditorChange,
  EditorDocumentPort,
  EditorGlobalMarkReference,
  EditorGlobalMarkStore,
  EditorInput,
  EditorMachine,
  EditorMachineOptions,
  EditorMode,
  EditorRegister,
  EditorResult,
  EditorSearchState,
  EditorSelection,
  EditorTransaction,
  EditorTextInput,
  EditorPasteInput,
} from './editor/types.js';

export { EDITOR_LIMITS } from './editor/limits.js';
export type {
  EditorAction,
  EditorCapabilityCommand,
  EditorChange,
  EditorDocumentPort,
  EditorGlobalMarkReference,
  EditorGlobalMarkStore,
  EditorInput,
  EditorMachine,
  EditorMachineOptions,
  EditorMode,
  EditorRegister,
  EditorResult,
  EditorSearchState,
  EditorSelection,
  EditorTransaction,
  EditorTextInput,
  EditorPasteInput,
} from './editor/types.js';

type Token = { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

interface VisualChange {
  readonly mode: 'visual-character' | 'visual-line' | 'visual-block';
  readonly width: number;
  readonly height: number;
  linewiseChange: boolean;
  insert: string;
}

function token(input: EditorInput): Token {
  if (typeof input !== 'string') {
    if (isCommittedText(input)) throw new Error('Committed text is not a keyboard token');
    return normalizeKeyboardEvent(input);
  }
  const lower = input.toLowerCase();
  const shift = input.length === 1 && lower !== input;
  return { key: shift ? lower : input, ctrl: false, alt: false, shift, meta: false };
}

function isCommittedText(input: EditorInput): input is Extract<EditorInput, { kind: 'text' | 'paste' }> {
  return typeof input === 'object' && 'kind' in input && (input.kind === 'text' || input.kind === 'paste');
}

function inputDisplay(input: EditorInput): string {
  return isCommittedText(input) ? input.text : displayToken(token(input));
}

function displayToken(value: Token): string {
  return value.shift && value.key.length === 1 ? value.key.toLocaleUpperCase() : value.key;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Pure editor state machine. All document effects flow through EditorDocumentPort. */
export function createEditorMachine(
  document: EditorDocumentPort,
  options: EditorMachineOptions = {},
): EditorMachine {
  let mode: EditorMode = 'normal';
  let pending = '';
  let countBuffer = '';
  let operatorCount = 1;
  let activeRegister: string | undefined;
  let visualAnchor = 0;
  let visualHead = 0;
  let inputBuffer = '';
  let inputBufferBytes = 0;
  let ignoreCase = options.ignoreCase ?? false;
  let smartCase = options.smartCase ?? false;
  let searchState: EditorSearchState | undefined;
  let insertFirstEdit = true;
  let insertChange: EditorInput[] | undefined;
  let lastChange: EditorInput[] | undefined;
  let lastVisualChange: VisualChange | undefined;
  let activeVisualChange: VisualChange | undefined;
  let recording: { name: string; inputs: EditorInput[] } | undefined;
  let macroDepth = 0;
  const macroBudget: ReplayBudget = { actions: 0 };
  let invocationGroup: { used: boolean } | undefined;
  const backJumps: number[] = [];
  const forwardJumps: number[] = [];
  let queuedActions: EditorAction[] = [];
  const registers = new Map<string, EditorRegister>();
  const marks = new Map<string, number>();
  const macros = new Map<string, readonly EditorInput[]>();
  const commands: string[] = [];

  function snapshot(actions: readonly EditorAction[] = []): EditorResult {
    const allActions = queuedActions.length > 0 ? [...queuedActions, ...actions] : actions;
    queuedActions = [];
    return {
      mode,
      pending,
      count: countBuffer ? Number(countBuffer) : undefined,
      actions: allActions,
      ...(searchState ? { search: { ...searchState } } : {}),
    };
  }

  function cursor(): number {
    return mode.startsWith('visual-') ? visualHead : (document.selections()[0]?.head ?? 0);
  }

  function commit(
    changes: readonly EditorChange[],
    selections: readonly EditorSelection[],
    defaultHistory: EditorTransaction['history'],
  ): boolean {
    const grouped = changes.length > 0 && invocationGroup
      ? (invocationGroup.used ? 'join' : 'new')
      : defaultHistory;
    let transaction: EditorTransaction;
    try {
      transaction = editorTransaction(changes, selections, grouped);
      document.apply(transaction);
    } catch {
      queuedActions.push({ type: 'status', level: 'error', message: 'Editor transaction failed' });
      return false;
    }
    if (changes.length === 0) return true;
    if (invocationGroup) invocationGroup.used = true;
    const nextText = document.text();
    for (const [name, position] of marks) marks.set(name, relocateMark(nextText, position, transaction.changes));
    const firstChange = transaction.changes[0];
    const lastChangeInTransaction = transaction.changes.at(-1);
    if (firstChange && lastChangeInTransaction) {
      const start = mapPosition(firstChange.from, transaction.changes, 'before');
      const end = mapPosition(lastChangeInTransaction.to, transaction.changes, 'after');
      marks.set('[', start);
      marks.set(']', end);
      marks.set('.', start);
    }
    if (options.bufferId && options.globalMarks) {
      for (const name of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        try {
          const reference = options.globalMarks.get(name);
          if (!reference || reference.buffer !== options.bufferId) continue;
          const position = relocateMark(nextText, reference.position, transaction.changes);
          if (position === reference.position) continue;
          const relocated = { ...reference, position };
          options.globalMarks.set(name, relocated);
          queuedActions.push({ type: 'mark.set-global', mark: name, reference: relocated });
        } catch {
          queuedActions.push({ type: 'status', level: 'error', message: 'Global mark relocation failed' });
        }
      }
    }
    return true;
  }

  function apply(from: number, to: number, insert: string, position: number, group: 'join' | 'new'): boolean {
    return commit([{ from, to, insert }], [{ anchor: position, head: position }], group);
  }

  function setSelections(selections: readonly EditorSelection[]): boolean {
    return commit([], selections, 'join');
  }

  function insertAtSelections(insert: string): boolean {
    const positions = document.selections().map((selection) => selection.head).sort((left, right) => left - right);
    const changes = positions.map((position) => ({ from: position, to: position, insert }));
    const next = positionsAfterChanges(changes);
    return commit(changes, next.map((position) => ({ anchor: position, head: position })), 'join');
  }

  function select(position: number, recordJump = true): void {
    const text = document.text();
    const bounded = Math.max(0, Math.min(text.length, position));
    const previous = document.selections()[0]?.head ?? 0;
    let selections: readonly EditorSelection[] = [{ anchor: bounded, head: bounded }];
    if (mode === 'visual-character') {
      selections = bounded >= visualAnchor
        ? [{ anchor: visualAnchor, head: nextGrapheme(text, bounded) }]
        : [{ anchor: nextGrapheme(text, visualAnchor), head: bounded }];
    }
    if (mode === 'visual-line') {
      const anchorStart = lineStart(text, visualAnchor);
      const anchorEnd = lineEnd(text, visualAnchor);
      const headStart = lineStart(text, bounded);
      const headEnd = lineEnd(text, bounded);
      selections = bounded >= visualAnchor
        ? [{ anchor: anchorStart, head: headEnd < text.length ? headEnd + 1 : headEnd }]
        : [{ anchor: anchorEnd < text.length ? anchorEnd + 1 : anchorEnd, head: headStart }];
    }
    if (mode === 'visual-block') {
      const firstLine = lineNumber(text, visualAnchor);
      const lastLine = lineNumber(text, bounded);
      const anchorLineStart = lineStart(text, visualAnchor);
      const headLineStart = lineStart(text, bounded);
      const anchorColumn = graphemeColumn(text, anchorLineStart, visualAnchor);
      const headColumn = graphemeColumn(text, headLineStart, bounded);
      const fromColumn = Math.min(anchorColumn, headColumn);
      const toColumn = Math.max(anchorColumn, headColumn) + 1;
      const block: EditorSelection[] = [];
      const lineDirection = lastLine >= firstLine ? 1 : -1;
      const columnDirection = headColumn >= anchorColumn ? 1 : -1;
      for (let line = firstLine; line !== lastLine + lineDirection; line += lineDirection) {
        const start = lineAt(text, line);
        block.push(columnDirection > 0
          ? {
              anchor: positionAtGraphemeColumn(text, start, fromColumn),
              head: positionAtGraphemeColumn(text, start, toColumn),
            }
          : {
              anchor: positionAtGraphemeColumn(text, start, toColumn),
              head: positionAtGraphemeColumn(text, start, fromColumn),
            });
      }
      selections = block;
    }
    if (setSelections(selections)) {
      visualHead = bounded;
      if (recordJump && previous !== bounded && !mode.startsWith('visual-')) {
        backJumps.push(previous);
        if (backJumps.length > 100) backJumps.shift();
        forwardJumps.length = 0;
      }
    }
  }

  function resetPending(): void {
    pending = '';
    countBuffer = '';
    operatorCount = 1;
    activeRegister = undefined;
  }

  function appendCount(digit: string): EditorResult {
    const next = `${countBuffer}${digit}`;
    if (next.length > EDITOR_LIMITS.countDigits || Number(next) > EDITOR_LIMITS.count) {
      resetPending();
      return snapshot([{
        type: 'status', level: 'error', message: `Count exceeds limit (${EDITOR_LIMITS.count})`,
      }]);
    }
    countBuffer = next;
    return snapshot();
  }

  function enter(next: EditorMode): EditorResult {
    mode = next;
    resetPending();
    inputBuffer = '';
    inputBufferBytes = 0;
    if (next.startsWith('visual-')) {
      visualAnchor = visualHead = document.selections()[0]?.head ?? 0;
      select(visualHead);
    }
    if (next === 'insert' || next === 'replace') insertFirstEdit = true;
    return snapshot([{ type: 'mode', mode }]);
  }

  function setRegister(name: string, text: string, linewise = false): boolean {
    const target = /^[A-Z]$/u.test(name) ? name.toLowerCase() : name;
    const previous = registers.get(target);
    const next: EditorRegister = /^[A-Z]$/u.test(name) && previous
      ? { text: previous.text + text, linewise: previous.linewise || linewise }
      : { text, linewise };
    const entries = registers.has(target) ? registers.size : registers.size + 1;
    let bytes = 0;
    for (const [key, value] of registers) if (key !== target) bytes += byteLength(value.text);
    bytes += byteLength(next.text);
    if (entries > EDITOR_LIMITS.registerEntries || bytes > EDITOR_LIMITS.registerBytes) return false;
    registers.set(target, next);
    if ((target === '+' || target === '*') && options.clipboardRegisters) {
      options.clipboard?.write(target, next);
    }
    if (/^[a-z]$/u.test(target)) macros.set(target, [...next.text]);
    return true;
  }

  function writeRegisters(operation: 'delete' | 'yank', text: string, linewise: boolean): void {
    const selected = activeRegister;
    activeRegister = undefined;
    if (selected === '_') return;
    if (selected) setRegister(selected, text, linewise);
    setRegister('"', text, linewise);
    if (operation === 'yank') setRegister('0', text, linewise);
    else if (linewise || text.includes('\n')) {
      for (let index = 9; index > 1; index -= 1) {
        const previous = registers.get(String(index - 1));
        if (previous) setRegister(String(index), previous.text, previous.linewise);
      }
      setRegister('1', text, linewise);
    } else setRegister('-', text, false);
  }

  function motion(key: string, shifted: boolean, count: number, argument?: string): number | undefined {
    const text = document.text();
    const position = cursor();
    if (key === 'h' || key === 'l') {
      let result = position;
      for (let index = 0; index < count; index += 1) {
        result = key === 'h' ? previousGrapheme(text, result) : nextGrapheme(text, result);
      }
      return result;
    }
    if (key === 'j' || key === 'k') return vertical(text, position, (key === 'j' ? 1 : -1) * count);
    if (key === '0') return lineStart(text, position);
    if (key === '^') {
      const start = lineStart(text, position);
      return start + (text.slice(start, lineEnd(text, position)).match(/^\s*/u)?.[0].length ?? 0);
    }
    if (key === '$') {
      const end = lineEnd(text, position);
      return end === lineStart(text, position) ? end : previousGrapheme(text, end);
    }
    if (key === 'w' || key === 'W') return wordForward(text, position, count, key === 'W' || shifted);
    if (key === 'b' || key === 'B') return wordBackward(text, position, count, key === 'B' || shifted);
    if (key === 'e' || key === 'E') return wordEnd(text, position, count, key === 'E' || shifted);
    if (key === 'G') return countBuffer ? lineAt(text, count - 1) : lastLineStart(text);
    if (key === 'gg') return countBuffer ? lineAt(text, count - 1) : 0;
    if ('fFtT'.includes(key)) {
      if (!argument) return undefined;
      let found = position;
      for (let index = 0; index < count; index += 1) {
        found = key === 'f' || key === 't'
          ? text.indexOf(argument, found + 1)
          : text.lastIndexOf(argument, found - 1);
        if (found < 0 || found > lineEnd(text, position) || found < lineStart(text, position)) return undefined;
      }
      return key === 't' ? previousGrapheme(text, found) : key === 'T' ? nextGrapheme(text, found) : found;
    }
    if (key === '}' || key === '{') {
      let result = position;
      for (let index = 0; index < count; index += 1) result = paragraph(text, result, key === '}' ? 1 : -1);
      return result;
    }
    if (key === '%') return matchingDelimiter(text, position);
    return undefined;
  }

  function operate(
    operation: 'd' | 'c' | 'y',
    range: { from: number; to: number },
    linewise: boolean,
    changeInputs: EditorInput[],
    registerText?: string,
  ): EditorResult {
    const from = Math.max(0, Math.min(range.from, range.to));
    const to = Math.min(document.text().length, Math.max(range.from, range.to));
    const removed = registerText ?? document.text().slice(from, to);
    if (operation !== 'y') {
      if (!apply(from, to, '', from, 'new')) return snapshot();
    } else if (!setSelections([{ anchor: from, head: from }])) return snapshot();
    writeRegisters(operation === 'y' ? 'yank' : 'delete', removed, linewise);
    mode = operation === 'c' ? 'insert' : 'normal';
    resetPending();
    if (operation !== 'y') {
      lastChange = changeInputs;
      lastVisualChange = undefined;
    }
    if (operation === 'c') {
      insertFirstEdit = false;
      insertChange = changeInputs;
    }
    return snapshot([{ type: 'mode', mode }]);
  }

  function visualChange(
    visualMode: VisualChange['mode'],
    selections: readonly EditorSelection[],
    text: string,
  ): VisualChange {
    const from = Math.min(...selections.flatMap((selection) => [selection.anchor, selection.head]));
    const to = Math.max(...selections.flatMap((selection) => [selection.anchor, selection.head]));
    if (visualMode === 'visual-block') {
      return {
        mode: visualMode,
        width: Math.max(1, ...selections.map((selection) => graphemeCount(text.slice(
          Math.min(selection.anchor, selection.head),
          Math.max(selection.anchor, selection.head),
        )))),
        height: selections.length,
        linewiseChange: false,
        insert: '',
      };
    }
    if (visualMode === 'visual-line') {
      return {
        mode: visualMode,
        width: 0,
        height: lineNumber(text, Math.max(from, to - 1)) - lineNumber(text, from) + 1,
        linewiseChange: false,
        insert: '',
      };
    }
    return {
      mode: visualMode,
      width: graphemeCount(text.slice(from, to)),
      height: 1,
      linewiseChange: false,
      insert: '',
    };
  }

  function advanceGraphemes(text: string, position: number, count: number): number {
    let result = position;
    for (let index = 0; index < count; index += 1) result = nextGrapheme(text, result);
    return result;
  }

  function repeatVisual(change: VisualChange): EditorResult {
    const text = document.text();
    const position = cursor();
    let ranges: { from: number; to: number }[];
    if (change.mode === 'visual-character') {
      ranges = [{ from: position, to: advanceGraphemes(text, position, change.width) }];
    } else if (change.mode === 'visual-line') {
      const from = lineStart(text, position);
      const to = lineAt(text, lineNumber(text, from) + change.height);
      ranges = [{ from, to: to === from ? text.length : to }];
    } else {
      const firstLine = lineNumber(text, position);
      const column = graphemeColumn(text, lineStart(text, position), position);
      ranges = [];
      for (let offset = 0; offset < change.height; offset += 1) {
        const start = lineAt(text, firstLine + offset);
        if (offset > 0 && start === lineAt(text, firstLine + offset - 1)) break;
        ranges.push({
          from: positionAtGraphemeColumn(text, start, column),
          to: positionAtGraphemeColumn(text, start, column + change.width),
        });
      }
    }
    const ordered = ranges.sort((left, right) => right.from - left.from);
    const removed = [...ordered].reverse().map((range) => text.slice(range.from, range.to)).join('\n');
    const targetHasLineBreak = change.mode === 'visual-line'
      && ordered.some((range) => text[range.to - 1] === '\n');
    const insert = change.linewiseChange && targetHasLineBreak
      ? `${change.insert}\n`
      : change.insert;
    const changes = ordered.map((range) => ({ from: range.from, to: range.to, insert }));
    const positions = positionsAfterChanges(changes);
    if (!commit(changes, [{ anchor: positions[0] ?? 0, head: positions[0] ?? 0 }], 'new')) return snapshot();
    writeRegisters('delete', removed, change.mode === 'visual-line');
    mode = 'normal';
    lastVisualChange = change;
    lastChange = undefined;
    resetPending();
    return snapshot([{ type: 'mode', mode }]);
  }

  function rangeForMotion(key: string, target: number): { from: number; to: number; linewise: boolean } {
    const text = document.text();
    const position = cursor();
    if (key === 'j' || key === 'k' || key === 'G' || key === 'gg') {
      const from = lineStart(text, Math.min(position, target));
      const end = lineEnd(text, Math.max(position, target));
      return { from, to: end < text.length ? end + 1 : end, linewise: true };
    }
    const inclusive = '$eEfFtT%'.includes(key);
    return target >= position
      ? { from: position, to: inclusive ? nextGrapheme(text, target) : target, linewise: false }
      : { from: target, to: inclusive ? nextGrapheme(text, position) : position, linewise: false };
  }

  function search(direction: 'forward' | 'backward'): EditorResult {
    if (!searchState?.pattern) return snapshot([{ type: 'status', level: 'error', message: 'No previous search' }]);
    const compiled = compilePattern(searchState.pattern, {
      ignoreCase,
      smartCase,
    });
    if (!compiled) return snapshot([{ type: 'status', level: 'error', message: 'Unsupported search pattern' }]);
    const target = findMatch(document.text(), compiled, cursor(), direction, searchState.wholeWord);
    if (!target) return snapshot([{ type: 'status', level: 'error', message: 'Pattern not found' }]);
    select(target.from);
    return snapshot([{ type: 'search', query: searchState.pattern, direction, active: true }]);
  }

  function pushExHistory(command: string): void {
    commands.push(command);
    while (commands.length > EDITOR_LIMITS.exHistoryEntries
      || byteLength(commands.join('')) > EDITOR_LIMITS.exHistoryBytes) commands.shift();
  }

  function selectedRegister(): EditorRegister | undefined {
    const name = activeRegister ?? '"';
    activeRegister = undefined;
    if ((name === '+' || name === '*') && options.clipboardRegisters) {
      const value = options.clipboard?.read(name);
      return value === undefined ? registers.get(name) : { text: value, linewise: false };
    }
    if (name === '=') return options.expressionResult === undefined
      ? undefined : { text: options.expressionResult, linewise: false };
    if (name === '%') return options.currentFilename === undefined
      ? undefined : { text: options.currentFilename, linewise: false };
    return registers.get(name.toLocaleLowerCase()) ?? registers.get(name);
  }

  function transformRange(
    range: { from: number; to: number },
    transform: (value: string) => string,
  ): EditorResult {
    const value = document.text().slice(range.from, range.to);
    const insert = transform(value);
    if (!commit([{ ...range, insert }], [{ anchor: range.from, head: range.from }], 'new')) return snapshot();
    resetPending();
    lastChange = undefined;
    lastVisualChange = undefined;
    return snapshot();
  }

  function transformLines(from: number, to: number, direction: 'indent' | 'outdent'): EditorResult {
    const text = document.text();
    const start = lineStart(text, from);
    const end = to >= text.length ? text.length : lineEnd(text, Math.max(start, to));
    const original = text.slice(start, end);
    const indent = options.indentText ?? '  ';
    const insert = original.split('\n').map((line) => direction === 'indent'
      ? `${indent}${line}`
      : line.startsWith(indent) ? line.slice(indent.length) : line.replace(/^\s/u, '')).join('\n');
    if (!commit([{ from: start, to: end, insert }], [{ anchor: start, head: start }], 'new')) return snapshot();
    resetPending();
    return snapshot();
  }

  function paste(before: boolean): EditorResult {
    const value = selectedRegister();
    if (!value) return snapshot([{ type: 'status', level: 'error', message: 'Register is empty' }]);
    const text = document.text();
    let position: number;
    let insert = value.text;
    if (value.linewise) {
      position = before ? lineStart(text, cursor()) : Math.min(text.length, lineEnd(text, cursor()) + 1);
      if (!insert.endsWith('\n')) insert += '\n';
    } else position = before ? cursor() : nextGrapheme(text, cursor());
    const head = position + Math.max(0, insert.length - (value.linewise ? 1 : 0));
    if (!apply(position, position, insert, head, 'new')) return snapshot();
    lastChange = [before ? 'P' : 'p'];
    return snapshot();
  }

  function joinLines(): EditorResult {
    const text = document.text();
    const end = lineEnd(text, cursor());
    if (end >= text.length) return snapshot([{ type: 'status', level: 'error', message: 'No next line to join' }]);
    let from = end;
    while (from > lineStart(text, cursor()) && /\s/u.test(text[from - 1]!)) from -= 1;
    let to = end + 1;
    while (to < text.length && /[\t ]/u.test(text[to]!)) to += 1;
    if (!commit([{ from, to, insert: ' ' }], [{ anchor: from, head: from }], 'new')) return snapshot();
    lastChange = ['J'];
    return snapshot();
  }

  function changeNumber(delta: 1 | -1): EditorResult {
    const text = document.text();
    const tail = text.slice(cursor());
    const match = /[-+]?\d+/u.exec(tail);
    if (!match) return snapshot([{ type: 'status', level: 'error', message: 'No number under cursor' }]);
    const from = cursor() + match.index;
    const original = match[0];
    const value = Number(original);
    if (!Number.isSafeInteger(value)) return snapshot([{ type: 'status', level: 'error', message: 'Number is out of range' }]);
    const nextValue = value + delta;
    const sign = nextValue < 0 ? '-' : original.startsWith('+') ? '+' : '';
    const digits = String(Math.abs(nextValue)).padStart(original.replace(/^[-+]/u, '').length, '0');
    const insert = `${sign}${digits}`;
    if (!commit([{ from, to: from + original.length, insert }], [{ anchor: from, head: from }], 'new')) return snapshot();
    lastChange = [{ key: delta > 0 ? 'a' : 'x', ctrlKey: true }];
    return snapshot();
  }

  async function invoke(
    command: Parameters<EditorDocumentPort['command']>[0],
    argument?: string,
  ): Promise<EditorAction> {
    try {
      return { type: 'command', command, success: await document.command(command, argument) };
    } catch {
      return { type: 'status', level: 'error', message: `Document command failed: ${command}` };
    }
  }

  async function executeEx(commandText: string): Promise<EditorResult> {
    if (byteLength(commandText) > EDITOR_LIMITS.exCommandBytes) {
      mode = 'normal';
      inputBuffer = '';
      inputBufferBytes = 0;
      return snapshot([{
        type: 'status', level: 'error', message: `Ex command exceeds limit (${EDITOR_LIMITS.exCommandBytes} bytes)`,
      }]);
    }
    const command = commandText.trim();
    pushExHistory(command);
    mode = 'normal';
    inputBuffer = '';
    inputBufferBytes = 0;
    if (command.includes('|')) return snapshot([{ type: 'status', level: 'error', message: 'Pipes are not allowed' }]);
    if (command.startsWith('!')) return snapshot([{ type: 'status', level: 'error', message: 'Shell commands are not allowed' }]);
    if (/^source(?:\s|$)/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Source commands are not allowed' }]);
    }
    if (/^(?:(?:%|\d+(?:,\d+)?)\s*)?g(?:lobal)?(?:\/|\s|$)/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Global commands are not supported' }]);
    }
    if (/^(?:w|write|save|e|edit)\s+\S/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Filesystem arguments are not allowed' }]);
    }
    const parsed = parseExCommand(command);
    if (parsed.type === 'capability') return snapshot([await invoke(parsed.command)]);
    if (parsed.type === 'buffer') return snapshot([await invoke('select-buffer', parsed.name)]);
    if (parsed.type === 'option') {
      if (parsed.name === 'ignore-case') ignoreCase = parsed.enabled;
      if (parsed.name === 'smart-case') smartCase = parsed.enabled;
      const action = await invoke('set-option', `${parsed.name}=${parsed.enabled}`);
      return snapshot([{ type: 'option', name: parsed.name, enabled: parsed.enabled }, action]);
    }
    if (parsed.type === 'substitute') {
      if (!parsed.pattern) return snapshot([{ type: 'status', level: 'error', message: 'Empty substitute pattern' }]);
      const compiled = compilePattern(parsed.pattern, { ignoreCase, smartCase });
      if (!compiled) return snapshot([{
        type: 'status', level: 'error', message: 'Unsupported substitute pattern',
      }]);
      const text = document.text();
      let from = lineStart(text, cursor());
      let to = lineEnd(text, cursor());
      if (parsed.range === '%') {
        from = 0;
        to = text.length;
      } else if (parsed.range) {
        from = lineAt(text, Math.max(0, parsed.range.from - 1));
        const last = lineAt(text, Math.max(0, parsed.range.to - 1));
        to = lineEnd(text, last);
      }
      const original = text.slice(from, to);
      const substitution = substituteText(
        original,
        compiled,
        parsed.replacement,
        parsed.global,
        EDITOR_LIMITS.macroActions,
      );
      if (!substitution) return snapshot([{
        type: 'status', level: 'error',
        message: `Substitute exceeds replacement limit (${EDITOR_LIMITS.macroActions})`,
      }]);
      if (parsed.confirm) {
        const confirmation = await invoke('confirm-substitute', JSON.stringify({
          pattern: parsed.pattern,
          replacement: parsed.replacement,
          replacements: substitution.replacements,
        }));
        if (confirmation.type !== 'command' || !confirmation.success) return snapshot([confirmation]);
      }
      if (substitution.replacements > 0
        && !commit([{ from, to, insert: substitution.text }], [{ anchor: from, head: from }], 'new')) return snapshot();
      return snapshot();
    }
    const single = new Map<string, Parameters<EditorDocumentPort['command']>[0]>([
      ['w', 'save'], ['write', 'save'], ['save', 'save'],
      ['wa', 'save-all'], ['write-all', 'save-all'], ['save-all', 'save-all'],
      ['q', 'close'], ['quit', 'close'], ['q!', 'force-close'], ['force-quit', 'force-close'],
      ['bn', 'next-buffer'], ['next', 'next-buffer'], ['bp', 'previous-buffer'], ['previous', 'previous-buffer'],
    ]);
    const mapped = single.get(command.toLowerCase());
    if (mapped) return snapshot([await invoke(mapped)]);
    if (['wq', 'write-quit', 'x'].includes(command.toLowerCase())) {
      const save = await invoke('save');
      const actions: EditorAction[] = [save];
      if (save.type === 'command' && save.success) actions.push(await invoke('close'));
      return snapshot(actions);
    }
    if (/^\d+$/u.test(command)) {
      select(lineAt(document.text(), Math.max(0, Number(command) - 1)));
      return snapshot();
    }
    if (command === 'noh' || command === 'nohlsearch') {
      if (searchState) searchState = { ...searchState, highlight: false };
      return snapshot([{
        type: 'search',
        query: searchState?.pattern ?? '',
        direction: searchState?.direction ?? 'forward',
        active: false,
      }]);
    }
    return snapshot([{
      type: 'status',
      level: 'error',
      message: truncateBytes(`Unknown Ex command: ${command}`, EDITOR_LIMITS.exCommandBytes),
    }]);
  }

  async function replay(
    inputs: readonly EditorInput[],
    macro: boolean,
    repetitions = 1,
  ): Promise<EditorResult> {
    const recovery = {
      mode,
      pending,
      countBuffer,
      operatorCount,
      activeRegister,
      visualAnchor,
      visualHead,
      inputBuffer,
      inputBufferBytes,
      searchState,
      insertFirstEdit,
      insertChange,
      lastChange,
      lastVisualChange,
      activeVisualChange,
      macroDepth,
      macroActions: macroBudget.actions,
      invocationGroup,
    };
    if (macro) {
      if (macroDepth >= EDITOR_LIMITS.macroDepth) {
        return snapshot([{
          type: 'status', level: 'error', message: `Macro recursion limit reached (${EDITOR_LIMITS.macroDepth})`,
        }]);
      }
      if (macroDepth === 0) {
        macroBudget.actions = 0;
        invocationGroup = { used: false };
      }
      macroDepth += 1;
    } else invocationGroup = { used: false };
    let failed = false;
    try {
      let result = snapshot();
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const input of inputs) {
          if (macro && !consumeReplayAction(macroBudget, EDITOR_LIMITS.macroActions)) {
            return snapshot([{
              type: 'status', level: 'error', message: `Macro action limit reached (${EDITOR_LIMITS.macroActions})`,
            }]);
          }
          result = await handle(input, true);
          const transactionFailure = result.actions.some((action) => action.type === 'status'
            && action.level === 'error' && action.message === 'Editor transaction failed');
          if (transactionFailure) {
            failed = true;
            mode = recovery.mode;
            pending = recovery.pending;
            countBuffer = recovery.countBuffer;
            operatorCount = recovery.operatorCount;
            activeRegister = recovery.activeRegister;
            visualAnchor = recovery.visualAnchor;
            visualHead = recovery.visualHead;
            inputBuffer = recovery.inputBuffer;
            inputBufferBytes = recovery.inputBufferBytes;
            searchState = recovery.searchState;
            insertFirstEdit = recovery.insertFirstEdit;
            insertChange = recovery.insertChange;
            lastChange = recovery.lastChange;
            lastVisualChange = recovery.lastVisualChange;
            activeVisualChange = recovery.activeVisualChange;
            macroDepth = recovery.macroDepth;
            macroBudget.actions = recovery.macroActions;
            invocationGroup = recovery.invocationGroup;
            return snapshot(result.actions);
          }
          if (result.actions.some((action) => action.type === 'status' && action.level === 'error')) return result;
        }
      }
      return result;
    } catch {
      failed = true;
      mode = recovery.mode;
      pending = recovery.pending;
      countBuffer = recovery.countBuffer;
      operatorCount = recovery.operatorCount;
      activeRegister = recovery.activeRegister;
      visualAnchor = recovery.visualAnchor;
      visualHead = recovery.visualHead;
      inputBuffer = recovery.inputBuffer;
      inputBufferBytes = recovery.inputBufferBytes;
      searchState = recovery.searchState;
      insertFirstEdit = recovery.insertFirstEdit;
      insertChange = recovery.insertChange;
      lastChange = recovery.lastChange;
      lastVisualChange = recovery.lastVisualChange;
      activeVisualChange = recovery.activeVisualChange;
      macroDepth = recovery.macroDepth;
      macroBudget.actions = recovery.macroActions;
      invocationGroup = recovery.invocationGroup;
      return snapshot([{ type: 'status', level: 'error', message: 'Editor replay failed' }]);
    } finally {
      if (!failed) {
        macroDepth = recovery.macroDepth;
        invocationGroup = recovery.invocationGroup;
      }
    }
  }

  function appendInputText(text: string): EditorResult {
    const nextBytes = inputBufferBytes + byteLength(text);
    const limit = mode === 'search' ? EDITOR_LIMITS.searchPatternBytes : EDITOR_LIMITS.exCommandBytes;
    if (nextBytes > limit) {
      const label = mode === 'search' ? 'Search pattern' : 'Ex command';
      mode = 'normal';
      inputBuffer = '';
      inputBufferBytes = 0;
      resetPending();
      return snapshot([{
        type: 'status', level: 'error', message: `${label} exceeds limit (${limit} bytes)`,
      }]);
    }
    inputBuffer += text;
    inputBufferBytes = nextBytes;
    return snapshot();
  }

  async function handleCommittedText(
    input: Extract<EditorInput, { kind: 'text' | 'paste' }>,
    replaying: boolean,
  ): Promise<EditorResult> {
    if (!input.text) return snapshot();
    if (recording && !replaying) {
      recording.inputs.push(input);
      if (recording.inputs.length > EDITOR_LIMITS.macroActions) {
        recording = undefined;
        return snapshot([{ type: 'status', level: 'error', message: 'Macro recording limit reached (10000)' }]);
      }
    }
    if (mode === 'command-line' || mode === 'search') return appendInputText(input.text);
    if (mode !== 'insert' && mode !== 'replace') return snapshot();
    if (mode === 'insert' && activeVisualChange?.mode === 'visual-block' && document.selections().length > 1) {
      if (!insertAtSelections(input.text)) return snapshot();
      insertFirstEdit = false;
      activeVisualChange.insert += input.text;
      insertChange ??= ['i'];
      insertChange.push(input);
      return snapshot();
    }
    const position = cursor();
    const to = mode === 'replace'
      ? advanceGraphemes(document.text(), position, graphemeCount(input.text))
      : position;
    if (!apply(position, to, input.text, position + input.text.length, insertFirstEdit ? 'new' : 'join')) {
      return snapshot();
    }
    insertFirstEdit = false;
    if (activeVisualChange) activeVisualChange.insert += input.text;
    insertChange ??= [mode === 'replace' ? 'R' : 'i'];
    insertChange.push(input);
    return snapshot();
  }

  async function handle(input: EditorInput, replaying = false): Promise<EditorResult> {
    if (isCommittedText(input)) return handleCommittedText(input, replaying);
    const value = token(input);
    const key = displayToken(value);

    if (recording && !replaying) {
      if (mode === 'normal' && key === 'q' && !pending) {
        const completed = recording;
        recording = undefined;
        setRegister(completed.name, completed.inputs.map(inputDisplay).join(''));
        macros.set(completed.name, [...completed.inputs]);
        return snapshot([{ type: 'status', level: 'info', message: `Recorded macro ${completed.name}` }]);
      }
      recording.inputs.push(input);
      if (recording.inputs.length > EDITOR_LIMITS.macroActions) {
        recording = undefined;
        return snapshot([{ type: 'status', level: 'error', message: 'Macro recording limit reached (10000)' }]);
      }
    }

    if (value.key === 'Escape') {
      if (mode.startsWith('visual-')) {
        const selections = document.selections();
        marks.set('<', Math.min(...selections.flatMap((selection) => [selection.anchor, selection.head])));
        marks.set('>', Math.max(...selections.flatMap((selection) => [selection.anchor, selection.head])));
      }
      if ((mode === 'insert' || mode === 'replace') && activeVisualChange) {
        lastVisualChange = activeVisualChange;
        lastChange = undefined;
        activeVisualChange = undefined;
      } else if ((mode === 'insert' || mode === 'replace') && insertChange) {
        lastChange = [...insertChange, 'Escape'];
        lastVisualChange = undefined;
      }
      if (mode === 'insert' || mode === 'replace') {
        marks.set('^', cursor());
        const inserted = insertChange?.slice(1).map(inputDisplay).join('') ?? activeVisualChange?.insert ?? '';
        if (inserted) setRegister('.', inserted);
      }
      insertChange = undefined;
      return enter('normal');
    }

    if (mode === 'insert' || mode === 'replace') {
      if (value.ctrl || value.alt || value.meta || key.length !== 1) return snapshot();
      if (mode === 'insert' && activeVisualChange?.mode === 'visual-block' && document.selections().length > 1) {
        if (!insertAtSelections(key)) return snapshot();
        insertFirstEdit = false;
        activeVisualChange.insert += key;
        return snapshot();
      }
      const position = cursor();
      const to = mode === 'replace' ? nextGrapheme(document.text(), position) : position;
      if (!apply(position, to, key, position + key.length, insertFirstEdit ? 'new' : 'join')) return snapshot();
      insertFirstEdit = false;
      if (activeVisualChange) activeVisualChange.insert += key;
      insertChange ??= [mode === 'replace' ? 'R' : 'i'];
      insertChange.push(input);
      return snapshot();
    }

    if (mode === 'command-line' || mode === 'search') {
      if (key === 'Backspace') {
        inputBuffer = inputBuffer.slice(0, previousGrapheme(inputBuffer, inputBuffer.length));
        inputBufferBytes = byteLength(inputBuffer);
        return snapshot();
      }
      if (key === 'Enter') {
        if (mode === 'command-line') return executeEx(inputBuffer);
        const direction = searchState?.direction ?? 'forward';
        if (/\\(?:[1-9]|k<)/u.test(inputBuffer) || /\(\?/u.test(inputBuffer)) {
          mode = 'normal';
          return snapshot([{ type: 'status', level: 'error', message: 'Unsupported search pattern' }]);
        }
        try {
          void new RegExp(inputBuffer, 'u');
        } catch {
          mode = 'normal';
          return snapshot([{ type: 'status', level: 'error', message: 'Invalid search pattern' }]);
        }
        if (!compilePattern(inputBuffer, {
          ignoreCase: options.ignoreCase ?? false,
          smartCase: options.smartCase ?? false,
        })) {
          mode = 'normal';
          return snapshot([{ type: 'status', level: 'error', message: 'Unsupported search pattern' }]);
        }
        searchState = { pattern: inputBuffer, direction, highlight: true };
        mode = 'normal';
        return search(direction);
      }
      if (!value.ctrl && !value.alt && !value.meta && key.length === 1) {
        return appendInputText(key);
      }
      return snapshot();
    }

    if ((!pending || /^[dcy]$/u.test(pending))
      && !value.ctrl && !value.alt && !value.meta && /^[1-9]$/u.test(value.key)) {
      return appendCount(value.key);
    }
    if (!pending && countBuffer && value.key === '0') {
      return appendCount('0');
    }

    if (pending === '"') {
      pending = '';
      if ((key === '+' || key === '*') && !options.clipboardRegisters) {
        activeRegister = undefined;
        return snapshot([{ type: 'status', level: 'error', message: `Clipboard register ${key} is disabled` }]);
      }
      activeRegister = key;
      return snapshot();
    }
    if (pending === 'm') {
      pending = '';
      if (!/^[A-Za-z]$/u.test(key)) return snapshot([{ type: 'status', level: 'error', message: `Invalid mark ${key}` }]);
      if (/^[A-Z]$/u.test(key)) {
        if (!options.bufferId || !options.globalMarks) {
          return snapshot([{ type: 'status', level: 'error', message: `Global mark ${key} is unavailable` }]);
        }
        const reference = { buffer: options.bufferId, position: cursor() };
        options.globalMarks.set(key, reference);
        return snapshot([{ type: 'mark.set-global', mark: key, reference }]);
      }
      marks.set(key, cursor());
      return snapshot();
    }
    if (pending === '`' || pending === "'") {
      const exact = pending === '`';
      pending = '';
      if (/^[A-Z]$/u.test(key)) {
        const reference = options.globalMarks?.get(key);
        if (!reference) {
          return snapshot([{ type: 'status', level: 'error', message: `Global mark ${key} is not set` }]);
        }
        return snapshot([{ type: 'mark.jump-global', mark: key, reference, linewise: !exact }]);
      }
      const mark = marks.get(key);
      if (mark === undefined) return snapshot([{ type: 'status', level: 'error', message: `Mark ${key} is not set` }]);
      select(exact ? mark : lineStart(document.text(), mark));
      return snapshot();
    }
    if (pending === 'q') {
      pending = '';
      if (!/^[A-Za-z]$/u.test(key)) return snapshot([{ type: 'status', level: 'error', message: 'Invalid macro register' }]);
      recording = { name: key.toLowerCase(), inputs: [] };
      return snapshot([{ type: 'status', level: 'info', message: `Recording macro ${key}` }]);
    }
    if (pending === '@') {
      pending = '';
      const register = key.toLowerCase();
      const macro = macros.get(register)
        ?? (registers.has(register) ? [...registers.get(register)!.text] : undefined);
      if (!macro) return snapshot([{ type: 'status', level: 'error', message: `Macro ${key} is not set` }]);
      const repetitions = countBuffer ? Number(countBuffer) : 1;
      resetPending();
      return replay(macro, true, repetitions);
    }
    if ((pending === '>' || pending === '<') && key === pending) {
      const count = countBuffer ? Number(countBuffer) : 1;
      const text = document.text();
      const from = lineStart(text, cursor());
      const last = lineAt(text, lineNumber(text, from) + count - 1);
      return transformLines(from, lineEnd(text, last), pending === '>' ? 'indent' : 'outdent');
    }
    if (pending === 'g' && (key === 'u' || key === 'U' || key === '~')) {
      pending = `g${key}`;
      return snapshot();
    }
    if (pending === 'g' && key === 'q') {
      pending = 'gq';
      return snapshot();
    }
    if (pending === 'gq' && key === 'q') {
      resetPending();
      return snapshot([await invoke('format')]);
    }
    if (/^g[uU~]$/u.test(pending)) {
      const target = motion(key, value.shift, countBuffer ? Number(countBuffer) : 1);
      if (target === undefined) {
        resetPending();
        return snapshot([{ type: 'status', level: 'error', message: `Motion ${key} found no target` }]);
      }
      const range = rangeForMotion(key, target);
      const operation = pending[1]!;
      return transformRange(range, (text) => operation === 'u'
        ? text.toLocaleLowerCase()
        : operation === 'U'
          ? text.toLocaleUpperCase()
          : [...text].map((character) => character === character.toLocaleUpperCase()
            ? character.toLocaleLowerCase() : character.toLocaleUpperCase()).join(''));
    }

    if (!pending) {
      if (mode.startsWith('visual-') && (key === '>' || key === '<' || key === '~' || key === 'u' || key === 'U')) {
        const selections = document.selections();
        const from = Math.min(...selections.flatMap((selection) => [selection.anchor, selection.head]));
        const to = Math.max(...selections.flatMap((selection) => [selection.anchor, selection.head]));
        marks.set('<', from);
        marks.set('>', to);
        mode = 'normal';
        activeVisualChange = undefined;
        if (key === '>' || key === '<') {
          return transformLines(from, Math.max(from, to - 1), key === '>' ? 'indent' : 'outdent');
        }
        return transformRange({ from, to }, (text) => key === 'u'
          ? text.toLocaleLowerCase()
          : key === 'U'
            ? text.toLocaleUpperCase()
            : [...text].map((character) => character === character.toLocaleUpperCase()
              ? character.toLocaleLowerCase() : character.toLocaleUpperCase()).join(''));
      }
      if (key === '"' || key === 'm' || key === '`' || key === "'" || key === 'q' || key === '@') {
        pending = key;
        return snapshot();
      }
      if (key === '.') {
        if (lastVisualChange) return repeatVisual(lastVisualChange);
        if (!lastChange) return snapshot([{ type: 'status', level: 'error', message: 'No change to repeat' }]);
        return replay(lastChange, false);
      }
      if (value.ctrl && value.key === 'o') {
        const target = backJumps.pop();
        if (target === undefined) return snapshot([{ type: 'status', level: 'error', message: 'Jump list is empty' }]);
        forwardJumps.push(cursor());
        select(target, false);
        return snapshot();
      }
      if (value.ctrl && value.key === 'i') {
        const target = forwardJumps.pop();
        if (target === undefined) return snapshot([{ type: 'status', level: 'error', message: 'Jump list is empty' }]);
        backJumps.push(cursor());
        select(target, false);
        return snapshot();
      }
      if (value.ctrl && (value.key === 'a' || value.key === 'x')) return changeNumber(value.key === 'a' ? 1 : -1);
      if (value.ctrl && value.key === 'r') return snapshot([await invoke('redo')]);
      if (key === 'u') return snapshot([await invoke('undo')]);
      if (key === 'n' || key === 'N') {
        const base = searchState?.direction ?? 'forward';
        const direction = key === 'n' ? base : (base === 'forward' ? 'backward' : 'forward');
        const repetitions = countBuffer ? Number(countBuffer) : 1;
        resetPending();
        let result = snapshot();
        for (let index = 0; index < repetitions; index += 1) {
          result = search(direction);
          if (result.actions.some((action) => action.type === 'status' && action.level === 'error')) break;
        }
        return result;
      }
      if (key === '*' || key === '#') {
        const word = wordAt(document.text(), cursor());
        if (!word) return snapshot([{ type: 'status', level: 'error', message: 'No word under cursor' }]);
        const direction = key === '*' ? 'forward' : 'backward';
        searchState = { pattern: escapePattern(word), direction, highlight: true, wholeWord: true };
        const result = search(direction);
        return {
          ...result,
          search: result.search ? { ...result.search, pattern: word, wholeWord: true } : result.search,
          actions: result.actions.map((action) => action.type === 'search' ? { ...action, query: word } : action),
        };
      }
      if (value.ctrl && value.key === 'v') return enter('visual-block');
      if (key === 'i' || key === 'R' || key === 'a' || key === 'A') {
        if (key === 'a') select(nextGrapheme(document.text(), cursor()));
        if (key === 'A') select(lineEnd(document.text(), cursor()));
        insertChange = [key];
        return enter(key === 'R' ? 'replace' : 'insert');
      }
      if (key === 'o' || key === 'O') {
        const position = key === 'o' ? lineEnd(document.text(), cursor()) : lineStart(document.text(), cursor());
        if (!apply(position, position, '\n', key === 'o' ? position + 1 : position, 'new')) return snapshot();
        insertChange = [key];
        const result = enter('insert');
        insertFirstEdit = false;
        return result;
      }
      if (key === 's' || key === 'S') {
        const from = key === 'S' ? lineStart(document.text(), cursor()) : cursor();
        const to = key === 'S' ? lineEnd(document.text(), cursor()) : nextGrapheme(document.text(), cursor());
        if (!apply(from, to, '', from, 'new')) return snapshot();
        insertChange = [key];
        const result = enter('insert');
        insertFirstEdit = false;
        return result;
      }
      if (key === 'p' || key === 'P') return paste(key === 'P');
      if (key === 'J') return joinLines();
      if (key === '>' || key === '<') {
        pending = key;
        return snapshot();
      }
      if (key === 'v') return enter('visual-character');
      if (key === 'V') return enter('visual-line');
      if (key === ':') return enter('command-line');
      if (key === '/' || key === '?') {
        searchState = { pattern: '', direction: key === '/' ? 'forward' : 'backward', highlight: true };
        return enter('search');
      }
      if (mode.startsWith('visual-') && 'dcy'.includes(key)) {
        const selections = document.selections();
        const descriptor = visualChange(mode as VisualChange['mode'], selections, document.text());
        if (mode === 'visual-block') {
          const operation = key as 'd' | 'c' | 'y';
          const ranges = selections
            .map((selection) => ({
              from: Math.min(selection.anchor, selection.head),
              to: Math.max(selection.anchor, selection.head),
            }));
          const changes = ranges.map((range) => ({ from: range.from, to: range.to, insert: '' }));
          const insertionPositions = positionsAfterChanges(changes);
          const removed = [...ranges].sort((left, right) => left.from - right.from)
            .map((range) => document.text().slice(range.from, range.to)).join('\n');
          if (operation !== 'y') {
            const selections = operation === 'c'
              ? insertionPositions.map((position) => ({ anchor: position, head: position }))
              : [{ anchor: insertionPositions[0] ?? 0, head: insertionPositions[0] ?? 0 }];
            if (!commit(changes, selections, 'new')) return snapshot();
            lastChange = undefined;
            lastVisualChange = descriptor;
          } else {
            const origin = Math.min(...ranges.map((range) => range.from));
            if (!setSelections([{ anchor: origin, head: origin }])) return snapshot();
          }
          writeRegisters(operation === 'y' ? 'yank' : 'delete', removed, false);
          mode = operation === 'c' ? 'insert' : 'normal';
          if (operation === 'c') {
            insertFirstEdit = false;
            insertChange = [key];
            activeVisualChange = descriptor;
          }
          resetPending();
          return snapshot([{ type: 'mode', mode }]);
        }
        const from = Math.min(...selections.flatMap((selection) => [selection.anchor, selection.head]));
        const to = Math.max(...selections.flatMap((selection) => [selection.anchor, selection.head]));
        const linewise = mode === 'visual-line';
        const changeTo = key === 'c' && linewise && document.text()[to - 1] === '\n' ? to - 1 : to;
        descriptor.linewiseChange = key === 'c' && linewise;
        const result = operate(
          key as 'd' | 'c' | 'y',
          { from, to: changeTo },
          linewise,
          [key],
          key === 'c' && linewise ? document.text().slice(from, to) : undefined,
        );
        if (key !== 'y') {
          lastChange = undefined;
          lastVisualChange = descriptor;
        }
        if (key === 'c') activeVisualChange = descriptor;
        return result;
      }
      if ('dcy'.includes(key)) {
        operatorCount = countBuffer ? Number(countBuffer) : 1;
        countBuffer = '';
        pending = key;
        return snapshot();
      }
      if (key === 'g' || 'fFtT'.includes(key)) {
        pending = key;
        return snapshot();
      }
    }

    if (pending && 'dcy'.includes(pending)) {
      const operation = pending as 'd' | 'c' | 'y';
      const motionCount = countBuffer ? Number(countBuffer) : 1;
      if (key === operation) {
        const text = document.text();
        const total = operatorCount * motionCount;
        const from = lineStart(text, cursor());
        const target = lineAt(text, lineNumber(text, cursor()) + total);
        const to = target === from ? text.length : target;
        return operate(operation, { from, to }, true, [
          ...(total > 1 ? [...String(total)] : []), operation, operation,
        ]);
      }
      if (key === 'i' || key === 'a') {
        pending += key;
        return snapshot();
      }
      if (key === 'g' || 'fFtT'.includes(key)) {
        pending = `${operation}:${key}`;
        return snapshot();
      }
      const total = operatorCount * motionCount;
      const target = motion(key, value.shift, total);
      if (target === undefined) {
        resetPending();
        return snapshot([{ type: 'status', level: 'error', message: `Motion ${key} found no target` }]);
      }
      const range = rangeForMotion(key, target);
      return operate(operation, range, range.linewise, [
        ...(total > 1 ? [...String(total)] : []), operation, key,
      ]);
    }
    if (/^[dcy][ia]$/u.test(pending)) {
      const operation = pending[0] as 'd' | 'c' | 'y';
      const range = key === 't'
        ? options.syntaxTagObject?.(document.text(), cursor(), pending[1] === 'a')
        : objectRange(document.text(), cursor(), key, pending[1] === 'a');
      if (!range) {
        resetPending();
        return snapshot([{ type: 'status', level: 'error', message: `Text object ${key} not found` }]);
      }
      return operate(operation, range, false, [operation, pending[1]!, key]);
    }
    const operatorMotion = /^([dcy]):([gfFtT])$/u.exec(pending);
    if (operatorMotion) {
      const operation = operatorMotion[1] as 'd' | 'c' | 'y';
      const motionKey = operatorMotion[2] === 'g' ? (key === 'g' ? 'gg' : undefined) : operatorMotion[2]!;
      const target = motion(
        motionKey ?? '',
        value.shift,
        operatorCount * (countBuffer ? Number(countBuffer) : 1),
        'fFtT'.includes(operatorMotion[2]!) ? key : undefined,
      );
      if (target === undefined) {
        resetPending();
        const label = operatorMotion[2] === 'g' ? `g${key}` : `${operatorMotion[2]}${key}`;
        return snapshot([{ type: 'status', level: 'error', message: `Motion ${label} found no target` }]);
      }
      const range = rangeForMotion(motionKey!, target);
      return operate(operation, range, range.linewise, [operation, ...operatorMotion[2] === 'g' ? ['g', 'g'] : [operatorMotion[2]!, key]]);
    }

    const count = countBuffer ? Number(countBuffer) : 1;
    let motionKey = key;
    let argument: string | undefined;
    if (pending === 'g') {
      if (key !== 'g') {
        resetPending();
        return snapshot([{ type: 'status', level: 'error', message: `Unsupported motion g${key}` }]);
      }
      motionKey = 'gg';
    } else if (pending && 'fFtT'.includes(pending)) {
      motionKey = pending;
      argument = key;
    }
    const target = motion(motionKey, value.shift, count, argument);
    resetPending();
    if (target === undefined) {
      const message = motionKey === '%' ? 'No matching delimiter' : `Motion ${motionKey} found no target`;
      return snapshot([{ type: 'status', level: 'error', message }]);
    }
    select(target);
    return snapshot();
  }

  return {
    limits: EDITOR_LIMITS,
    handle,
    executeEx,
    snapshot: () => snapshot(),
    register: (name) => {
      if (name === '=' && options.expressionResult !== undefined) {
        return { text: options.expressionResult, linewise: false };
      }
      if (name === '%' && options.currentFilename !== undefined) {
        return { text: options.currentFilename, linewise: false };
      }
      if ((name === '+' || name === '*') && options.clipboardRegisters) {
        const text = options.clipboard?.read(name);
        if (text !== undefined) return { text, linewise: false };
      }
      const value = registers.get(name.toLocaleLowerCase()) ?? registers.get(name);
      return value ? { ...value } : undefined;
    },
    setRegister,
    mark: (name) => marks.get(name),
    exHistory: () => [...commands],
  };
}
