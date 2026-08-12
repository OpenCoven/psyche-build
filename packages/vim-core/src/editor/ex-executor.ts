import type { CompiledPattern } from './patterns.js';

export interface SubstituteResult {
  readonly text: string;
  readonly replacements: number;
}

export function substituteText(
  text: string,
  compiled: CompiledPattern,
  replacement: string,
  global: boolean,
  limit: number,
): SubstituteResult | undefined {
  const expression = new RegExp(compiled.source, compiled.flags.replace('g', '') + (global ? 'g' : ''));
  let replacements = 0;
  const next = text.replace(expression, (...args: unknown[]) => {
    replacements += 1;
    return replacements <= limit ? replacement : String(args[0]);
  });
  if (replacements > limit) return undefined;
  return { text: next, replacements };
}
