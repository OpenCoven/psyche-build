import { validateVimFixtures, type VimFixtureDocument } from './fixtures.js';
import type {
  EditorAction,
  EditorCapabilityCommand,
  EditorMode,
  EditorRegister,
  EditorSearchState,
  EditorSelection,
} from './editor/types.js';

/**
 * Versioned, fail-closed loader for the shared Vim v1 fixture set owned by
 * `protocol-fixtures/vim/v1/`. TypeScript adapters consume documents parsed by
 * this module; non-TypeScript adapters mirror the same schema and replay the
 * same traces through their platform seam: one format, one version, strict
 * validation, no silent drift.
 *
 * The module is intentionally platform-pure (no node/browser imports): it
 * parses and validates in-memory documents. Hosts read the JSON bytes with
 * whatever IO the platform owns (fs in tests/node, bundled imports or Swift
 * decoders elsewhere) and hand the text to `parseVimFixtureDocument`.
 */

/** The single shared fixture version. Same value as every canonical Vim v1 document. */
export const VIM_FIXTURE_VERSION = 'vim/v1' as const;

export type VimFixtureVersion = typeof VIM_FIXTURE_VERSION;

/** Maximum accepted byte length of one fixture document. */
export const MAX_FIXTURE_SOURCE_LENGTH = 1024 * 1024;
/** Maximum accepted number of traces in one editor fixture document. */
export const MAX_EDITOR_TRACES = 128;
/** Maximum accepted number of inputs in one editor fixture trace. */
export const MAX_EDITOR_INPUTS = 32;
/** Maximum accepted length of one fixture id. */
export const MAX_FIXTURE_ID_LENGTH = 128;
/** Maximum accepted length of fixture document/expected text. */
export const MAX_FIXTURE_TEXT_LENGTH = 2048;
/** Maximum accepted number of actions expected from one trace's final input. */
export const MAX_EDITOR_EXPECTED_ACTIONS = 16;
/** Maximum accepted number of register or mark assertions in one trace. */
export const MAX_EDITOR_EXPECTED_ENTRIES = 16;
/** Maximum accepted number of selection assertions in one trace. */
export const MAX_EDITOR_EXPECTED_SELECTIONS = 64;
/** Maximum accepted length of status/search strings inside expectations. */
export const MAX_FIXTURE_MESSAGE_LENGTH = 256;
/** Maximum accepted length of one key token. */
export const MAX_FIXTURE_KEY_LENGTH = 32;

const editorModes = new Set<EditorMode>([
  'normal', 'insert', 'replace', 'visual-character', 'visual-line', 'visual-block', 'command-line', 'search',
]);

const capabilityCommands = new Set<EditorCapabilityCommand>([
  'save', 'save-all', 'close', 'force-close', 'close-all', 'force-close-all', 'reload-buffer',
  'next-buffer', 'previous-buffer', 'select-buffer', 'undo', 'redo', 'format', 'set-option',
  'confirm-substitute', 'clipboard-read', 'clipboard-write', 'current-filename', 'expression-result',
]);

const exOptionNames = new Set(['number', 'relative-number', 'ignore-case', 'smart-case', 'wrap']);

const inputModifiers = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'] as const;

const textInputKinds = new Set<'text' | 'paste'>(['text', 'paste']);
const textInputSources = new Set<'composition' | 'beforeinput'>(['composition', 'beforeinput']);

/** Key token mirroring a DOM `KeyboardEventLike` subset. */
export interface VimFixtureKeyToken {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}

/** Committed IME text or pasted text, mirroring `EditorTextInput`/`EditorPasteInput`. */
export interface VimFixtureTextInput {
  readonly kind: 'text' | 'paste';
  readonly text: string;
  readonly source?: 'composition' | 'beforeinput';
}

/** One fixture input: a key name, a key token object, or committed/pasted text. */
export type VimEditorFixtureInput = string | VimFixtureKeyToken | VimFixtureTextInput;

/** Bounded expectation for the result of a trace's final input. */
export interface VimEditorFixtureExpected {
  readonly mode: EditorMode;
  readonly pending: string;
  readonly count?: number;
  readonly text: string;
  readonly cursor: number;
  readonly selections?: readonly EditorSelection[];
  readonly actions: readonly EditorAction[];
  readonly search?: EditorSearchState;
  /** Register names asserted through `EditorMachine.register` after the trace. */
  readonly registers?: Readonly<Record<string, EditorRegister>>;
  /** Mark names asserted through `EditorMachine.mark` after the trace. */
  readonly marks?: Readonly<Record<string, number>>;
}

/** One deterministic editor trace: start state, inputs, expected end state. */
export interface VimEditorFixtureTrace {
  readonly id: string;
  readonly document: { readonly text: string; readonly cursor: number };
  readonly inputs: readonly VimEditorFixtureInput[];
  readonly expected: VimEditorFixtureExpected;
}

/** A canonical Vim v1 document covering the editor state machine. */
export interface VimEditorFixtureDocument {
  readonly version: VimFixtureVersion;
  readonly kind: 'editor';
  readonly traces: readonly VimEditorFixtureTrace[];
}

/** A parsed fixture document: chrome (input contract) or editor (editing contract). */
export type ParsedVimFixtureDocument =
  | { readonly kind: 'chrome'; readonly document: VimFixtureDocument }
  | { readonly kind: 'editor'; readonly document: VimEditorFixtureDocument };

const chromeTraceFields = new Set(['id', 'context', 'sequence', 'disposition', 'expected', 'actions']);
const chromeTokenFields = new Set(['key', 'ctrl', 'alt', 'shift', 'meta']);
const chromeExpectedFields = new Set(['context', 'pending']);
const chromeDirectionalActionTypes = new Set(['focus.move', 'pane.focus', 'pane.resize']);

function invalid(origin: string, message: string): never {
  throw new TypeError(`Invalid Vim fixture${origin ? ` (${origin})` : ''}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exceedsUtf8ByteLength(value: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return true;
  }
  return false;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  origin: string,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(origin, `${label} has an unknown field ${field}`);
  }
}

function expectString(
  origin: string,
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; maxLength: number },
): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0) || value.length > options.maxLength) {
    invalid(origin, `${label} must be a string of 1..${options.maxLength} characters`);
  }
  return value;
}

function expectInteger(origin: string, value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(origin, `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function expectBoolean(origin: string, value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(origin, `${label} must be a boolean`);
  return value;
}

function expectOneOf<T extends string>(
  origin: string,
  value: unknown,
  label: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    invalid(origin, `${label} has an unsupported value`);
  }
  return value as T;
}

function validateInputToken(origin: string, token: unknown): VimEditorFixtureInput {
  if (typeof token === 'string') {
    const key = expectString(origin, token, 'input key', { maxLength: MAX_FIXTURE_KEY_LENGTH });
    // Key names never contain control characters; committed text uses the
    // explicit {kind: 'text'} form instead of embedding newlines in a token.
    if (/[\u0000-\u001f\u007f]/u.test(key)) invalid(origin, 'input key must not contain control characters');
    return key;
  }
  if (!isPlainObject(token)) invalid(origin, 'input must be a key string or an object');
  if ('kind' in token) {
    rejectUnknownFields(token, new Set(['kind', 'text', 'source']), origin, 'text input');
    const kind = expectOneOf(origin, token.kind, 'text input kind', textInputKinds);
    const text = expectString(origin, token.text, 'text input text', { maxLength: MAX_FIXTURE_TEXT_LENGTH });
    if (token.source === undefined) return { kind, text };
    const source = expectOneOf(origin, token.source, 'text input source', textInputSources);
    return { kind, text, source };
  }
  rejectUnknownFields(token, new Set(['key', ...inputModifiers]), origin, 'key input');
  const key = expectString(origin, token.key, 'key input key', { maxLength: MAX_FIXTURE_KEY_LENGTH });
  if (/[\u0000-\u001f\u007f]/u.test(key)) invalid(origin, 'key input must not contain control characters');
  const result: Record<string, string | boolean> = { key };
  for (const modifier of inputModifiers) {
    if (token[modifier] === undefined) continue;
    result[modifier] = expectBoolean(origin, token[modifier], `key input ${modifier}`);
  }
  return result as unknown as VimFixtureKeyToken;
}

function validateSelections(origin: string, value: unknown, textLength: number): EditorSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITOR_EXPECTED_SELECTIONS) {
    invalid(origin, `expected selections must be an array of 1..${MAX_EDITOR_EXPECTED_SELECTIONS}`);
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) invalid(origin, `expected selection ${index} must be an object`);
    rejectUnknownFields(entry, new Set(['anchor', 'head']), origin, `expected selection ${index}`);
    return {
      anchor: expectInteger(origin, entry.anchor, `expected selection ${index} anchor`, 0, textLength),
      head: expectInteger(origin, entry.head, `expected selection ${index} head`, 0, textLength),
    };
  });
}

function validateAction(origin: string, action: unknown, index: number): EditorAction {
  if (!isPlainObject(action)) invalid(origin, `expected action ${index} must be an object`);
  const type = expectString(origin, action.type, `expected action ${index} type`, { maxLength: MAX_FIXTURE_MESSAGE_LENGTH });
  switch (type) {
    case 'mode': {
      rejectUnknownFields(action, new Set(['type', 'mode']), origin, `expected action ${index}`);
      return { type, mode: expectOneOf(origin, action.mode, `expected action ${index} mode`, editorModes) };
    }
    case 'status': {
      rejectUnknownFields(action, new Set(['type', 'level', 'message']), origin, `expected action ${index}`);
      return {
        type,
        level: expectOneOf(origin, action.level, `expected action ${index} level`, new Set(['info', 'error'])),
        message: expectString(origin, action.message, `expected action ${index} message`, {
          allowEmpty: true, maxLength: MAX_FIXTURE_MESSAGE_LENGTH,
        }),
      };
    }
    case 'search': {
      rejectUnknownFields(action, new Set(['type', 'query', 'direction', 'active']), origin, `expected action ${index}`);
      return {
        type,
        query: expectString(origin, action.query, `expected action ${index} query`, {
          allowEmpty: true, maxLength: MAX_FIXTURE_MESSAGE_LENGTH,
        }),
        direction: expectOneOf(origin, action.direction, `expected action ${index} direction`, new Set(['forward', 'backward'])),
        active: expectBoolean(origin, action.active, `expected action ${index} active`),
      };
    }
    case 'option': {
      rejectUnknownFields(action, new Set(['type', 'name', 'enabled']), origin, `expected action ${index}`);
      return {
        type,
        name: expectOneOf(origin, action.name, `expected action ${index} name`, exOptionNames),
        enabled: expectBoolean(origin, action.enabled, `expected action ${index} enabled`),
      };
    }
    case 'command': {
      rejectUnknownFields(action, new Set(['type', 'command', 'success']), origin, `expected action ${index}`);
      return {
        type,
        command: expectOneOf(origin, action.command, `expected action ${index} command`, capabilityCommands),
        success: expectBoolean(origin, action.success, `expected action ${index} success`),
      };
    }
    case 'mark.set-global':
    case 'mark.jump-global': {
      rejectUnknownFields(action, new Set(['type', 'mark', 'reference', ...(type === 'mark.jump-global' ? ['linewise'] : [])]), origin, `expected action ${index}`);
      if (!isPlainObject(action.reference)) invalid(origin, `expected action ${index} reference must be an object`);
      rejectUnknownFields(action.reference, new Set(['buffer', 'position']), origin, `expected action ${index} reference`);
      const mark = expectString(origin, action.mark, `expected action ${index} mark`, { maxLength: 1 });
      const reference = {
        buffer: expectString(origin, action.reference.buffer, `expected action ${index} reference buffer`, { maxLength: 256 }),
        position: expectInteger(origin, action.reference.position, `expected action ${index} reference position`, 0, Number.MAX_SAFE_INTEGER),
      };
      if (type === 'mark.jump-global') {
        return { type: 'mark.jump-global', mark, reference, linewise: expectBoolean(origin, action.linewise, `expected action ${index} linewise`) };
      }
      return { type: 'mark.set-global', mark, reference };
    }
    default:
      invalid(origin, `expected action ${index} has an unsupported type ${type}`);
  }
}

function validateSearchState(origin: string, value: unknown): EditorSearchState {
  if (!isPlainObject(value)) invalid(origin, 'expected search must be an object');
  rejectUnknownFields(value, new Set(['pattern', 'direction', 'highlight', 'wholeWord']), origin, 'expected search');
  const state: Record<string, unknown> = {
    pattern: expectString(origin, value.pattern, 'expected search pattern', {
      allowEmpty: true, maxLength: MAX_FIXTURE_MESSAGE_LENGTH,
    }),
    direction: expectOneOf(origin, value.direction, 'expected search direction', new Set(['forward', 'backward'])),
    highlight: expectBoolean(origin, value.highlight, 'expected search highlight'),
  };
  if (value.wholeWord !== undefined) state.wholeWord = expectBoolean(origin, value.wholeWord, 'expected search wholeWord');
  return state as unknown as EditorSearchState;
}

function validateNamedEntries(
  origin: string,
  value: unknown,
  label: string,
  keyPattern: RegExp,
): Map<string, Record<string, unknown>> {
  if (!isPlainObject(value)) invalid(origin, `expected ${label} must be an object`);
  const names = Object.keys(value);
  if (names.length > MAX_EDITOR_EXPECTED_ENTRIES) {
    invalid(origin, `expected ${label} exceeds ${MAX_EDITOR_EXPECTED_ENTRIES} entries`);
  }
  const entries = new Map<string, Record<string, unknown>>();
  for (const name of names) {
    if (!keyPattern.test(name)) invalid(origin, `expected ${label} has an invalid name ${name}`);
    const entry = value[name];
    if (!isPlainObject(entry)) invalid(origin, `expected ${label} ${name} must be an object`);
    entries.set(name, entry);
  }
  return entries;
}

function validateExpected(origin: string, value: unknown, textLength: number): VimEditorFixtureExpected {
  if (!isPlainObject(value)) invalid(origin, 'expected must be an object');
  rejectUnknownFields(
    value,
    new Set(['mode', 'pending', 'count', 'text', 'cursor', 'selections', 'actions', 'search', 'registers', 'marks']),
    origin,
    'expected',
  );
  const text = expectString(origin, value.text, 'expected text', { allowEmpty: true, maxLength: MAX_FIXTURE_TEXT_LENGTH });
  if (text !== '' && /[\u0000]/u.test(text)) invalid(origin, 'expected text must not contain NUL characters');
  const actionsValue = value.actions;
  if (!Array.isArray(actionsValue) || actionsValue.length > MAX_EDITOR_EXPECTED_ACTIONS) {
    invalid(origin, `expected actions must be an array of up to ${MAX_EDITOR_EXPECTED_ACTIONS}`);
  }
  const expected: Record<string, unknown> = {
    mode: expectOneOf(origin, value.mode, 'expected mode', editorModes),
    pending: expectString(origin, value.pending, 'expected pending', { allowEmpty: true, maxLength: MAX_FIXTURE_MESSAGE_LENGTH }),
    text,
    cursor: expectInteger(origin, value.cursor, 'expected cursor', 0, text.length),
    actions: actionsValue.map((action, index) => validateAction(origin, action, index)),
  };
  if (value.count !== undefined) expected.count = expectInteger(origin, value.count, 'expected count', 0, 10_000);
  if (value.selections !== undefined) expected.selections = validateSelections(origin, value.selections, text.length);
  if (value.search !== undefined) expected.search = validateSearchState(origin, value.search);
  if (value.registers !== undefined) {
    const registers: Record<string, EditorRegister> = {};
    for (const [name, entry] of validateNamedEntries(origin, value.registers, 'registers', /^[\x21-\x7e]$/u)) {
      rejectUnknownFields(entry, new Set(['text', 'linewise']), origin, `expected register ${name}`);
      registers[name] = {
        text: expectString(origin, entry.text, `expected register ${name} text`, { allowEmpty: true, maxLength: MAX_FIXTURE_TEXT_LENGTH }),
        linewise: expectBoolean(origin, entry.linewise, `expected register ${name} linewise`),
      };
    }
    expected.registers = registers;
  }
  if (value.marks !== undefined) {
    if (!isPlainObject(value.marks)) invalid(origin, 'expected marks must be an object');
    const markNames = Object.keys(value.marks);
    if (markNames.length > MAX_EDITOR_EXPECTED_ENTRIES) {
      invalid(origin, `expected marks exceeds ${MAX_EDITOR_EXPECTED_ENTRIES} entries`);
    }
    const marks: Record<string, number> = {};
    for (const name of markNames) {
      if (!/^[\x21-\x7e]$/u.test(name)) invalid(origin, `expected marks has an invalid name ${name}`);
      marks[name] = expectInteger(origin, value.marks[name], `expected mark ${name} position`, 0, text.length);
    }
    expected.marks = marks;
  }
  return expected as unknown as VimEditorFixtureExpected;
}

function validateEditorDocument(document: Record<string, unknown>, origin: string): VimEditorFixtureDocument {
  rejectUnknownFields(document, new Set(['version', 'kind', 'traces']), origin, 'document');
  const tracesValue = document.traces;
  if (!Array.isArray(tracesValue) || tracesValue.length === 0 || tracesValue.length > MAX_EDITOR_TRACES) {
    invalid(origin, `document must contain 1..${MAX_EDITOR_TRACES} traces`);
  }
  const ids = new Set<string>();
  const traces = tracesValue.map((entry) => {
    if (!isPlainObject(entry)) invalid(origin, 'trace must be an object');
    rejectUnknownFields(entry, new Set(['id', 'document', 'inputs', 'expected']), origin, 'trace');
    const id = expectString(origin, entry.id, 'trace id', { maxLength: MAX_FIXTURE_ID_LENGTH });
    if (ids.has(id)) invalid(origin, `duplicate trace id ${id}`);
    ids.add(id);
    if (!isPlainObject(entry.document)) invalid(origin, `${id} must have a document object`);
    rejectUnknownFields(entry.document, new Set(['text', 'cursor']), origin, `${id} document`);
    const text = expectString(origin, entry.document.text, `${id} document text`, { allowEmpty: true, maxLength: MAX_FIXTURE_TEXT_LENGTH });
    const inputsValue = entry.inputs;
    if (!Array.isArray(inputsValue) || inputsValue.length === 0 || inputsValue.length > MAX_EDITOR_INPUTS) {
      invalid(origin, `${id} must have 1..${MAX_EDITOR_INPUTS} inputs`);
    }
    return {
      id,
      document: { text, cursor: expectInteger(origin, entry.document.cursor, `${id} document cursor`, 0, text.length) },
      inputs: inputsValue.map((token) => validateInputToken(origin, token)),
      expected: validateExpected(origin, entry.expected, text.length),
    };
  });
  return { version: VIM_FIXTURE_VERSION, kind: 'editor', traces };
}

/** Validates an editor fixture document. Throws `TypeError` on any deviation. */
export function validateEditorFixtures(document: unknown): asserts document is VimEditorFixtureDocument {
  const origin = '';
  if (!isPlainObject(document)) invalid(origin, 'document must be an object');
  validateEditorDocument(document, origin);
}

/**
 * Parses one fixture document (chrome or editor) from raw JSON text.
 * Dispatches on the optional `kind` field: documents declaring `kind: "editor"`
 * use the editor schema; documents without `kind` use the chrome input-contract
 * schema. Unknown versions and malformed JSON fail closed with a `TypeError`.
 */
export function parseVimFixtureDocument(source: string, origin = ''): ParsedVimFixtureDocument {
  if (
    typeof source !== 'string'
    || source.length === 0
    || exceedsUtf8ByteLength(source, MAX_FIXTURE_SOURCE_LENGTH)
  ) {
    invalid(origin, `source must be a non-empty UTF-8 string of up to ${MAX_FIXTURE_SOURCE_LENGTH} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid(origin, 'source is not valid JSON');
  }
  if (!isPlainObject(parsed)) invalid(origin, 'document must be a JSON object');
  const version = expectString(origin, parsed.version, 'document version', { maxLength: 32 });
  if (version !== VIM_FIXTURE_VERSION) {
    invalid(origin, `document declares unsupported version ${version}; expected ${VIM_FIXTURE_VERSION}`);
  }
  if (parsed.kind === undefined) {
    // Chrome (input contract) documents reuse the core validator, plus a
    // strict shape check at every nested level so drift fails closed here too.
    rejectUnknownFields(parsed, new Set(['version', 'traces']), origin, 'document');
    if (!Array.isArray(parsed.traces)) invalid(origin, 'document must contain traces');
    for (const trace of parsed.traces) {
      if (!isPlainObject(trace)) invalid(origin, 'trace must be an object');
      rejectUnknownFields(trace, chromeTraceFields, origin, 'trace');
      if (Array.isArray(trace.sequence)) {
        for (const token of trace.sequence) {
          if (isPlainObject(token)) rejectUnknownFields(token, chromeTokenFields, origin, 'trace token');
        }
      }
      if (isPlainObject(trace.expected)) {
        rejectUnknownFields(trace.expected, chromeExpectedFields, origin, 'trace expected state');
      }
      if (Array.isArray(trace.actions)) {
        for (const action of trace.actions) {
          if (!isPlainObject(action)) continue;
          const allowed = typeof action.type === 'string' && chromeDirectionalActionTypes.has(action.type)
            ? new Set(['type', 'direction'])
            : new Set(['type']);
          rejectUnknownFields(action, allowed, origin, 'trace action');
        }
      }
    }
    validateVimFixtures(parsed);
    return { kind: 'chrome', document: parsed as VimFixtureDocument };
  }
  if (parsed.kind !== 'editor') invalid(origin, `document declares unsupported kind ${String(parsed.kind)}`);
  return { kind: 'editor', document: validateEditorDocument(parsed, origin) };
}

/**
 * Validates a parsed fixture set before an adapter consumes it: at least one
 * document, every document at the shared version, and trace ids unique across
 * the whole set so adapters can reference traces unambiguously.
 */
export function validateVimFixtureSet(documents: readonly ParsedVimFixtureDocument[]): void {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError('Invalid Vim fixture set: at least one document is required');
  }
  const ids = new Set<string>();
  for (const parsed of documents) {
    if (parsed.document.version !== VIM_FIXTURE_VERSION) {
      throw new TypeError(`Invalid Vim fixture set: document version ${String(parsed.document.version)} is unsupported`);
    }
    for (const trace of parsed.document.traces) {
      if (ids.has(trace.id)) throw new TypeError(`Invalid Vim fixture set: duplicate trace id ${trace.id}`);
      ids.add(trace.id);
    }
  }
}
