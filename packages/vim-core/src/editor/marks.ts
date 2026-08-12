import type { EditorChange } from './types.js';

export function mapPosition(
  position: number,
  changes: readonly EditorChange[],
  affinity: 'before' | 'after' = 'after',
): number {
  let delta = 0;
  for (const change of changes) {
    if (position < change.from) break;
    if (position > change.to || (position === change.to && change.from !== change.to)) {
      delta += change.insert.length - (change.to - change.from);
      continue;
    }
    return change.from + delta + (affinity === 'after' ? change.insert.length : 0);
  }
  return position + delta;
}

export function snapToGrapheme(text: string, position: number, affinity: 'before' | 'after' = 'after'): number {
  const bounded = Math.max(0, Math.min(text.length, position));
  const boundaries = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .map((part) => part.index);
  boundaries.push(text.length);
  if (boundaries.includes(bounded)) return bounded;
  if (affinity === 'before') {
    let previous = 0;
    for (const boundary of boundaries) {
      if (boundary >= bounded) break;
      previous = boundary;
    }
    return previous;
  }
  return boundaries.find((boundary) => boundary > bounded) ?? text.length;
}

export function relocateMark(
  text: string,
  position: number,
  changes: readonly EditorChange[],
): number {
  return snapToGrapheme(text, mapPosition(position, changes), 'after');
}
