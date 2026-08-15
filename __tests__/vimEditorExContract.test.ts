import {
  createEditorMachine,
  type EditorCapabilityCommand,
  type EditorDocumentPort,
  type EditorTransaction,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class ExDocument implements EditorDocumentPort {
  value: string;
  ranges = [{ anchor: 0, head: 0 }];
  readonly commands: { action: EditorCapabilityCommand; argument?: string }[] = [];
  constructor(text = 'one') { this.value = text; }
  text(): string { return this.value; }
  selections(): readonly { anchor: number; head: number }[] { return this.ranges; }
  apply(transaction: EditorTransaction): void {
    for (const change of [...transaction.changes].reverse()) {
      this.value = `${this.value.slice(0, change.from)}${change.insert}${this.value.slice(change.to)}`;
    }
    this.ranges = transaction.selections.map((selection) => ({ ...selection }));
  }
  async command(action: EditorCapabilityCommand, argument?: string): Promise<boolean> {
    this.commands.push({ action, argument });
    return true;
  }
}

describe('Vim bounded Ex contract', () => {
  it.each([
    { ex: 'qa', action: 'close-all' },
    { ex: 'qa!', action: 'force-close-all' },
    { ex: 'e', action: 'reload-buffer' },
    { ex: 'edit', action: 'reload-buffer' },
    { ex: 'bn', action: 'next-buffer' },
    { ex: 'bp', action: 'previous-buffer' },
  ] as const)('maps :$ex to $action', async ({ ex, action }) => {
    const document = new ExDocument();
    await createEditorMachine(document).executeEx(ex);
    expect(document.commands).toEqual([{ action }]);
  });

  it('selects a named buffer without treating the name as a filesystem path', async () => {
    const document = new ExDocument();
    await createEditorMachine(document).executeEx('b agent-log');
    expect(document.commands).toEqual([{ action: 'select-buffer', argument: 'agent-log' }]);
  });

  it.each([
    ['number', 'number', true],
    ['nonumber', 'number', false],
    ['relativenumber', 'relative-number', true],
    ['norelativenumber', 'relative-number', false],
    ['ignorecase', 'ignore-case', true],
    ['noignorecase', 'ignore-case', false],
    ['smartcase', 'smart-case', true],
    ['nosmartcase', 'smart-case', false],
    ['wrap', 'wrap', true],
    ['nowrap', 'wrap', false],
  ] as const)('supports :set %s', async (setting, name, enabled) => {
    const document = new ExDocument();
    const result = await createEditorMachine(document).executeEx(`set ${setting}`);
    expect(result.actions).toContainEqual({ type: 'option', name, enabled });
    expect(document.commands).toEqual([{ action: 'set-option', argument: `${name}=${enabled}` }]);
  });

  it('applies bounded literal and safe-regex range substitutions atomically', async () => {
    const literalDocument = new ExDocument('one one\none');
    const literal = createEditorMachine(literalDocument);
    await literal.executeEx('1,1s/one/two/g');
    expect(literalDocument.value).toBe('two two\none');

    const regexDocument = new ExDocument('a1 a2\na3');
    const regex = createEditorMachine(regexDocument);
    await regex.executeEx('%s/a[0-9]/x/g');
    expect(regexDocument.value).toBe('x x\nx');
  });

  it('applies non-global substitutions once per selected line and global substitutions throughout each line', async () => {
    const once = new ExDocument('a a\na a');
    await createEditorMachine(once).executeEx('%s/a/x/');
    expect(once.value).toBe('x a\nx a');
    expect(once.ranges).toEqual([{ anchor: 0, head: 0 }]);

    const global = new ExDocument('a a\na a');
    await createEditorMachine(global).executeEx('%s/a/x/g');
    expect(global.value).toBe('x x\nx x');
    expect(global.ranges).toEqual([{ anchor: 0, head: 0 }]);
  });

  it('requires the host confirmation capability for substitute c flag', async () => {
    const document = new ExDocument('one one');
    const machine = createEditorMachine(document);
    await machine.executeEx('%s/one/two/gc');
    expect(document.commands[0]).toMatchObject({ action: 'confirm-substitute' });
    expect(document.value).toBe('two two');
  });

  it('bounds substitution replacements and rejects unsafe patterns inline', async () => {
    const document = new ExDocument('a'.repeat(20_000));
    const machine = createEditorMachine(document);
    const tooMany = await machine.executeEx('%s/a/b/g');
    expect(tooMany.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Substitute exceeds replacement limit (10000)',
    });
    expect(document.value).toBe('a'.repeat(20_000));

    const unsafe = await machine.executeEx('%s/(a+)+/b/g');
    expect(unsafe.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Unsupported substitute pattern',
    });
  });

  it.each(['!echo nope', 'source x', 'w /tmp/x', 'edit /tmp/x', 'b ../../secret', 'global/x/delete'])
    ('retains the document for rejected command %s', async (command) => {
      const document = new ExDocument('safe');
      const result = await createEditorMachine(document).executeEx(command);
      expect(result.actions.at(-1)).toMatchObject({ type: 'status', level: 'error' });
      expect(document.value).toBe('safe');
      expect(document.commands).toEqual([]);
    });
});
