import type { EditorChange, EditorSelection, EditorTransaction } from './types.js';

export function normalizeChanges(changes: readonly EditorChange[]): EditorChange[] {
  const ordered = changes
    .map((change) => ({ ...change }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let previousTo = -1;
  for (const change of ordered) {
    if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
      || change.from < 0 || change.to < change.from || change.from < previousTo) {
      throw new Error('Invalid editor transaction changes');
    }
    previousTo = change.to;
  }
  return ordered;
}

export function editorTransaction(
  changes: readonly EditorChange[],
  selections: readonly EditorSelection[],
  history: EditorTransaction['history'],
): EditorTransaction {
  return {
    changes: normalizeChanges(changes),
    selections: selections.map((selection) => ({ ...selection })),
    history,
  };
}

export function positionsAfterChanges(changes: readonly EditorChange[]): number[] {
  let delta = 0;
  return normalizeChanges(changes).map((change) => {
    const position = change.from + delta + change.insert.length;
    delta += change.insert.length - (change.to - change.from);
    return position;
  });
}
