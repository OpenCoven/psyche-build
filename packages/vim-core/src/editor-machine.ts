import { normalizeKeyboardEvent } from './normalize.js';
import type { KeyboardEventLike } from './types.js';

export type EditorMode =
  | 'normal'
  | 'insert'
  | 'replace'
  | 'visual-character'
  | 'visual-line'
  | 'visual-block'
  | 'command-line'
  | 'search';

export type EditorInput = string | KeyboardEventLike;
export type EditorSelection = { anchor: number; head: number };

export interface EditorDocumentPort {
  text(): string;
  selections(): readonly EditorSelection[];
  apply(edit: {
    from: number;
    to: number;
    insert: string;
    selections: readonly EditorSelection[];
    history: 'join' | 'new';
  }): void;
  command(
    action: 'save' | 'save-all' | 'close' | 'force-close' | 'next-buffer' | 'previous-buffer',
    argument?: string,
  ): Promise<boolean>;
}

export type EditorAction =
  | { type: 'mode'; mode: EditorMode }
  | { type: 'status'; level: 'info' | 'error'; message: string }
  | { type: 'search'; query: string; direction: 'forward' | 'backward'; active: boolean }
  | { type: 'option'; name: string; enabled: boolean }
  | { type: 'mark.set-global'; mark: string; reference: EditorGlobalMarkReference }
  | { type: 'mark.jump-global'; mark: string; reference: EditorGlobalMarkReference; linewise: boolean }
  | { type: 'command'; command: Parameters<EditorDocumentPort['command']>[0]; success: boolean };

export interface EditorGlobalMarkReference {
  readonly buffer: string;
  readonly position: number;
}

export interface EditorGlobalMarkStore {
  get(mark: string): EditorGlobalMarkReference | undefined;
  set(mark: string, reference: EditorGlobalMarkReference): void;
}

export interface EditorRegister {
  readonly text: string;
  readonly linewise: boolean;
}

export interface EditorSearchState {
  readonly pattern: string;
  readonly direction: 'forward' | 'backward';
  readonly highlight: boolean;
}

export const EDITOR_LIMITS = Object.freeze({
  registerEntries: 64,
  registerBytes: 1024 * 1024,
  macroDepth: 16,
  macroActions: 10_000,
  exHistoryEntries: 100,
  exHistoryBytes: 64 * 1024,
});

export interface EditorResult {
  readonly mode: EditorMode;
  readonly pending: string;
  readonly count: number | undefined;
  readonly actions: readonly EditorAction[];
  readonly search?: EditorSearchState;
}

export interface EditorMachine {
  readonly limits: typeof EDITOR_LIMITS;
  handle(input: EditorInput): Promise<EditorResult>;
  executeEx(command: string): Promise<EditorResult>;
  snapshot(): EditorResult;
  register(name: string): EditorRegister | undefined;
  setRegister(name: string, text: string, linewise?: boolean): boolean;
  mark(name: string): number | undefined;
  exHistory(): readonly string[];
}

export interface EditorMachineOptions {
  readonly clipboardRegisters?: boolean;
  readonly bufferId?: string;
  readonly globalMarks?: EditorGlobalMarkStore;
}

type Token = { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

interface VisualChange {
  readonly mode: 'visual-character' | 'visual-line' | 'visual-block';
  readonly width: number;
  readonly height: number;
  insert: string;
}

function token(input: EditorInput): Token {
  if (typeof input !== 'string') return normalizeKeyboardEvent(input);
  const lower = input.toLowerCase();
  const shift = input.length === 1 && lower !== input;
  return { key: shift ? lower : input, ctrl: false, alt: false, shift, meta: false };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function starts(text: string): number[] {
  const result = [...segmenter.segment(text)].map((part) => part.index);
  result.push(text.length);
  return result;
}

function previousGrapheme(text: string, position: number): number {
  let previous = 0;
  for (const start of starts(text)) {
    if (start >= position) break;
    previous = start;
  }
  return previous;
}

function nextGrapheme(text: string, position: number): number {
  for (const start of starts(text)) if (start > position) return start;
  return text.length;
}

function graphemeCount(text: string): number {
  return Math.max(0, starts(text).length - 1);
}

function graphemeColumn(text: string, line: number, position: number): number {
  const relative = Math.max(0, Math.min(lineEnd(text, line) - line, position - line));
  const boundaries = starts(text.slice(line, lineEnd(text, line)));
  let column = 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    if (boundaries[index]! > relative) break;
    column = index;
  }
  return column;
}

function positionAtGraphemeColumn(text: string, line: number, column: number): number {
  const boundaries = starts(text.slice(line, lineEnd(text, line)));
  return line + boundaries[Math.min(Math.max(0, column), boundaries.length - 1)]!;
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

function lineEnd(text: string, position: number): number {
  const end = text.indexOf('\n', position);
  return end < 0 ? text.length : end;
}

function lineNumber(text: string, position: number): number {
  return text.slice(0, position).split('\n').length - 1;
}

function lineAt(text: string, target: number): number {
  if (target <= 0) return 0;
  let position = 0;
  for (let line = 0; line < target; line += 1) {
    const end = text.indexOf('\n', position);
    if (end < 0) return lineStart(text, text.length);
    position = end + 1;
  }
  return position;
}

function lastLineStart(text: string): number {
  return lineStart(text, text.length);
}

function vertical(text: string, position: number, delta: number): number {
  const start = lineStart(text, position);
  const column = starts(text.slice(start, position)).length - 1;
  const targetStart = lineAt(text, Math.max(0, lineNumber(text, position) + delta));
  const targetEnd = lineEnd(text, targetStart);
  const boundaries = starts(text.slice(targetStart, targetEnd));
  return targetStart + boundaries[Math.min(column, Math.max(0, boundaries.length - 1))]!;
}

function kind(character: string, big: boolean): 'space' | 'word' | 'punctuation' {
  if (/\s/u.test(character)) return 'space';
  if (big || /[\p{Letter}\p{Number}_]/u.test(character)) return 'word';
  return 'punctuation';
}

function graphemes(text: string): { value: string; index: number }[] {
  return [...segmenter.segment(text)].map((part) => ({ value: part.segment, index: part.index }));
}

function wordForward(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  const found = parts.findIndex((part) => part.index >= position);
  if (found < 0) return text.length;
  let index = found;
  for (let step = 0; step < count; step += 1) {
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index < parts.length && kind(parts[index]!.value, big) === current) index += 1;
    while (index < parts.length && kind(parts[index]!.value, big) === 'space') index += 1;
  }
  return parts[index]?.index ?? text.length;
}

function wordBackward(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  let index = parts.findIndex((part) => part.index >= position);
  if (index < 0) index = parts.length;
  index -= 1;
  for (let step = 0; step < count; step += 1) {
    while (index > 0 && kind(parts[index]!.value, big) === 'space') index -= 1;
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index > 0 && kind(parts[index - 1]!.value, big) === current) index -= 1;
    if (step + 1 < count) index -= 1;
  }
  return parts[Math.max(0, index)]?.index ?? 0;
}

function wordEnd(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  const found = parts.findIndex((part) => part.index >= position);
  if (found < 0) return text.length;
  let index = found;
  for (let step = 0; step < count; step += 1) {
    if (step > 0) index += 1;
    while (index < parts.length && kind(parts[index]!.value, big) === 'space') index += 1;
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index + 1 < parts.length && kind(parts[index + 1]!.value, big) === current) index += 1;
  }
  return parts[index]?.index ?? text.length;
}

const pairs: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
const reversePairs: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };

function matchingDelimiter(text: string, position: number): number | undefined {
  const character = text[position];
  const close = character ? pairs[character] : undefined;
  const open = character ? reversePairs[character] : undefined;
  if (!close && !open) return undefined;
  const direction = close ? 1 : -1;
  const target = close ?? open!;
  let depth = 0;
  for (let cursor = position + direction; cursor >= 0 && cursor < text.length; cursor += direction) {
    if (text[cursor] === character) depth += 1;
    if (text[cursor] === target) {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return undefined;
}

function paragraph(text: string, position: number, direction: 1 | -1): number {
  if (direction > 0) {
    const match = /\n\s*\n/g.exec(text.slice(position));
    return match ? position + match.index + 1 : lastLineStart(text);
  }
  const prefix = text.slice(0, lineStart(text, position));
  let boundary = -1;
  for (const match of prefix.matchAll(/\n\s*\n/g)) boundary = match.index! + match[0].length;
  return boundary < 0 ? 0 : boundary;
}

function objectRange(
  text: string,
  position: number,
  object: string,
  around: boolean,
): { from: number; to: number } | undefined {
  if (object === 'w' || object === 'W') {
    const parts = graphemes(text);
    let index = parts.findIndex((part, partIndex) => {
      const end = parts[partIndex + 1]?.index ?? text.length;
      return part.index <= position && position < end;
    });
    if (index < 0) return undefined;
    const big = object === 'W';
    while (index < parts.length && kind(parts[index]!.value, big) === 'space') index += 1;
    if (index >= parts.length) return undefined;
    const objectKind = kind(parts[index]!.value, big);
    let first = index;
    let last = index + 1;
    while (first > 0 && kind(parts[first - 1]!.value, big) === objectKind) first -= 1;
    while (last < parts.length && kind(parts[last]!.value, big) === objectKind) last += 1;
    if (around) {
      if (last < parts.length && kind(parts[last]!.value, big) === 'space') {
        while (last < parts.length && kind(parts[last]!.value, big) === 'space') last += 1;
      } else {
        while (first > 0 && kind(parts[first - 1]!.value, big) === 'space') first -= 1;
      }
    }
    return { from: parts[first]!.index, to: parts[last]?.index ?? text.length };
  }

  if ('"\'`'.includes(object)) {
    const from = text.lastIndexOf(object, position);
    const to = from < 0 ? -1 : text.indexOf(object, Math.max(position + 1, from + 1));
    if (from < lineStart(text, position) || to < 0 || to > lineEnd(text, position)) return undefined;
    return around ? { from, to: to + object.length } : { from: from + object.length, to };
  }

  const open = ')]}'.includes(object) ? reversePairs[object]! : object;
  const close = pairs[open];
  if (!close) return undefined;
  for (let from = text.lastIndexOf(open, position); from >= 0; from = text.lastIndexOf(open, from - 1)) {
    const to = matchingDelimiter(text, from);
    if (to !== undefined && from <= position && position <= to) {
      return around ? { from, to: to + 1 } : { from: from + 1, to };
    }
  }
  return undefined;
}

function displayToken(value: Token): string {
  return value.shift && value.key.length === 1 ? value.key.toLocaleUpperCase() : value.key;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
  let searchState: EditorSearchState | undefined;
  let insertFirstEdit = true;
  let insertChange: EditorInput[] | undefined;
  let lastChange: EditorInput[] | undefined;
  let lastVisualChange: VisualChange | undefined;
  let activeVisualChange: VisualChange | undefined;
  let recording: { name: string; inputs: EditorInput[] } | undefined;
  let macroDepth = 0;
  let macroActions = 0;
  let invocationGroup: { used: boolean } | undefined;
  const registers = new Map<string, EditorRegister>();
  const marks = new Map<string, number>();
  const macros = new Map<string, readonly EditorInput[]>();
  const commands: string[] = [];

  function snapshot(actions: readonly EditorAction[] = []): EditorResult {
    return {
      mode,
      pending,
      count: countBuffer ? Number(countBuffer) : undefined,
      actions,
      ...(searchState ? { search: { ...searchState } } : {}),
    };
  }

  function cursor(): number {
    return mode.startsWith('visual-') ? visualHead : (document.selections()[0]?.head ?? 0);
  }

  function history(defaultHistory: 'join' | 'new'): 'join' | 'new' {
    if (!invocationGroup) return defaultHistory;
    const result = invocationGroup.used ? 'join' : 'new';
    invocationGroup.used = true;
    return result;
  }

  function apply(from: number, to: number, insert: string, position: number, group: 'join' | 'new'): void {
    document.apply({
      from,
      to,
      insert,
      selections: [{ anchor: position, head: position }],
      history: history(group),
    });
  }

  function select(position: number): void {
    const text = document.text();
    const bounded = Math.max(0, Math.min(text.length, position));
    visualHead = bounded;
    let selections: readonly EditorSelection[] = [{ anchor: bounded, head: bounded }];
    if (mode === 'visual-character') {
      const from = Math.min(visualAnchor, bounded);
      const to = nextGrapheme(text, Math.max(visualAnchor, bounded));
      selections = [{ anchor: from, head: to }];
    }
    if (mode === 'visual-line') {
      const from = lineStart(text, Math.min(visualAnchor, bounded));
      const finalEnd = lineEnd(text, Math.max(visualAnchor, bounded));
      selections = [{
        anchor: from,
        head: finalEnd < text.length ? finalEnd + 1 : finalEnd,
      }];
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
      for (let line = Math.min(firstLine, lastLine); line <= Math.max(firstLine, lastLine); line += 1) {
        const start = lineAt(text, line);
        block.push({
          anchor: positionAtGraphemeColumn(text, start, fromColumn),
          head: positionAtGraphemeColumn(text, start, toColumn),
        });
      }
      selections = block;
    }
    const current = document.selections()[0]?.head ?? 0;
    document.apply({ from: current, to: current, insert: '', selections, history: 'join' });
  }

  function resetPending(): void {
    pending = '';
    countBuffer = '';
    operatorCount = 1;
    activeRegister = undefined;
  }

  function enter(next: EditorMode): EditorResult {
    mode = next;
    resetPending();
    inputBuffer = '';
    if (next.startsWith('visual-')) visualAnchor = visualHead = document.selections()[0]?.head ?? 0;
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
  ): EditorResult {
    const from = Math.max(0, Math.min(range.from, range.to));
    const to = Math.min(document.text().length, Math.max(range.from, range.to));
    const removed = document.text().slice(from, to);
    writeRegisters(operation === 'y' ? 'yank' : 'delete', removed, linewise);
    mode = operation === 'c' ? 'insert' : 'normal';
    resetPending();
    if (operation !== 'y') {
      apply(from, to, '', from, 'new');
      lastChange = changeInputs;
      lastVisualChange = undefined;
    } else select(from);
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
        insert: '',
      };
    }
    if (visualMode === 'visual-line') {
      return {
        mode: visualMode,
        width: 0,
        height: lineNumber(text, Math.max(from, to - 1)) - lineNumber(text, from) + 1,
        insert: '',
      };
    }
    return { mode: visualMode, width: graphemeCount(text.slice(from, to)), height: 1, insert: '' };
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
    writeRegisters('delete', removed, change.mode === 'visual-line');
    invocationGroup = { used: false };
    for (const range of ordered) apply(range.from, range.to, change.insert, range.from + change.insert.length, 'new');
    invocationGroup = undefined;
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
    let expression: RegExp;
    try {
      expression = new RegExp(searchState.pattern, 'gu');
    } catch {
      return snapshot([{ type: 'status', level: 'error', message: 'Invalid search pattern' }]);
    }
    const matches = [...document.text().matchAll(expression)].map((match) => match.index);
    if (matches.length === 0) return snapshot([{ type: 'status', level: 'error', message: 'Pattern not found' }]);
    const position = cursor();
    const target = direction === 'forward'
      ? (matches.find((match) => match > position) ?? matches[0]!)
      : ([...matches].reverse().find((match) => match < position) ?? matches.at(-1)!);
    select(target);
    return snapshot([{ type: 'search', query: searchState.pattern, direction, active: true }]);
  }

  function pushExHistory(command: string): void {
    commands.push(command);
    while (commands.length > EDITOR_LIMITS.exHistoryEntries
      || byteLength(commands.join('')) > EDITOR_LIMITS.exHistoryBytes) commands.shift();
  }

  async function invoke(command: Parameters<EditorDocumentPort['command']>[0]): Promise<EditorAction> {
    try {
      return { type: 'command', command, success: await document.command(command) };
    } catch {
      return { type: 'status', level: 'error', message: `Document command failed: ${command}` };
    }
  }

  async function executeEx(commandText: string): Promise<EditorResult> {
    const command = commandText.trim();
    pushExHistory(command);
    mode = 'normal';
    inputBuffer = '';
    if (command.includes('|')) return snapshot([{ type: 'status', level: 'error', message: 'Pipes are not allowed' }]);
    if (command.startsWith('!')) return snapshot([{ type: 'status', level: 'error', message: 'Shell commands are not allowed' }]);
    if (/^source(?:\s|$)/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Source commands are not allowed' }]);
    }
    if (/^(?:(?:%|\d+(?:,\d+)?)\s*)?(?:s(?:ubstitute)?|g(?:lobal)?)(?:\/|\s|$)/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Substitute and global commands are not supported' }]);
    }
    if (/^(?:w|write|save|e|edit)\s+\S/iu.test(command)) {
      return snapshot([{ type: 'status', level: 'error', message: 'Filesystem arguments are not allowed' }]);
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
    return snapshot([{ type: 'status', level: 'error', message: `Unknown Ex command: ${command}` }]);
  }

  async function replay(inputs: readonly EditorInput[], macro: boolean): Promise<EditorResult> {
    if (macro) {
      if (macroDepth >= EDITOR_LIMITS.macroDepth) {
        return snapshot([{
          type: 'status', level: 'error', message: `Macro recursion limit reached (${EDITOR_LIMITS.macroDepth})`,
        }]);
      }
      if (macroDepth === 0) {
        macroActions = 0;
        invocationGroup = { used: false };
      }
      macroDepth += 1;
    } else invocationGroup = { used: false };
    let result = snapshot();
    for (const input of inputs) {
      if (macro && ++macroActions > EDITOR_LIMITS.macroActions) {
        result = snapshot([{
          type: 'status', level: 'error', message: `Macro action limit reached (${EDITOR_LIMITS.macroActions})`,
        }]);
        break;
      }
      result = await handle(input, true);
      if (result.actions.some((action) => action.type === 'status' && action.level === 'error')) break;
    }
    if (macro) {
      macroDepth -= 1;
      if (macroDepth === 0) invocationGroup = undefined;
    } else invocationGroup = undefined;
    return result;
  }

  async function handle(input: EditorInput, replaying = false): Promise<EditorResult> {
    const value = token(input);
    const key = displayToken(value);

    if (recording && !replaying) {
      if (mode === 'normal' && key === 'q' && !pending) {
        const completed = recording;
        recording = undefined;
        setRegister(completed.name, completed.inputs.map((item) => displayToken(token(item))).join(''));
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
      if ((mode === 'insert' || mode === 'replace') && activeVisualChange) {
        lastVisualChange = activeVisualChange;
        lastChange = undefined;
        activeVisualChange = undefined;
      } else if ((mode === 'insert' || mode === 'replace') && insertChange) {
        lastChange = [...insertChange, 'Escape'];
        lastVisualChange = undefined;
      }
      insertChange = undefined;
      return enter('normal');
    }

    if (mode === 'insert' || mode === 'replace') {
      if (value.ctrl || value.alt || value.meta || key.length !== 1) return snapshot();
      const position = cursor();
      const to = mode === 'replace' ? nextGrapheme(document.text(), position) : position;
      apply(position, to, key, position + key.length, insertFirstEdit ? 'new' : 'join');
      insertFirstEdit = false;
      if (activeVisualChange) activeVisualChange.insert += key;
      insertChange ??= [mode === 'replace' ? 'R' : 'i'];
      insertChange.push(input);
      return snapshot();
    }

    if (mode === 'command-line' || mode === 'search') {
      if (key === 'Backspace') {
        inputBuffer = inputBuffer.slice(0, previousGrapheme(inputBuffer, inputBuffer.length));
        return snapshot();
      }
      if (key === 'Enter') {
        if (mode === 'command-line') return executeEx(inputBuffer);
        const direction = searchState?.direction ?? 'forward';
        try {
          void new RegExp(inputBuffer, 'u');
        } catch {
          mode = 'normal';
          return snapshot([{ type: 'status', level: 'error', message: 'Invalid search pattern' }]);
        }
        searchState = { pattern: inputBuffer, direction, highlight: true };
        mode = 'normal';
        return search(direction);
      }
      if (!value.ctrl && !value.alt && !value.meta && key.length === 1) inputBuffer += key;
      return snapshot();
    }

    if ((!pending || /^[dcy]$/u.test(pending))
      && !value.ctrl && !value.alt && !value.meta && /^[1-9]$/u.test(value.key)) {
      countBuffer += value.key;
      return snapshot();
    }
    if (!pending && countBuffer && value.key === '0') {
      countBuffer += '0';
      return snapshot();
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
      return replay(Array.from({ length: repetitions }, () => macro).flat(), true);
    }

    if (!pending) {
      if (key === '"' || key === 'm' || key === '`' || key === "'" || key === 'q' || key === '@') {
        pending = key;
        return snapshot();
      }
      if (key === '.') {
        if (lastVisualChange) return repeatVisual(lastVisualChange);
        if (!lastChange) return snapshot([{ type: 'status', level: 'error', message: 'No change to repeat' }]);
        return replay(lastChange, false);
      }
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
      if (value.ctrl && value.key === 'v') return enter('visual-block');
      if (key === 'i' || key === 'R') {
        insertChange = [key];
        return enter(key === 'i' ? 'insert' : 'replace');
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
            }))
            .sort((left, right) => right.from - left.from);
          const removed = [...ranges].reverse().map((range) => document.text().slice(range.from, range.to)).join('\n');
          writeRegisters(operation === 'y' ? 'yank' : 'delete', removed, false);
          invocationGroup = { used: false };
          if (operation !== 'y') {
            for (const range of ranges) apply(range.from, range.to, '', range.from, 'new');
            lastChange = undefined;
            lastVisualChange = descriptor;
          }
          invocationGroup = undefined;
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
        const result = operate(key as 'd' | 'c' | 'y', { from, to }, mode === 'visual-line', [key]);
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
      const range = objectRange(document.text(), cursor(), key, pending[1] === 'a');
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
      const value = registers.get(name.toLocaleLowerCase()) ?? registers.get(name);
      return value ? { ...value } : undefined;
    },
    setRegister,
    mark: (name) => marks.get(name),
    exHistory: () => [...commands],
  };
}
