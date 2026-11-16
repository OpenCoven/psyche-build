import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pnpm(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('pnpm', args, { cwd, encoding: 'utf8', timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    const code = `${output.stdout ?? ''}\n${output.stderr ?? ''}`.match(/ERR_PNPM_[A-Z_]+/)?.[0];
    throw new Error(`pnpm ${args.join(' ')} failed: ${code ?? output.message.split('\n')[0]}`);
  }
}

function projects(cwd: string): Array<{ name: string; path: string }> {
  return JSON.parse(pnpm(cwd, 'list', '--recursive', '--depth', '-1', '--json'));
}

describe('standalone docs dependency resolution', () => {
  it('keeps docs out of the root workspace graph', () => {
    expect(projects(process.cwd()).map((project) => project.name)).not.toContain('psyche-build-docs');
  });

  it('resolves docs commands against only the docs application', () => {
    expect(projects(path.resolve('docs')).map((project) => project.name)).toEqual(['psyche-build-docs']);
  });

  it('accepts a docs-only manifest and lockfile update without touching root resolution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-docs-resolution-'));
    roots.push(root);
    const rootManifest = JSON.parse(await readFile('package.json', 'utf8'));
    const pin = rootManifest.packageManager;
    // Use the real workspace configuration with a registry-free dependency graph.
    // Actual repository dependencies are qualified separately by clean bootstrap/build.
    const members = projects(process.cwd());
    for (const member of [...members, { name: 'psyche-build-docs', path: path.resolve('docs') }]) {
      const relative = path.relative(process.cwd(), member.path);
      await mkdir(path.join(root, relative), { recursive: true });
      await writeFile(path.join(root, relative, 'package.json'), JSON.stringify({
        name: member.name, version: '1.0.0', packageManager: pin, engines: rootManifest.engines,
      }));
    }
    await cp('pnpm-workspace.yaml', path.join(root, 'pnpm-workspace.yaml'));
    try { await cp('docs/pnpm-workspace.yaml', path.join(root, 'docs/pnpm-workspace.yaml')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const version of ['1', '2']) {
      await mkdir(path.join(root, `docs/update-fixture-${version}`));
      await writeFile(path.join(root, `docs/update-fixture-${version}/package.json`),
        JSON.stringify({ name: 'docs-update-fixture', version: `${version}.0.0` }));
    }
    const manifestPath = path.join(root, 'docs/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.devDependencies = { 'docs-update-fixture': 'file:./update-fixture-1' };
    manifest.scripts = { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'scripts-ran\', \'unexpected\')"' };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    pnpm(root, 'install', '--lockfile-only', '--offline', '--ignore-scripts', '--no-frozen-lockfile');
    pnpm(path.join(root, 'docs'), 'install', '--ignore-workspace', '--lockfile-only', '--offline',
      '--ignore-scripts', '--no-frozen-lockfile');
    const rootLock = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
    manifest.devDependencies['docs-update-fixture'] = 'file:./update-fixture-2';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // This is the docs updater's scope: only its manifest and lockfile may move.
    pnpm(path.join(root, 'docs'), 'install', '--ignore-workspace', '--lockfile-only', '--offline',
      '--ignore-scripts', '--no-frozen-lockfile');
    expect(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(rootLock);
    pnpm(root, 'install', '--frozen-lockfile', '--lockfile-only', '--offline', '--ignore-scripts');
    pnpm(path.join(root, 'docs'), 'install', '--frozen-lockfile', '--lockfile-only', '--offline', '--ignore-scripts');
    expect(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(rootLock);
    expect(await readFile(path.join(root, 'docs/pnpm-lock.yaml'), 'utf8')).toContain('specifier: file:./update-fixture-2');
    await mkdir(path.join(root, 'scripts'));
    await cp('scripts/agent-bootstrap', path.join(root, 'scripts/agent-bootstrap'));
    await cp('.gitignore', path.join(root, '.gitignore'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    // This fixture tests dependency installation, independently of system tmux provisioning.
    const tools = path.join(root, 'fixture-tools');
    await mkdir(tools);
    await writeFile(path.join(tools, 'tmux'), '#!/bin/sh\n[ "$1" = "-V" ] || exit 64\nprintf "tmux 3.0.0\\n"\n');
    await chmod(path.join(tools, 'tmux'), 0o755);
    execFileSync('bash', ['scripts/agent-bootstrap'], { cwd: root, timeout: 15_000,
      env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(await readFile(path.join(root, 'docs/node_modules/docs-update-fixture/package.json'), 'utf8'))
      .version).toBe('2.0.0');
    await expect(readFile(path.join(root, 'docs/scripts-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});
