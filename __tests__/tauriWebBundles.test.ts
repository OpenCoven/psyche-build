import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The committed web bundles are generated build output, so nothing but a
 * test stops them drifting from the sources they were built from. This invokes
 * the same repository build script in an isolated output directory and
 * compares the bytes, so the check cannot validate yesterday's command.
 */
const packageRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri');
const webRoot = join(packageRoot, 'web');
const buildScript = (
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts['build:web'];

type BundleStep = { outfile: string };

const steps: BundleStep[] = [
  { outfile: 'web/control.bundle.js' },
  { outfile: 'web/diffs.bundle.js' },
  { outfile: 'web/editor.bundle.js' },
  { outfile: 'web/input.bundle.js' },
  { outfile: 'web/panes.bundle.js' },
  { outfile: 'web/runtime-debug.bundle.js' },
  { outfile: 'web/runtime.bundle.js' },
  { outfile: 'web/sessions.bundle.js' },
  { outfile: 'web/status.bundle.js' },
  { outfile: 'web/workspace.bundle.js' },
];
const artifactRoot = join(process.cwd(), '.test-artifacts', 'tauri-web-bundles');
const releaseScratch = join(artifactRoot, 'release');
const debugScratch = join(artifactRoot, 'debug');
const debugRepeatScratch = join(artifactRoot, 'debug-repeat');
rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(artifactRoot, { recursive: true });
beforeAll(() => {
  execFileSync(process.execPath, [
    join(packageRoot, 'scripts/build-web.mjs'),
    '--outdir',
    releaseScratch,
  ], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [
    join(packageRoot, 'scripts/build-web.mjs'),
    '--debug',
    '--outdir',
    debugScratch,
  ], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [
    join(packageRoot, 'scripts/build-web.mjs'),
    '--debug',
    '--outdir',
    debugRepeatScratch,
  ], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
});
afterAll(() => rmSync(artifactRoot, { recursive: true, force: true }));

describe('committed web bundles', () => {
  it('uses the repository-local cross-platform web build script', () => {
    expect(buildScript).toBe('node scripts/build-web.mjs');
    expect(existsSync(join(packageRoot, 'scripts/build-web.mjs'))).toBe(true);
  });

  it('parses the native workspace shell before packaging it', () => {
    expect(() => execFileSync(process.execPath, ['--check', join(webRoot, 'main.js')]))
      .not.toThrow();
  });

  it('builds every bundle index.html loads', () => {
    // If a bundle stops being produced, the freshness checks below would have
    // nothing to compare and would quietly pass.
    expect(steps.map((step) => step.outfile).sort()).toEqual([
      'web/control.bundle.js',
      'web/diffs.bundle.js',
      'web/editor.bundle.js',
      'web/input.bundle.js',
      'web/panes.bundle.js',
      'web/runtime-debug.bundle.js',
      'web/runtime.bundle.js',
      'web/sessions.bundle.js',
      'web/status.bundle.js',
      'web/workspace.bundle.js',
    ]);
  });

  it('ships every script index.html references', () => {
    const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
    const sources = [...html.matchAll(/src="\.\/([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.indexOf('runtime.bundle.js')).toBeGreaterThan(-1);
    expect(sources.indexOf('runtime.bundle.js')).toBeLessThan(sources.indexOf('main.js'));
    // The blanket `native/` ignore once let a referenced bundle be deleted with
    // nothing in `git status` to show for it, leaving the app unable to boot.
    const missing = sources.filter((source) => !existsSync(join(webRoot, source)));
    expect(missing).toEqual([]);
  });

  it('exposes flattenSidebarSearchResults in the source entry and committed bundle', () => {
    const sessionEntry = readFileSync(join(webRoot, 'sessions', 'session-entry.js'), 'utf8');
    const sessionsBundle = readFileSync(join(webRoot, 'sessions.bundle.js'), 'utf8');

    expect(sessionEntry).toContain('flattenSidebarSearchResults');
    expect(sessionsBundle).toContain('flattenSidebarSearchResults');
  });

  for (const step of steps) {
    it(`${step.outfile} matches its sources`, () => {
      const committed = join(packageRoot, step.outfile);
      expect(existsSync(committed), `${step.outfile} is missing — run pnpm build:web`).toBe(true);
      const rebuilt = join(releaseScratch, step.outfile);

      // Byte comparison, not a hash, so a failure can point at the divergence.
      // Equal-length drift is the common case -- an edited source usually
      // rebuilds to the same size -- so length alone would be a poor message.
      const fresh = readFileSync(rebuilt);
      const onDisk = readFileSync(committed);
      const at = onDisk.length === fresh.length
        ? onDisk.findIndex((byte, index) => byte !== fresh[index])
        : Math.min(onDisk.length, fresh.length);
      expect(
        onDisk.equals(fresh),
        `${step.outfile} is stale: committed ${onDisk.length} bytes, rebuild ` +
          `${fresh.length}, first difference at byte ${at}. ` +
          'Run pnpm build:web and commit the result.',
      ).toBe(true);
    });
  }

  it('builds a reproducible debug stress bundle while release stays stub-only', () => {
    const debugBundle = readFileSync(join(debugScratch, 'web/runtime-debug.bundle.js'));
    const repeatedDebugBundle = readFileSync(join(debugRepeatScratch, 'web/runtime-debug.bundle.js'));
    const releaseBundle = readFileSync(join(releaseScratch, 'web/runtime-debug.bundle.js'));

    expect(debugBundle.equals(repeatedDebugBundle)).toBe(true);
    expect(debugBundle.toString('utf8')).toMatch(/runStressPlan|buildStressPlan|WEBGL_lose_context|stress-harness/);
    expect(releaseBundle.toString('utf8')).not.toMatch(/runStressPlan|buildStressPlan|WEBGL_lose_context|stress-harness/);
  });
});
