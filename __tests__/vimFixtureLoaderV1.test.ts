import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  VIM_FIXTURE_VERSION,
  parseVimFixtureDocument,
  validateEditorFixtures,
  validateVimFixtureSet,
  type ParsedVimFixtureDocument,
  type VimEditorFixtureDocument,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

// The cross-language canonical root for every Vim v1 fixture document.
const fixtureDirectory = join(process.cwd(), 'protocol-fixtures/vim/v1');
// The fixture set this slice owns: every JSON document in the canonical root
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

function firstEditorDocument(): { name: string; document: VimEditorFixtureDocument } {
  for (const name of fixtureFiles) {
    const parsed = parseVimFixtureDocument(readDocument(name), name);
    if (parsed.kind === 'editor') return { name, document: parsed.document };
  }
  throw new Error('no editor fixture document found');
}

describe('Vim v1 fixture set (protocol-fixtures/vim/v1)', () => {
  it('ships at least one chrome and one editor fixture document', () => {
    const parsed = parseAll();
    expect(fixtureFiles).toContain('chrome-navigation.json');
    expect(fixtureFiles).toContain('motions.json');
    expect(fixtureFiles).toContain('edits.json');
    expect(fixtureFiles).toContain('search.json');
    expect(fixtureFiles).toContain('ex-commands.json');
    expect(parsed.filter((document) => document.kind === 'chrome').length).toBeGreaterThanOrEqual(1);
    expect(parsed.filter((document) => document.kind === 'editor').length).toBeGreaterThanOrEqual(1);
  });

  it('parses every fixture document at the shared version vim/v1', () => {
    expect(VIM_FIXTURE_VERSION).toBe('vim/v1');
    for (const parsed of parseAll()) expect(parsed.document.version).toBe('vim/v1');
  });

  it('keeps trace ids unique across the whole set', () => {
    const parsed = parseAll();
    expect(() => validateVimFixtureSet(parsed)).not.toThrow();
    const ids = parsed.flatMap((document) => document.document.traces.map((trace) => trace.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(32);
  });

  it('rejects malformed JSON sources', () => {
    expect(() => parseVimFixtureDocument('{', 'broken.json')).toThrow(/not valid JSON/i);
    expect(() => parseVimFixtureDocument('', 'empty.json')).toThrow(/non-empty string/i);
    expect(() => parseVimFixtureDocument('[]', 'array.json')).toThrow(/JSON object/i);
  });

  it('fails closed on unsupported fixture versions', () => {
    const source = JSON.stringify({ version: 'vim/v2', traces: [] });
    expect(() => parseVimFixtureDocument(source, 'future.json')).toThrow(/unsupported version/i);
  });

  it('fails closed on unknown kind values', () => {
    const source = JSON.stringify({ version: 'vim/v1', kind: 'macro', traces: [] });
    expect(() => parseVimFixtureDocument(source, 'macro.json')).toThrow(/unsupported kind/i);
  });

  it('rejects unknown fields on documents, traces, inputs, and expectations', () => {
    const editor = parseVimFixtureDocument(readDocument('motions.json'), 'motions.json');
    expect(editor.kind).toBe('editor');
    const base = editor.document as unknown as Record<string, unknown>;

    expect(() => validateEditorFixtures({ ...base, extra: true })).toThrow(/unknown field extra/i);
    expect(() => validateEditorFixtures({
      ...base,
      traces: [{ ...editor.document.traces[0], surprise: 1 }],
    })).toThrow(/unknown field surprise/i);
    expect(() => validateEditorFixtures({
      ...base,
      traces: [{
        ...editor.document.traces[0],
        inputs: [{ key: 'h', hyper: true }],
      }],
    })).toThrow(/unknown field hyper/i);
    expect(() => validateEditorFixtures({
      ...base,
      traces: [{
        ...editor.document.traces[0],
        expected: { ...editor.document.traces[0].expected, colours: 1 },
      }],
    })).toThrow(/unknown field colours/i);
  });

  it('rejects traces with duplicate ids, bad cursors, or missing inputs', () => {
    const { document } = firstEditorDocument();
    const trace = document.traces[0]!;
    expect(() => validateEditorFixtures({ ...document, traces: [trace, trace] })).toThrow(/duplicate trace id/i);
    expect(() => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, document: { ...trace.document, cursor: trace.document.text.length + 1 } }],
    })).toThrow(/document cursor/i);
    expect(() => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, inputs: [] }],
    })).toThrow(/1\.\.32 inputs/i);
    expect(() => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, inputs: Array.from({ length: 33 }, () => 'h') }],
    })).toThrow(/1\.\.32 inputs/i);
    expect(() => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, document: { ...trace.document, text: 'x'.repeat(2049) } }],
    })).toThrow(/document text/i);
    expect(() => validateEditorFixtures({ ...document, traces: [] })).toThrow(/1\.\.128 traces/i);
  });

  it('rejects invalid input tokens and expectations', () => {
    const { document } = firstEditorDocument();
    const trace = document.traces[0]!;
    const withInputs = (inputs: unknown) => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, inputs }],
    });

    expect(() => withInputs([''])).toThrow(/input key/i);
    expect(() => withInputs(['h\n'])).toThrow(/control characters/i);
    expect(() => withInputs([{ key: 3 }])).toThrow(/key input key/i);
    expect(() => withInputs([{ key: 'h', ctrlKey: 'yes' }])).toThrow(/ctrlKey must be a boolean/i);
    expect(() => withInputs([{ kind: 'keystroke', text: 'x' }])).toThrow(/text input kind/i);
    expect(() => withInputs([{ kind: 'text', text: '' }])).toThrow(/text input text/i);

    const withExpected = (expected: unknown) => validateEditorFixtures({
      ...document,
      traces: [{ ...trace, expected }],
    });
    const base = { ...trace.expected };

    expect(() => withExpected({ ...base, mode: 'zen' })).toThrow(/expected mode/i);
    expect(() => withExpected({ ...base, cursor: base.cursor + 999 })).toThrow(/expected cursor/i);
    expect(() => withExpected({ ...base, actions: [{ type: 'explode' }] })).toThrow(/unsupported type/i);
    expect(() => withExpected({ ...base, actions: [{ type: 'mode', mode: 'normal' }, ...Array.from({ length: 16 }, () => ({ type: 'status', level: 'info', message: 'x' }))] })).toThrow(/up to 16/i);
    expect(() => withExpected({ ...base, search: { pattern: 'a', direction: 'sideways', highlight: true } })).toThrow(/expected search direction/i);
    expect(() => withExpected({ ...base, registers: { ab: { text: 'x', linewise: false } } })).toThrow(/invalid name ab/i);
    expect(() => withExpected({ ...base, marks: { a: -1 } })).toThrow(/expected mark a position/i);
    expect(() => withExpected({ ...base, selections: [] })).toThrow(/expected selections/i);
  });

  it('rejects chrome documents that declare extra fields or drift their traces', () => {
    const chrome = parseVimFixtureDocument(readDocument('chrome-navigation.json'), 'chrome-navigation.json');
    expect(chrome.kind).toBe('chrome');
    const source = JSON.parse(readDocument('chrome-navigation.json')) as Record<string, unknown>;

    expect(() => parseVimFixtureDocument(JSON.stringify({ ...source, kind: 'terminal' }), 'chrome.json')).toThrow(/unsupported kind/i);
    expect(() => parseVimFixtureDocument(JSON.stringify({ ...source, owner: 'x' }), 'chrome.json')).toThrow(/unknown field owner/i);
    expect(() => parseVimFixtureDocument(JSON.stringify({
      ...source,
      traces: [{ ...(source.traces as Record<string, unknown>[])[0], unknown: 1 }],
    }), 'chrome.json')).toThrow(/unknown field unknown/i);
  });
});
