import {
  createEditorMachine,
  type EditorDocumentPort,
  type EditorInput,
  type EditorTransaction,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

class AtomicDocument implements EditorDocumentPort {
  value: string;
  ranges: { anchor: number; head: number }[];
  readonly transactions: EditorTransaction[] = [];
  failNextApply = false;

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

  apply(transaction: EditorTransaction): void {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('atomic adapter failure');
    }
    let next = this.value;
    for (const change of [...transaction.changes].reverse()) {
      next = `${next.slice(0, change.from)}${change.insert}${next.slice(change.to)}`;
    }
    this.value = next;
    this.ranges = transaction.selections.map((selection) => ({ ...selection }));
    this.transactions.push({
      ...transaction,
      changes: transaction.changes.map((change) => ({ ...change })),
      selections: transaction.selections.map((selection) => ({ ...selection })),
    });
  }

  async command(): Promise<boolean> {
    return true;
  }
}

const keys = (value: string): EditorInput[] => [...value];

async function send(machine: ReturnType<typeof createEditorMachine>, ...inputs: EditorInput[]) {
  let result = machine.snapshot();
  for (const input of inputs) result = await machine.handle(input);
  return result;
}

describe('Vim editor atomic transactions', () => {
  it('applies a block delete as one sorted multi-change transaction', async () => {
    const document = new AtomicDocument('abcd\nefgh\nijkl');
    const machine = createEditorMachine(document);

    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l', 'd');

    expect(document.value).toBe('cd\ngh\nijkl');
    const contentTransactions = document.transactions.filter((transaction) => transaction.changes.length > 0);
    expect(contentTransactions).toHaveLength(1);
    expect(contentTransactions[0]).toEqual({
      changes: [
        { from: 0, to: 2, insert: '' },
        { from: 5, to: 7, insert: '' },
      ],
      selections: [{ anchor: 0, head: 0 }],
      history: 'new',
    });
  });

  it('leaves document and machine state unchanged when an atomic block edit fails', async () => {
    const document = new AtomicDocument('abcd\nefgh\nijkl');
    const machine = createEditorMachine(document);
    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l');
    const before = {
      value: document.value,
      ranges: document.ranges.map((selection) => ({ ...selection })),
      transactions: document.transactions.length,
      snapshot: machine.snapshot(),
      unnamed: machine.register('"'),
    };
    document.failNextApply = true;

    const failure = await machine.handle('d');

    expect(failure.actions.at(-1)).toEqual({
      type: 'status', level: 'error', message: 'Editor transaction failed',
    });
    expect(document.value).toBe(before.value);
    expect(document.ranges).toEqual(before.ranges);
    expect(document.transactions).toHaveLength(before.transactions);
    expect(machine.snapshot()).toMatchObject({
      mode: before.snapshot.mode,
      pending: before.snapshot.pending,
      count: before.snapshot.count,
    });
    expect(machine.register('"')).toEqual(before.unnamed);

    await send(machine, 'Escape', 'i', 'X');
    expect(document.transactions.at(-1)?.history).toBe('new');
  });

  it('uses one deterministic transaction for a repeated block edit', async () => {
    const document = new AtomicDocument('abcd\nefgh\nijkl\nmnop');
    const machine = createEditorMachine(document);

    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l', 'd', 'j', 'j', '0', '.');

    const contentTransactions = document.transactions.filter((transaction) => transaction.changes.length > 0);
    expect(contentTransactions).toHaveLength(2);
    expect(contentTransactions.map((transaction) => transaction.history)).toEqual(['new', 'new']);
    expect(contentTransactions.map((transaction) => transaction.changes.length)).toEqual([2, 2]);
  });

  it('relocates local marks after insertions and clamps marks deleted by a range', async () => {
    const inserted = new AtomicDocument('one two', 4);
    const insertMachine = createEditorMachine(inserted);
    await send(insertMachine, 'm', 'a', '0', 'i', 'X', 'Escape');
    expect(insertMachine.mark('a')).toBe(5);
    await send(insertMachine, '`', 'a');
    expect(inserted.ranges[0]).toEqual({ anchor: 5, head: 5 });

    const deleted = new AtomicDocument('abcdef', 3);
    const deleteMachine = createEditorMachine(deleted);
    await send(deleteMachine, 'm', 'a', '0', 'd', '$');
    expect(deleteMachine.mark('a')).toBe(0);
  });

  it('snaps relocated marks to grapheme boundaries', async () => {
    const document = new AtomicDocument('ex', 1);
    const machine = createEditorMachine(document);
    await send(machine, 'm', 'a', 'i', '\u0301', 'Escape');

    expect(document.value).toBe('e\u0301x');
    expect(machine.mark('a')).toBe(2);
  });

  it('relocates current-buffer global marks and emits semantic update actions', async () => {
    const globals = new Map([['A', { buffer: 'buffer-a', position: 4 }]]);
    const document = new AtomicDocument('one two');
    const machine = createEditorMachine(document, {
      bufferId: 'buffer-a',
      globalMarks: {
        get: (mark) => globals.get(mark),
        set: (mark, reference) => globals.set(mark, reference),
      },
    });

    const result = await send(machine, 'i', 'X');

    expect(globals.get('A')).toEqual({ buffer: 'buffer-a', position: 5 });
    expect(result.actions).toContainEqual({
      type: 'mark.set-global', mark: 'A', reference: { buffer: 'buffer-a', position: 5 },
    });
  });

  it('treats transaction changes as pre-edit coordinates and selections as post-edit coordinates', async () => {
    const document = new AtomicDocument('abcd\nefgh');
    const machine = createEditorMachine(document);

    await send(machine, { key: 'v', ctrlKey: true }, 'j', 'l', 'c');

    const transaction = document.transactions.find((candidate) => candidate.changes.length > 0);
    expect(transaction?.changes).toEqual([
      { from: 0, to: 2, insert: '' },
      { from: 5, to: 7, insert: '' },
    ]);
    expect(transaction?.selections).toEqual([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]);
    expect(document.ranges).toEqual([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]);
  });
});
