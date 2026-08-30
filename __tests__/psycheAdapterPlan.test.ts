import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planPath = 'docs/PSYCHE-ADAPTER-PLAN.md';
const plan = readFileSync(resolve(root, planPath), 'utf8');
const map = readFileSync(resolve(root, 'docs/PSYCHE-COMPATIBILITY-MAP.md'), 'utf8');

const CANARY_CATEGORIES = [
  'negotiation',
  'lifecycle',
  'denial',
  'authority-widening',
  'stale-correlation',
  'duplicate-retry',
  'ambiguity-fence',
  'restart',
  'downgrade',
  'unknown-enum',
  'unknown-version',
  'cancellation',
] as const;

function readJson(relativePath: string): Record<string, unknown> {
  const source = readFileSync(resolve(root, relativePath), 'utf8');
  return JSON.parse(source) as Record<string, unknown>;
}

const SHAPE_SCHEMA_FILES = [
  'docs/psyche/pin.schema.json',
  'docs/psyche/canary-vector.schema.json',
  'docs/psyche/canary-evidence.schema.json',
  'docs/psyche/correlation-envelope.schema.json',
];

const EXAMPLE_FILES = [
  'docs/psyche/examples/psyche-profile-pin.example.json',
  'docs/psyche/examples/canary-vector-negotiation-positive.example.json',
  'docs/psyche/examples/canary-vector-authority-widening-negative.example.json',
  'docs/psyche/examples/canary-vector-stale-correlation-negative.example.json',
  'docs/psyche/examples/canary-evidence-pass.example.json',
  'docs/psyche/examples/correlation-envelope-bound.example.json',
];

describe('Psyche adapter plan document', () => {
  it('stays explicitly pre-conformance and release-gated', () => {
    expect(plan).toMatch(/not.*protocol-conformance claim/i);
    expect(plan).toContain('OpenCoven/psyche#11');
    expect(plan).toContain('OpenCoven/psyche#12');
    expect(plan).toMatch(/No floating|never a branch, never `main`/i);
    expect(plan).toMatch(/Not implemented in this change/i);
    expect(plan).toMatch(/No runtime code/i);
  });

  it('cross-references the slice-1 compatibility map in both directions', () => {
    expect(plan).toContain('PSYCHE-COMPATIBILITY-MAP.md');
    expect(map).toContain('PSYCHE-ADAPTER-PLAN.md');
  });

  it('defines all twelve canary vector categories required by issue 253', () => {
    for (const category of CANARY_CATEGORIES) {
      expect(plan, `missing category ${category}`).toContain(`\`${category}\``);
    }
  });

  it('keeps every migration seam and adapter mode from the map', () => {
    for (const seam of ['Seam A', 'Seam B', 'Seam C', 'Seam D']) {
      expect(plan).toContain(seam);
    }
    for (const mode of ['disabled', 'shadow', 'enforcing', 'retired']) {
      expect(plan).toContain(`\`${mode}\``);
    }
  });

  it('preserves identity, rollback, and fail-closed invariants', () => {
    expect(plan).toMatch(/never derive from pane ids, paths, branch names, provider ids, Beads, or GitHub issues/i);
    expect(plan).toMatch(/rollback/i);
    expect(plan).toMatch(/quarantin/i);
    expect(plan).toMatch(/fail closed/i);
    expect(plan).toMatch(/no success receipt before the effect is terminal/i);
    expect(plan).toMatch(/does not retroactively declare `v0\.0\.1` unsupported|never rewrites the support story/i);
  });

  it('cites the current control-plane sources the design leans on', () => {
    for (const cited of [
      'src/control/runtime.ts',
      'src/control/leases.ts',
      'src/control/capabilityLeases.ts',
      'src/control/approvals.ts',
      'src/control/journal.ts',
      'src/control/ownerLock.ts',
      'src/control/taskIdentity.ts',
      'docs/CONTROL-PLANE.md',
    ]) {
      expect(plan, `missing citation ${cited}`).toContain(cited);
    }
  });

  it('records maintainer decisions with alternatives', () => {
    for (const decision of ['D1', 'D2', 'D3', 'D4', 'D5']) {
      expect(plan).toContain(decision);
    }
    expect(plan).toMatch(/Alternatives considered/);
    expect(plan).toMatch(/Recommendation/);
  });
});

describe('Psyche adapter shape schemas', () => {
  it.each(SHAPE_SCHEMA_FILES)('%s is a bounded draft 2020-12 schema with closed objects', (file) => {
    const schema = readJson(file);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
    expect(Array.isArray(schema.required)).toBe(true);
    const source = readFileSync(resolve(root, file), 'utf8');
    expect(source).toContain('"additionalProperties": false');
  });

  it('pins the schema contract to the plan', () => {
    for (const file of SHAPE_SCHEMA_FILES) {
      expect(plan).toContain(file.replace('docs/', ''));
    }
  });

  it('keeps the canary category enum equal to the issue-required twelve', () => {
    const schema = readJson('docs/psyche/canary-vector.schema.json');
    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.category.enum).toEqual(CANARY_CATEGORIES);
  });

  it('fails the evidence schema closed on unverified artifacts', () => {
    const schema = readJson('docs/psyche/canary-evidence.schema.json');
    const properties = schema.properties as Record<
      string,
      { const?: boolean }
    >;
    expect(properties.artifactDigestVerified.const).toBe(true);
  });
});

describe('Psyche adapter golden examples', () => {
  it.each(EXAMPLE_FILES)('%s parses with schemaVersion 1', (file) => {
    const example = readJson(file);
    expect(example.schemaVersion).toBe(1);
  });

  it('demonstrates an active pin with sha256 digest corroboration', () => {
    const pin = readJson('docs/psyche/examples/psyche-profile-pin.example.json');
    expect(pin.status).toBe('active');
    const artifact = pin.artifact as Record<string, string>;
    expect(artifact.digestAlgorithm).toBe('sha256');
    expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.digestSource).toContain('http');
  });

  it('keeps negative example vectors from claiming success', () => {
    for (const file of [
      'docs/psyche/examples/canary-vector-authority-widening-negative.example.json',
      'docs/psyche/examples/canary-vector-stale-correlation-negative.example.json',
    ]) {
      const vector = readJson(file);
      expect(vector.kind).toBe('negative');
      const expectation = vector.expectation as Record<string, unknown>;
      expect(expectation.result).not.toBe('accepted');
      expect(vector.id).toMatch(/^psyche-canary-[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('shows a passing evidence receipt whose summaries are consistent', () => {
    const evidence = readJson('docs/psyche/examples/canary-evidence-pass.example.json');
    expect(evidence.artifactDigestVerified).toBe(true);
    expect(evidence.result).toBe('pass');
    const summary = evidence.summary as Record<string, Record<string, number>>;
    for (const kind of ['positive', 'negative']) {
      expect(summary[kind].passed + summary[kind].failed).toBe(summary[kind].total);
      expect(summary[kind].failed).toBe(0);
    }
  });

  it('shows a bound correlation envelope with protocol ids and reject policy', () => {
    const envelope = readJson('docs/psyche/examples/correlation-envelope-bound.example.json');
    const binding = envelope.binding as Record<string, string>;
    expect(binding.state).toBe('bound');
    expect(binding.conflictPolicy).toBe('reject');
    expect(envelope.protocol).toBeTruthy();
  });
});
