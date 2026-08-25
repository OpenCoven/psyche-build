import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { scanDirectories, dirCacheSize, resetDirCache } from '../src/utils/dirScanner.js';

const roots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'psyche-dirscanner-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('dirScanner cache bounds', () => {
  beforeEach(() => {
    resetDirCache();
  });

  it('does not retain every directory it has ever scanned', () => {
    const root = makeTempRoot();
    for (let i = 0; i < 80; i++) {
      const dir = path.join(root, `parent-${i}`);
      mkdirSync(path.join(dir, 'child'), { recursive: true });
      scanDirectories(dir, '');
    }

    expect(dirCacheSize()).toBeLessThanOrEqual(32);
  });

  it('still returns correct entries after eviction pressure', () => {
    const root = makeTempRoot();
    const first = path.join(root, 'first');
    mkdirSync(path.join(first, 'alpha'), { recursive: true });
    mkdirSync(path.join(first, 'beta'), { recursive: true });

    expect(scanDirectories(first, '').map((e) => e.name)).toEqual(['alpha', 'beta']);

    for (let i = 0; i < 80; i++) {
      const dir = path.join(root, `filler-${i}`);
      mkdirSync(dir, { recursive: true });
      scanDirectories(dir, '');
    }

    // `first` has been evicted; the re-read must produce the same answer.
    expect(scanDirectories(first, '').map((e) => e.name)).toEqual(['alpha', 'beta']);
  });
});
