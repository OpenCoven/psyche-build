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
const pngChunkTypePattern = /^[A-Za-z]{4}$/;
const supportedCriticalPngChunkTypes = new Set(['IHDR', 'IDAT', 'IEND']);
const requiredModernIcnsChunkDimensions: Record<string, number> = {
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
};
const requiredModernIcnsChunkTypes = new Set(Object.keys(requiredModernIcnsChunkDimensions));

function json(name: string) {
  return JSON.parse(readFileSync(join(desktop, 'src-tauri', name), 'utf8'));
}

function readText(path: string) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
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

function pngChunkCrc32(...parts: readonly Buffer[]) {
  let crc = 0xffffffff;

  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
      }
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function isCriticalPngChunkType(typeBytes: Buffer) {
  return (typeBytes[0] & 0x20) === 0;
}

function isAsciiLetterByte(byte: number) {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function formatPngChunkTypeBytes(typeBytes: Buffer) {
  return [...typeBytes].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(' ');
}

function decodePngChunkType(typeBytes: Buffer, source: string) {
  if (typeBytes.length !== 4 || ![...typeBytes].every(isAsciiLetterByte)) {
    throw new Error(
      `Invalid PNG chunk type bytes ${formatPngChunkTypeBytes(typeBytes)} (expected ASCII letters): ${source}`,
    );
  }

  if ((typeBytes[2] & 0x20) !== 0) {
    throw new Error(`Invalid PNG chunk type reserved bit for ${typeBytes.toString('ascii')}: ${source}`);
  }

  return typeBytes.toString('ascii');
}

function buildPngChunk(type: string, data = Buffer.alloc(0)) {
  if (!pngChunkTypePattern.test(type)) {
    throw new Error(`Invalid PNG chunk type ${JSON.stringify(type)}`);
  }

  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngChunkCrc32(typeBytes, data), 8 + data.length);
  return chunk;
}

function pngChunkOffset(png: Buffer, type: string) {
  let offset = pngSignature.length;

  while (offset < png.length) {
    if (offset + 8 > png.length) {
      throw new Error(`Truncated PNG chunk header while locating ${type}`);
    }

    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.length) {
      throw new Error(`Out-of-bounds PNG chunk while locating ${type}`);
    }

    if (decodePngChunkType(png.subarray(offset + 4, offset + 8), `while locating ${type}`) === type) {
      return offset;
    }

    offset = chunkEnd;
  }

  throw new Error(`Missing PNG chunk ${type}`);
}

function pngRgbaBuffer(png: Buffer, source: string) {
  if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`Invalid PNG signature: ${source}`);
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
  let sawIDAT = false;
  let endedIDATSequence = false;
  let offset = 8;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    if (offset + 8 > png.length) {
      throw new Error(`Truncated PNG chunk header: ${source}`);
    }
    const length = png.readUInt32BE(offset);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    const type = decodePngChunkType(typeBytes, source);
    if (chunkEnd > png.length) {
      throw new Error(`Out-of-bounds PNG chunk payload: ${source}`);
    }
    const actualCrc = pngChunkCrc32(typeBytes, png.subarray(dataStart, dataEnd));
    const storedCrc = png.readUInt32BE(dataEnd);
    if (actualCrc !== storedCrc) {
      throw new Error(`PNG chunk CRC mismatch for ${type}: ${source}`);
    }
    if (sawIEND) {
      if (type === 'IEND') throw new Error(`Duplicate IEND chunk: ${source}`);
      throw new Error(`Unexpected trailing PNG data after IEND: ${source}`);
    }
    if (isCriticalPngChunkType(typeBytes) && !supportedCriticalPngChunkTypes.has(type)) {
      throw new Error(`Unsupported PNG critical chunk ${type}: ${source}`);
    }

    if (type === 'IHDR') {
      if (sawIHDR) throw new Error(`Duplicate IHDR chunk: ${source}`);
      if (length !== 13) throw new Error(`Unexpected IHDR length: ${source}`);
      sawIHDR = true;
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      compressionMethod = png[dataStart + 10];
      filterMethod = png[dataStart + 11];
      interlaceMethod = png[dataStart + 12];
    } else if (!sawIHDR) {
      throw new Error(`PNG is missing a leading IHDR chunk: ${source}`);
    } else if (type === 'IDAT') {
      if (endedIDATSequence) throw new Error(`PNG has a non-contiguous IDAT sequence: ${source}`);
      sawIDAT = true;
      idatChunks.push(png.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (!sawIDAT) throw new Error(`PNG IEND chunk must follow IDAT data: ${source}`);
      if (length !== 0) throw new Error(`Unexpected IEND length: ${source}`);
      sawIEND = true;
    } else if (sawIDAT) {
      endedIDATSequence = true;
    }

    offset = chunkEnd;
  }

  if (!sawIHDR) throw new Error(`Missing IHDR chunk: ${source}`);
  if (!sawIEND) throw new Error(`Missing IEND chunk: ${source}`);
  if (offset !== png.length) throw new Error(`Unexpected trailing PNG data after IEND: ${source}`);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}: ${source}`);
  if (colorType !== 6) throw new Error(`Unsupported PNG color type ${colorType}: ${source}`);
  if (compressionMethod !== 0) {
    throw new Error(`Unsupported PNG compression method ${compressionMethod}: ${source}`);
  }
  if (filterMethod !== 0) throw new Error(`Unsupported PNG filter method ${filterMethod}: ${source}`);
  if (interlaceMethod !== 0) {
    throw new Error(`Unsupported PNG interlace method ${interlaceMethod}: ${source}`);
  }
  if (width === 0 || height === 0) throw new Error(`Invalid PNG dimensions: ${source}`);
  if (idatChunks.length === 0) throw new Error(`Missing PNG IDAT data: ${source}`);

  const rowBytes = width * 4;
  let scanlines: Buffer;
  try {
    scanlines = inflateSync(Buffer.concat(idatChunks));
  } catch {
    throw new Error(`Invalid PNG IDAT stream: ${source}`);
  }
  const expectedScanlineBytes = height * (rowBytes + 1);
  if (scanlines.length !== expectedScanlineBytes) {
    throw new Error(`Unexpected PNG scanline size: ${source}`);
  }

  const rgba = Buffer.alloc(rowBytes * height);
  let scanlineOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = scanlines[scanlineOffset];
    scanlineOffset += 1;
    const rowStart = y * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const sourceByte = scanlines[scanlineOffset];
      scanlineOffset += 1;
      const left = x >= 4 ? rgba[rowStart + x - 4] : 0;
      const up = y > 0 ? rgba[rowStart - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[rowStart - rowBytes + x - 4] : 0;

      switch (filterType) {
        case 0:
          rgba[rowStart + x] = sourceByte;
          break;
        case 1:
          rgba[rowStart + x] = (sourceByte + left) & 0xff;
          break;
        case 2:
          rgba[rowStart + x] = (sourceByte + up) & 0xff;
          break;
        case 3:
          rgba[rowStart + x] = (sourceByte + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          rgba[rowStart + x] = (sourceByte + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filterType}: ${source}`);
      }
    }
  }

  if (scanlineOffset !== scanlines.length) {
    throw new Error(`Unexpected PNG row decoding state: ${source}`);
  }

  const alphaAt = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(`PNG coordinate out of range (${x}, ${y}): ${source}`);
    }
    return rgba[(y * width + x) * 4 + 3];
  };

  return { width, height, bitDepth, colorType, alphaAt };
}

function pngRgba(path: string) {
  return pngRgbaBuffer(readFileSync(path), path);
}

function normalizeIcoDimension(rawDimension: number) {
  return rawDimension || 256;
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

  const entries: Array<{ width: number; height: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = normalizeIcoDimension(ico[entryOffset]);
    const height = normalizeIcoDimension(ico[entryOffset + 1]);
    const payloadSize = ico.readUInt32LE(entryOffset + 8);
    const payloadOffset = ico.readUInt32LE(entryOffset + 12);
    const payloadEnd = payloadOffset + payloadSize;

    if (payloadSize === 0) throw new Error(`ICO entry ${index} has an empty payload: ${path}`);
    if (payloadOffset < tableEnd) throw new Error(`ICO entry ${index} overlaps the directory: ${path}`);
    if (payloadEnd > ico.length) throw new Error(`ICO entry ${index} extends past EOF: ${path}`);

    const png = pngRgbaBuffer(ico.subarray(payloadOffset, payloadEnd), `${path}#entry-${index}`);
    if (png.width !== width || png.height !== height) {
      throw new Error(
        `ICO entry ${index} dimensions ${png.width}x${png.height} do not match directory ${width}x${height}: ${path}`,
      );
    }

    entries.push({ width, height });
  }

  return { entries };
}

function icnsChunks(path: string) {
  const icns = readFileSync(path);
  if (icns.length < 8) throw new Error(`Truncated ICNS header: ${path}`);
  if (icns.subarray(0, 4).toString('ascii') !== 'icns') throw new Error(`Invalid ICNS magic: ${path}`);

  const declaredLength = icns.readUInt32BE(4);
  if (declaredLength !== icns.length) throw new Error(`Mismatched ICNS length: ${path}`);

  const chunkTypes: string[] = [];
  let offset = 8;
  while (offset < icns.length) {
    if (offset + 8 > icns.length) throw new Error(`Truncated ICNS chunk header: ${path}`);
    const type = icns.subarray(offset, offset + 4).toString('ascii');
    const size = icns.readUInt32BE(offset + 4);
    const chunkEnd = offset + size;
    if (size <= 8) throw new Error(`Invalid ICNS chunk length for ${type}: ${path}`);
    if (chunkEnd > icns.length) throw new Error(`Out-of-bounds ICNS chunk ${type}: ${path}`);

    if (requiredModernIcnsChunkTypes.has(type)) {
      const expectedDimension = requiredModernIcnsChunkDimensions[type];
      const png = pngRgbaBuffer(icns.subarray(offset + 8, chunkEnd), `${path}#${type}`);
      if (png.width !== expectedDimension || png.height !== expectedDimension) {
        throw new Error(
          `ICNS chunk ${type} dimensions ${png.width}x${png.height} do not match expected ${expectedDimension}x${expectedDimension}: ${path}`,
        );
      }
    }

    chunkTypes.push(type);
    offset = chunkEnd;
  }

  return { chunkTypes };
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
    const desktopCheck = workflowJob(workflow, 'desktop-check');
    const desktopWeb = workflowJob(workflow, 'desktop-web');
    const rustTest = workflowJob(workflow, 'rust-test');
    const bundleFreshnessGate = 'pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriPackageScripts.test.ts __tests__/tauriDesktopTabs.test.ts';
    const buildBundles = 'pnpm --dir native/desktop/psyche-build-tauri build:web';

    expect(desktopCheck).toContain('runs-on: ${{ matrix.os }}');
    expect([...desktopCheck.matchAll(/^\s{10}- (.+)$/gm)].map(([, runner]) => runner)).toEqual([
      'macos-15',
      'windows-2025',
      'ubuntu-24.04',
    ]);
    expect(desktopWeb).toContain('pnpm install --frozen-lockfile');
    expect(desktopWeb).toContain(buildBundles);
    expect(rustTest).toContain('cargo fmt --manifest-path "$MANIFEST" --check');
    expect(rustTest).toContain('cargo test --manifest-path "$MANIFEST" --locked');
    expect(desktopCheck).toContain('cargo check --manifest-path "$MANIFEST" --locked');
    expect(desktopWeb).toContain(bundleFreshnessGate);
    expect(
      desktopWeb.indexOf(bundleFreshnessGate),
      'desktop-web must run bundle freshness checks before the in-place build can overwrite stale committed bundles',
    ).toBeLessThan(desktopWeb.indexOf(buildBundles));
    for (const job of [desktopWeb, rustTest, desktopCheck]) {
      expect(job).not.toMatch(/^\s+run: .*tauri build(?:\s|$)/gmi);
      expect(job).not.toMatch(/upload-artifact|signing|notarize|publish/i);
    }
  });

  it('installs official Tauri prerequisites only on Linux with a target-safe shell', () => {
    const workflow = readText(ciWorkflowPath);
    const job = workflowJob(workflow, 'desktop-check');
    const installStart = job.indexOf('- name: Install Tauri Linux prerequisites');
    const installEnd = job.indexOf('\n      - name:', installStart + 1);
    const installStep = job.slice(
      installStart,
      installEnd === -1 ? undefined : installEnd,
    );

    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installStep).toContain(
      "if: runner.os == 'Linux' && needs.changes.outputs.desktop == 'true'",
    );
    expect(installStep).toContain('timeout-minutes: 20');
    expect(installStep).toContain('shell: bash');
    expect(installStep).toContain('run: |');
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
    expect(job).toMatch(
      /- name: Check desktop runtime\s*\n\s+if: needs\.changes\.outputs\.desktop == 'true'\s*\n\s+shell: bash\s*\n\s+run: \|/,
    );
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
      .toBe('vite web --host 127.0.0.1 --port 1420 --strictPort --publicDir ../.psyche-dev-web/web');
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
    expect(ico.entries).toEqual(expect.arrayContaining([
      { width: 16, height: 16 },
      { width: 24, height: 24 },
      { width: 32, height: 32 },
      { width: 48, height: 48 },
      { width: 64, height: 64 },
      { width: 256, height: 256 },
    ]));

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
  });

  it('rejects PNG chunks with invalid CRCs', () => {
    const validPng = readFileSync(join(icons, '32x32.png'));
    const corruptedPng = Buffer.from(validPng);
    const ihdrCrcOffset = pngChunkOffset(corruptedPng, 'IHDR') + 8 + 13;

    corruptedPng[ihdrCrcOffset] ^= 0xff;

    expect(() => pngRgbaBuffer(corruptedPng, 'corrupted-ihdr-crc')).toThrow(
      /PNG chunk CRC mismatch for IHDR: corrupted-ihdr-crc/,
    );
  });

  it('rejects unsupported critical PNG chunks even with valid CRCs', () => {
    const validPng = readFileSync(join(icons, '32x32.png'));
    const iendOffset = pngChunkOffset(validPng, 'IEND');
    const unknownCriticalChunk = buildPngChunk('ABCD');
    const mutatedPng = Buffer.concat([
      validPng.subarray(0, iendOffset),
      unknownCriticalChunk,
      validPng.subarray(iendOffset),
    ]);

    expect(() => pngRgbaBuffer(mutatedPng, 'unsupported-critical-abcd')).toThrow(
      /Unsupported PNG critical chunk ABCD: unsupported-critical-abcd/,
    );
  });

  it('rejects PNG chunk types with non-ASCII bytes even when the CRC matches', () => {
    const validPng = readFileSync(join(icons, '32x32.png'));
    const mutatedPng = Buffer.from(validPng);
    const ihdrOffset = pngChunkOffset(mutatedPng, 'IHDR');
    const typeOffset = ihdrOffset + 4;
    const dataStart = ihdrOffset + 8;
    const dataEnd = dataStart + mutatedPng.readUInt32BE(ihdrOffset);

    mutatedPng[typeOffset] = 0xc9;
    mutatedPng.writeUInt32BE(
      pngChunkCrc32(mutatedPng.subarray(typeOffset, typeOffset + 4), mutatedPng.subarray(dataStart, dataEnd)),
      dataEnd,
    );

    expect(() => pngRgbaBuffer(mutatedPng, 'non-ascii-ihdr-type')).toThrow(
      /Invalid PNG chunk type bytes 0xc9 0x48 0x44 0x52 \(expected ASCII letters\): non-ascii-ihdr-type/,
    );
  });

  it('rejects unsupported PLTE chunks instead of treating them as valid critical structure', () => {
    const validPng = readFileSync(join(icons, '32x32.png'));
    const iendOffset = pngChunkOffset(validPng, 'IEND');
    const mutatedPng = Buffer.concat([
      validPng.subarray(0, iendOffset),
      buildPngChunk('PLTE'),
      validPng.subarray(iendOffset),
    ]);

    expect(() => pngRgbaBuffer(mutatedPng, 'unsupported-critical-plte')).toThrow(
      /Unsupported PNG critical chunk PLTE: unsupported-critical-plte/,
    );
  });

  it('rejects non-contiguous IDAT sequences', () => {
    const validPng = readFileSync(join(icons, '32x32.png'));
    const idatOffset = pngChunkOffset(validPng, 'IDAT');
    const idatChunkEnd = idatOffset + 12 + validPng.readUInt32BE(idatOffset);
    const iendOffset = pngChunkOffset(validPng, 'IEND');
    const repeatedIdatChunk = validPng.subarray(idatOffset, idatChunkEnd);
    const mutatedPng = Buffer.concat([
      validPng.subarray(0, iendOffset),
      buildPngChunk('tEXt'),
      repeatedIdatChunk,
      validPng.subarray(iendOffset),
    ]);

    expect(() => pngRgbaBuffer(mutatedPng, 'non-contiguous-idat')).toThrow(
      /PNG has a non-contiguous IDAT sequence: non-contiguous-idat/,
    );
  });

  it('routes structured targets through the native platform launch descriptor', () => {
    const libSource = readFileSync(libSourcePath, 'utf8');
    const mainSource = readFileSync(mainSourcePath, 'utf8');
    const appEnvironment = bracedItem(libSource, 'fn app_environment');
    const ptyStart = bracedItem(libSource, 'fn pty_start_blocking');
    const ptyStartImplementation = bracedItem(libSource, 'fn pty_start_blocking_with_launch');
    const spawnShellThread = bracedItem(mainSource, 'function spawnShellThread');
    const spawnPsycheThread = bracedItem(mainSource, 'function spawnPsycheThread');

    expect(libSource).toMatch(/pub default_shell_args:\s*Vec<String>/);
    expect(appEnvironment).toMatch(
      /let\s+\(default_shell,\s*default_shell_args\)\s*=\s*platform::default_shell\(\)/,
    );
    expect(appEnvironment).toMatch(
      /AppEnvironment\s*\{[\s\S]*default_shell,[\s\S]*default_shell_args,/,
    );
    expect(ptyStart).toContain('pty_start_blocking_with_launch(app, options, None)');
    expect(ptyStartImplementation).toMatch(
      /platform::pty_launch_descriptor\(options\.command,\s*options\.args\)/,
    );
    expect(ptyStartImplementation).toContain('let platform::LaunchDescriptor');
    expect(ptyStartImplementation).toContain('cmd.args(args)');
    expect(ptyStartImplementation).toContain('for (key, value) in launch_env');

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
