import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  parseSupportBundleArgs,
  runSupportBundle,
} from '../src/diagnostics/supportBundleCli.js';
import {
  createSupportCollectors,
  projectIdentityDigest,
  supportBundleArchitecture,
  supportBundlePlatform,
} from '../src/diagnostics/supportBundleCollectors.js';
import {
  MAX_RETAINED_BUNDLES,
  supportBundleDirectory,
  writeSupportBundleFile,
} from '../src/diagnostics/supportBundleStore.js';
import {
  collectSupportBundle,
  isSupportBundleV1,
  parseSupportBundle,
} from '../src/diagnostics/supportBundle.js';
import { worktreeRecoveryMarkerDirectory } from '../src/services/WorktreeRecoveryMarker.js';

const directories: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(path.join(process.cwd(), '.psyche-support-bundle-'));
  directories.push(root);
  return root;
}

function defaults(cwd: string) {
  return {
    cwd,
    releaseVersion: '0.0.2',
    platform: 'darwin',
    architecture: 'arm64',
  };
}

async function collect(projectRoot: string) {
  return collectSupportBundle(createSupportCollectors({
    projectRoot,
    releaseVersion: '0.0.2',
    platform: 'darwin',
    architecture: 'arm64',
  }));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('support bundle collectors', () => {
  it('produces a valid v1 bundle with no collector errors or omitted fields', async () => {
    const projectRoot = createProjectRoot();
    mkdirSync(path.join(projectRoot, '.psyche'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.psyche', 'psyche.config.json'), '{"panes":[]}', 'utf8');

    const bundle = await collect(projectRoot);

    expect(isSupportBundleV1(bundle)).toBe(true);
    expect(bundle.errors).toEqual([]);
    // A dropped collector field is silently invisible in the output, so the
    // vocabulary being wrong must fail here rather than ship an empty bundle.
    expect(bundle.redaction.omittedFields).toBe(0);
    expect(bundle.persistence).toEqual({
      projectConfig: 'available',
      quarantinedRecoveryFiles: 0,
      recoveryMarkers: 0,
      recoveryRequired: false,
    });
    expect(bundle.status).not.toBe('recovery_required');
  });

  it('reports outstanding recovery state and raises the bundle status', async () => {
    const projectRoot = createProjectRoot();
    const directory = worktreeRecoveryMarkerDirectory(projectRoot);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${'f'.repeat(64)}.json`), '{"version": 99}', 'utf8');

    const bundle = await collect(projectRoot);

    expect(bundle.errors).toEqual([]);
    expect(bundle.persistence).toMatchObject({
      quarantinedRecoveryFiles: 1,
      recoveryRequired: true,
    });
    expect(bundle.status).toBe('recovery_required');
  });

  it('reports a missing project config without failing collection', async () => {
    const bundle = await collect(createProjectRoot());

    expect(bundle.errors).toEqual([]);
    expect(bundle.persistence).toMatchObject({ projectConfig: 'missing' });
  });

  it('carries a project digest instead of the project path', async () => {
    const projectRoot = createProjectRoot();

    const bundle = await collect(projectRoot);

    expect(bundle.project?.idDigest).toBe(projectIdentityDigest(projectRoot));
    expect(JSON.stringify(bundle)).not.toContain(projectRoot);
    expect(JSON.stringify(bundle)).not.toContain(path.basename(projectRoot));
  });

  it('keeps the project path out of what collectors hand to normalization', async () => {
    const projectRoot = createProjectRoot();
    const collectors = createSupportCollectors({
      projectRoot,
      releaseVersion: '0.0.2',
      platform: 'darwin',
      architecture: 'arm64',
    });

    const contributions = await Promise.all(
      collectors.map((collector) => collector.collect(new AbortController().signal)),
    );

    // Normalization would digest a supplied path anyway, so the final bundle
    // looks identical either way. The path must not reach it regardless: the
    // sanitizer is the last line of defence, not the first.
    for (const contribution of contributions) {
      expect(JSON.stringify(contribution)).not.toContain(projectRoot);
    }
  });

  it('maps host platform and architecture into the bundle vocabulary', () => {
    expect(supportBundlePlatform('win32')).toBe('windows');
    expect(supportBundlePlatform('darwin')).toBe('darwin');
    expect(supportBundlePlatform('sunos')).toBe('unknown');
    expect(supportBundleArchitecture('ia32')).toBe('x86');
    expect(supportBundleArchitecture('arm64')).toBe('arm64');
    expect(supportBundleArchitecture('mips')).toBe('unknown');
  });

  it('never claims control-plane verification from the CLI', async () => {
    const bundle = await collect(createProjectRoot());

    expect(bundle.provenance.verification).toBe('unverified');
  });
});

describe('support bundle argument parsing', () => {
  it('defaults to the working directory and the project runtime location', () => {
    const parsed = parseSupportBundleArgs([], defaults('/work/project'));

    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({
      projectRoot: path.resolve('/work/project'),
      toStdout: false,
      outPath: undefined,
      platform: 'darwin',
      architecture: 'arm64',
    });
  });

  it('rejects a flag without its path instead of consuming the next flag', () => {
    expect(parseSupportBundleArgs(['--project', '--stdout'], defaults('/work')).error)
      .toBe('psyche support-bundle --project requires a path');
    expect(parseSupportBundleArgs(['--out'], defaults('/work')).error)
      .toBe('psyche support-bundle --out requires a path');
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(parseSupportBundleArgs(['--everything'], defaults('/work')).error)
      .toBe('Unsupported psyche support-bundle option: --everything');
  });

  it('rejects writing to a file and stdout at once', () => {
    expect(parseSupportBundleArgs(['--stdout', '--out', 'b.json'], defaults('/work')).error)
      .toBe('psyche support-bundle cannot combine --stdout with --out');
  });
});

describe('support bundle command', () => {
  it('writes a parseable bundle into the project and reports where', async () => {
    const projectRoot = createProjectRoot();
    const parsed = parseSupportBundleArgs(['--project', projectRoot], defaults(process.cwd()));

    const result = await runSupportBundle(parsed.options!);

    expect(result.exitCode).toBe(0);
    expect(result.written?.path.startsWith(supportBundleDirectory(projectRoot))).toBe(true);
    const written = readFileSync(result.written!.path, 'utf8');
    expect(isSupportBundleV1(parseSupportBundle(written))).toBe(true);
    expect(result.text).toContain(result.written!.path);
    expect(result.text).toContain('psyche.diagnostics/v1 v1');
    expect(result.text).toContain('Review it before attaching it to a report.');
  });

  it('writes the bundle owner-readable only', async () => {
    const projectRoot = createProjectRoot();
    const parsed = parseSupportBundleArgs(['--project', projectRoot], defaults(process.cwd()));

    const result = await runSupportBundle(parsed.options!);

    expect(statSync(result.written!.path).mode & 0o777).toBe(0o600);
  });

  it('prints the bundle and writes nothing with --stdout', async () => {
    const projectRoot = createProjectRoot();
    const parsed = parseSupportBundleArgs(['--project', projectRoot, '--stdout'], defaults(process.cwd()));

    const result = await runSupportBundle(parsed.options!);

    expect(result.exitCode).toBe(0);
    expect(result.written).toBeUndefined();
    expect(isSupportBundleV1(parseSupportBundle(result.text))).toBe(true);
    expect(() => statSync(supportBundleDirectory(projectRoot))).toThrow();
  });

  it('reports a write failure without losing the collected bundle', async () => {
    const projectRoot = createProjectRoot();
    // A file where the bundle directory must be: mkdir fails, collection did not.
    mkdirSync(path.join(projectRoot, '.psyche', 'runtime'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.psyche', 'runtime', 'support-bundles'), 'not a directory', 'utf8');
    const parsed = parseSupportBundleArgs(['--project', projectRoot], defaults(process.cwd()));

    const result = await runSupportBundle(parsed.options!);

    expect(result.exitCode).toBe(1);
    expect(result.bundle).toBeDefined();
    expect(result.text).toContain('rerun with --stdout');
  });
});

describe('support bundle retention', () => {
  function seed(directory: string, name: string): string {
    mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, name);
    writeFileSync(filePath, '{}', 'utf8');
    return filePath;
  }

  it('prunes the oldest bundles beyond the retention limit', async () => {
    const projectRoot = createProjectRoot();
    const directory = supportBundleDirectory(projectRoot);
    for (let index = 0; index < MAX_RETAINED_BUNDLES + 3; index += 1) {
      seed(directory, `psyche-support-2026090${index % 10}T000000Z-${'a'.repeat(12)}.json`);
    }

    const written = await writeSupportBundleFile({
      directory,
      filename: `psyche-support-20260916T000000Z-${'b'.repeat(12)}.json`,
      serialized: '{"kept":true}',
    });

    expect(written.removed.length).toBeGreaterThan(0);
    expect(readFileSync(written.path, 'utf8')).toBe('{"kept":true}');
    expect(written.removed).not.toContain(path.basename(written.path));
  });

  it('never prunes a file it did not write', async () => {
    const projectRoot = createProjectRoot();
    const directory = supportBundleDirectory(projectRoot);
    const operatorNotes = seed(directory, 'operator-notes.md');
    const namedLikeABundle = seed(directory, 'psyche-support-backup.json');
    for (let index = 0; index < MAX_RETAINED_BUNDLES + 5; index += 1) {
      seed(directory, `psyche-support-2026090${index % 10}T00000${index % 10}Z-${'c'.repeat(12)}.json`);
    }

    const written = await writeSupportBundleFile({
      directory,
      filename: `psyche-support-20260916T010000Z-${'d'.repeat(12)}.json`,
      serialized: '{}',
    });

    expect(written.removed.length).toBeGreaterThan(0);
    expect(readFileSync(operatorNotes, 'utf8')).toBe('{}');
    expect(readFileSync(namedLikeABundle, 'utf8')).toBe('{}');
  });

  it('keeps the bundle it just wrote even when retention is exhausted', async () => {
    const projectRoot = createProjectRoot();
    const directory = supportBundleDirectory(projectRoot);

    const written = await writeSupportBundleFile({
      directory,
      filename: `psyche-support-20260916T020000Z-${'e'.repeat(12)}.json`,
      serialized: '{"survivor":true}',
      maxRetained: 0,
    });

    expect(readFileSync(written.path, 'utf8')).toBe('{"survivor":true}');
  });
});
