import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const desktop = join(root, 'native/desktop/psyche-build-tauri');
const icons = join(desktop, 'src-tauri', 'icons');
const ciWorkflowPath = join(root, '.github/workflows/ci.yml');
const libSourcePath = join(desktop, 'src-tauri/src/lib.rs');
const controlProviderSourcePath = join(desktop, 'src-tauri/src/control_provider.rs');
const platformSourcePath = join(desktop, 'src-tauri/src/platform/mod.rs');
const covenSessionsSourcePath = join(desktop, 'src-tauri/src/coven_sessions.rs');
const mainSourcePath = join(desktop, 'web/main.js');
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.lock', '.md', '.mjs', '.rs', '.sh',
  '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);
const stalePathPattern = /native\/macos\/psyche-build-tauri|['"]native['"]\s*,\s*['"]macos['"]\s*,\s*['"]psyche-build-tauri['"]/;
const originalBaseCsp = "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; frame-src https: http:; connect-src 'self' ipc: http://ipc.localhost https: http:";
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg2000Signature = Buffer.from('0000000c6a5020200d0a870a', 'hex');
const icoDibHeaderSizes = new Set([40]);
const requiredModernIcnsChunkTypes = new Set([
  'ic07',
  'ic08',
  'ic09',
  'ic10',
  'ic11',
  'ic12',
  'ic13',
  'ic14',
]);

function json(name: string) {
  return JSON.parse(readFileSync(join(desktop, 'src-tauri', name), 'utf8'));
}

function readText(path: string) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function hasLeadingSignature(payload: Buffer, signature: Buffer) {
  return payload.length >= signature.length && payload.subarray(0, signature.length).equals(signature);
}

function icoPayloadEncoding(payload: Buffer) {
  if (hasLeadingSignature(payload, pngSignature)) return 'png' as const;
  if (payload.length < 4) return null;

  const dibHeaderSize = payload.readUInt32LE(0);
  if (!icoDibHeaderSizes.has(dibHeaderSize)) return null;
  if (payload.length < dibHeaderSize) return null;

  return 'dib' as const;
}

function icnsPayloadEncoding(payload: Buffer) {
  if (hasLeadingSignature(payload, pngSignature)) return 'png' as const;
  if (hasLeadingSignature(payload, jpeg2000Signature)) return 'jp2' as const;
  return null;
}

function paethPredictor(left: number, up: number, upLeft: number) {
  const candidate = left + up - upLeft;
  const leftDistance = Math.abs(candidate - left);
  const upDistance = Math.abs(candidate - up);
  const upLeftDistance = Math.abs(candidate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function pngRgba(path: string) {
  const png = readFileSync(path);
  if (!hasLeadingSignature(png, pngSignature)) {
    throw new Error(`Invalid PNG signature: ${path}`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compressionMethod = 0;
  let filterMethod = 0;
  let interlaceMethod = 0;
  let sawIHDR = false;
  let sawIEND = false;
  let offset = 8;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    if (offset + 8 > png.length) {
      throw new Error(`Truncated PNG chunk header: ${path}`);
    }
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > png.length) {
      throw new Error(`Out-of-bounds PNG chunk payload: ${path}`);
    }

    if (type === 'IHDR') {
      if (sawIHDR) throw new Error(`Duplicate IHDR chunk: ${path}`);
      if (length !== 13) throw new Error(`Unexpected IHDR length: ${path}`);
      sawIHDR = true;
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      compressionMethod = png[dataStart + 10];
      filterMethod = png[dataStart + 11];
      interlaceMethod = png[dataStart + 12];
    } else if (!sawIHDR) {
      throw new Error(`PNG is missing a leading IHDR chunk: ${path}`);
    } else if (type === 'IDAT') {
      idatChunks.push(png.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error(`Unexpected IEND length: ${path}`);
      sawIEND = true;
      offset = chunkEnd;
      break;
    }

    offset = chunkEnd;
  }

  if (!sawIHDR) throw new Error(`Missing IHDR chunk: ${path}`);
  if (!sawIEND) throw new Error(`Missing IEND chunk: ${path}`);
  if (offset !== png.length) throw new Error(`Unexpected trailing PNG data: ${path}`);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}: ${path}`);
  if (colorType !== 6) throw new Error(`Unsupported PNG color type ${colorType}: ${path}`);
  if (compressionMethod !== 0) {
    throw new Error(`Unsupported PNG compression method ${compressionMethod}: ${path}`);
  }
  if (filterMethod !== 0) throw new Error(`Unsupported PNG filter method ${filterMethod}: ${path}`);
  if (interlaceMethod !== 0) {
    throw new Error(`Unsupported PNG interlace method ${interlaceMethod}: ${path}`);
  }
  if (width === 0 || height === 0) throw new Error(`Invalid PNG dimensions: ${path}`);
  if (idatChunks.length === 0) throw new Error(`Missing PNG IDAT data: ${path}`);

  const rowBytes = width * 4;
  const scanlines = inflateSync(Buffer.concat(idatChunks));
  const expectedScanlineBytes = height * (rowBytes + 1);
  if (scanlines.length !== expectedScanlineBytes) {
    throw new Error(`Unexpected PNG scanline size: ${path}`);
  }

  const rgba = Buffer.alloc(rowBytes * height);
  let scanlineOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = scanlines[scanlineOffset];
    scanlineOffset += 1;
    const rowStart = y * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const source = scanlines[scanlineOffset];
      scanlineOffset += 1;
      const left = x >= 4 ? rgba[rowStart + x - 4] : 0;
      const up = y > 0 ? rgba[rowStart - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[rowStart - rowBytes + x - 4] : 0;

      switch (filterType) {
        case 0:
          rgba[rowStart + x] = source;
          break;
        case 1:
          rgba[rowStart + x] = (source + left) & 0xff;
          break;
        case 2:
          rgba[rowStart + x] = (source + up) & 0xff;
          break;
        case 3:
          rgba[rowStart + x] = (source + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          rgba[rowStart + x] = (source + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filterType}: ${path}`);
      }
    }
  }

  if (scanlineOffset !== scanlines.length) throw new Error(`Unexpected PNG row decoding state: ${path}`);

  const alphaAt = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(`PNG coordinate out of range (${x}, ${y}): ${path}`);
    }
    return rgba[(y * width + x) * 4 + 3];
  };

  return { width, height, bitDepth, colorType, alphaAt };
}

function icoEntries(path: string) {
  const ico = readFileSync(path);
  if (ico.length < 6) throw new Error(`Truncated ICO header: ${path}`);

  const reserved = ico.readUInt16LE(0);
  const type = ico.readUInt16LE(2);
  const count = ico.readUInt16LE(4);
  if (reserved !== 0) throw new Error(`Invalid ICO reserved field: ${path}`);
  if (type !== 1) throw new Error(`Invalid ICO type field: ${path}`);

  const tableEnd = 6 + count * 16;
  if (tableEnd > ico.length) throw new Error(`Out-of-bounds ICO directory table: ${path}`);

  const widths: number[] = [];
  const encodings: Array<'png' | 'dib'> = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = ico[entryOffset] || 256;
    const payloadSize = ico.readUInt32LE(entryOffset + 8);
    const payloadOffset = ico.readUInt32LE(entryOffset + 12);
    const payloadEnd = payloadOffset + payloadSize;

    if (payloadSize === 0) throw new Error(`ICO entry ${index} has an empty payload: ${path}`);
    if (payloadOffset < tableEnd) throw new Error(`ICO entry ${index} overlaps the directory: ${path}`);
    if (payloadEnd > ico.length) throw new Error(`ICO entry ${index} extends past EOF: ${path}`);

    const encoding = icoPayloadEncoding(ico.subarray(payloadOffset, payloadEnd));
    if (!encoding) throw new Error(`ICO entry ${index} has an unsupported payload encoding: ${path}`);

    widths.push(width);
    encodings.push(encoding);
  }

  return { widths, encodings, payloadsValidated: true };
}

function icnsChunks(path: string) {
  const icns = readFileSync(path);
  if (icns.length < 8) throw new Error(`Truncated ICNS header: ${path}`);
  if (icns.subarray(0, 4).toString('ascii') !== 'icns') throw new Error(`Invalid ICNS magic: ${path}`);

  const declaredLength = icns.readUInt32BE(4);
  if (declaredLength !== icns.length) throw new Error(`Mismatched ICNS length: ${path}`);

  const chunkTypes: string[] = [];
  const encodingsByType: Partial<Record<string, 'png' | 'jp2'>> = {};
  let offset = 8;
  while (offset < icns.length) {
    if (offset + 8 > icns.length) throw new Error(`Truncated ICNS chunk header: ${path}`);
    const type = icns.subarray(offset, offset + 4).toString('ascii');
    const size = icns.readUInt32BE(offset + 4);
    const chunkEnd = offset + size;
    if (size <= 8) throw new Error(`Invalid ICNS chunk length for ${type}: ${path}`);
    if (chunkEnd > icns.length) throw new Error(`Out-of-bounds ICNS chunk ${type}: ${path}`);

    if (requiredModernIcnsChunkTypes.has(type)) {
      const encoding = icnsPayloadEncoding(icns.subarray(offset + 8, chunkEnd));
      if (!encoding) throw new Error(`ICNS chunk ${type} has an unsupported image signature: ${path}`);
      encodingsByType[type] = encoding;
    }

    chunkTypes.push(type);
    offset = chunkEnd;
  }

  return { chunkTypes, encodingsByType };
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

  it('ships valid committed desktop icon PNG, ICO, and ICNS containers', () => {
    for (const [name, size] of [
      ['icon.png', 1024],
      ['32x32.png', 32],
      ['64x64.png', 64],
      ['128x128.png', 128],
      ['128x128@2x.png', 256],
    ] as const) {
      const png = pngRgba(join(icons, name));
      expect(png).toMatchObject({ width: size, height: size, bitDepth: 8, colorType: 6 });
      for (const [x, y] of [
        [0, 0],
        [png.width - 1, 0],
        [0, png.height - 1],
        [png.width - 1, png.height - 1],
      ] as const) {
        expect(png.alphaAt(x, y)).toBe(0);
      }
      expect(png.alphaAt(Math.floor(png.width / 2), Math.floor(png.height / 2))).toBe(255);
    }

    const ico = icoEntries(join(icons, 'icon.ico'));
    expect(ico.widths).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 256]));
    expect(ico.payloadsValidated).toBe(true);

    const icns = icnsChunks(join(icons, 'icon.icns'));
    expect(icns.chunkTypes).toEqual(expect.arrayContaining([
      'ic07',
      'ic08',
      'ic09',
      'ic10',
      'ic11',
      'ic12',
      'ic13',
      'ic14',
    ]));
    expect(icns.encodingsByType).toEqual(expect.objectContaining({
      ic07: 'png',
      ic08: 'png',
      ic09: 'png',
      ic10: 'png',
      ic11: 'png',
      ic12: 'png',
      ic13: 'png',
      ic14: 'png',
    }));
  });

  it('routes structured targets through the native platform launch descriptor', () => {
    const libSource = readFileSync(libSourcePath, 'utf8');
    const mainSource = readFileSync(mainSourcePath, 'utf8');
    const appEnvironment = bracedItem(libSource, 'fn app_environment');
    const ptyStart = bracedItem(libSource, 'fn pty_start_blocking');
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

  it('routes control credentials through the shared platform home resolver', () => {
    const controlProviderSource = readFileSync(controlProviderSourcePath, 'utf8');
    const platformSource = readFileSync(platformSourcePath, 'utf8');
    const controlCredentialsPath = bracedItem(controlProviderSource, 'fn control_credentials_path');

    expect(controlCredentialsPath).toContain('platform::psyche_user_config_directory()');
    expect(controlCredentialsPath).toContain('.join("control")');
    expect(controlCredentialsPath).toContain('.join("projects")');
    expect(controlCredentialsPath).toContain('project_identity_digest(identity)');
    expect(controlCredentialsPath).toContain('.join("control-credentials.json")');
    expect(controlCredentialsPath).not.toMatch(/std::env::var_os\(["']HOME["']\)/);
    expect(platformSource).toContain('non_empty(user_profile).or_else(|| non_empty(home))');
    expect(platformSource).toContain('.join(".config")');
    expect(platformSource).toContain('.join("psyche")');
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
