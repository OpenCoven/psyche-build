import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSupportBundle, supportBundleDigest } from '../src/diagnostics/supportBundle.js';
import { formatSupportBundleSummary } from '../src/diagnostics/supportBundleCli.js';
import {
  createSupportCollectors,
  SUPPORT_SECTIONS_NOT_COLLECTED,
} from '../src/diagnostics/supportBundleCollectors.js';

// #476: every category of a v1 bundle is either collected or omitted for a
// stated reason. These cases hold the stated list equal to what the shipped
// collectors really leave empty, so adding a collector, or adding a section
// to the bundle, fails here until the list and the document are updated.

/** Top-level bundle fields that describe the bundle itself, not the installation. */
const METADATA = new Set([
  'schema',
  'version',
  'compatibility',
  'generatedAt',
  'status',
  'errors',
  'redaction',
  'truncation',
  'accountingProof',
]);

/** Top-level bundle fields that carry facts a collector can supply. */
const FACT_SECTIONS = [
  'provenance',
  'project',
  'ownerEpoch',
  'lifecycle',
  'providers',
  'persistence',
  'updater',
  'graphics',
  'terminalTail',
  'records',
  'receipts',
];

const roots: string[] = [];

async function collectors() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'psyche-bundle-coverage-'));
  roots.push(projectRoot);
  return createSupportCollectors({
    projectRoot,
    releaseVersion: '0.0.0',
    platform: 'darwin',
    architecture: 'arm64',
    providerDefinitions: [],
    providerSearchPath: [],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('support bundle coverage', () => {
  it('classifies every top-level field of a collected bundle', async () => {
    const bundle = await collectSupportBundle(await collectors());
    const unclassified = Object.keys(bundle).filter(
      (key) => !METADATA.has(key) && !FACT_SECTIONS.includes(key),
    );
    expect(unclassified).toEqual([]);
  });

  it('lists as not collected exactly the sections no shipped collector fills', async () => {
    const signal = new AbortController().signal;
    const filled = new Set<string>();
    for (const collector of await collectors()) {
      for (const key of Object.keys(await collector.collect(signal))) filled.add(key);
    }

    const listed = SUPPORT_SECTIONS_NOT_COLLECTED.flatMap((entry) => [...entry.sections]);
    expect([...listed].sort()).toEqual(FACT_SECTIONS.filter((section) => !filled.has(section)).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('leaves those sections empty in a real bundle, not fabricated', async () => {
    const bundle = await collectSupportBundle(await collectors());

    expect(bundle.errors).toEqual([]);
    expect(bundle.redaction.omittedFields).toBe(0);
    for (const section of SUPPORT_SECTIONS_NOT_COLLECTED.flatMap((entry) => [...entry.sections])) {
      const value = (bundle as unknown as Record<string, unknown>)[section];
      expect(value === undefined || (Array.isArray(value) && value.length === 0), section).toBe(true);
    }
  });

  it('gives every omission a label and a one-line reason', () => {
    expect(SUPPORT_SECTIONS_NOT_COLLECTED.length).toBeGreaterThan(0);
    for (const entry of SUPPORT_SECTIONS_NOT_COLLECTED) {
      expect(entry.label).toMatch(/^[a-z][a-z ]+$/);
      expect(entry.reason).toMatch(/^[A-Z].*\.$/);
      expect(entry.reason).not.toMatch(/\n/);
      expect(entry.sections.length).toBeGreaterThan(0);
    }
    expect(new Set(SUPPORT_SECTIONS_NOT_COLLECTED.map((entry) => entry.label)).size).toBe(
      SUPPORT_SECTIONS_NOT_COLLECTED.length,
    );
  });

  it('states terminal content as never collected, which the sanitizer enforces', async () => {
    const terminal = SUPPORT_SECTIONS_NOT_COLLECTED.find((entry) => entry.sections.includes('terminalTail'));
    expect(terminal?.reason).toMatch(/never/i);

    // A collector that supplies terminal lines still produces none.
    const bundle = await collectSupportBundle([
      { name: 'terminal', collect: async () => ({ terminalTail: ['first line', 'second line'] }) },
    ]);
    expect(bundle.terminalTail).toEqual([]);
    expect(bundle.redaction.categories['terminal-omitted']).toBe(1);
    expect(bundle.truncation.terminalLinesOmitted).toBe(2);
  });

  it('tells the operator what the bundle does not contain', async () => {
    const bundle = await collectSupportBundle(await collectors());
    const summary = formatSupportBundleSummary(bundle, supportBundleDigest(bundle), {
      path: 'bundle.json',
      bytes: 1,
      removed: [],
      retentionFailures: 0,
    });

    const line = summary.split('\n').find((entry) => entry.startsWith('  not collected: '));
    expect(line).toBe(
      `  not collected: ${SUPPORT_SECTIONS_NOT_COLLECTED.map((entry) => entry.label).join(', ')}`,
    );
  });

  it('documents each omission with the same label and reason', async () => {
    const document = await readFile('docs/SUPPORT-BUNDLE-V1.md', 'utf8');
    const section = document.split('\n### Not collected, and why\n')[1]?.split('\n## ')[0];
    expect(section, 'docs/SUPPORT-BUNDLE-V1.md has no "Not collected, and why" section').toBeDefined();

    const rows = section!
      .split('\n')
      .filter((line) => line.startsWith('| ') && !/^\| (Category|---)/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    expect(rows).toEqual(
      SUPPORT_SECTIONS_NOT_COLLECTED.map((entry) => [
        entry.label[0].toUpperCase() + entry.label.slice(1),
        entry.sections.map((name) => `\`${name}\``).join(', '),
        entry.reason,
      ]),
    );
  });
});
