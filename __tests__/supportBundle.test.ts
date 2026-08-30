import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serialize as serializeProtocolFixture } from '../scripts/generate-protocol-fixtures.js';
import {
  SUPPORT_BUNDLE_LIMITS,
  SUPPORT_BUNDLE_SCHEMA,
  SUPPORT_ACTION_STATES,
  buildSupportBundle,
  collectSupportBundle,
  createSupportBundleCodec,
  createSafeSupportBundleFixture,
  isSupportBundleV1,
  parseSupportBundle,
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
        auth: 'auth-secret',
        passwd: 'passwd-secret',
        prompt: 'do not include this prompt',
        upstreamUrl: 'https://internal.example.test/repo.git?token=secret',
        cwd: '/home/alice/private-project',
        safeState: 'ready',
        diagnosticNote: 'sk_live_01234567890123456789',
      },
      terminalTail: [
        '\u001b[31mBearer very-secret-value\u001b[0m',
        'API_KEY=another-secret',
        'password: terminal-secret',
        '{"apiKey":"json-secret"}',
        '/tmp/workspace/private.txt',
        '\\\\server\\share\\private.txt',
        'Authorization: hidden',
        'Authorization: Token very-secret-value',
        'authorizationHeader=header-secret',
        'passwordHash: hash-secret',
        'password is spaced-secret',
        'cwd /tmp/private.txt',
        'AWS_SECRET_ACCESS_KEY=aws-secret',
        'github_pat_012345678901234567890123456789',
        'password: one two three',
        '/tmp/workspace/private file.txt',
        'C:\\Users\\alice\\private file.txt',
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
    expect(serialized).not.toContain('very-secret-value');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('hash-secret');
    expect(serialized).not.toContain('spaced-secret');
    expect(serialized).not.toContain('aws-secret');
    expect(serialized).not.toContain('auth-secret');
    expect(serialized).not.toContain('passwd-secret');
    expect(serialized).not.toContain('012345678901234567890123456789');
    expect(serialized).not.toContain('one two three');
    expect(serialized).not.toContain('private file.txt');
    expect(serialized).not.toContain('do not include this prompt');
    expect(serialized).not.toContain('source should never be here');
    expect(serialized).not.toContain('internal.example.test');
    expect(serialized).not.toContain('sk_live_01234567890123456789');
    expect(serialized).not.toContain('/home/alice/private-project');
    expect(bundle.lifecycle).toMatchObject({ safeState: 'ready' });
    expect(bundle.records[0]?.attributes).toMatchObject({ relativePath: 'src/index.ts', safe: true });
    expect(bundle.redaction.redactedFields).toBeGreaterThan(0);
    expect(bundle.redaction.omittedFields).toBeGreaterThan(0);
    expect(bundle.redaction.categories).toHaveProperty('secret-field');
    expect((JSON.parse(serialized) as typeof bundle).redaction.categories).toHaveProperty('secret-field');
  });

  it('keeps redaction accounting stable across repeated serialization', () => {
    const bundle = buildSupportBundle({ lifecycle: { password: 'secret' } });
    const first = serializeSupportBundle(bundle);

    expect(serializeSupportBundle(bundle)).toBe(first);
    expect(JSON.parse(first).redaction).toEqual(JSON.parse(serializeSupportBundle(bundle)).redaction);
  });

  it('marks structurally valid raw control values unverified until adapted from the control plane', () => {
    const input = {
      provenance: {
        application: 'psyche-build',
        releaseVersion: '1.0.0',
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        platform: 'linux',
        architecture: 'x86_64',
      },
      receipts: [{
        schema: 'psyche.control.receipt/v1' as const,
        actionId: 'action',
        state: 'succeeded' as const,
        resource: { kind: 'project' as const, id: 'project' },
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const raw = buildSupportBundle(input);
    expect(raw.status).toBe('partial');
    expect(raw.provenance.verification).toBe('unverified');
    expect(raw.receipts[0]?.verification).toBe('unverified');

    expect(createSafeSupportBundleFixture().status).toBe('complete');
  });

  it('does not accept unverified receipts as a complete normalized bundle', () => {
    const fixture = createSafeSupportBundleFixture();
    expect(isSupportBundleV1({
      ...fixture,
      status: 'complete',
      receipts: fixture.receipts.map((receipt) => ({ ...receipt, verification: 'unverified' as const })),
    })).toBe(false);
  });

  it('does not treat forged normalized JSON as authoritative and rejects tampering', () => {
    const codec = createSupportBundleCodec('support-bundle-proof-test-key-v1');
    const fixture = createSafeSupportBundleFixture();
    const forged = { ...fixture } as SupportBundle & { provenance: Record<string, unknown> };
    delete (forged as { accountingProof?: string }).accountingProof;

    const forgedSerialized = serializeSupportBundle(forged, codec);
    const forgedOutput = JSON.parse(forgedSerialized) as SupportBundle;
    expect(forgedOutput.status).toBe('partial');
    expect(forgedOutput.provenance.verification).toBe('unverified');
    expect(forgedOutput.receipts[0]?.verification).toBe('unverified');

    const tampered = JSON.parse(serializeSupportBundle(fixture)) as Record<string, unknown>;
    tampered.lifecycle = { state: 'stale' };
    expect(() => parseSupportBundle(JSON.stringify(tampered), createSupportBundleCodec('psyche-build-support-fixture-v1')))
      .toThrow(/accounting proof/i);
  });

  it('preserves bounded redaction and truncation metadata after a JSON round trip', () => {
    const codec = createSupportBundleCodec('support-bundle-test-key-v1');
    const bundle = buildSupportBundle({
      lifecycle: { password: 'secret' },
      records: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords + 1 }, (_, sequence) => ({
        sequence,
        at: '2026-01-01T00:00:00.000Z',
        component: 'test',
        event: 'sample',
      })),
    }, { codec });
    const serialized = serializeSupportBundle(bundle);
    const roundTripped = parseSupportBundle(serialized, codec);

    expect(serializeSupportBundle(roundTripped)).toBe(serialized);
    expect(roundTripped.redaction).toEqual(bundle.redaction);
    expect(roundTripped.truncation).toEqual(bundle.truncation);
  });

  it('preserves the complete action-state vocabulary without exposing receipt payloads', () => {
    const receipts = SUPPORT_ACTION_STATES.map((state, index) => ({
      schema: 'psyche.control.receipt/v1' as const,
      actionId: `action-${index}`,
      state: state === 'pending' ? 'queued' as const
        : state === 'executing' ? 'running' as const
          : state === 'invalidated' ? 'expired' as const
            : state === 'failed' ? 'failed' as const
              : state === 'unknown' ? 'unknown' as const
                : 'succeeded' as const,
      resource: { kind: 'project' as const, id: `project-${index}` },
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      message: 'private outcome detail',
      value: { secret: 'private' },
    }));
    const bundle = buildSupportBundle({ receipts });

    expect(bundle.receipts.map((receipt) => receipt.sourceState).sort()).toEqual([
      'expired', 'failed', 'queued', 'running', 'succeeded', 'unknown',
    ]);
    expect(bundle.receipts.map((receipt) => receipt.state).sort()).toEqual([
      'executing', 'failed', 'invalidated', 'pending', 'succeeded', 'unknown',
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

  it('keeps fitted byte accounting inside the validator bound', () => {
    const bundle = buildSupportBundle({
      records: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords }, (_, sequence) => ({
        sequence,
        at: '2026-01-01T00:00:00.000Z',
        component: 'test',
        event: 'sample',
        attributes: { values: Array.from({ length: 32 }, () => 'ready') },
      })),
    }, { maxBundleBytes: 1_024 });

    expect(bundle.truncation.bytesOmitted).toBeGreaterThan(0);
    expect(isSupportBundleV1(bundle)).toBe(true);
  });

  it('selects over-cap records deterministically before applying the record cap', () => {
    const records = Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords + 1 }, (_, sequence) => ({
      sequence,
      at: '2026-01-01T00:00:00.000Z',
      component: 'test',
      event: 'event',
    }));
    const options = { now: () => 1_767_225_600_000 };
    const first = buildSupportBundle({ records }, options);
    const second = buildSupportBundle({ records: [...records].reverse() }, options);

    expect(serializeSupportBundle(first)).toBe(serializeSupportBundle(second));
    expect(first.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords }, (_, sequence) => sequence),
    );
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

  it('fails closed when a synchronous collector returns after the deadline', async () => {
    const bundle = await collectSupportBundle([{
      name: 'sync-overrun',
      collect: (() => {
        const deadline = Date.now() + 25;
        while (Date.now() < deadline) {
          // Deliberately model a synchronous native/bridge overrun.
        }
        return { lifecycle: { state: 'ready' } };
      }) as never,
    }], { maxElapsedMs: 5 });

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors.some((error) => error.recoveryRequired === true)).toBe(true);
  });

  it('rejects collectors that do not return a promise', async () => {
    let called = false;
    const bundle = await collectSupportBundle([{
      name: 'synchronous-collector',
      collect: (() => {
        called = true;
        return { lifecycle: { state: 'ready' } };
      }) as never,
    }], { maxElapsedMs: 5 });

    expect(called).toBe(true);
    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_invalid_output', recoveryRequired: true }),
    ]));
  });

  it('accepts a promise returned by a non-async collector function', async () => {
    const bundle = await collectSupportBundle([{
      name: 'promise-collector',
      collect: () => Promise.resolve({ lifecycle: { state: 'ready' } }),
    }]);

    expect(bundle.lifecycle).toEqual({ state: 'ready' });
    expect(bundle.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_invalid_output' }),
    ]));
  });

  it('never returns complete after cancellation or a late normalization deadline', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledBundle = await collectSupportBundle([], { signal: cancelled.signal });
    expect(cancelledBundle.status).toBe('recovery_required');
    expect(cancelledBundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_cancelled', recoveryRequired: true }),
    ]));

    const emptyBundle = await collectSupportBundle([]);
    expect(emptyBundle.status).toBe('recovery_required');
    expect(emptyBundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'no_collectors', recoveryRequired: true }),
    ]));

    const originalDateNow = Date.now;
    let dateNowCalls = 0;
    Date.now = () => {
      dateNowCalls += 1;
      const now = originalDateNow();
      return dateNowCalls >= 6 ? now + 60_000 : now;
    };
    try {
      const lateBundle = await collectSupportBundle([{
        name: 'late-normalization',
        collect: async () => ({ lifecycle: { state: 'ready' } }),
      }], { maxElapsedMs: SUPPORT_BUNDLE_LIMITS.maxElapsedMs, now: () => 1_767_225_600_000 });
      expect(lateBundle.status).toBe('recovery_required');
    } finally {
      Date.now = originalDateNow;
    }
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

  it('fails closed for empty, null, and malformed collector results', async () => {
    for (const result of [
      undefined,
      null,
      {},
      { status: 'complete' },
      { records: [] },
      { lifecycle: new Map([['state', 'ready']]) },
      { lifecycle: 'not-a-map' },
      { records: [{}] },
      Object.defineProperty({}, 'lifecycle', { get: () => { throw new Error('getter boom'); } }),
    ]) {
      const bundle = await collectSupportBundle([{
        name: 'malformed',
        collect: async () => result as never,
      }]);

      expect(bundle.status).toBe('recovery_required');
      expect(bundle.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ collector: 'malformed', code: 'collection_invalid_output', recoveryRequired: true }),
      ]));
    }
  });

  it('degrades conflicting singleton collector sections to recovery_required', async () => {
    const bundle = await collectSupportBundle([
      { name: 'alpha', collect: async () => ({ lifecycle: { state: 'ready' } }) },
      { name: 'beta', collect: async () => ({ lifecycle: { state: 'stale' } }) },
    ]);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'beta', code: 'collection_conflict', recoveryRequired: true }),
    ]));
  });

  it('retains a singleton conflict when earlier collector errors fill the error bound', async () => {
    const bundle = await collectSupportBundle([
      {
        name: 'alpha',
        collect: async () => ({
          errors: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxErrorChain }, (_, index) => ({
            collector: 'alpha',
            code: `warning-${index}`,
            at: '2026-01-01T00:00:00.000Z',
          })),
        }),
      },
      { name: 'beta', collect: async () => ({ lifecycle: { state: 'ready' } }) },
      { name: 'gamma', collect: async () => ({ lifecycle: { state: 'stale' } }) },
    ]);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_conflict', recoveryRequired: true }),
    ]));
  });

  it('requires unique authoritative receipt ownership across collectors', async () => {
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

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.receipts[0]?.actionId).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.receipts[0]?.actionId).not.toBe('alpha');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'zeta', code: 'collection_conflict', recoveryRequired: true }),
    ]));
  });

  it('bounds scalar array members during collector preflight', async () => {
    const result = {
      records: Array.from({ length: 128 }, (_, sequence) => ({
        sequence,
        at: '2026-01-01T00:00:00.000Z',
        component: 'diagnostics',
        event: 'sample',
        attributes: { values: Array.from({ length: 32 }, () => 'ready') },
      })),
    };
    const delay = (milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
    const bundle = await collectSupportBundle([
      { name: 'alpha', collect: async () => { await delay(30); return result; } },
      { name: 'beta', collect: async () => { await delay(20); return result; } },
      { name: 'gamma', collect: async () => { await delay(10); return result; } },
      { name: 'zeta', collect: async () => result },
    ]);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'zeta', code: 'collection_invalid_output', recoveryRequired: true }),
    ]));
  });

  it('does not hash unbounded project identities or receipt resource IDs', () => {
    const project = buildSupportBundle({ project: { id: 'x'.repeat(16_385) } });
    expect(project.project).toBeUndefined();

    const receipt = buildSupportBundle({ receipts: [{
      schema: 'psyche.control.receipt/v1',
      actionId: 'large-resource-id',
      state: 'queued',
      resource: { kind: 'project', id: 'x'.repeat(16_385) },
      createdAt: '2026-01-01T00:00:00.000Z',
    }] as never });
    expect(receipt.receipts).toHaveLength(0);
  });

  it('rejects malformed, projected, and overflowing collector output', async () => {
    const validRecord = {
      sequence: 1,
      at: '2026-01-01T00:00:00.000Z',
      component: 'collector',
      event: 'ready',
    };
    const validReceipt = {
      schema: 'psyche.control.receipt/v1' as const,
      actionId: 'overflow-action',
      state: 'queued' as const,
      resource: { kind: 'project' as const, id: 'project' },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const cases = [
      { records: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords + 1 }, () => validRecord) },
      { receipts: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxReceipts + 1 }, () => validReceipt) },
      { errors: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxErrorChain + 1 }, () => ({ collector: 'c', code: 'failed', at: '2026-01-01T00:00:00.000Z' })) },
      { terminalTail: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxTerminalLines + 1 }, () => 'arbitrary') },
      { records: [{ ...validRecord, sequence: 'not-a-number' }] },
      { receipts: [{ sourceSchema: 'psyche.control.receipt/v1', actionId: 'projected', state: 'pending', sourceState: 'queued', resource: { kind: 'project', idDigest: 'a'.repeat(64) }, createdAt: '2026-01-01T00:00:00.000Z' }] },
    ];

    for (const result of cases) {
      const bundle = await collectSupportBundle([{
        name: 'malformed-or-overflowing',
        collect: async () => result as never,
      }]);
      expect(bundle.status).toBe('recovery_required');
      expect(bundle.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ recoveryRequired: true }),
      ]));
    }
  });

  it('bounds the total collector normalization graph before merging sections', async () => {
    const state = () => Object.fromEntries(Array.from({ length: 32 }, (_, key) => [
      `key-${key}`,
      Array.from({ length: 110 }, (_, index) => ({ value: index })),
    ]));
    const bundle = await collectSupportBundle([{
      name: 'oversized-graph',
      collect: async () => ({
        lifecycle: state(),
        providers: state(),
        persistence: state(),
        updater: state(),
        graphics: state(),
      }),
    }]);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ collector: 'oversized-graph', code: 'collection_invalid_output', recoveryRequired: true }),
    ]));
  });

  it('detects duplicate and conflicting action IDs as recovery-required', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1' as const,
      actionId: 'same-action',
      state: 'queued' as const,
      resource: { kind: 'project' as const, id: 'project' },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const direct = buildSupportBundle({ receipts: [receipt, { ...receipt, state: 'failed' as const }] });
    expect(direct.status).toBe('recovery_required');
    expect(direct.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_action_id', recoveryRequired: true }),
    ]));

    const collected = await collectSupportBundle([
      {
        name: 'alpha',
        collect: async () => ({ receipts: [receipt, { ...receipt, state: 'failed' as const }] }),
      },
    ]);
    expect(collected.status).toBe('recovery_required');
    expect(collected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_action_id', recoveryRequired: true }),
    ]));

    const saturated = buildSupportBundle({
      errors: [
        { collector: 'one', code: 'collection_conflict', at: '2026-01-01T00:00:00.000Z', recoveryRequired: true },
        { collector: 'two', code: 'warning-two', at: '2026-01-01T00:00:00.000Z' },
        { collector: 'three', code: 'warning-three', at: '2026-01-01T00:00:00.000Z' },
        { collector: 'four', code: 'warning-four', at: '2026-01-01T00:00:00.000Z' },
      ],
      receipts: [receipt, { ...receipt, state: 'failed' as const }],
    });
    expect(saturated.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_conflict', recoveryRequired: true }),
    ]));
  });

  it('omits every conflicting receipt revision deterministically', () => {
    const now = () => 1_767_225_600_000;
    const receipt = (state: 'queued' | 'failed') => ({
      schema: 'psyche.control.receipt/v1' as const,
      actionId: 'same-action',
      state,
      resource: { kind: 'project' as const, id: 'project' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const queuedFirst = buildSupportBundle({ receipts: [receipt('queued'), receipt('failed')] }, { now });
    const failedFirst = buildSupportBundle({ receipts: [receipt('failed'), receipt('queued')] }, { now });
    expect(queuedFirst.receipts).toEqual([]);
    expect(failedFirst.receipts).toEqual([]);
    expect(serializeSupportBundle(queuedFirst)).toBe(serializeSupportBundle(failedFirst));
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

  it('rejects unsafe unknown fields at every typed validation boundary', () => {
    const fixture = createSafeSupportBundleFixture();
    expect(isSupportBundleV1({
      ...fixture,
      provenance: { ...fixture.provenance, secret: 'must not pass' },
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      project: { ...fixture.project, secret: 'must not pass' },
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      records: [{ ...fixture.records[0], futureSecret: 'must not pass' }],
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      errors: [{ collector: 'fixture', code: 'failed', at: 'unknown', message: 'must not pass' }],
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      receipts: [{ ...fixture.receipts[0], message: 'must not pass' }],
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      lifecycle: { alice: true, userId: 'ready' },
    } as unknown)).toBe(false);
  });

  it('drops malformed receipt revisions without serializing their payload', () => {
    const bundle = buildSupportBundle({
      receipts: [{
        schema: 'psyche.control.receipt/v1',
        actionId: 'unsafe-revision',
        state: 'queued',
        resource: { kind: 'project', id: 'project' },
        createdAt: '2026-01-01T00:00:00.000Z',
        leaseRevision: { secret: 'must-not-serialize' },
      } as never],
    });

    expect(bundle.receipts).toHaveLength(0);
    expect(serializeSupportBundle(bundle)).not.toContain('must-not-serialize');
  });

  it('validates normalized collection entries and bounds at the type guard boundary', () => {
    const fixture = createSafeSupportBundleFixture();
    expect(isSupportBundleV1(fixture)).toBe(true);
    expect(isSupportBundleV1({ ...fixture, records: [{}] } as unknown)).toBe(false);
    expect(isSupportBundleV1({ ...fixture, terminalTail: [123] } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      records: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords + 1 }, () => fixture.records[0]),
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      lifecycle: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, 'value'])),
    } as unknown)).toBe(false);
    const largeState = Object.fromEntries(Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxAttributeKeys }, (_, index) => [
      `key-${index}`, 'x'.repeat(SUPPORT_BUNDLE_LIMITS.maxStringBytes),
    ]));
    expect(isSupportBundleV1({
      ...fixture,
      lifecycle: largeState,
      providers: largeState,
      persistence: largeState,
      updater: largeState,
      graphics: largeState,
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      project: {
        ...fixture.project,
        relativePath: 'src/ghp_01234567890123456789',
      },
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      project: {
        ...fixture.project,
        relativePath: 'a'.repeat(SUPPORT_BUNDLE_LIMITS.maxStringBytes + 1),
      },
    } as unknown)).toBe(false);
    expect(isSupportBundleV1({
      ...fixture,
      truncation: { ...fixture.truncation, totalPayloadBounded: false },
    } as unknown)).toBe(false);
  });

  it('omits long valid relative paths without emitting an invalid ellipsis', () => {
    const longRelativePath = `${'segment/'.repeat(100)}file.ts`;
    const bundle = buildSupportBundle({
      project: { id: 'project', relativePath: longRelativePath },
      records: [{
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        component: 'path-test',
        event: 'path',
        attributes: { relativePath: longRelativePath },
      }],
    });

    expect(bundle.project?.relativePath).toBeUndefined();
    expect(bundle.records[0]?.attributes?.relativePath).toBeUndefined();
    expect(serializeSupportBundle(bundle)).not.toContain('…');
    expect(serializeSupportBundle(bundle)).not.toContain(longRelativePath);
  });

  it('fails closed for invalid or recovery-sensitive collection status', () => {
    expect(buildSupportBundle({ status: 'not-a-status' }).status).toBe('unknown');
    expect(buildSupportBundle({ errors: [{ collector: 'disk', code: 'write_failed', at: 'now', recoveryRequired: true }] }).status)
      .toBe('recovery_required');
    const timedOut = buildSupportBundle({ lifecycle: { state: 'ready' } }, { maxElapsedMs: 0 });
    expect(timedOut.status).toBe('recovery_required');
    expect(timedOut.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'normalization_timeout', recoveryRequired: true }),
    ]));
    expect(buildSupportBundle({}).status).toBe('partial');
    expect(buildSupportBundle({ provenance: { sourceSha: 'abcdef0' } }).provenance.sourceSha).toBe('unknown');
    expect(isSupportBundleV1({
      ...createSafeSupportBundleFixture(),
      status: 'complete',
      errors: [{ collector: 'disk', code: 'failed', at: 'unknown', recoveryRequired: true }],
    })).toBe(false);
    expect(isSupportBundleV1({
      ...createSafeSupportBundleFixture(),
      lifecycle: { state: 'privateimplementationfragment' },
    })).toBe(false);
    expect(buildSupportBundle({ project: { relativePath: '~/.ssh/id_rsa' } }).project?.relativePath).toBeUndefined();
    expect(buildSupportBundle({ project: { relativePath: 'src/ghp_01234567890123456789' } }).project?.relativePath)
      .toBeUndefined();
    expect(buildSupportBundle({ project: { relativePath: 'src/glpat-01234567890123456789' } }).project?.relativePath)
      .toBeUndefined();
    expect(buildSupportBundle({ project: { relativePath: '.ssh/id_rsa' } }).project?.relativePath).toBeUndefined();
    expect(buildSupportBundle({ project: { relativePath: 'config/credentials.json' } }).project?.relativePath)
      .toBeUndefined();
    expect(buildSupportBundle({ project: { relativePath: 'config/passwords.txt' } }).project?.relativePath)
      .toBeUndefined();
    expect(buildSupportBundle({ provenance: {
      application: 'psyche-build',
      releaseVersion: '1.0.0-736563726574',
      sourceSha: '0'.repeat(40),
      platform: 'linux',
      architecture: 'x86_64',
    } }).status).toBe('partial');
    const rawIdentifier = 'a'.repeat(64);
    const rawReceipt = buildSupportBundle({ receipts: [{
      schema: 'psyche.control.receipt/v1',
      actionId: rawIdentifier,
      state: 'queued',
      resource: { kind: 'project', id: 'project' },
      createdAt: '2026-01-01T00:00:00.000Z',
    }] });
    expect(rawReceipt.receipts[0]?.actionId).toBe(createHash('sha256').update(rawIdentifier).digest('hex'));
    expect(buildSupportBundle({ errors: [null] as never }).status).toBe('recovery_required');
    expect(buildSupportBundle({ lifecycle: { alice: true, userId: 'ready' } }).lifecycle).toEqual({});
    expect(buildSupportBundle({ records: [{
      sequence: 1,
      at: '2026-02-31T00:00:00.000Z',
      component: 'fixture',
      event: 'ready',
    }] }).records).toEqual([]);
    const marker = 'collector-marker';
    const privateBundle = buildSupportBundle({
      provenance: {
        application: marker,
        releaseVersion: marker,
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        platform: marker,
        architecture: marker,
      },
      project: { id: marker, name: marker },
      receipts: [{
        schema: 'psyche.control.receipt/v1',
        actionId: marker,
        state: 'queued',
        resource: { kind: 'project', id: marker },
        createdAt: '2026-01-01T00:00:00.000Z',
        taskId: marker,
        actorId: marker,
        leaseId: marker,
        code: marker,
      } as never],
    });
    expect(serializeSupportBundle(privateBundle)).not.toContain(marker);
  });

  it('does not expose sensitive record attributes or claim forged provenance as complete', () => {
    const bundle = buildSupportBundle({
      provenance: {
        application: 'psyche-build',
        releaseVersion: '1.0.0',
        sourceSha: '0'.repeat(40),
        platform: 'linux',
        architecture: 'x86_64',
      },
      records: [{
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        component: 'diagnostics',
        event: 'sample',
        attributes: { password: 'secret', safeState: 'ready' },
      }],
      receipts: [{
        schema: 'psyche.control.receipt/v1',
        actionId: 'forged-success',
        state: 'succeeded',
        resource: { kind: 'project', id: 'forged-project' },
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    expect(bundle.status).not.toBe('complete');
    expect(bundle.records[0]?.attributes).toEqual({ safeState: 'ready' });
    expect(serializeSupportBundle(bundle)).not.toContain('password');
    expect(serializeSupportBundle(bundle)).not.toContain('forged-project');
  });

  it('keeps record attributes inside the bounded diagnostic vocabulary', () => {
    const bundle = buildSupportBundle({
      records: [{
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        component: 'diagnostics',
        event: 'sample',
        attributes: { arbitraryFlag: true, safeState: 'ready' },
      }],
    });

    expect(bundle.records[0]?.attributes).toEqual({ safeState: 'ready' });
  });

  it('rejects direct arrays beyond the scan bound instead of selecting an order-dependent prefix', () => {
    const records = Array.from({ length: 1_025 }, (_, sequence) => ({
      sequence,
      at: '2026-01-01T00:00:00.000Z',
      component: 'test',
      event: 'sample',
    }));
    const options = { now: () => 1_767_225_600_000 };
    const first = buildSupportBundle({ records }, options);
    const second = buildSupportBundle({ records: [...records].reverse() }, options);

    expect(first.status).toBe('recovery_required');
    expect(serializeSupportBundle(first)).toBe(serializeSupportBundle(second));
    expect(first.records).toEqual([]);
  });

  it('sorts records globally when bounded collectors contribute to one aggregate', async () => {
    const record = (sequence: number) => ({
      sequence,
      at: '2026-01-01T00:00:00.000Z',
      component: 'diagnostics',
      event: 'sample',
    });
    const bundle = await collectSupportBundle([
      { name: 'alpha', collect: async () => ({ records: [record(100)] }) },
      { name: 'beta', collect: async () => ({ records: [record(1)] }) },
    ], { maxRecords: 1 });

    expect(bundle.records.map((item) => item.sequence)).toEqual([1]);
    expect(bundle.status).toBe('recovery_required');
  });

  it('does not trust caller redaction metadata and reports honest truncation accounting', () => {
    const bundle = buildSupportBundle({
      redaction: { version: 1, redactedFields: 123, omittedFields: 456, categories: { forged: 789 } },
    });
    expect(bundle.redaction).toEqual({ version: 1, redactedFields: 0, omittedFields: 0, categories: {} });
    expect(bundle.truncation.bytesOmitted).toBe(0);

    const overflowing = buildSupportBundle({
      errors: Array.from({ length: 8 }, (_, index) => ({
        collector: 'c',
        code: `warning-${index}`,
        at: '2026-01-01T00:00:00.000Z',
      })),
    });
    expect(overflowing.truncation.errorsOmitted).toBeGreaterThan(0);

    const normalized = buildSupportBundle({ lifecycle: { password: 'secret' } }) as unknown as {
      truncation: Record<string, unknown>;
      redaction: { categories: Record<string, number> };
    };
    normalized.truncation.recordsOmitted = 999_999;
    normalized.redaction.categories['forged'] = 999_999;
    const reserialized = JSON.parse(serializeSupportBundle(normalized as unknown as SupportBundle)) as SupportBundle;
    expect(reserialized.truncation.recordsOmitted).toBe(0);
    expect(reserialized.redaction.categories).not.toHaveProperty('forged');
  });

  it('fails closed for untyped state strings and numbers', () => {
    const bundle = buildSupportBundle({
      lifecycle: {
        safeState: 'ready',
        note: 'glpat-01234567890123456789',
        proprietaryDetail: 'internal implementation detail',
        otp: 123456,
        version: '1.2.3',
      },
    });

    expect(bundle.lifecycle).toMatchObject({ safeState: 'ready', version: '1.2.3' });
    expect(bundle.lifecycle).not.toHaveProperty('note');
    expect(bundle.lifecycle).not.toHaveProperty('proprietaryDetail');
    expect(bundle.lifecycle).not.toHaveProperty('otp');
    expect(serializeSupportBundle(bundle)).not.toContain('glpat-01234567890123456789');
    expect(serializeSupportBundle(bundle)).not.toContain('internal implementation detail');
  });

  it('accounts for records omitted while merging bounded collectors', async () => {
    const record = (sequence: number) => ({
      sequence,
      at: '2026-01-01T00:00:00.000Z',
      component: 'collector',
      event: 'sample',
    });
    const bundle = await collectSupportBundle([
      { name: 'alpha', collect: async () => ({ records: Array.from({ length: SUPPORT_BUNDLE_LIMITS.maxRecords }, (_, index) => record(index)) }) },
      { name: 'beta', collect: async () => ({ records: [record(10_000), record(10_001)] }) },
    ]);

    expect(bundle.truncation.recordsOmitted).toBe(2);
    expect(bundle.status).toBe('recovery_required');
    expect(bundle.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'collection_output_overflow', recoveryRequired: true }),
    ]));
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

  it('accepts unknown fields within v1 and drops them at serialization', () => {
    const fixture = createSafeSupportBundleFixture();
    const extended = {
      ...fixture,
      futureRootField: { secret: 'must not serialize' },
      compatibility: { ...fixture.compatibility, futureReaderHint: 'ignored' },
      lifecycle: { ...fixture.lifecycle, futureState: 'private-detail' },
      records: [{ ...fixture.records[0], futureRecordField: 'ignored' }],
    } as unknown as SupportBundle;

    expect(isSupportBundleV1(extended)).toBe(false);
    const serialized = serializeSupportBundle(extended);
    expect(serialized).not.toContain('futureRootField');
    expect(serialized).not.toContain('must not serialize');
    expect(serialized).not.toContain('futureReaderHint');
    expect(serialized).not.toContain('futureState');
    expect(serialized).not.toContain('futureRecordField');
  });

  it('ignores unknown fields while verifying a supported serialized bundle', () => {
    const codec = createSupportBundleCodec('psyche-build-support-fixture-v1');
    const fixture = createSafeSupportBundleFixture();
    const extended = {
      ...fixture,
      futureRootField: 'ignored',
      compatibility: { ...fixture.compatibility, futureReaderHint: 'ignored' },
      lifecycle: { ...fixture.lifecycle, futureState: 'ignored' },
      records: [{ ...fixture.records[0], futureRecordField: 'ignored' }],
    };

    const parsed = parseSupportBundle(JSON.stringify(extended), codec);
    expect(serializeSupportBundle(parsed, codec)).toBe(serializeSupportBundle(fixture));
    expect(parsed).not.toHaveProperty('futureRootField');
  });

  it('parses unsigned partial bundles without requiring an application codec', () => {
    const bundle = buildSupportBundle({ lifecycle: { password: 'secret' } });
    const parsed = parseSupportBundle(serializeSupportBundle(bundle));

    expect(parsed.status).toBe('partial');
    expect(parsed).not.toHaveProperty('accountingProof');
    expect(parsed.provenance.verification).toBe('unverified');
  });

  it('preserves the codec on minimal recovery bundles', () => {
    const codec = createSupportBundleCodec('support-bundle-recovery-proof-v1');
    const bundle = buildSupportBundle({ lifecycle: { state: 'ready' } }, { maxElapsedMs: 0, codec });
    const parsed = parseSupportBundle(serializeSupportBundle(bundle), codec);

    expect(bundle.status).toBe('recovery_required');
    expect(bundle.accountingProof).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.status).toBe('recovery_required');
  });

  it('omits arbitrary terminal text by default', () => {
    const lines = Array.from({ length: 64 }, (_, index) => `line-${index}-${'x'.repeat(480)}`);
    lines[63] = '\u001b]0;OSC_SECRET\u0007newest';
    const bundle = buildSupportBundle({ terminalTail: lines });
    const serialized = serializeSupportBundle(bundle);
    expect(serialized).not.toContain('OSC_SECRET');
    expect(bundle.terminalTail).toEqual([]);
    expect(bundle.truncation.terminalLinesOmitted).toBe(lines.length);
    expect(bundle.redaction.categories).toHaveProperty('terminal-omitted');
  });

  it('keeps the checked-in safe fixture equal to the canonical fixture generator', async () => {
    const fixturePath = new URL('../protocol-fixtures/support-bundle/v1/safe-bundle.json', import.meta.url);
    const fixture = parseSupportBundle(
      await readFile(fixturePath, 'utf8'),
      createSupportBundleCodec('psyche-build-support-fixture-v1'),
    );
    expect(serializeSupportBundle(fixture)).toBe(serializeSupportBundle(createSafeSupportBundleFixture()));
    expect(await readFile(fixturePath, 'utf8')).toBe(serializeProtocolFixture(createSafeSupportBundleFixture()));
  });
});
