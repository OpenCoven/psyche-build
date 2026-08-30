import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  SUPPORT_BUNDLE_LIMITS,
  SUPPORT_BUNDLE_SCHEMA,
  SUPPORT_ACTION_STATES,
  buildSupportBundle,
  collectSupportBundle,
  createSafeSupportBundleFixture,
  serializeSupportBundle,
  supportBundleDigest,
  type SupportBundle,
} from '../src/diagnostics/supportBundle.js';

describe('support bundle v1', () => {
  it('builds a deterministic versioned bundle and digest', () => {
    const first = buildSupportBundle({
      generatedAt: '2026-01-01T00:00:00.000Z',
      provenance: {
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        architecture: 'arm64',
        platform: 'darwin',
        releaseVersion: '0.0.2',
        application: 'psyche-build',
      },
      records: [
        { sequence: 2, at: '2026-01-01T00:00:02.000Z', component: 'b', event: 'later' },
        { sequence: 1, at: '2026-01-01T00:00:01.000Z', component: 'a', event: 'first' },
      ],
    });
    const second = buildSupportBundle({
      provenance: {
        application: 'psyche-build',
        releaseVersion: '0.0.2',
        platform: 'darwin',
        architecture: 'arm64',
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
      records: [
        { event: 'first', component: 'a', at: '2026-01-01T00:00:01.000Z', sequence: 1 },
        { event: 'later', component: 'b', at: '2026-01-01T00:00:02.000Z', sequence: 2 },
      ],
    });

    expect(first.schema).toBe(SUPPORT_BUNDLE_SCHEMA);
    expect(first.version).toBe(1);
    expect(serializeSupportBundle(first)).toBe(serializeSupportBundle(second));
    expect(supportBundleDigest(first)).toBe(supportBundleDigest(second));
    expect(first.records.map((record) => record.sequence)).toEqual([1, 2]);
  });

  it('redacts secrets, unsafe content, infrastructure URLs, and absolute paths', () => {
    const bundle = buildSupportBundle({
      provenance: {
        application: 'psyche-build',
        releaseVersion: '0.0.2',
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        platform: 'linux',
        architecture: 'x86_64',
      },
      project: {
        id: '/home/alice/private-project',
        name: 'private-project',
        path: '/home/alice/private-project',
      },
      lifecycle: {
        accessToken: 'ghp_01234567890123456789',
        prompt: 'do not include this prompt',
        upstreamUrl: 'https://internal.example.test/repo.git?token=secret',
        cwd: '/home/alice/private-project',
        safeState: 'ready',
      },
      terminalTail: [
        '\u001b[31mBearer very-secret-value\u001b[0m',
        'API_KEY=another-secret',
      ],
      records: [{
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        component: 'collector',
        event: 'captured',
        attributes: {
          password: 'do-not-persist',
          repositoryContents: 'source should never be here',
          relativePath: 'src/index.ts',
          safe: true,
        },
      }],
    });
    const serialized = serializeSupportBundle(bundle);

    expect(serialized).not.toContain('very-secret-value');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain('do not include this prompt');
    expect(serialized).not.toContain('source should never be here');
    expect(serialized).not.toContain('internal.example.test');
    expect(serialized).not.toContain('/home/alice/private-project');
    expect(bundle.lifecycle).toMatchObject({ safeState: 'ready' });
    expect(bundle.records[0]?.attributes).toMatchObject({ relativePath: 'src/index.ts', safe: true });
    expect(bundle.redaction.redactedFields).toBeGreaterThan(0);
    expect(bundle.redaction.omittedFields).toBeGreaterThan(0);
    expect(bundle.redaction.categories).toHaveProperty('secret-field');
  });

  it('preserves the complete action-state vocabulary without exposing receipt payloads', () => {
    const receipts = SUPPORT_ACTION_STATES.map((state, index) => ({
      actionId: `action-${index}`,
      state,
      resource: { kind: 'project', idDigest: '0123456789abcdef0123456789abcdef' },
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      message: 'private outcome detail',
      value: { secret: 'private' },
    }));
    const bundle = buildSupportBundle({ receipts });

    expect(bundle.receipts.map((receipt) => receipt.state).sort()).toEqual([...SUPPORT_ACTION_STATES].sort());
    expect(serializeSupportBundle(bundle)).not.toContain('private outcome detail');
    expect(serializeSupportBundle(bundle)).not.toContain('private');
  });

  it('bounds record count, record size, terminal data, and final payload', () => {
    const records = Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords + 20 }, (_, sequence) => ({
      sequence,
      at: '2026-01-01T00:00:00.000Z',
      component: 'test',
      event: 'event',
      attributes: { detail: 'x'.repeat(10_000) },
    }));
    const bundle = buildSupportBundle({
      records,
      terminalTail: Array.from({ length: 100 }, () => 'y'.repeat(2_000)),
    }, { maxRecordBytes: 100 });
    const serialized = serializeSupportBundle(bundle);

    expect(bundle.records.length).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxRecords);
    expect(bundle.truncation.totalPayloadBounded).toBe(true);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
    expect(bundle.redaction.categories).toHaveProperty('record-size');
    expect(bundle.truncation.fieldsTruncated).toBeGreaterThan(0);
  });

  it('returns recovery_required when a bounded collector times out', async () => {
    const bundle = await collectSupportBundle([
      {
        name: 'slow-recovery',
        collect: async () => new Promise(() => undefined),
      },
    ], { maxElapsedMs: 10 });

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'slow-recovery', code: 'collection_timeout_or_cancelled', recoveryRequired: true }),
    ]));
  });

  it('produces a safe fixture with no content-heavy fields', () => {
    const fixture = createSafeSupportBundleFixture();
    expect(fixture.schema).toBe(SUPPORT_BUNDLE_SCHEMA);
    expect(fixture.status).toBe('complete');
    expect(serializeSupportBundle(fixture)).not.toMatch(/prompt|password|token|transcript|repositoryContents/i);
  });

  it('keeps the checked-in safe fixture equal to the canonical fixture generator', async () => {
    const fixture = JSON.parse(await readFile(new URL('../protocol-fixtures/support-bundle/v1/safe-bundle.json', import.meta.url), 'utf8')) as SupportBundle;
    expect(serializeSupportBundle(fixture)).toBe(serializeSupportBundle(createSafeSupportBundleFixture()));
  });
});
