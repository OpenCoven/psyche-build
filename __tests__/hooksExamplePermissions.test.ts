import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { initializeHooksDirectory } from '../src/utils/hooks.js';
import { EXAMPLE_HOOKS } from '../src/utils/hooksDocs.js';

it.each([0o600, 0o640, 0o660, 0o1600])('preserves existing hook-example permissions while making mode %s executable', (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mode-'));
  const directory = path.join(root, '.psyche-hooks', 'examples');
  fs.mkdirSync(directory, { recursive: true });
  const example = path.join(directory, Object.keys(EXAMPLE_HOOKS)[0]);
  fs.writeFileSync(example, '# private customized example\n');
  fs.chmodSync(example, mode);
  try {
    initializeHooksDirectory(root);
    const actual = fs.statSync(example).mode & 0o7777;
    expect(actual & ~0o111).toBe(mode & ~0o111);
    expect(actual & 0o100).toBe(0o100);
    expect(fs.readFileSync(example, 'utf8')).toBe('# private customized example\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
