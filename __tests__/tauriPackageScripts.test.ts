import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('root Tauri package scripts', () => {
  it('delegates native build and development to the Tauri workspace', () => {
    expect(rootPackage.scripts['build:tauri']).toBe(
      'pnpm --filter psyche-build-tauri run build'
    );
    expect(rootPackage.scripts['dev:tauri']).toBe(
      'pnpm --filter psyche-build-tauri run dev'
    );
  });
});
