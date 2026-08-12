import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('dependency policy', () => {
  it('uses a pnpm release that supports minimum release age enforcement', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

    expect(packageJson.packageManager).toBe('pnpm@10.34.5');
  });

  it('rejects dependency releases newer than 24 hours', () => {
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

    expect(workspace).toMatch(/^minimumReleaseAge:\s*1440$/m);
  });
});
