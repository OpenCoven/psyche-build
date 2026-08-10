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
const originalBaseCsp = "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; frame-src https: http:; connect-src 'self' ipc: http://ipc.localhost https: http:";

function json(name: string) {
  return JSON.parse(readFileSync(join(desktop, 'src-tauri', name), 'utf8'));
}

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

  it('keeps portable opaque defaults and macOS presentation in its overlay', () => {
    const base = json('tauri.conf.json');
    const mac = json('tauri.macos.conf.json');
    const win = json('tauri.windows.conf.json');
    const linux = json('tauri.linux.conf.json');

    expect(base.app.windows[0]).toMatchObject({ transparent: false, decorations: true });
    expect(base.app).not.toHaveProperty('macOSPrivateApi');
    expect(mac.app.windows[0]).toMatchObject({ transparent: true, titleBarStyle: 'Overlay' });
    expect(mac.app.macOSPrivateApi).toBe(true);
    expect(win.app.windows[0].transparent).toBe(false);
    expect(linux.app.windows[0].transparent).toBe(false);
    expect(base.app.security.csp).toBe(originalBaseCsp);

    for (const config of [base, mac, win, linux]) {
      const csp = config.app?.security?.csp;
      if (!csp) continue;
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
    for (const overlay of [mac, win, linux]) {
      expect(overlay.app?.security?.csp).toBeUndefined();
    }
  });

  it('keeps vibrancy target-specific while retaining Tauri build compatibility', () => {
    const cargoToml = readFileSync(join(desktop, 'src-tauri', 'Cargo.toml'), 'utf8');

    expect(cargoToml).toContain(
      'tauri = { version = "2", features = ["macos-private-api", "unstable"] }',
    );
    expect(cargoToml).toContain(
      'tauri-build validates macOSPrivateApi against this entry even though Tauri cfg-gates it off non-macOS targets.',
    );
    expect(cargoToml).toMatch(
      /\[target\.'cfg\(target_os = "macos"\)'\.dependencies\][\s\S]*window-vibrancy = "0\.6"/,
    );
    expect(cargoToml.match(/window-vibrancy/g)).toHaveLength(1);
  });

  it('uses the portable Vite web server for Tauri development', () => {
    const configs = ['tauri.conf.json', 'tauri.macos.conf.json',
      'tauri.windows.conf.json', 'tauri.linux.conf.json'].map(json);
    const desktopPackage = json('../package.json');

    expect(configs[0].build.beforeDevCommand).toBe('pnpm run serve:web');
    expect(desktopPackage.scripts['serve:web'])
      .toBe('vite web --host 127.0.0.1 --port 1420 --strictPort');
    expect(desktopPackage.devDependencies.vite).toBe('6.4.3');
    expect(JSON.stringify(configs)).not.toMatch(/\bpython3?\b/);
  });
});
