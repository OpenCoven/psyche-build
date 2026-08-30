import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GPU_DIAGNOSTICS_ACCELERATION_STATES,
  GPU_DIAGNOSTICS_AUTHORIZATION_ENV,
  GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN,
  GPU_DIAGNOSTICS_EVIDENCE_CLASSES,
  GPU_DIAGNOSTICS_FIELDS,
  GPU_DIAGNOSTICS_GROUPS,
  GPU_DIAGNOSTICS_LIMITS,
  GPU_DIAGNOSTICS_SURFACE_ID,
  GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION,
  GPU_DIAGNOSTICS_TRANSITION_PROPERTIES,
  canControlScenarios,
  copyForA11y,
  diagnosticsJson,
  filterDiagnosticTransitionProperties,
  isAllowedDiagnosticTransitionProperty,
  isDiagnosticsAuthorized,
  omissionManifestsFor,
  visibleRowsFor,
  type GpuDiagnosticsSnapshotV1,
} from '../src/gpu/diagnosticsSurface.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractDoc = readFileSync(
  resolve(root, 'docs', 'gpu', 'DIAGNOSTICS-SURFACE-CONTRACT.md'),
  'utf8',
);

const AUTHORIZED = { debugBuild: true, authorizationToken: GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN };

/** Snapshot with every catalogued field present, in catalog order. */
const buildFullSnapshot = (): GpuDiagnosticsSnapshotV1 => ({
  graphics: {
    acceleration: 'software',
    backend: 'Vulkan',
    adapter: 'llvmpipe (LLVM 17.0.5)',
    softwareMarkers: ['llvmpipe'],
    fallbackReason: 'strict context creation failed',
    supportingProbe: 'webgl2-strict',
  },
  runtime: {
    engine: 'WebKitGTK',
    engineVersion: '2.44.0',
    os: 'Linux',
    arch: 'x86_64',
  },
  renderer: {
    mode: 'canvas',
  },
  transport: {
    queueHighWater: 12,
    ipcMessagesPerSecond: 240,
    throughputBytesPerSecond: 2_500_000,
  },
  frame: {
    averageMs: 28.5,
    p95Ms: 40.2,
    maxMs: 61.3,
    droppedEstimated: 9,
  },
  process: {
    cpuPercent: 38.2,
    rssMb: 768,
  },
});

const CATALOG_ROW_KEYS = [
  'graphics.acceleration',
  'graphics.backend',
  'graphics.adapter',
  'graphics.softwareMarkers',
  'graphics.fallbackReason',
  'graphics.supportingProbe',
  'runtime.engine',
  'runtime.engineVersion',
  'runtime.os',
  'runtime.arch',
  'renderer.mode',
  'transport.queueHighWater',
  'transport.ipcMessagesPerSecond',
  'transport.throughputBytesPerSecond',
  'frame.averageMs',
  'frame.p95Ms',
  'frame.maxMs',
  'frame.droppedEstimated',
  'process.cpuPercent',
  'process.rssMb',
];

/** Values that would indicate a placeholder instead of real evidence. */
const PLACEHOLDER_VALUES = ['', 'N/A', 'n/a', 'TBD', 'placeholder', '-', '—', '(not available)'];

describe('gpu diagnostics authorization gate', () => {
  it.each([
    ['debug build plus exact token', { debugBuild: true, authorizationToken: '1' }, true],
    ['debug build with null token', { debugBuild: true, authorizationToken: null }, false],
    ['debug build with undefined token', { debugBuild: true, authorizationToken: undefined }, false],
    ['debug build with empty token', { debugBuild: true, authorizationToken: '' }, false],
    ['debug build with wrong token', { debugBuild: true, authorizationToken: '0' }, false],
    ['debug build with padded token', { debugBuild: true, authorizationToken: ' 1 ' }, false],
    ['debug build with numeric token', { debugBuild: true, authorizationToken: 1 as unknown as string }, false],
    ['production build with valid token', { debugBuild: false, authorizationToken: '1' }, false],
    ['production build with no token', { debugBuild: false }, false],
  ])('%s → %s', (_name, input, expected) => {
    expect(isDiagnosticsAuthorized(input)).toBe(expected);
  });

  it('fails closed when the input is not an object', () => {
    expect(isDiagnosticsAuthorized(null as unknown as { debugBuild: boolean })).toBe(false);
    expect(isDiagnosticsAuthorized(undefined as unknown as { debugBuild: boolean })).toBe(false);
  });

  it('pins the authorization constants to the family startup contract', () => {
    expect(GPU_DIAGNOSTICS_AUTHORIZATION_ENV).toBe('PSYCHE_RENDER_DIAGNOSTICS');
    expect(GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN).toBe('1');
    expect(GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION).toBe(1);
    expect(GPU_DIAGNOSTICS_SURFACE_ID).toBe('gpu-diagnostics');
  });
});

describe('scenario controls are authorization-gated', () => {
  it('exposes no controls for any unauthorized input', () => {
    expect(canControlScenarios({ debugBuild: false, authorizationToken: '1' })).toBe(false);
    expect(canControlScenarios({ debugBuild: true, authorizationToken: null })).toBe(false);
    expect(canControlScenarios({ debugBuild: true, authorizationToken: '' })).toBe(false);
    expect(canControlScenarios({ debugBuild: true, authorizationToken: ' 1 ' })).toBe(false);
    expect(canControlScenarios({ debugBuild: false })).toBe(false);
  });

  it('exposes controls only for the exact authorized combination', () => {
    expect(canControlScenarios(AUTHORIZED)).toBe(true);
  });

  it('uses exactly the same gate as the surface itself', () => {
    const probes = [
      { debugBuild: true, authorizationToken: '1' },
      { debugBuild: true, authorizationToken: '0' },
      { debugBuild: false, authorizationToken: '1' },
      { debugBuild: false },
    ];
    for (const probe of probes) {
      expect(canControlScenarios(probe)).toBe(isDiagnosticsAuthorized(probe));
    }
  });
});

describe('visibleRowsFor renders only present fields', () => {
  it('renders the full catalog in display order for a complete snapshot', () => {
    const rows = visibleRowsFor(buildFullSnapshot());
    expect(rows.map((row) => row.key)).toEqual(CATALOG_ROW_KEYS);
  });

  it('omits absent fields entirely — no placeholder values, no stub rows', () => {
    const rows = visibleRowsFor({
      graphics: { acceleration: 'software', adapter: 'llvmpipe (LLVM 17)' },
      frame: { p95Ms: 40 },
    });
    expect(rows.map((row) => row.key)).toEqual([
      'graphics.acceleration',
      'graphics.adapter',
      'frame.p95Ms',
    ]);
    for (const row of rows) {
      expect(PLACEHOLDER_VALUES).not.toContain(row.value);
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  it('omits an entire group that is absent or not an object', () => {
    const rows = visibleRowsFor({
      graphics: { acceleration: 'unknown' },
      runtime: undefined,
      transport: null as unknown as GpuDiagnosticsSnapshotV1['transport'],
    });
    expect(rows.map((row) => row.group)).toEqual(['graphics']);
  });

  it('omits non-finite numbers instead of serializing them', () => {
    const rows = visibleRowsFor({
      frame: {
        averageMs: Number.NaN,
        p95Ms: Number.POSITIVE_INFINITY,
        maxMs: Number.NEGATIVE_INFINITY,
        droppedEstimated: 7,
      },
      process: { cpuPercent: 5.5, rssMb: Number.NaN },
    });
    expect(rows.map((row) => row.key)).toEqual(['frame.droppedEstimated', 'process.cpuPercent']);
  });

  it('omits empty-string and oversize string values rather than truncating them', () => {
    const oversize = 'x'.repeat(GPU_DIAGNOSTICS_LIMITS.stringValueLength + 1);
    const atLimit = 'y'.repeat(GPU_DIAGNOSTICS_LIMITS.stringValueLength);
    const rows = visibleRowsFor({
      graphics: { backend: oversize, adapter: atLimit },
      runtime: { engine: '', os: 'macOS' },
    });
    expect(rows.map((row) => row.key)).toEqual(['graphics.adapter', 'runtime.os']);
    expect(rows[0].value).toBe(atLimit);
  });

  it('omits empty and oversize marker lists, keeps bounded ones', () => {
    const oversizeEntry = 'x'.repeat(GPU_DIAGNOSTICS_LIMITS.stringListEntryLength + 1);
    expect(visibleRowsFor({ graphics: { softwareMarkers: ['SwiftShader'] } }).map((row) => row.key))
      .toEqual(['graphics.softwareMarkers']);
    expect(visibleRowsFor({ graphics: { softwareMarkers: [] } })).toEqual([]);
    expect(
      visibleRowsFor({
        graphics: {
          softwareMarkers: Array.from(
            { length: GPU_DIAGNOSTICS_LIMITS.stringListEntries + 1 },
            (_unused, index) => `marker-${index}`,
          ),
        },
      }),
    ).toEqual([]);
    expect(visibleRowsFor({ graphics: { softwareMarkers: [oversizeEntry] } })).toEqual([]);
    expect(visibleRowsFor({ graphics: { softwareMarkers: ['a'.repeat(GPU_DIAGNOSTICS_LIMITS.stringListEntryLength)] } }).map((row) => row.key))
      .toEqual(['graphics.softwareMarkers']);
  });

  it('omits out-of-vocabulary acceleration states instead of displaying them', () => {
    const rows = visibleRowsFor({
      graphics: { acceleration: 'gpu-glorious' } as unknown as GpuDiagnosticsSnapshotV1['graphics'],
    });
    expect(rows).toEqual([]);
  });

  it('attaches the correct evidence class to every row', () => {
    const rows = visibleRowsFor(buildFullSnapshot());
    for (const row of rows) {
      expect(GPU_DIAGNOSTICS_EVIDENCE_CLASSES).toContain(row.evidenceClass);
      if (row.group === 'frame') {
        expect(row.evidenceClass).toBe('derived');
      } else if (row.group === 'transport' || row.group === 'process') {
        expect(row.evidenceClass).toBe('measured');
      } else {
        expect(row.evidenceClass).toBe('reported');
      }
    }
  });

  it('formats list values deterministically and numbers without locale drift', () => {
    const rows = visibleRowsFor({
      graphics: { softwareMarkers: ['SwiftShader', 'llvmpipe'] },
      frame: { p95Ms: 22.5 },
    });
    expect(rows[0].value).toBe('SwiftShader, llvmpipe');
    expect(rows[1].value).toBe('22.5');
  });

  it('returns no rows for a non-object snapshot', () => {
    expect(visibleRowsFor(null as unknown as GpuDiagnosticsSnapshotV1)).toEqual([]);
    expect(visibleRowsFor('snapshot' as unknown as GpuDiagnosticsSnapshotV1)).toEqual([]);
  });
});

describe('diagnosticsJson is deterministic and bounded', () => {
  it('produces byte-identical output across repeated calls', () => {
    const snapshot = buildFullSnapshot();
    const first = diagnosticsJson(snapshot);
    const second = diagnosticsJson(snapshot);
    const third = diagnosticsJson(structuredClone(snapshot));
    expect(first).toBe(second);
    expect(first).toBe(third);
  });

  it('produces deep-equal objects across calls regardless of key insertion order', () => {
    const forward = JSON.parse(diagnosticsJson(buildFullSnapshot())) as unknown;
    const shuffled = JSON.parse(
      diagnosticsJson({
        process: { rssMb: 768, cpuPercent: 38.2 },
        frame: { droppedEstimated: 9, maxMs: 61.3, p95Ms: 40.2, averageMs: 28.5 },
        transport: { throughputBytesPerSecond: 2_500_000, ipcMessagesPerSecond: 240, queueHighWater: 12 },
        renderer: { mode: 'canvas' },
        runtime: { arch: 'x86_64', os: 'Linux', engineVersion: '2.44.0', engine: 'WebKitGTK' },
        graphics: {
          supportingProbe: 'webgl2-strict',
          fallbackReason: 'strict context creation failed',
          softwareMarkers: ['llvmpipe'],
          adapter: 'llvmpipe (LLVM 17.0.5)',
          backend: 'Vulkan',
          acceleration: 'software',
        },
      }),
    ) as unknown;
    expect(shuffled).toEqual(forward);
  });

  it('sorts object keys recursively at every level', () => {
    const parsed = JSON.parse(diagnosticsJson(buildFullSnapshot())) as Record<string, unknown>;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        expect(keys).toEqual([...keys].sort());
        for (const key of keys) {
          walk((value as Record<string, unknown>)[key]);
        }
      }
    };
    walk(parsed);
  });

  it('pins the envelope schema version and surface id', () => {
    const parsed = JSON.parse(diagnosticsJson(buildFullSnapshot())) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION);
    expect(parsed.surface).toBe(GPU_DIAGNOSTICS_SURFACE_ID);
  });

  it('serializes raw values — numbers stay numbers, lists stay lists', () => {
    const parsed = JSON.parse(diagnosticsJson(buildFullSnapshot())) as {
      snapshot: Record<string, Record<string, unknown>>;
    };
    expect(parsed.snapshot.frame).toEqual({ averageMs: 28.5, p95Ms: 40.2, maxMs: 61.3, droppedEstimated: 9 });
    expect(parsed.snapshot.graphics).toEqual({
      acceleration: 'software',
      adapter: 'llvmpipe (LLVM 17.0.5)',
      backend: 'Vulkan',
      fallbackReason: 'strict context creation failed',
      softwareMarkers: ['llvmpipe'],
      supportingProbe: 'webgl2-strict',
    });
  });

  it('preserves the observed order of software-marker evidence', () => {
    const parsed = JSON.parse(
      diagnosticsJson({
        graphics: { acceleration: 'software', softwareMarkers: ['llvmpipe', 'SwiftShader'] },
      }),
    ) as { snapshot: { graphics: { softwareMarkers: string[] } } };
    expect(parsed.snapshot.graphics.softwareMarkers).toEqual(['llvmpipe', 'SwiftShader']);
  });

  it('records unknown keys by name only and never serializes their values', () => {
    const secret = 'super-secret-env-dump-value';
    const json = diagnosticsJson({
      graphics: { acceleration: 'accelerated', untrustedField: secret } as GpuDiagnosticsSnapshotV1['graphics'],
      notAGroup: { anything: secret },
    } as GpuDiagnosticsSnapshotV1);
    const parsed = JSON.parse(json) as { omittedKeys: string[] };
    expect(parsed.omittedKeys).toEqual(['graphics.untrustedField', 'notAGroup.anything']);
    expect(json).not.toContain(secret);
  });

  it('records a non-object unknown group by its own name', () => {
    const manifests = omissionManifestsFor({
      notAGroup: 'garbage',
    } as unknown as GpuDiagnosticsSnapshotV1);
    expect(manifests.omittedKeys).toEqual(['notAGroup']);
  });

  it('records unpresentable catalogued values by name only in invalidKeys', () => {
    const oversize = 'x'.repeat(GPU_DIAGNOSTICS_LIMITS.stringValueLength + 1);
    const parsed = JSON.parse(
      diagnosticsJson({
        graphics: { acceleration: 'accelerated', adapter: oversize },
        frame: { p95Ms: Number.NaN, maxMs: 40 },
      }),
    ) as { invalidKeys: string[]; snapshot: Record<string, Record<string, unknown>> };
    expect(parsed.invalidKeys).toEqual(['frame.p95Ms', 'graphics.adapter']);
    expect(parsed.snapshot.frame).toEqual({ maxMs: 40 });
    expect(parsed.snapshot.graphics).toEqual({ acceleration: 'accelerated' });
  });

  it('omits groups with no presentable field instead of emitting empty objects', () => {
    const parsed = JSON.parse(
      diagnosticsJson({
        graphics: { acceleration: 'accelerated' },
        runtime: { engine: Number.NaN } as unknown as GpuDiagnosticsSnapshotV1['runtime'],
        frame: { p95Ms: undefined },
      }),
    ) as { snapshot: Record<string, unknown> };
    expect(Object.keys(parsed.snapshot)).toEqual(['graphics']);
  });

  it('caps the omission manifests at the documented limits', () => {
    const bigUnknown: Record<string, unknown> = {};
    for (let index = 0; index < GPU_DIAGNOSTICS_LIMITS.omittedKeys + 10; index += 1) {
      bigUnknown[`field${String(index).padStart(3, '0')}`] = index;
    }
    const manifests = omissionManifestsFor({
      notAGroup: bigUnknown,
    } as unknown as GpuDiagnosticsSnapshotV1);
    expect(manifests.omittedKeys).toHaveLength(GPU_DIAGNOSTICS_LIMITS.omittedKeys);
    expect(manifests.omittedKeys).toEqual([...manifests.omittedKeys].sort());
  });
});

describe('copyForA11y status text', () => {
  it('leads with a prominent software-fallback sentence', () => {
    const copy = copyForA11y({
      graphics: {
        acceleration: 'software',
        backend: 'Vulkan',
        softwareMarkers: ['SwiftShader'],
        fallbackReason: 'strict context creation failed',
      },
    });
    expect(copy.startsWith('SOFTWARE FALLBACK:')).toBe(true);
    expect(copy).toContain('not hardware acceleration');
    expect(copy).toContain('Fallback reason: strict context creation failed.');
  });

  it('never leads with fallback language when acceleration is hardware', () => {
    const copy = copyForA11y({ graphics: { acceleration: 'accelerated', backend: 'Metal' } });
    expect(copy.startsWith('Hardware graphics acceleration active.')).toBe(true);
    expect(copy).not.toContain('SOFTWARE FALLBACK');
  });

  it('states unknown and unavailable acceleration honestly', () => {
    expect(copyForA11y({ graphics: { acceleration: 'unknown' } }).startsWith(
      'Graphics acceleration state unknown.',
    )).toBe(true);
    expect(copyForA11y({ graphics: { acceleration: 'unavailable' } }).startsWith(
      'Graphics acceleration evidence unavailable.',
    )).toBe(true);
    expect(copyForA11y({ runtime: { engine: 'WKWebView' } }).startsWith(
      'Graphics acceleration evidence unavailable.',
    )).toBe(true);
  });

  it('lists only present fields and omits the absent ones', () => {
    const copy = copyForA11y({
      graphics: { acceleration: 'software' },
      frame: { p95Ms: 40 },
    });
    expect(copy).toContain('Acceleration: software');
    expect(copy).toContain('p95 frame time (ms): 40');
    expect(copy).not.toContain('Adapter');
    expect(copy).not.toContain('PTY');
  });

  it('describes scenario-control availability per authorization', () => {
    const snapshot = buildFullSnapshot();
    expect(copyForA11y(snapshot, { scenarioControlsAuthorized: true })).toContain(
      'Rendering scenario controls: available; start, progress, and cancel are authorized.',
    );
    expect(copyForA11y(snapshot, { scenarioControlsAuthorized: false })).toContain(
      'Rendering scenario controls: not available without diagnostics authorization.',
    );
    expect(copyForA11y(snapshot)).toContain(
      'Rendering scenario controls: not available without diagnostics authorization.',
    );
  });

  it('counts omissions explicitly instead of filling placeholders', () => {
    const copy = copyForA11y({
      graphics: { acceleration: 'software', adapter: 'x'.repeat(GPU_DIAGNOSTICS_LIMITS.stringValueLength + 1) },
      transport: { queueHighWater: 4, ipcMessagesPerSecond: Number.POSITIVE_INFINITY },
      frame: { p95Ms: Number.NaN },
    });
    expect(copy).toContain(
      '3 fields are unavailable or unsupported and omitted rather than shown as placeholders.',
    );
  });

  it('says when nothing is present and uses the singular for one field', () => {
    expect(copyForA11y({})).toContain('No diagnostic fields are present to display.');
    const single = copyForA11y({ graphics: { acceleration: 'accelerated' } });
    expect(single).toContain('Diagnostics (1 field): Acceleration: accelerated.');
    expect(single).not.toContain('unavailable or unsupported');
  });

  it('keeps the acceleration vocabulary aligned with the GPU family', () => {
    expect([...GPU_DIAGNOSTICS_ACCELERATION_STATES]).toEqual([
      'accelerated',
      'software',
      'unknown',
      'unavailable',
    ]);
  });
});

describe('transition allowlist (Slice 3 compositor contract)', () => {
  it('pins the allowlist to exactly transform and opacity', () => {
    expect([...GPU_DIAGNOSTICS_TRANSITION_PROPERTIES]).toEqual(['transform', 'opacity']);
  });

  it('accepts the compositor-safe properties in any case and whitespace', () => {
    expect(filterDiagnosticTransitionProperties(['transform', ' opacity ', 'TRANSFORM'])).toEqual({
      allowed: ['transform', 'opacity'],
      rejected: ['transform'],
    });
    expect(isAllowedDiagnosticTransitionProperty('Opacity')).toBe(true);
  });

  it('rejects every other property class, including the implicit all', () => {
    const filter = filterDiagnosticTransitionProperties([
      'all',
      'color',
      'width',
      'height',
      'margin-top',
      'padding',
      'background',
      'background-color',
      'border-color',
      'box-shadow',
      'filter',
      'left',
      'top',
      'font-size',
      'display',
      'visibility',
    ]);
    expect(filter.allowed).toEqual([]);
    expect(filter.rejected).toHaveLength(16);
  });

  it('partitions a mixed list without mutating the input', () => {
    const input = ['transform', 'color', 'opacity', 'box-shadow'];
    const filter = filterDiagnosticTransitionProperties(input);
    expect(filter.allowed).toEqual(['transform', 'opacity']);
    expect(filter.rejected).toEqual(['color', 'box-shadow']);
    expect(input).toEqual(['transform', 'color', 'opacity', 'box-shadow']);
  });

  it('rejects non-string entries and empty strings', () => {
    const filter = filterDiagnosticTransitionProperties([
      '',
      '   ',
      null as unknown as string,
      120 as unknown as string,
    ]);
    expect(filter.allowed).toEqual([]);
    expect(filter.rejected).toHaveLength(4);
  });
});

describe('field catalog integrity', () => {
  it('has unique dotted keys and unique labels across all groups', () => {
    const keys = GPU_DIAGNOSTICS_FIELDS.map((field) => `${field.group}.${field.key}`);
    const labels = GPU_DIAGNOSTICS_FIELDS.map((field) => field.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('covers exactly the six documented groups in display order', () => {
    expect([...GPU_DIAGNOSTICS_GROUPS]).toEqual([
      'graphics',
      'runtime',
      'renderer',
      'transport',
      'frame',
      'process',
    ]);
    const groups = new Set(GPU_DIAGNOSTICS_FIELDS.map((field) => field.group));
    expect([...groups]).toEqual([...GPU_DIAGNOSTICS_GROUPS]);
  });
});

describe('diagnostics surface documentation contract', () => {
  it('keeps the contract document aligned with the module', () => {
    for (const phrase of [
      'isDiagnosticsAuthorized',
      'visibleRowsFor',
      'diagnosticsJson',
      'copyForA11y',
      'canControlScenarios',
      'PSYCHE_RENDER_DIAGNOSTICS',
      'omitted',
      'placeholder',
      'transform',
      'opacity',
      'startup graphics logging',
      'capability',
      'CSP',
      'software fallback',
    ]) {
      expect(contractDoc).toContain(phrase);
    }
  });
});
