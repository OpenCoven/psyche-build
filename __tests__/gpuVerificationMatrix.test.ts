import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GPU_VERIFICATION_ACCELERATION_VALUES,
  GPU_VERIFICATION_ARCHITECTURES,
  GPU_VERIFICATION_DIFF_VERDICTS,
  GPU_VERIFICATION_GATES,
  GPU_VERIFICATION_LIFECYCLE_CHECKS,
  GPU_VERIFICATION_LIMITS,
  GPU_VERIFICATION_MATRIX_SCHEMA_VERSION,
  GPU_VERIFICATION_METRIC_KEYS,
  GPU_VERIFICATION_PLATFORMS,
  GPU_VERIFICATION_REVIEW_STATUSES,
  GPU_VERIFICATION_SCENARIO_IDS,
  GPU_VERIFICATION_STATUSES,
  validateEvidenceManifest,
} from '../src/gpu/verificationMatrix.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrixDoc = readFileSync(resolve(root, 'docs', 'gpu', 'VERIFICATION-MATRIX.md'), 'utf8');

type AnyRecord = Record<string, unknown>;

const COMMIT_SHA = 'a1b2c3d4e5f60123456789abcdefa1b2c3d4e5f6';
const HOSTNAME_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const clone = (value: AnyRecord): AnyRecord => JSON.parse(JSON.stringify(value)) as AnyRecord;

/** A structurally valid, minimal manifest: only required fields, nothing optional. */
const buildValidManifest = (): AnyRecord => ({
  schemaVersion: GPU_VERIFICATION_MATRIX_SCHEMA_VERSION,
  provenance: {
    releaseVersion: '0.0.2',
    commitSha: COMMIT_SHA,
    platform: 'macos',
    architecture: 'arm64',
    collectedAt: '2026-08-28T12:00:00.000Z',
    collector: 'operator-manual',
  },
  machine: {
    hostnameDigest: HOSTNAME_DIGEST,
    osName: 'macOS',
    osVersion: '14.6.1',
    physicalHardware: true,
  },
  driver: {
    webviewEngine: 'WKWebView',
    acceleration: 'accelerated',
    softwareMarkers: [],
  },
  gates: GPU_VERIFICATION_GATES.map((gate) => ({ gate, status: 'succeeded' })),
  scenarios: GPU_VERIFICATION_SCENARIO_IDS.map((scenarioId) => ({
    scenarioId,
    status: 'succeeded',
    metrics:
      scenarioId === 'panes-6'
        ? [
            { key: 'frame.p95Ms', value: 22.5 },
            { key: 'input.focusToPaintMs', value: 61 },
          ]
        : [],
  })),
  lifecycle: {
    contextLoss: 'recovery_required',
    minimize: 'succeeded',
    background: 'succeeded',
    restore: 'succeeded',
  },
  metrics: [
    { key: 'process.cpuPercent', value: 12.5 },
    { key: 'process.rssMb', value: 512 },
  ],
  cspCapabilityAudit: { cspDiff: 'unchanged', capabilityDiff: 'unchanged' },
  reviews: {
    specReview: { status: 'approved' },
    codeReview: { status: 'approved' },
  },
});

function expectInvalid(manifest: unknown): string[] {
  const result = validateEvidenceManifest(manifest);
  if (result.ok) {
    throw new Error('expected the manifest to be rejected');
  }
  return result.errors;
}

describe('gpu verification matrix contract constants', () => {
  it('pins the evidence status vocabulary to exactly the six required values', () => {
    expect([...GPU_VERIFICATION_STATUSES]).toEqual([
      'succeeded',
      'failed',
      'unknown',
      'recovery_required',
      'unavailable',
      'not-run',
    ]);
  });

  it('pins the deterministic repository gates from the acceptance criteria', () => {
    expect([...GPU_VERIFICATION_GATES]).toEqual([
      'build:web',
      'test',
      'typecheck',
      'build',
      'smoke',
      'smoke:pack',
      'rust:fmt',
      'rust:test',
      'rust:check',
      'git:diff-check',
    ]);
  });

  it('pins the stress scenarios to 1/6/12/24 panes in execution order', () => {
    expect([...GPU_VERIFICATION_SCENARIO_IDS]).toEqual(['panes-1', 'panes-6', 'panes-12', 'panes-24']);
  });

  it('pins the physical platform set and supporting vocabularies', () => {
    expect([...GPU_VERIFICATION_PLATFORMS]).toEqual(['macos', 'windows', 'linux']);
    expect([...GPU_VERIFICATION_ARCHITECTURES]).toEqual(['x86_64', 'arm64']);
    expect([...GPU_VERIFICATION_ACCELERATION_VALUES]).toEqual([
      'accelerated',
      'software',
      'unknown',
      'unavailable',
    ]);
    expect([...GPU_VERIFICATION_LIFECYCLE_CHECKS]).toEqual([
      'contextLoss',
      'minimize',
      'background',
      'restore',
    ]);
    expect([...GPU_VERIFICATION_DIFF_VERDICTS]).toEqual([
      'unchanged',
      'weakened',
      'strengthened',
      'unknown',
    ]);
    expect([...GPU_VERIFICATION_REVIEW_STATUSES]).toEqual(['pending', 'approved', 'changes-requested']);
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('frame.p95Ms');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('input.focusToPaintMs');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('input.resizeToPaintMs');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('process.cpuPercent');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('process.rssMb');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('pty.queueHighWater');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('pty.ipcMessagesPerSecond');
    expect(GPU_VERIFICATION_METRIC_KEYS).toContain('pty.throughputBytesPerSecond');
  });

  it('bounds record counts to the fixed gate and scenario sets', () => {
    expect(GPU_VERIFICATION_LIMITS.schemaVersion).toBe(1);
    expect(GPU_VERIFICATION_LIMITS.gateRecords).toBe(GPU_VERIFICATION_GATES.length);
    expect(GPU_VERIFICATION_LIMITS.scenarioRecords).toBe(GPU_VERIFICATION_SCENARIO_IDS.length);
  });
});

describe('validateEvidenceManifest accepts honest evidence', () => {
  it('accepts a valid minimal manifest', () => {
    const result = validateEvidenceManifest(buildValidManifest());
    if (!result.ok) {
      throw new Error(`expected acceptance, got: ${result.errors.join('; ')}`);
    }
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.provenance.platform).toBe('macos');
    expect(result.manifest.gates).toHaveLength(10);
    expect(result.manifest.scenarios).toHaveLength(4);
  });

  it('accepts a manifest that fills optional fields honestly', () => {
    const manifest = buildValidManifest();
    (manifest.driver as AnyRecord).webviewVersion = '618.1.15';
    (manifest.driver as AnyRecord).gpuBackend = 'Metal';
    (manifest.driver as AnyRecord).gpuAdapter = 'Apple M3';
    (manifest.driver as AnyRecord).softwareMarkers = ['llvmpipe'];
    (manifest.gates as AnyRecord[])[0].note = 'reproduced from a clean checkout';
    (manifest.reviews as AnyRecord).specReview = { status: 'approved', reviewer: 'reviewer-a' };
    expect(validateEvidenceManifest(manifest).ok).toBe(true);
  });

  it('accepts a manifest recording unavailable evidence instead of a guessed success', () => {
    const manifest = buildValidManifest();
    (manifest.driver as AnyRecord).acceleration = 'unavailable';
    (manifest.driver as AnyRecord).softwareMarkers = ['SwiftShader'];
    (manifest.lifecycle as AnyRecord).contextLoss = 'not-run';
    expect(validateEvidenceManifest(manifest).ok).toBe(true);
  });
});

describe('validateEvidenceManifest rejects unknown fields', () => {
  it('rejects unknown top-level fields', () => {
    const manifest = buildValidManifest();
    manifest.ciApproved = true;
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('manifest.ciApproved: unknown field');
  });

  it('rejects unknown fields nested in provenance, driver, and records', () => {
    const manifest = buildValidManifest();
    (manifest.provenance as AnyRecord).hostName = 'lab-mac-01';
    (manifest.driver as AnyRecord).score = 99;
    (manifest.gates as AnyRecord[])[0].evidenceUrl = 'https://ci.example.invalid/run/1';
    (manifest.scenarios as AnyRecord[])[0].screenshots = [];
    (manifest.lifecycle as AnyRecord).reboot = 'succeeded';
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('provenance.hostName: unknown field');
    expect(errors).toContainEqual('driver.score: unknown field');
    expect(errors).toContainEqual('gates[0].evidenceUrl: unknown field');
    expect(errors).toContainEqual('scenarios[0].screenshots: unknown field');
    expect(errors).toContainEqual('lifecycle.reboot: unknown field');
  });
});

describe('validateEvidenceManifest requires provenance', () => {
  it('rejects a manifest without provenance, machine, or driver sections', () => {
    for (const section of ['provenance', 'machine', 'driver'] as const) {
      const manifest = buildValidManifest();
      delete manifest[section];
      const errors = expectInvalid(manifest);
      expect(errors.some((error) => error.startsWith(`${section}:`))).toBe(true);
    }
  });

  it('rejects provenance missing any required field', () => {
    for (const field of [
      'releaseVersion',
      'commitSha',
      'platform',
      'architecture',
      'collectedAt',
      'collector',
    ] as const) {
      const manifest = buildValidManifest();
      delete (manifest.provenance as AnyRecord)[field];
      const errors = expectInvalid(manifest);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects short or malformed commit SHAs', () => {
    const short = buildValidManifest();
    (short.provenance as AnyRecord).commitSha = 'a1b2c3d';
    const upper = buildValidManifest();
    (upper.provenance as AnyRecord).commitSha = COMMIT_SHA.toUpperCase();
    expect(expectInvalid(short)).toContainEqual(
      'provenance.commitSha: must be a full 40-character lowercase hex commit SHA',
    );
    expect(expectInvalid(upper)).toContainEqual(
      'provenance.commitSha: must be a full 40-character lowercase hex commit SHA',
    );
  });

  it('rejects non-UTC collection timestamps', () => {
    const manifest = buildValidManifest();
    (manifest.provenance as AnyRecord).collectedAt = '2026-08-28T12:00:00+02:00';
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('provenance.collectedAt: must be an ISO-8601 UTC timestamp ending in Z');
  });

  it('fails closed on raw hostnames instead of the required digest', () => {
    const manifest = buildValidManifest();
    (manifest.machine as AnyRecord).hostnameDigest = 'lab-macbook-01';
    const errors = expectInvalid(manifest);
    expect(
      errors.some((error) =>
        error.startsWith('machine.hostnameDigest: must be a 64-character lowercase hex SHA-256 digest'),
      ),
    ).toBe(true);
  });

  it('rejects a virtualized host flag that is not a boolean', () => {
    const manifest = buildValidManifest();
    (manifest.machine as AnyRecord).physicalHardware = 'yes';
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('machine.physicalHardware: must be a boolean');
  });
});

describe('validateEvidenceManifest bounds records', () => {
  it('rejects more gate records than the fixed gate set', () => {
    const manifest = buildValidManifest();
    (manifest.gates as unknown[]).push({ gate: 'lint', status: 'succeeded' });
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('gates: must contain exactly 10 records, one per gate');
  });

  it('rejects more scenario records than the four scenarios', () => {
    const manifest = buildValidManifest();
    (manifest.scenarios as unknown[]).push({ scenarioId: 'panes-48', status: 'succeeded', metrics: [] });
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('scenarios: must contain exactly 4 records, one per scenario');
  });

  it('rejects duplicated gate and scenario records', () => {
    const manifest = buildValidManifest();
    const gates = manifest.gates as AnyRecord[];
    gates[1] = { ...gates[0] };
    const scenarios = manifest.scenarios as AnyRecord[];
    scenarios[3] = { ...scenarios[2] };
    const errors = expectInvalid(manifest);
    expect(errors.some((error) => error.includes('duplicate gate'))).toBe(true);
    expect(errors.some((error) => error.includes('duplicate scenario'))).toBe(true);
  });

  it('rejects unbounded metric records at the manifest and scenario level', () => {
    const manyMetrics = Array.from({ length: GPU_VERIFICATION_LIMITS.topLevelMetrics + 1 }, () => ({
      key: 'process.cpuPercent',
      value: 1,
    }));
    const manifest = buildValidManifest();
    manifest.metrics = manyMetrics;
    expect(expectInvalid(manifest)).toContainEqual('metrics: exceeds maximum of 16 records');

    const scenarioManifest = buildValidManifest();
    (scenarioManifest.scenarios as AnyRecord[])[0].metrics = Array.from(
      { length: GPU_VERIFICATION_LIMITS.metricsPerScenario + 1 },
      () => ({ key: 'frame.p95Ms', value: 1 }),
    );
    expect(expectInvalid(scenarioManifest)).toContainEqual(
      'scenarios[0].metrics: exceeds maximum of 8 records',
    );
  });

  it('rejects oversize note and identifier strings', () => {
    const manifest = buildValidManifest();
    (manifest.gates as AnyRecord[])[0].note = 'x'.repeat(GPU_VERIFICATION_LIMITS.noteLength + 1);
    (manifest.provenance as AnyRecord).collector = 'y'.repeat(GPU_VERIFICATION_LIMITS.shortStringLength + 1);
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('gates[0].note: exceeds maximum length of 512');
    expect(errors).toContainEqual('provenance.collector: exceeds maximum length of 128');
  });

  it('rejects more software markers than the bounded maximum', () => {
    const manifest = buildValidManifest();
    (manifest.driver as AnyRecord).softwareMarkers = Array.from(
      { length: GPU_VERIFICATION_LIMITS.softwareMarkers + 1 },
      (_, index) => `marker-${index}`,
    );
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('driver.softwareMarkers: exceeds maximum of 8 entries');
  });
});

describe('validateEvidenceManifest rejects bogus ids, statuses, and values', () => {
  it('rejects scenario ids outside the fixed set', () => {
    const manifest = buildValidManifest();
    (manifest.scenarios as AnyRecord[])[2].scenarioId = 'panes-18';
    const errors = expectInvalid(manifest);
    expect(errors.join('\n')).toContain('must be one of panes-1, panes-6, panes-12, panes-24');
  });

  it('rejects gate ids outside the fixed set', () => {
    const manifest = buildValidManifest();
    (manifest.gates as AnyRecord[])[5].gate = 'cargo:clippy';
    const errors = expectInvalid(manifest);
    expect(errors.join('\n')).toContain('must be one of build:web, test, typecheck, build, smoke,');
  });

  it('rejects statuses outside the closed vocabulary', () => {
    const manifest = buildValidManifest();
    (manifest.gates as AnyRecord[])[0].status = 'passed';
    (manifest.scenarios as AnyRecord[])[0].status = 'ok';
    (manifest.lifecycle as AnyRecord).restore = 'green';
    const errors = expectInvalid(manifest);
    expect(errors.filter((error) => error.includes('must be one of succeeded, failed,'))).toHaveLength(3);
  });

  it('rejects bogus platforms, architectures, acceleration evidence, diffs, and reviews', () => {
    const manifest = buildValidManifest();
    (manifest.provenance as AnyRecord).platform = 'browseros';
    (manifest.provenance as AnyRecord).architecture = 'wasm32';
    (manifest.driver as AnyRecord).acceleration = 'gpu-go-brrr';
    (manifest.cspCapabilityAudit as AnyRecord).cspDiff = 'weakened-but-fine';
    (manifest.reviews as AnyRecord).codeReview = { status: 'looks-good' };
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('provenance.platform: must be one of macos, windows, linux');
    expect(errors).toContainEqual('provenance.architecture: must be one of x86_64, arm64');
    expect(errors).toContainEqual(
      'driver.acceleration: must be one of accelerated, software, unknown, unavailable',
    );
    expect(errors).toContainEqual(
      'cspCapabilityAudit.cspDiff: must be one of unchanged, weakened, strengthened, unknown',
    );
    expect(errors.join('\n')).toContain('reviews.codeReview.status: must be one of pending, approved,');
  });

  it('rejects metric keys outside the bounded set', () => {
    const manifest = buildValidManifest();
    manifest.metrics = [{ key: 'gpu.fpsAbsolute', value: 60 }];
    const errors = expectInvalid(manifest);
    expect(errors.join('\n')).toContain('metrics[0].key: must be one of frame.averageMs,');
  });

  it('rejects non-finite, negative, and absurd metric values', () => {
    const manifest = buildValidManifest();
    manifest.metrics = [
      { key: 'process.cpuPercent', value: Number.NaN },
      { key: 'process.rssMb', value: Number.POSITIVE_INFINITY },
      { key: 'frame.p95Ms', value: -1 },
      { key: 'frame.maxMs', value: 2_000_000_000 },
    ];
    const errors = expectInvalid(manifest);
    expect(errors).toContainEqual('metrics[0].value: must be a finite number');
    expect(errors).toContainEqual('metrics[1].value: must be a finite number');
    expect(errors).toContainEqual('metrics[2].value: must be between 0 and 1000000000');
    expect(errors).toContainEqual('metrics[3].value: must be between 0 and 1000000000');
  });
});

describe('validateEvidenceManifest rejects malformed input', () => {
  it('rejects non-object input', () => {
    for (const value of [null, undefined, 'manifest', 42, [], true]) {
      const result = validateEvidenceManifest(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['manifest: must be a JSON object']);
      }
    }
  });

  it('rejects a wrong or missing schema version', () => {
    const wrong = buildValidManifest();
    wrong.schemaVersion = 2;
    const missing = buildValidManifest();
    delete missing.schemaVersion;
    for (const manifest of [wrong, missing]) {
      expect(expectInvalid(manifest)).toContainEqual('schemaVersion: must be 1');
    }
  });
});

describe('verification matrix documentation contract', () => {
  it('keeps the document aligned with the machine-checkable constants', () => {
    for (const gate of GPU_VERIFICATION_GATES) {
      expect(matrixDoc).toContain(`\`${gate}\``);
    }
    for (const scenario of GPU_VERIFICATION_SCENARIO_IDS) {
      expect(matrixDoc).toContain(`\`${scenario}\``);
    }
    for (const status of GPU_VERIFICATION_STATUSES) {
      expect(matrixDoc).toContain(`\`${status}\``);
    }
    for (const metric of GPU_VERIFICATION_METRIC_KEYS) {
      expect(matrixDoc).toContain(`\`${metric}\``);
    }
    expect(matrixDoc).toContain('src/gpu/verificationMatrix.ts');
    expect(matrixDoc).toContain('validateEvidenceManifest()');
  });

  it('states the CI substitution rule and the performance targets', () => {
    expect(matrixDoc).toContain('Hosted CI never substitutes for physical acceleration evidence');
    expect(matrixDoc).toContain('33.4');
    expect(matrixDoc).toContain('100 ms');
  });

  it('records uncollected physical evidence as open gaps instead of successes', () => {
    expect(matrixDoc).toMatch(/open gap/i);
    expect(matrixDoc).toContain('#231');
    expect(matrixDoc).not.toMatch(/acceleration: confirmed on all platforms/iu);
  });
});
