export type ExOptionName =
  | 'number'
  | 'relative-number'
  | 'ignore-case'
  | 'smart-case'
  | 'wrap';

export type ExCommand =
  | { type: 'capability'; command: 'close-all' | 'force-close-all' | 'reload-buffer' }
  | { type: 'buffer'; name: string }
  | { type: 'option'; name: ExOptionName; enabled: boolean }
  | { type: 'substitute'; range: '%' | { from: number; to: number } | undefined; pattern: string; replacement: string; global: boolean; confirm: boolean }
  | { type: 'other' };

const optionMap: Readonly<Record<string, { name: ExOptionName; enabled: boolean }>> = {
  number: { name: 'number', enabled: true },
  nonumber: { name: 'number', enabled: false },
  relativenumber: { name: 'relative-number', enabled: true },
  norelativenumber: { name: 'relative-number', enabled: false },
  ignorecase: { name: 'ignore-case', enabled: true },
  noignorecase: { name: 'ignore-case', enabled: false },
  smartcase: { name: 'smart-case', enabled: true },
  nosmartcase: { name: 'smart-case', enabled: false },
  wrap: { name: 'wrap', enabled: true },
  nowrap: { name: 'wrap', enabled: false },
};

function splitSubstitute(value: string): string[] | undefined {
  const result: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === '\\') escaped = true;
    else if (character === '/') {
      result.push(current);
      current = '';
    } else current += character;
  }
  if (escaped) return undefined;
  result.push(current);
  return result;
}

export function parseExCommand(command: string): ExCommand {
  const lower = command.toLocaleLowerCase();
  if (lower === 'qa') return { type: 'capability', command: 'close-all' };
  if (lower === 'qa!') return { type: 'capability', command: 'force-close-all' };
  if (lower === 'e' || lower === 'edit') return { type: 'capability', command: 'reload-buffer' };
  const buffer = /^b\s+([A-Za-z0-9._-]{1,256})$/u.exec(command);
  if (buffer) return { type: 'buffer', name: buffer[1]! };
  const option = /^set\s+(\S+)$/iu.exec(command);
  if (option) {
    const mapped = optionMap[option[1]!.toLocaleLowerCase()];
    if (mapped) return { type: 'option', ...mapped };
  }
  const substitute = /^(%|\d+(?:,\d+)?)?s(?:ubstitute)?\/(.*)$/iu.exec(command);
  if (substitute) {
    const pieces = splitSubstitute(substitute[2]!);
    if (pieces?.length === 3 && /^[gc]*$/u.test(pieces[2]!)) {
      const rangeText = substitute[1];
      const numeric = rangeText && rangeText !== '%' ? rangeText.split(',').map(Number) : undefined;
      return {
        type: 'substitute',
        range: rangeText === '%' ? '%' : numeric ? { from: numeric[0]!, to: numeric[1] ?? numeric[0]! } : undefined,
        pattern: pieces[0]!,
        replacement: pieces[1]!.replace(/\\\//gu, '/'),
        global: pieces[2]!.includes('g'),
        confirm: pieces[2]!.includes('c'),
      };
    }
  }
  return { type: 'other' };
}
