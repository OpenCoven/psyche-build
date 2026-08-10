import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const inputModule = await import(
  pathToFileURL(join(webRoot, 'input/terminal-drop.mjs')).href
);

describe('terminal image drop helpers', () => {
  it('filters supported image paths in drop order and shell-quotes them', () => {
    expect(
      inputModule.buildImageDropInsertion([
        '/tmp/cover image.PNG',
        "/tmp/witch's portrait.jpg",
        '/tmp/notes.md',
        '/tmp/reference.AVIF',
      ])
    ).toEqual({
      accepted: [
        '/tmp/cover image.PNG',
        "/tmp/witch's portrait.jpg",
        '/tmp/reference.AVIF',
      ],
      skipped: ['/tmp/notes.md'],
      text:
        "'/tmp/cover image.PNG' '/tmp/witch'\\''s portrait.jpg' '/tmp/reference.AVIF'",
    });
  });

  it('supports the approved image extensions case-insensitively', () => {
    for (const extension of [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'avif',
      'heic',
      'heif',
      'tif',
      'tiff',
      'bmp',
      'svg',
    ]) {
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension}`)).toBe(true);
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension.toUpperCase()}`)).toBe(true);
    }

    expect(inputModule.isSupportedImagePath('/tmp/image.txt')).toBe(false);
    expect(inputModule.isSupportedImagePath('/tmp/image.png.txt')).toBe(false);
  });

  it('converts Tauri physical coordinates to CSS coordinates', () => {
    expect(inputModule.physicalToCssPosition({ x: 300, y: 180 }, 2)).toEqual({
      x: 150,
      y: 90,
    });
  });

  it('rejects invalid or non-positive coordinates and scale factors', () => {
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, 0)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, -1)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, Number.NaN)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: Number.NaN, y: 2 }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: Number.POSITIVE_INFINITY }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 0, y: 2 }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: 1, y: -2 }, 2)).toBeNull();
    expect(inputModule.physicalToCssPosition(null, 2)).toBeNull();
  });
});

describe('terminal input bundle wiring', () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/package.json'), 'utf8')
  ) as { scripts: Record<string, string> };
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

  it('builds and loads PsycheTerminalInput before the application shell', () => {
    expect(packageJson.scripts['build:web']).toContain(
      'esbuild web/input/input-entry.js --bundle --minify --format=iife ' +
        '--global-name=PsycheTerminalInput --outfile=web/input.bundle.js'
    );
    const inputScript = '<script src="./input.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';
    expect(indexHtml).toContain(inputScript);
    expect(indexHtml.indexOf(inputScript)).toBeLessThan(indexHtml.indexOf(mainScript));
  });
});
