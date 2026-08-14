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
  let replacements = 0;
  const flags = compiled.flags.replace('g', '') + (global ? 'g' : '');
  const next = text.split('\n').map((line) => line.replace(
    new RegExp(compiled.source, flags),
    (...args: unknown[]) => {
      replacements += 1;
      return replacements <= limit ? replacement : String(args[0]);
    },
  )).join('\n');
  if (replacements > limit) return undefined;
  return { text: next, replacements };
}
