import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const LAUNCHER = path.join(projectRoot, 'script', 'build_and_run.sh');
const TAURI_DIR = path.join(projectRoot, 'native', 'desktop', 'psyche-build-tauri', 'src-tauri');

function readLauncher(): string {
  return readFileSync(LAUNCHER, 'utf-8');
}

/**
 * The script with comment lines removed.
 *
 * The comments here deliberately *name* the stale `psyche.app` to explain the
 * bug, so a scan for hardcoded bundle names has to look at code only.
 */
function readLauncherCode(): string {
  return readLauncher()
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** `[package] name` from Cargo.toml — the executable name Tauri produces. */
function cargoPackageName(): string {
  const toml = readFileSync(path.join(TAURI_DIR, 'Cargo.toml'), 'utf-8');
  const pkg = toml.split(/^\[/m).find((section) => section.startsWith('package]'));
  const match = pkg?.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('could not read [package] name from Cargo.toml');
  return match[1];
}

function tauriProductName(): string {
  const conf = JSON.parse(readFileSync(path.join(TAURI_DIR, 'tauri.conf.json'), 'utf-8'));
  return conf.productName;
}

/**
 * The launcher names two different things, from two different sources:
 *
 *   - the `.app` bundle, named after `productName` in tauri.conf.json
 *   - the running process, named after `[package] name` in Cargo.toml
 *
 * Both used to be hardcoded string literals. The comux -> psyche rename moved
 * `productName` to "Psyche Build" and left the launcher pointing at
 * `psyche.app`, which is never produced — so `run`, `--logs`, `--telemetry`
 * and `--verify` all built successfully and then died on `open`, for every
 * commit since that rename. The failure reads like a build problem, and
 * `set -e` aborts before the verification step ever runs.
 *
 * These tests pin the drift, not the current spelling.
 */
describe('desktop launcher tooling', () => {
  it('resolves the .app bundle from disk instead of hardcoding its name', () => {
    const script = readLauncherCode();

    // The shape that rotted was a path ending in a literal bundle filename:
    // `.../bundle/macos/psyche.app`. The glob `*.app` does not match this,
    // because `*` is not a name character.
    const hardcodedBundlePath = script.match(/\/[A-Za-z0-9_ -]+\.app\b/g) ?? [];
    expect(hardcodedBundlePath).toEqual([]);

    expect(script).toContain('APP_BUNDLE_DIR=');
    expect(script).toContain('resolve_app_bundle');
    expect(script).toMatch(/matches=\("\$APP_BUNDLE_DIR"\/\*\.app\)/);
  });

  it('fails loudly when the bundle directory does not hold exactly one .app', () => {
    // Silently opening the wrong bundle would be worse than not opening one.
    const script = readLauncherCode();

    expect(script).toContain('expected exactly one .app bundle');
    expect(script).toMatch(/\$\{#matches\[@\]\} -ne 1/);
  });

  it('greps for the process name Tauri actually produces', () => {
    // APP_NAME feeds `pkill -x` and `pgrep -x`, which match the executable,
    // not the bundle. Tauri names it after the cargo package unless
    // mainBinaryName overrides it.
    const script = readLauncherCode();
    const declared = script.match(/^APP_NAME="([^"]+)"/m)?.[1];

    expect(declared).toBe(cargoPackageName());
    expect(declared).not.toBe(tauriProductName());
  });

  it('verifies the app is actually running rather than assuming open() worked', () => {
    const script = readLauncherCode();

    expect(script).toMatch(/pgrep -x "\$APP_NAME"/);
  });

  it('never inlines a resolver into another command', () => {
    // Under `set -e`, a command substitution that fails as an *argument* does
    // not abort: the exit status belongs to the outer command, so the failure
    // is swallowed and the caller runs on with an empty string. Every resolver
    // must therefore be assigned on a line of its own.
    const script = readLauncherCode();

    const inlined = script
      .split('\n')
      .filter((line) => /\$\(resolve_[a-z_]+\)/.test(line))
      .filter((line) => !/^\s*[a-z_]+="\$\(resolve_[a-z_]+\)"\s*$/.test(line));

    expect(inlined).toEqual([]);
  });

  it('splits declaration from assignment so `local` cannot mask a failure', () => {
    // `local cli="$(resolve)"` takes local's exit status (always 0) and hides
    // the resolver's failure; `local cli` then `cli="$(resolve)"` propagates it.
    const script = readLauncherCode();

    expect(script).not.toMatch(/local\s+[a-z_]+="\$\(/);
  });
});
