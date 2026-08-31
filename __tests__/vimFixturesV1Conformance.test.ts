import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createChromeMachine,
  createEditorMachine,
  parseVimFixtureDocument,
  validateVimFixtureSet,
  type EditorDocumentPort,
  type EditorInput,
  type EditorSelection,
  type EditorTransaction,
  type ParsedVimFixtureDocument,
  type VimEditorFixtureDocument,
  type VimEditorFixtureInput,
  type VimInputResult,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

// The cross-language canonical root for every Vim v1 fixture document.
const fixtureDirectory = join(process.cwd(), 'protocol-fixtures/vim/v1');
// The replay set this slice owns: every JSON document in the canonical root
// except `chrome.json`, the pre-existing input-contract document exercised by
// `__tests__/vimContract.test.ts`. It shares the chrome-* trace-id namespace
// (for example `chrome-pane-focus-left` also appears in
// `chrome-navigation.json`), so the two groups are validated separately.
const contractOwnedDocuments = new Set(['chrome.json']);
const fixtureFiles = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith('.json') && !contractOwnedDocuments.has(name))
  .sort();

function readDocument(name: string): string {
  return readFileSync(join(fixtureDirectory, name), 'utf8');
}

function parseAll(): ParsedVimFixtureDocument[] {
  return fixtureFiles.map((name) => parseVimFixtureDocument(readDocument(name), name));
}

/**
 * Deterministic fixture document port. Applies transactions atomically and
 * records the pre-transaction state so `undo` restores it — the same contract
 * a real adapter's history stack provides.
 */
class FixtureDocumentPort implements EditorDocumentPort {
  value: string;
  ranges: EditorSelection[];
  readonly commands: { command: Parameters<EditorDocumentPort['command']>[0]; argument?: string }[] = [];
  private readonly history: { text: string; ranges: EditorSelection[] }[] = [];

  constructor(text: string, cursor: number) {
    this.value = text;
    this.ranges = [{ anchor: cursor, head: cursor }];
  }

  text(): string {
    return this.value;
  }

  selections(): readonly EditorSelection[] {
    return this.ranges;
  }

  apply(transaction: EditorTransaction): void {
    this.history.push({ text: this.value, ranges: this.ranges.map((range) => ({ ...range })) });
    for (const change of [...transaction.changes].reverse()) {
      this.value = `${this.value.slice(0, change.from)}${change.insert}${this.value.slice(change.to)}`;
    }
    this.ranges = transaction.selections.map((selection) => ({ ...selection }));
  }

  async command(command: Parameters<EditorDocumentPort['command']>[0], argument?: string): Promise<boolean> {
    this.commands.push({ command, argument });
    if (command === 'undo') {
      const previous = this.history.pop();
      if (previous) {
        this.value = previous.text;
        this.ranges = previous.ranges.map((range) => ({ ...range }));
      }
    }
    return true;
  }
}

function toEditorInput(token: VimEditorFixtureInput): EditorInput {
  return token as EditorInput;
}

async function replayEditorTrace(document: VimEditorFixtureDocument, trace: VimEditorFixtureDocument['traces'][number]): Promise<void> {
  const port = new FixtureDocumentPort(trace.document.text, trace.document.cursor);
  const machine = createEditorMachine(port);
  let result = machine.snapshot();
  for (const token of trace.inputs) result = await machine.handle(toEditorInput(token));

  const expected = trace.expected;
  expect(result.mode, `${trace.id} mode`).toBe(expected.mode);
  expect(result.pending, `${trace.id} pending`).toBe(expected.pending);
  expect(result.count, `${trace.id} count`).toBe(expected.count);
  expect(port.value, `${trace.id} text`).toBe(expected.text);
  const head = port.ranges[0]?.head ?? 0;
  expect(head, `${trace.id} cursor`).toBe(expected.cursor);
  expect(result.actions, `${trace.id} actions`).toEqual(expected.actions);
  expect(result.search, `${trace.id} search`).toEqual(expected.search);

  if (expected.selections) expect(port.ranges, `${trace.id} selections`).toEqual(expected.selections);
  for (const [name, value] of Object.entries(expected.registers ?? {})) {
    expect(machine.register(name), `${trace.id} register ${name}`).toEqual(value);
  }
  for (const [name, position] of Object.entries(expected.marks ?? {})) {
    expect(machine.mark(name), `${trace.id} mark ${name}`).toBe(position);
  }
}

function key(token: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) {
  return {
    key: token.key,
    ctrlKey: token.ctrl ?? false,
    altKey: token.alt ?? false,
    shiftKey: token.shift ?? false,
    metaKey: token.meta ?? false,
  };
}

describe('Vim v1 fixture conformance against the shared core', () => {
  it('validates the whole set before replaying it', () => {
    expect(() => validateVimFixtureSet(parseAll())).not.toThrow();
  });

  it('replays every chrome-navigation trace through createChromeMachine', () => {
    const parsed = parseAll().find((document) => document.kind === 'chrome');
    expect(parsed?.kind).toBe('chrome');
    if (parsed?.kind !== 'chrome') return;
    expect(parsed.document.traces.length).toBeGreaterThanOrEqual(24);
    for (const trace of parsed.document.traces) {
      const machine = createChromeMachine({ enabled: trace.context !== 'disabled', now: () => 0 });
      if (trace.context === 'chrome-normal' || trace.context === 'chrome-search') machine.handle(key({ key: 'F6' }));
      if (trace.context === 'chrome-search') machine.handle(key({ key: '/' }));
      let result: VimInputResult = machine.snapshot() as VimInputResult;
      for (const token of trace.sequence) {
        result = machine.handle(key({ key: token.key!, alt: token.alt, ctrl: token.ctrl, meta: token.meta, shift: token.shift }));
      }
      // The passthrough disposition carries the original event by contract;
      // consumed results never include a replayable event.
      expect(result, trace.id).toMatchObject({
        disposition: trace.disposition,
        context: trace.expected.context,
        pending: trace.expected.pending,
        actions: trace.actions,
      });
      if (result.disposition === 'passthrough') {
        expect(result.event, `${trace.id} passthrough event`).toBeDefined();
        expect(result.event.key, `${trace.id} passthrough key`).toBe(trace.sequence.at(-1)?.key);
      } else {
        expect(result.event, `${trace.id} consumed event`).toBeUndefined();
      }
    }
  });

  it('replays every editor trace through createEditorMachine', async () => {
    const editorDocuments = parseAll().filter((document): document is Extract<ParsedVimFixtureDocument, { kind: 'editor' }> => document.kind === 'editor');
    const traces = editorDocuments.flatMap((document) => document.document.traces);
    expect(traces.length).toBeGreaterThanOrEqual(48);
    for (const document of editorDocuments) {
      for (const trace of document.document.traces) {
        await replayEditorTrace(document.document, trace);
      }
    }
  });
});
