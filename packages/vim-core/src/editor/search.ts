import { snapToGrapheme } from './marks.js';
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
  rawFrom: number,
  rawTo: number,
  wholeWord: boolean,
): SearchMatch | undefined {
  const from = snapToGrapheme(text, rawFrom, 'before');
  const to = snapToGrapheme(text, rawTo, 'after');
  if (wholeWord && !isWholeWord(text, from, to)) return undefined;
  return { from, to };
}

/** Streams a single pass and retains only the requested and wrap candidates. */
export function findMatch(
  text: string,
  compiled: CompiledPattern,
  position: number,
  direction: 'forward' | 'backward',
  wholeWord = false,
): SearchMatch | undefined {
  const expression = new RegExp(compiled.source, compiled.flags);
  let first: SearchMatch | undefined;
  let lastBefore: SearchMatch | undefined;
  let last: SearchMatch | undefined;
  for (;;) {
    const match = expression.exec(text);
    if (!match) break;
    const rawFrom = match.index;
    const rawTo = rawFrom + match[0].length;
    const candidate = collectCandidate(text, rawFrom, rawTo, wholeWord);
    if (candidate) {
      first ??= candidate;
      last = candidate;
      if (direction === 'forward' && candidate.from > position) return candidate;
      if (direction === 'backward' && candidate.from < position) lastBefore = candidate;
    }
    if (match[0].length === 0) {
      const next = snapToGrapheme(text, rawFrom + 1, 'after');
      expression.lastIndex = next > rawFrom ? next : rawFrom + 1;
    }
  }
  return direction === 'forward' ? first : (lastBefore ?? last);
}

export function wordAt(text: string, position: number): string | undefined {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)];
  const match = parts.find((part) => part.isWordLike
    && part.index <= position && position < part.index + part.segment.length);
  return match?.segment;
}
