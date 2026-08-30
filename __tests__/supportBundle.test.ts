import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  SUPPORT_BUNDLE_LIMITS,
  SUPPORT_BUNDLE_SCHEMA,
  SUPPORT_ACTION_STATES,
  buildSupportBundle,
  collectSupportBundle,
  createSafeSupportBundleFixture,
  isSupportBundleV1,
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
        'password: terminal-secret',
        '{"apiKey":"json-secret"}',
        '/tmp/workspace/private.txt',
        '\\\\server\\share\\private.txt',
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
    expect(serialized).not.toContain('terminal-secret');
    expect(serialized).not.toContain('json-secret');
    expect(serialized).not.toContain('/tmp/workspace/private.txt');
    expect(serialized).not.toContain('server\\share');
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
      schema: 'psyche.control.receipt/v1' as const,
      actionId: `action-${index}`,
      state: state === 'pending' ? 'queued' as const
        : state === 'executing' ? 'running' as const
          : state === 'invalidated' ? 'expired' as const
            : state === 'recovery_required' ? 'unknown' as const
              : state === 'failed' ? 'failed' as const
                : state === 'unknown' ? 'unknown' as const
                  : state === 'requested' ? 'queued' as const
                    : state === 'accepted' ? 'running' as const
                      : 'succeeded' as const,
      resource: { kind: 'project' as const, id: `project-${index}` },
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      message: 'private outcome detail',
      value: { secret: 'private' },
    }));
    const bundle = buildSupportBundle({ receipts });

    expect(bundle.receipts.map((receipt) => receipt.sourceState)).toEqual([
      'queued', 'queued', 'running', 'running', 'succeeded', 'failed', 'unknown', 'expired', 'unknown',
    ]);
    expect(bundle.receipts.map((receipt) => receipt.state)).toEqual([
      'pending', 'pending', 'executing', 'executing', 'succeeded', 'failed', 'unknown', 'invalidated', 'unknown',
    ]);
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
    }, { maxRecordBytes: 20 });
    const serialized = serializeSupportBundle(bundle);

    expect(bundle.records.length).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxRecords);
    expect(bundle.truncation.totalPayloadBounded).toBe(true);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
    expect(bundle.redaction.categories).toHaveProperty('record-size');
    expect(bundle.truncation.fieldsTruncated).toBeGreaterThan(0);
    const serializedBundle = JSON.parse(serialized) as typeof bundle;
    expect(serializedBundle.truncation.recordsOmitted).toBeGreaterThan(0);
    expect(serializedBundle.truncation.terminalLinesOmitted).toBeGreaterThan(0);
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

  it('fails closed when a collector returns an invalid shape', async () => {
    const bundle = await collectSupportBundle([
      {
        name: 'malformed',
        collect: async () => ({ unexpected: 'not-a-contract' } as never),
      },
    ]);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'malformed', code: 'collection_invalid_output', recoveryRequired: true }),
    ]));
  });

  it('merges authoritative receipts from every collector deterministically', async () => {
    const receipt = (actionId: string) => ({
      schema: 'psyche.control.receipt/v1' as const,
      actionId,
      state: 'queued' as const,
      resource: { kind: 'project' as const, id: `project-${actionId}` },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const bundle = await collectSupportBundle([
      { name: 'zeta', collect: async () => ({ receipts: [receipt('zeta')] }) },
      { name: 'alpha', collect: async () => ({ receipts: [receipt('alpha')] }) },
    ]);

    expect(bundle.receipts.map((item) => item.actionId)).toEqual(['alpha', 'zeta']);
  });

  it('produces a safe fixture with no content-heavy fields', () => {
    const fixture = createSafeSupportBundleFixture();
    expect(fixture.schema).toBe(SUPPORT_BUNDLE_SCHEMA);
    expect(fixture.status).toBe('complete');
    expect(serializeSupportBundle(fixture)).not.toMatch(/prompt|password|token|transcript|repositoryContents/i);
  });

  it('re-sanitizes a mutated bundle at the serialization boundary and rejects unknown versions', () => {
    const bundle = createSafeSupportBundleFixture() as SupportBundle & { lifecycle: Record<string, unknown> };
    bundle.lifecycle = { safe: 'ready', BYPASS_SECRET: 'must not serialize' };
    const serialized = serializeSupportBundle(bundle);
    expect(serialized).not.toContain('must not serialize');
    expect(() => serializeSupportBundle({ ...bundle, version: 2 } as unknown as SupportBundle)).toThrow(/schema|compatibility/i);
    expect(isSupportBundleV1({
      schema: SUPPORT_BUNDLE_SCHEMA,
      version: 1,
      compatibility: bundle.compatibility,
    })).toBe(false);
    expect(() => serializeSupportBundle({ ...bundle, generatedAt: 'not-a-timestamp' } as unknown as SupportBundle))
      .toThrow(/schema|compatibility/i);
  });

  it('fails closed for invalid or recovery-sensitive collection status', () => {
    expect(buildSupportBundle({ status: 'not-a-status' }).status).toBe('unknown');
    expect(buildSupportBundle({ errors: [{ collector: 'disk', code: 'write_failed', at: 'now', recoveryRequired: true }] }).status)
      .toBe('recovery_required');
  });

  it('selects bounded map keys deterministically and omits unsafe names', () => {
    const left: Record<string, unknown> = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key-${index}`, index]));
    const right = Object.fromEntries(Object.entries(left).reverse());
    left['/home/alice/private'] = 'secret-path';
    right['/home/alice/private'] = 'secret-path';
    const first = buildSupportBundle({ generatedAt: '2026-01-01T00:00:00.000Z', lifecycle: left });
    const second = buildSupportBundle({ generatedAt: '2026-01-01T00:00:00.000Z', lifecycle: right });
    expect(serializeSupportBundle(first)).toBe(serializeSupportBundle(second));
    expect(serializeSupportBundle(first)).not.toContain('private-path');
    expect(first.redaction.categories).toHaveProperty('attribute-keys');
    expect(first.redaction.categories).toHaveProperty('unsafe-field-name');
  });

  it('keeps the newest terminal lines and strips OSC/DCS control sequences', () => {
    const lines = Array.from({ length: 64 }, (_, index) => `line-${index}-${'x'.repeat(480)}`);
    lines[63] = '\u001b]0;OSC_SECRET\u0007newest';
    const bundle = buildSupportBundle({ terminalTail: lines });
    const serialized = serializeSupportBundle(bundle);
    expect(serialized).not.toContain('OSC_SECRET');
    expect(bundle.terminalTail.at(-1)).toBe('newest');
    expect(bundle.truncation.terminalLinesOmitted).toBeGreaterThan(0);
  });

  it('keeps the checked-in safe fixture equal to the canonical fixture generator', async () => {
    const fixture = JSON.parse(await readFile(new URL('../protocol-fixtures/support-bundle/v1/safe-bundle.json', import.meta.url), 'utf8')) as SupportBundle;
    expect(serializeSupportBundle(fixture)).toBe(serializeSupportBundle(createSafeSupportBundleFixture()));
  });
});
