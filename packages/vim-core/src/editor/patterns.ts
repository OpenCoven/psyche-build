export interface CompiledPattern {
  readonly source: string;
  readonly flags: string;
}

function isQuantifier(character: string | undefined): boolean {
  return character === '*' || character === '+' || character === '?' || character === '{';
}

/**
 * Accepts a deliberately restricted ECMAScript-compatible regular-expression subset.
 * Assertions, backreferences, named groups, and quantified ambiguous/nested groups are rejected.
 */
export function compilePattern(
  source: string,
  options: { ignoreCase: boolean; smartCase: boolean },
): CompiledPattern | undefined {
  if (/\\(?:[1-9]|k<)/u.test(source) || /\(\?/u.test(source)) return undefined;
  const stack: { start: number; hasQuantifier: boolean; hasAlternation: boolean }[] = [];
  let escaped = false;
  let inClass = false;
  let repetitionCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (!inClass && character === '(') stack.push({ start: index, hasQuantifier: false, hasAlternation: false });
    else if (!inClass && character === '|') {
      if (stack.length > 0) stack[stack.length - 1]!.hasAlternation = true;
    } else if (!inClass && (character === '*' || character === '+' || character === '?')) {
      repetitionCount += 1;
      if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
    } else if (!inClass && character === '{') {
      const close = source.indexOf('}', index + 1);
      if (close < 0) return undefined;
      const bounds = /^(\d+)(?:,(\d*))?$/u.exec(source.slice(index + 1, close));
      if (!bounds) return undefined;
      const lower = Number(bounds[1]);
      const upper = bounds[2] === undefined || bounds[2] === '' ? lower : Number(bounds[2]);
      if (lower > 10_000 || upper > 10_000 || upper < lower) return undefined;
      repetitionCount += 1;
      if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
      index = close;
    } else if (!inClass && character === ')') {
      const group = stack.pop();
      if (!group) return undefined;
      const next = source[index + 1];
      if (isQuantifier(next) && (group.hasQuantifier || group.hasAlternation)) return undefined;
      if (stack.length > 0 && (group.hasQuantifier || isQuantifier(next))) stack[stack.length - 1]!.hasQuantifier = true;
    }
  }
  if (escaped || inClass || stack.length > 0 || repetitionCount > 1) return undefined;
  try {
    void new RegExp(source, 'u');
  } catch {
    return undefined;
  }
  const smartSensitive = options.smartCase && /\p{Uppercase_Letter}/u.test(source);
  return { source, flags: `gu${options.ignoreCase && !smartSensitive ? 'i' : ''}` };
}

export function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
