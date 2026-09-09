import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateOperatorAcceptanceManifest } from '../scripts/validate-operator-acceptance.mjs';

const templatePath = 'docs/templates/operator-acceptance-v0.0.1.json';

async function template(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(templatePath, 'utf8')) as Record<string, any>;
}

describe('operator acceptance manifest', () => {
  it('accepts the pinned incomplete execution template', async () => {
    expect(validateOperatorAcceptanceManifest(await template())).toEqual([]);
  });

  it('keeps exact source and packaged artifact identities pinned', async () => {
    const manifest = await template();
    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.1-x86_64.dmg',
      sha256: 'e0c8cce02cedc7b7cc122c4b453da8ccc665f42da457aa571c2c476d3f03c74f',
      architecture: 'x86_64',
    };

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'packagedRuntime.sha256 does not match the published v0.0.1 DMG',
    );

    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.1-aarch64.dmg',
      sha256: 'e0c8cce02cedc7b7cc122c4b453da8ccc665f42da457aa571c2c476d3f03c74f',
      architecture: 'aarch64',
    };
    manifest.release.sourceSha = '093b4dbd8ca5732deb312659a8ea7c371a6430ed';

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'release.sourceSha must identify the published v0.0.1 subject',
    );
  });

  it('rejects unknown consequential outcomes even while incomplete', async () => {
    const manifest = await template();
    manifest.observations[6].status = 'unknown';

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'unknown consequential outcome cannot support handoff: force-quit-transition',
    );
  });

  it('returns validation errors instead of throwing for malformed nested input', async () => {
    const manifest = await template();
    manifest.observations[0] = null;
    manifest.sourceSmoke = null;
    manifest.operator = null;
    manifest.sanitization = null;
    manifest.terminalState = 'complete';

    expect(() =>
      validateOperatorAcceptanceManifest(manifest, { requireComplete: true }),
    ).not.toThrow();
    expect(validateOperatorAcceptanceManifest(manifest, { requireComplete: true })).toEqual(
      expect.arrayContaining([
        'observations[0] must be an object',
        'sourceSmoke must be an object',
        'operator must be an object',
        'sanitization must be an object',
        'complete manifest requires successful exact-source smoke',
        'complete manifest requires the operator identity and observation time',
        'complete manifest requires a named sanitization review',
      ]),
    );
  });

  it('does not let deferred or undigested evidence claim completion', async () => {
    const manifest = await template();
    manifest.terminalState = 'complete';
    manifest.sourceSmoke.status = 'succeeded';
    manifest.sourceSmoke.commandExitStatus = 1;
    manifest.sourceSmoke.evidenceDigests = ['a'.repeat(64)];
    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.1-aarch64.dmg',
      sha256: 'e0c8cce02cedc7b7cc122c4b453da8ccc665f42da457aa571c2c476d3f03c74f',
      architecture: 'aarch64',
    };
    manifest.operator = {
      githubLogin: 'operator',
      observedAt: '2026-09-07T00:00:00Z',
    };
    manifest.sanitization = {
      reviewed: true,
      reviewerGitHubLogin: 'verifier',
      evidenceDigestCountBefore: 15,
      newEvidenceDigests: ['b'.repeat(64)],
    };

    const errors = validateOperatorAcceptanceManifest(manifest, { requireComplete: true });
    expect(errors).toContain('sourceSmoke.commandExitStatus must be 0 when succeeded');
    expect(errors).toContain('sourceSmoke.environment.macOS is required when succeeded');
    expect(errors).toContain(
      'complete manifest cannot contain deferred: corrupt-persisted-state',
    );
    expect(errors).toContain(
      'complete manifest requires expectationMet=true: corrupt-persisted-state',
    );
  });

  it('accepts a complete manifest only with terminal, expectation-matched evidence', async () => {
    const manifest = await template();
    manifest.terminalState = 'complete';
    manifest.sourceSmoke.status = 'succeeded';
    manifest.sourceSmoke.commandExitStatus = 0;
    manifest.sourceSmoke.environment = {
      macOS: '15.6',
      architecture: 'aarch64',
      node: '22.19.0',
      pnpm: '10.34.5',
      tmux: '3.5a',
      git: '2.51.0',
    };
    manifest.sourceSmoke.evidenceDigests = ['a'.repeat(64)];
    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.1-aarch64.dmg',
      sha256: 'e0c8cce02cedc7b7cc122c4b453da8ccc665f42da457aa571c2c476d3f03c74f',
      architecture: 'aarch64',
    };
    manifest.observations = manifest.observations.map(
      (observation: Record<string, any>, index: number) => ({
        ...observation,
        status: 'succeeded',
        expectationMet: true,
        workPreserved: true,
        safeNextAction: null,
        evidenceDigests: [(index + 1).toString(16).padStart(64, '0')],
      }),
    );
    manifest.observations[0] = {
      ...manifest.observations[0],
      status: 'inapplicable',
      safeNextAction: null,
      workPreserved: null,
    };
    expect(
      validateOperatorAcceptanceManifest(manifest, { requireComplete: true }),
    ).toContain(
      'observations[0].safeNextAction is required for inapplicable observations',
    );
    expect(
      validateOperatorAcceptanceManifest(manifest, { requireComplete: true }),
    ).toContain('observations[0].inapplicable is only supported for supported-agent-lane');
    manifest.observations[0] = {
      ...manifest.observations[0],
      status: 'succeeded',
      workPreserved: true,
      safeNextAction: null,
    };
    manifest.observations[2] = {
      ...manifest.observations[2],
      status: 'inapplicable',
      safeNextAction: 'Supported agent CLI unavailable',
      workPreserved: null,
    };
    manifest.operator = {
      githubLogin: 'operator',
      observedAt: '2026-09-07T00:00:00Z',
    };
    manifest.sanitization = {
      reviewed: true,
      reviewerGitHubLogin: 'verifier',
      evidenceDigestCountBefore: 15,
      newEvidenceDigests: ['f'.repeat(64)],
    };

    expect(
      validateOperatorAcceptanceManifest(manifest, { requireComplete: true }),
    ).toEqual([]);
  });

  it('requires a string ISO timestamp and complete smoke environment', async () => {
    const manifest = await template();
    manifest.operator.observedAt = 1;
    manifest.sourceSmoke.status = 'succeeded';
    manifest.sourceSmoke.commandExitStatus = 0;
    manifest.sourceSmoke.evidenceDigests = ['a'.repeat(64)];

    const errors = validateOperatorAcceptanceManifest(manifest);
    expect(errors).toContain('operator.observedAt must be an ISO-8601 timestamp');
    expect(errors).toContain('sourceSmoke.environment.macOS is required when succeeded');
    expect(errors).toContain('sourceSmoke.environment.architecture is required when succeeded');
    expect(errors).toContain('sourceSmoke.environment.node is required when succeeded');
    expect(errors).toContain('sourceSmoke.environment.tmux is required when succeeded');
    expect(errors).toContain('sourceSmoke.environment.git is required when succeeded');
  });
});
