import { starts } from './motions.js';
import type { CompiledPattern } from './patterns.js';

export interface SearchMatch {
  readonly from: number;
  readonly to: number;
}

function isWordCharacter(value: string): boolean {
  return /[\p{Letter}\p{Number}_]/u.test(value);
}

function isWholeWord(text: string, from: number, to: number): boolean {
  const before = from > 0 ? String.fromCodePoint(text.codePointAt(from - 1)!) : '';
  const after = to < text.length ? String.fromCodePoint(text.codePointAt(to)!) : '';
  return !isWordCharacter(before) && !isWordCharacter(after);
}

function collectCandidate(
  text: string,
  from: number,
  to: number,
  wholeWord: boolean,
): SearchMatch | undefined {
  if (wholeWord && !isWholeWord(text, from, to)) return undefined;
  return { from, to };
}

function scanMatches(
  text: string,
  compiled: CompiledPattern,
  boundaries: readonly number[],
  wholeWord: boolean,
  visit: (candidate: SearchMatch, ordinal: number) => boolean | void,
): number {
  const expression = new RegExp(compiled.source, compiled.flags);
  let ordinal = 0;
  let previousFrom = -1;
  let fromBoundary = 0;
  let toBoundary = 0;
  for (;;) {
    const match = expression.exec(text);
    if (!match) break;
    const rawFrom = match.index;
    const rawTo = rawFrom + match[0].length;
    while (fromBoundary + 1 < boundaries.length && boundaries[fromBoundary + 1]! <= rawFrom) {
      fromBoundary += 1;
    }
    while (toBoundary < boundaries.length && boundaries[toBoundary]! < rawTo) toBoundary += 1;
    const candidate = collectCandidate(
      text,
      boundaries[fromBoundary] ?? 0,
      boundaries[Math.min(toBoundary, boundaries.length - 1)] ?? text.length,
      wholeWord,
    );
    if (candidate && candidate.from !== previousFrom) {
      previousFrom = candidate.from;
      if (visit(candidate, ordinal) === false) return ordinal + 1;
      ordinal += 1;
    }
    if (match[0].length === 0) {
      const next = boundaries[fromBoundary + 1] ?? rawFrom + 1;
      expression.lastIndex = next > rawFrom ? next : rawFrom + 1;
    }
  }
  return ordinal;
}

/** Uses bounded-memory streaming passes to select the requested cyclic match. */
export function findMatch(
  text: string,
  compiled: CompiledPattern,
  position: number,
  direction: 'forward' | 'backward',
  wholeWord = false,
  repeatCount = 1,
): SearchMatch | undefined {
  const boundaries = starts(text);
  let before = 0;
  let after = 0;
  const total = scanMatches(text, compiled, boundaries, wholeWord, (candidate) => {
    if (candidate.from < position) before += 1;
    if (candidate.from > position) after += 1;
  });
  if (total === 0) return undefined;
  const offset = (Math.max(1, repeatCount) - 1) % total;
  const targetOrdinal = direction === 'forward'
    ? (offset < after ? total - after + offset : offset - after)
    : (offset < before ? before - 1 - offset : total - 1 - (offset - before));
  let target: SearchMatch | undefined;
  scanMatches(text, compiled, boundaries, wholeWord, (candidate, ordinal) => {
    if (ordinal !== targetOrdinal) return;
    target = candidate;
    return false;
  });
  return target;
}

export function wordAt(text: string, position: number): string | undefined {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)];
  const match = parts.find((part) => part.isWordLike
    && part.index <= position && position < part.index + part.segment.length);
  return match?.segment;
}
