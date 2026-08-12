export function starts(text: string): number[] {
  const result = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .map((part) => part.index);
  result.push(text.length);
  return result;
}

export function previousGrapheme(text: string, position: number): number {
  let previous = 0;
  for (const start of starts(text)) {
    if (start >= position) break;
    previous = start;
  }
  return previous;
}

export function nextGrapheme(text: string, position: number): number {
  for (const start of starts(text)) if (start > position) return start;
  return text.length;
}

export function graphemeCount(text: string): number {
  return Math.max(0, starts(text).length - 1);
}

export function lineStart(text: string, position: number): number {
  return text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

export function lineEnd(text: string, position: number): number {
  const end = text.indexOf('\n', position);
  return end < 0 ? text.length : end;
}

export function graphemeColumn(text: string, line: number, position: number): number {
  const relative = Math.max(0, Math.min(lineEnd(text, line) - line, position - line));
  const boundaries = starts(text.slice(line, lineEnd(text, line)));
  let column = 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    if (boundaries[index]! > relative) break;
    column = index;
  }
  return column;
}

export function positionAtGraphemeColumn(text: string, line: number, column: number): number {
  const boundaries = starts(text.slice(line, lineEnd(text, line)));
  return line + boundaries[Math.min(Math.max(0, column), boundaries.length - 1)]!;
}

export function lineNumber(text: string, position: number): number {
  return text.slice(0, position).split('\n').length - 1;
}

export function lineAt(text: string, target: number): number {
  if (target <= 0) return 0;
  let position = 0;
  for (let line = 0; line < target; line += 1) {
    const end = text.indexOf('\n', position);
    if (end < 0) return lineStart(text, text.length);
    position = end + 1;
  }
  return position;
}

export function lastLineStart(text: string): number {
  return lineStart(text, text.length);
}

export function vertical(text: string, position: number, delta: number): number {
  const start = lineStart(text, position);
  const column = starts(text.slice(start, position)).length - 1;
  const targetStart = lineAt(text, Math.max(0, lineNumber(text, position) + delta));
  const targetEnd = lineEnd(text, targetStart);
  const boundaries = starts(text.slice(targetStart, targetEnd));
  return targetStart + boundaries[Math.min(column, Math.max(0, boundaries.length - 1)]!;
}

export function kind(character: string, big: boolean): 'space' | 'word' | 'punctuation' {
  if (/\s/u.test(character)) return 'space';
  if (big || /[\p{Letter}\p{Number}_]/u.test(character)) return 'word';
  return 'punctuation';
}

export function graphemes(text: string): { value: string; index: number }[] {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .map((part) => ({ value: part.segment, index: part.index }));
}

export function wordForward(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  let index = Math.max(0, parts.findIndex((part) => part.index >= position));
  if (index < 0) return text.length;
  for (let step = 0; step < count; step += 1) {
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index < parts.length && kind(parts[index]!.value, big) === current) index += 1;
    while (index < parts.length && kind(parts[index]!.value, big) === 'space') index += 1;
  }
  return parts[index]?.index ?? text.length;
}

export function wordBackward(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  let index = parts.findIndex((part) => part.index >= position);
  if (index < 0) index = parts.length;
  index -= 1;
  for (let step = 0; step < count; step += 1) {
    while (index > 0 && kind(parts[index]!.value, big) === 'space') index -= 1;
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index > 0 && kind(parts[index - 1]!.value, big) === current) index -= 1;
    if (step + 1 < count) index -= 1;
  }
  return parts[Math.max(0, index)]?.index ?? 0;
}

export function wordEnd(text: string, position: number, count: number, big: boolean): number {
  const parts = graphemes(text);
  let index = Math.max(0, parts.findIndex((part) => part.index >= position));
  for (let step = 0; step < count; step += 1) {
    if (step > 0) index += 1;
    while (index < parts.length && kind(parts[index]!.value, big) === 'space') index += 1;
    const current = kind(parts[index]?.value ?? ' ', big);
    while (index + 1 < parts.length && kind(parts[index + 1]!.value, big) === current) index += 1;
  }
  return parts[index]?.index ?? text.length;
}

export const pairs: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
export const reversePairs: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };

export function matchingDelimiter(text: string, position: number): number | undefined {
  const character = text[position];
  const close = character ? pairs[character] : undefined;
  const open = character ? reversePairs[character] : undefined;
  if (!close && !open) return undefined;
  const direction = close ? 1 : -1;
  const target = close ?? open!;
  let depth = 0;
  for (let cursor = position + direction; cursor >= 0 && cursor < text.length; cursor += direction) {
    if (text[cursor] === character) depth += 1;
    if (text[cursor] === target) {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return undefined;
}

export function paragraph(text: string, position: number, direction: 1 | -1): number {
  if (direction > 0) {
    const match = /\n\s*\n/g.exec(text.slice(position));
    return match ? position + match.index + 1 : lastLineStart(text);
  }
  const prefix = text.slice(0, lineStart(text, position));
  let boundary = -1;
  for (const match of prefix.matchAll(/\n\s*\n/g)) boundary = match.index! + match[0].length;
  return boundary < 0 ? 0 : boundary;
}
