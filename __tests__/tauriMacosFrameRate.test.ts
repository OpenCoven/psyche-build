import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native', 'desktop', 'psyche-build-tauri', 'src-tauri');
const cargoToml = readFileSync(join(tauriRoot, 'Cargo.toml'), 'utf8');
const tauriLib = readFileSync(join(tauriRoot, 'src', 'lib.rs'), 'utf8');
const tauriConfig = JSON.parse(readFileSync(join(tauriRoot, 'tauri.conf.json'), 'utf8')) as {
  plugins?: Record<string, { enabled?: boolean }>;
};

describe('macOS WKWebView frame pacing', () => {
  it('unlocks the native display refresh rate for every Tauri webview', () => {
    expect(cargoToml).toMatch(/^rust-version = "1\.85"$/m);
    expect(cargoToml).toMatch(/^tauri-plugin-macos-fps = "0\.1\.0"$/m);
    expect(tauriConfig.plugins?.['macos-fps']).toMatchObject({ enabled: true });
    expect(tauriLib).toContain('.plugin(tauri_plugin_macos_fps::init())');
  });

  it('registers high-refresh support before the app starts creating webviews', () => {
    const fpsPlugin = tauriLib.indexOf('.plugin(tauri_plugin_macos_fps::init())');
    const openerPlugin = tauriLib.indexOf('.plugin(tauri_plugin_opener::init())');
    const run = tauriLib.indexOf('.run(tauri::generate_context!())');

    expect(fpsPlugin).toBeGreaterThan(-1);
    expect(openerPlugin).toBeGreaterThan(fpsPlugin);
    expect(run).toBeGreaterThan(openerPlugin);
  });
});
