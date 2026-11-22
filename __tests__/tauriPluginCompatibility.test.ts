import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const desktop = join(process.cwd(), 'native/desktop/psyche-build-tauri');
const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const resolve = createRequire(join(desktop, 'package.json')).resolve;
const rust = readFileSync(join(desktop, 'src-tauri/Cargo.lock'), 'utf8').replaceAll('\r\n', '\n').split('[[package]]');
function installedVersion(name: string): string {
  let directory = dirname(resolve(name));
  for (let depth = 0; depth < 4; depth += 1, directory = dirname(directory)) {
    const file = join(directory, 'package.json');
    if (!existsSync(file)) continue;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.name === name) return value.version;
  }
  throw new Error(`No installed package metadata for ${name}`);
}
function majorMinor(version: string) { return version.split('.').slice(0, 2).join('.'); }

describe('packaged Tauri plugin compatibility', () => {
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@tauri-apps/plugin-'))) {
    it(`${name} matches the locked native plugin major/minor`, () => {
      const crate = name.replace('@tauri-apps/plugin-', 'tauri-plugin-');
      const versions = rust.filter(block => block.includes(`name = "${crate}"\n`))
        .map(block => block.match(/\nversion = "([^"]+)"/)?.[1]);
      expect(versions, `Expected one locked native ${crate}`).toHaveLength(1);
      expect(majorMinor(installedVersion(name)), 'Tauri packaging requires paired plugin releases').toBe(majorMinor(versions[0]!));
    });
  }
});
