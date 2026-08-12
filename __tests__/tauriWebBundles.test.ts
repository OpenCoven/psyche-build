import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The committed web bundles are generated build output, so nothing but a
 * test stops them drifting from the sources they were built from. This rebuilds
 * each one with the *same* flags the build script uses -- parsed out of
 * package.json rather than restated here, so changing the build cannot leave
 * the check validating yesterday's command -- and compares the bytes.
 */
const packageRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri');
const webRoot = join(packageRoot, 'web');
const require = createRequire(import.meta.url);

/**
 * Where the esbuild binary lands depends on how the workspace was installed:
 * a fresh clone gives the member its own node_modules, while an install that
 * can dedupe against an existing one may only hoist it to the workspace root.
 * Assuming a single location made this check fail with "esbuild is not
 * installed" in a perfectly good tree, so try both before giving up.
 */
function resolveEsbuild(): string | null {
  const candidates = [
    join(packageRoot, 'node_modules/.bin/esbuild'),
    join(process.cwd(), 'node_modules/.bin/esbuild'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type EsbuildLauncher = {
  command: string;
  args: string[];
  packageBinPath: string | null;
  shimPath: string | null;
};

function resolveEsbuildLauncher(): EsbuildLauncher | null {
  const shimPath = resolveEsbuild();

  for (const base of [packageRoot, process.cwd()]) {
    try {
      const packageJsonPath = require.resolve('esbuild/package.json', { paths: [base] });
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.esbuild;
      if (!bin) throw new Error(`esbuild package.json at ${packageJsonPath} has no bin entry`);
      const packageBinPath = join(dirname(packageJsonPath), bin);
      return {
        command: process.execPath,
        args: [packageBinPath],
        packageBinPath,
        shimPath,
      };
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException;
      if (candidate.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }

  return null;
}

const buildScript = (
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts['build:web'];

/** One `esbuild <entry> <flags> --outfile=web/x.bundle.js` step of build:web. */
type BundleStep = { argv: string[]; outfile: string };

function parseBuildScript(script: string): BundleStep[] {
  return script.split('&&').map((command) => {
    const argv = command.trim().split(/\s+/);
    expect(argv[0]).toBe('esbuild');
    const outfileArg = argv.find((arg) => arg.startsWith('--outfile='));
    if (!outfileArg) throw new Error(`build:web step has no --outfile: ${command}`);
    return { argv: argv.slice(1), outfile: outfileArg.slice('--outfile='.length) };
  });
}

const steps = parseBuildScript(buildScript);
const scratch = join(process.cwd(), '.test-artifacts', 'tauri-web-bundles');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('committed web bundles', () => {
  it('launches esbuild without depending on the POSIX-only .bin shim contract', () => {
    const launcher = resolveEsbuildLauncher();
    expect(launcher, 'esbuild launcher').not.toBeNull();
    expect(launcher?.command).toBe(process.execPath);
    expect(launcher?.args).toHaveLength(1);
    expect(launcher?.packageBinPath).toBe(launcher?.args[0]);
    expect(launcher?.packageBinPath).toMatch(/node_modules[/\\].*esbuild[/\\]bin[/\\]esbuild$/);

    const shimPath = launcher?.shimPath;
    if (!shimPath) return;

    expect(readFileSync(shimPath, 'utf8')).toContain('#!/bin/sh');
    expect(readFileSync(launcher!.packageBinPath!, 'utf8')).toContain('#!/usr/bin/env node');
    expect(launcher?.packageBinPath).not.toBe(shimPath);
  });

  it('parses the native workspace shell before packaging it', () => {
    expect(() => execFileSync(process.execPath, ['--check', join(webRoot, 'main.js')]))
      .not.toThrow();
  });

  it('builds every bundle index.html loads', () => {
    // If a bundle stops being produced, the freshness checks below would have
    // nothing to compare and would quietly pass.
    expect(steps.map((step) => step.outfile).sort()).toEqual([
      'web/diffs.bundle.js',
      'web/editor.bundle.js',
      'web/input.bundle.js',
      'web/panes.bundle.js',
      'web/sessions.bundle.js',
      'web/status.bundle.js',
    ]);
  });

  it('ships every script index.html references', () => {
    const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
    const sources = [...html.matchAll(/src="\.\/([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    // The blanket `native/` ignore once let a referenced bundle be deleted with
    // nothing in `git status` to show for it, leaving the app unable to boot.
    const missing = sources.filter((source) => !existsSync(join(webRoot, source)));
    expect(missing).toEqual([]);
  });

  for (const step of steps) {
    it(`${step.outfile} matches its sources`, () => {
      const committed = join(packageRoot, step.outfile);
      expect(existsSync(committed), `${step.outfile} is missing — run pnpm build:web`).toBe(true);

      const launcher = resolveEsbuildLauncher();
      if (!launcher) {
        throw new Error(
          'esbuild is not installed for psyche-build-tauri. Run `pnpm install` at the ' +
            'repo root — it is a workspace member, so a root install provides it.',
        );
      }

      const rebuilt = join(scratch, step.outfile.replace(/\//g, '_'));
      const argv = step.argv.map((arg) =>
        arg.startsWith('--outfile=') ? `--outfile=${rebuilt}` : arg,
      );
      execFileSync(launcher.command, [...launcher.args, ...argv], {
        cwd: packageRoot,
        stdio: 'pipe',
      });

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
});
