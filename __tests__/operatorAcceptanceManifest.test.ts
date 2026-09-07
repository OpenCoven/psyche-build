import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateOperatorAcceptanceManifest } from '../scripts/validate-operator-acceptance.mjs';

const templatePath = 'docs/templates/operator-acceptance-v0.0.2.json';

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
      filename: 'Psyche-Build-v0.0.2-x86_64.dmg',
      sha256: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
      architecture: 'x86_64',
    };

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'packagedRuntime.sha256 does not match the published v0.0.2 DMG',
    );

    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.2-aarch64.dmg',
      sha256: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
      architecture: 'aarch64',
    };
    manifest.release.sourceSha = '093b4dbd8ca5732deb312659a8ea7c371a6430ed';

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'release.sourceSha must identify the published v0.0.2 subject',
    );
  });

  it('rejects unknown consequential outcomes even while incomplete', async () => {
    const manifest = await template();
    manifest.observations[6].status = 'unknown';

    expect(validateOperatorAcceptanceManifest(manifest)).toContain(
      'unknown consequential outcome cannot support handoff: force-quit-transition',
    );
  });

  it('does not let deferred or undigested evidence claim completion', async () => {
    const manifest = await template();
    manifest.terminalState = 'complete';
    manifest.sourceSmoke.status = 'succeeded';
    manifest.sourceSmoke.commandExitStatus = 0;
    manifest.sourceSmoke.evidenceDigests = ['a'.repeat(64)];
    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.2-aarch64.dmg',
      sha256: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
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
    manifest.sourceSmoke.evidenceDigests = ['a'.repeat(64)];
    manifest.packagedRuntime = {
      subject: 'published_dmg',
      filename: 'Psyche-Build-v0.0.2-aarch64.dmg',
      sha256: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
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
});
