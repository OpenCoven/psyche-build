import {
  graphemes,
  kind,
  lineEnd,
  lineStart,
  matchingDelimiter,
  pairs,
  reversePairs,
} from './motions.js';

export function objectRange(
  text: string,
  position: number,
  object: string,
  around: boolean,
): { from: number; to: number } | undefined {
  if (object === 'p') {
    let from = lineStart(text, position);
    let to = lineEnd(text, position);
    while (from > 0) {
      const previous = lineStart(text, Math.max(0, from - 1));
      if (!text.slice(previous, lineEnd(text, previous)).trim()) break;
      from = previous;
    }
    while (to < text.length) {
      const next = to + 1;
      if (!text.slice(next, lineEnd(text, next)).trim()) {
        if (around) to = Math.min(text.length, lineEnd(text, next) + 1);
        break;
      }
      to = lineEnd(text, next);
    }
    if (to < text.length && text[to] === '\n') to += 1;
    return { from, to };
  }
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
      } else while (first > 0 && kind(parts[first - 1]!.value, big) === 'space') first -= 1;
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
