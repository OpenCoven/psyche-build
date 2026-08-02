import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBuiltInRituals } from '../src/utils/rituals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const exportedPath = path.join(
  projectRoot,
  'native',
  'macos',
  'psyche-app',
  'Sources',
  'PsycheApp',
  'Resources',
  'builtin-rituals.json',
);

describe('built-in rituals export parity', () => {
  it('the bundled JSON resource matches getBuiltInRituals()', () => {
    if (!fs.existsSync(exportedPath)) {
      // Resource is generated at build time; skip locally if absent.
      return;
    }

    const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
    const expected = getBuiltInRituals();

    expect(exported).toEqual(expected);
  });
});
