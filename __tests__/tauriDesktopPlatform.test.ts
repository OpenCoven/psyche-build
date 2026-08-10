import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const desktop = join(root, 'native/desktop/psyche-build-tauri');
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.lock', '.md', '.mjs', '.rs', '.sh',
  '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);
const stalePathPattern = /native\/macos\/psyche-build-tauri|['"]native['"]\s*,\s*['"]macos['"]\s*,\s*['"]psyche-build-tauri['"]/;

function stalePathReferences(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file
      && file !== '__tests__/tauriDesktopPlatform.test.ts'
      && !file.startsWith('docs/superpowers/')
      && textExtensions.has(extname(file)))
    .filter((file) => stalePathPattern.test(readFileSync(join(root, file), 'utf8')));
}

describe('desktop Tauri layout', () => {
  it('owns the active app from the platform-neutral desktop path', () => {
    expect(existsSync(desktop)).toBe(true);
    expect(existsSync(join(root, 'native/macos/psyche-build-tauri'))).toBe(false);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
      .toContain('native/desktop/psyche-build-tauri');
  });

  it('does not leave executable references to the old path', () => {
    for (const file of ['package.json', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain('native/macos/psyche-build-tauri');
    }
  });

  it('has no stale desktop app paths in tracked text source', () => {
    expect(stalePathReferences()).toEqual([]);
  });

  it('never opts out of GPU acceleration or software fallback', () => {
    const configText = ['tauri.conf.json', 'tauri.macos.conf.json',
      'tauri.windows.conf.json', 'tauri.linux.conf.json']
      .filter((name) => existsSync(join(desktop, 'src-tauri', name)))
      .map((name) => readFileSync(join(desktop, 'src-tauri', name), 'utf8'))
      .concat([
        readFileSync(join(desktop, 'src-tauri/src/lib.rs'), 'utf8'),
        readFileSync(join(desktop, 'package.json'), 'utf8'),
        readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      ])
      .join('\n');
    expect(configText).not.toMatch(
      /disable-gpu|disable-software-rasterizer|LIBGL_ALWAYS_SOFTWARE/i,
    );
  });
});
