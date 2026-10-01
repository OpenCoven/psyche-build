import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Cancellation has to land *between* probe candidates to be observable, and the
// only seam there is the filesystem call itself. This file mocks
// `node:fs/promises` so the first provider probe aborts the collection; it is
// kept separate so the mock cannot leak into the other collector tests.
const probe = vi.hoisted(() => ({
  marker: '',
  controller: undefined as AbortController | undefined,
  probed: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: async (candidate: string, mode?: number) => {
      if (probe.marker && String(candidate).includes(probe.marker)) {
        probe.probed.push(String(candidate));
        probe.controller?.abort();
      }
      return actual.access(candidate, mode);
    },
  };
});

const { createSupportCollectors, surveyInstalledProviders } = await import('../src/diagnostics/supportBundleCollectors.js');
const { collectSupportBundle } = await import('../src/diagnostics/supportBundle.js');

const directories: string[] = [];

afterEach(() => {
  probe.marker = '';
  probe.controller = undefined;
  probe.probed = [];
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('provider survey cancellation', () => {
  it('fails the bundle closed when cancelled after the first probe candidate', async () => {
    const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-support-bundle-cancel-'));
    directories.push(projectRoot);
    const controller = new AbortController();
    probe.controller = controller;
    probe.marker = path.join(projectRoot, 'probe');

    const bundle = await collectSupportBundle(createSupportCollectors({
      projectRoot,
      releaseVersion: '0.0.2',
      platform: 'darwin',
      architecture: 'arm64',
      providerDefinitions: [
        {
          id: 'claude',
          installTestCommand: 'command -v claude',
          commonPaths: [
            path.join(projectRoot, 'probe', 'one', 'claude'),
            path.join(projectRoot, 'probe', 'two', 'claude'),
          ],
        },
        { id: 'codex', installTestCommand: 'command -v codex', commonPaths: [] },
      ],
      providerSearchPath: [path.join(projectRoot, 'probe', 'bin')],
    }), { signal: controller.signal });

    // The abort fired inside the first candidate's probe; the survey must stop
    // at the next candidate rather than finish and report a count.
    expect(probe.probed).toHaveLength(1);
    expect(bundle.status).toBe('recovery_required');
    // Collector names are outside the closed error vocabulary, so the error is
    // attributed as `unknown`; the code is what carries the meaning.
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_timeout_or_cancelled', recoveryRequired: true }),
    ]));
    expect(bundle.providers).not.toHaveProperty('count');
    expect(bundle.provenance.verification).toBe('unverified');
  });

  // An abort that lands while the final candidate's I/O is in flight has no
  // later candidate to notice it. The survey must still reject, whether that
  // last probe fails or succeeds, rather than return a count it was told to
  // abandon.
  for (const [label, installed] of [['fails', false], ['succeeds', true]] as const) {
    it(`rejects when cancelled during the last candidate's probe that ${label}`, async () => {
      const root = mkdtempSync(path.join(process.cwd(), '.psyche-support-bundle-cancel-'));
      directories.push(root);
      const bin = path.join(root, 'probe', 'bin');
      mkdirSync(bin, { recursive: true });
      if (installed) {
        writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
      }
      const controller = new AbortController();
      probe.controller = controller;
      probe.marker = path.join(bin, 'claude');

      await expect(surveyInstalledProviders(
        [{ id: 'claude', installTestCommand: 'command -v claude', commonPaths: [] }],
        { pathEntries: [bin], signal: controller.signal },
      )).rejects.toThrow();
      expect(probe.probed).toHaveLength(1);
    });
  }
});
