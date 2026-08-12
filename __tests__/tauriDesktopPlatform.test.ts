import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const desktop = join(root, 'native/desktop/psyche-build-tauri');
const ciWorkflowPath = join(root, '.github/workflows/ci.yml');
const libSourcePath = join(desktop, 'src-tauri/src/lib.rs');
const covenSessionsSourcePath = join(desktop, 'src-tauri/src/coven_sessions.rs');
const mainSourcePath = join(desktop, 'web/main.js');
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.lock', '.md', '.mjs', '.rs', '.sh',
  '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);
const stalePathPattern = /native\/macos\/psyche-build-tauri|['"]native['"]\s*,\s*['"]macos['"]\s*,\s*['"]psyche-build-tauri['"]/;
const originalBaseCsp = "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; frame-src https: http:; connect-src 'self' ipc: http://ipc.localhost https: http:";

function json(name: string) {
  return JSON.parse(readFileSync(join(desktop, 'src-tauri', name), 'utf8'));
}

function readText(path: string) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function stalePathReferences(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file
      && file !== '__tests__/tauriDesktopPlatform.test.ts'
      && !file.startsWith('docs/superpowers/')
      && textExtensions.has(extname(file)))
    .filter((file) => existsSync(join(root, file)))
    .filter((file) => stalePathPattern.test(readFileSync(join(root, file), 'utf8')));
}

function bracedItem(source: string, marker: string, start = 0): string {
  const itemStart = source.indexOf(marker, start);
  expect(itemStart).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf('{', itemStart);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(itemStart, index + 1);
  }

  throw new Error(`Could not find the end of ${marker}`);
}

function workflowJob(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
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

  it('checks the desktop runtime on exactly macOS, Windows, and Linux', () => {
    const workflow = readText(ciWorkflowPath);
    const job = workflowJob(workflow, 'desktop-runtime');
    const bundleFreshnessGate = 'pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriPackageScripts.test.ts __tests__/tauriDesktopTabs.test.ts';
    const buildBundles = 'pnpm --dir native/desktop/psyche-build-tauri build:web';

    expect(job).toContain('runs-on: ${{ matrix.os }}');
    expect([...job.matchAll(/^\s{10}- (.+)$/gm)].map(([, runner]) => runner)).toEqual([
      'macos-15',
      'windows-2025',
      'ubuntu-24.04',
    ]);
    expect(job).toContain('pnpm install --frozen-lockfile');
    expect(job).toContain(buildBundles);
    expect(job).toContain(
      'cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check',
    );
    expect(job).toContain(
      'cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked',
    );
    expect(job).toContain(
      'cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked',
    );
    expect(job).toContain(bundleFreshnessGate);
    expect(
      job.indexOf(bundleFreshnessGate),
      'desktop-runtime must run bundle freshness checks before the in-place build can overwrite stale committed bundles',
    ).toBeLessThan(job.indexOf(buildBundles));
    expect(job).not.toMatch(/^\s+run: .*tauri build(?:\s|$)/gmi);
    expect(job).not.toMatch(/upload-artifact|signing|notarize|publish/i);
  });

  it('installs official Tauri prerequisites only on Linux with a target-safe shell', () => {
    const workflow = readText(ciWorkflowPath);
    const job = workflowJob(workflow, 'desktop-runtime');

    expect(job).toMatch(
      /- name: Install Tauri Linux prerequisites\s*\n\s+if: runner\.os == 'Linux'\s*\n\s+shell: bash\s*\n\s+run: \|/,
    );
    for (const dependency of [
      'libwebkit2gtk-4.1-dev',
      'build-essential',
      'curl',
      'wget',
      'file',
      'libxdo-dev',
      'libssl-dev',
      'libayatana-appindicator3-dev',
      'librsvg2-dev',
    ]) {
      expect(job).toContain(dependency);
    }
    expect(job.match(/shell: bash/g)).toHaveLength(1);
    expect(job).not.toMatch(/\bMANIFEST=|\$MANIFEST|set -euo pipefail/);
  });

  it('keeps portable opaque defaults and macOS presentation in its overlay', () => {
    const base = json('tauri.conf.json');
    const mac = json('tauri.macos.conf.json');
    const win = json('tauri.windows.conf.json');
    const linux = json('tauri.linux.conf.json');

    expect(base.app.windows[0]).toMatchObject({ transparent: false, decorations: true });
    expect(base.app.macOSPrivateApi).toBe(true);
    expect(mac.app.windows[0]).toMatchObject({ transparent: true, titleBarStyle: 'Overlay' });
    expect(mac.app).not.toHaveProperty('macOSPrivateApi');
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
    expect(desktopPackage.devDependencies.vite).toBe('8.2.1');
    expect(JSON.stringify(configs)).not.toMatch(/\bpython3?\b/);
  });

  it('routes structured targets through the native platform launch descriptor', () => {
    const libSource = readFileSync(libSourcePath, 'utf8');
    const mainSource = readFileSync(mainSourcePath, 'utf8');
    const appEnvironment = bracedItem(libSource, 'fn app_environment');
    const ptyStart = bracedItem(libSource, 'fn pty_start');
    const spawnShellThread = bracedItem(mainSource, 'function spawnShellThread');
    const spawnPsycheThread = bracedItem(mainSource, 'function spawnPsycheThread');

    expect(libSource).toMatch(/pub default_shell_args:\s*Vec<String>/);
    expect(appEnvironment).toMatch(
      /let\s+\(default_shell,\s*default_shell_args\)\s*=\s*platform::default_shell\(\)/,
    );
    expect(appEnvironment).toMatch(
      /AppEnvironment\s*\{[\s\S]*default_shell,[\s\S]*default_shell_args,/,
    );
    expect(ptyStart).toMatch(
      /platform::pty_launch_descriptor\(options\.command,\s*options\.args\)/,
    );
    expect(ptyStart).toContain('let platform::LaunchDescriptor');
    expect(ptyStart).toContain('cmd.args(args)');
    expect(ptyStart).toContain('for (key, value) in launch_env');

    expect(spawnShellThread).toContain('command: state.env.default_shell');
    expect(spawnShellThread).toContain('args: state.env.default_shell_args');
    expect(spawnShellThread).not.toMatch(/\/bin\/zsh|\[\s*["']-l["']\s*\]/);

    expect(spawnPsycheThread).toContain('command: state.env.node_path');
    expect(spawnPsycheThread).toContain('args: [state.env.psyche_entry]');
    expect(spawnPsycheThread).not.toMatch(
      /default_shell|\/bin\/zsh|quoted|["']exec\s|["']-l["']|["']-c["']/,
    );
  });

  it('uses the platform home contract instead of assuming HOME exists', () => {
    const libSource = readFileSync(libSourcePath, 'utf8');
    const appEnvironment = bracedItem(libSource, 'fn app_environment');

    expect(appEnvironment).toContain('let home = platform::home_directory();');
    expect(appEnvironment).not.toMatch(/std::env::var\(["']HOME["']\)/);
  });

  it('uses Windows PATHEXT when resolving extensionless executables', () => {
    const libSource = readFileSync(libSourcePath, 'utf8');
    const executableLookup = libSource.slice(
      libSource.indexOf('fn is_executable_file'),
      libSource.indexOf('fn locate_psyche_repo'),
    );

    expect(executableLookup).toMatch(/#\[cfg\(target_os = "windows"\)\][\s\S]*PATHEXT/);
    expect(executableLookup).toMatch(/std::env::split_paths/);
    expect(executableLookup).toMatch(/executable_names_with_extensions/);
  });

  it('cfg-isolates every Unix Coven descriptor and polling implementation detail', () => {
    const source = readFileSync(covenSessionsSourcePath, 'utf8');
    const unixOnlyDeclarations = [
      'const EXCHANGE_TIMEOUT',
      'fn try_load_coven_sessions',
      'fn request_endpoint',
      'trait LocalHttpStream',
      'impl LocalHttpStream for TcpStream',
      'impl LocalHttpStream for UnixStream',
      'fn exchange_http',
      'fn remaining_before',
      'fn write_all_before',
      'fn flush_before',
      'fn read_to_end_before',
      'fn connect_unix_before',
      'fn wait_for_unix_connect',
      'fn wait_for_io',
      'fn categorize_io_error',
    ];

    for (const declaration of unixOnlyDeclarations) {
      const start = source.indexOf(declaration);
      expect(start, declaration).toBeGreaterThanOrEqual(0);
      expect(source.slice(Math.max(0, start - 80), start), declaration)
        .toMatch(/#\[cfg\(unix\)\]\s*$/);
    }

    expect(source).not.toContain('#[cfg(not(unix))]\n        CovenEndpoint::Unix');
    expect(source).toMatch(
      /#\[cfg\(target_os = "windows"\)\]\s*#\[tauri::command\][\s\S]*?fn coven_sessions[\s\S]*?-> CovenSessionsUnavailableResponse\s*\{\s*windows_transport_unavailable_response\(\)\s*\}/,
    );
    expect(source).toContain(
      'reason: "local Coven Unix socket transport is unsupported on Windows"',
    );
  });
});
