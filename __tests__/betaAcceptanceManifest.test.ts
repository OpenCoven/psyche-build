import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BETA_ACCEPTANCE_ROWS,
  BETA_AGENT_IDS,
  BETA_AGENTS_WITH_PROMPT_IN_ARGV,
  validateBetaAcceptanceManifest,
} from '../scripts/validate-beta-acceptance.mjs';
import { validateOperatorAcceptanceManifest } from '../scripts/validate-operator-acceptance.mjs';
import { AGENT_IDS, promptReachesAgentArgv } from '../src/utils/agentLaunch.js';

// #555: the beta acceptance pass records G1-G4 on one packaged, untagged
// release candidate. These cases hold the manifest contract. Every identity
// below is a fixed fixture, not a real candidate, and no case observes a build.

const templatePath = 'docs/templates/beta-acceptance-candidate.json';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ID = 'rc-0123456789ab';
const VERSION = '0.0.3';
const ARM = `Psyche-Build-v${VERSION}-${ID}-aarch64.dmg`;
const INTEL = `Psyche-Build-v${VERSION}-${ID}-x86_64.dmg`;
const digest = (seed: string) => createHash('sha256').update(seed).digest('hex');

type Manifest = Record<string, any>;

async function template(): Promise<Manifest> {
  return JSON.parse(await readFile(templatePath, 'utf8')) as Manifest;
}

function sha256sums(): string {
  return `${digest('arm')}  ${ARM}\n${digest('intel')}  ${INTEL}\n`;
}

function provenance(): Manifest {
  const build = (arch: string, file: string, seed: string) => ({
    arch,
    candidateSha: SHA,
    candidateId: ID,
    version: VERSION,
    artifact: { file, sha256: digest(seed), bytes: 1 },
    signing: { codesign: 'verified', notarization: 'accepted', stapled: true, gatekeeper: 'accepted' },
  });
  return {
    schema: 'psyche-build.release-candidate-provenance.v1',
    candidate: { id: ID, sha: SHA, embeddedVersion: VERSION, intendedReleaseTag: `v${VERSION}` },
    publication: {
      tagCreated: false,
      releaseCreated: false,
      testflightUploaded: false,
      homebrewNotified: false,
    },
    checksums: 'SHA256SUMS',
    builds: [build('aarch64', ARM, 'arm'), build('x86_64', INTEL, 'intel')],
  };
}

/** The template with a candidate identified and a host declared; every row still pending. */
async function identified(): Promise<Manifest> {
  const manifest = await template();
  manifest.candidate = {
    id: ID,
    sha: SHA,
    version: VERSION,
    provenanceSha256: digest(JSON.stringify(provenance())),
    sha256sumsSha256: digest(sha256sums()),
  };
  manifest.artifacts = [
    { architecture: 'aarch64', filename: ARM, sha256: digest('arm') },
    { architecture: 'x86_64', filename: INTEL, sha256: digest('intel') },
  ];
  manifest.host = { macOS: '15.6', architecture: 'arm64', machineClass: 'MacBook Pro (Apple Silicon)' };
  manifest.upgradeBaseline.filename = 'Psyche-Build-v0.0.2-aarch64.dmg';
  manifest.upgradeBaseline.sha256 = digest('v0.0.2 arm');
  return manifest;
}

function succeed(row: Manifest) {
  row.outcome = 'succeeded';
  row.evidenceDigests = [digest(row.id)];
  if (/^G[34]\./.test(row.id)) row.workPreserved = true;
  if (row.id === 'G2.4') row.agent = { id: 'cline', version: '1.0.0', promptInArgv: false };
}

/** Every row observed and succeeded, signed off, and marked accepted. */
async function accepted(): Promise<Manifest> {
  const manifest = await identified();
  for (const row of manifest.rows) succeed(row);
  manifest.operator = { githubLogin: 'operator', observedAt: '2026-11-20T00:00:00Z' };
  manifest.sanitization = { reviewed: true, reviewerGitHubLogin: 'reviewer', omissions: [] };
  manifest.terminalState = 'accepted';
  return manifest;
}

const row = (manifest: Manifest, id: string) => manifest.rows.find((entry: Manifest) => entry.id === id);

describe('beta acceptance manifest', () => {
  it('ships a template whose only errors are the identity an operator must fill in', async () => {
    const errors = validateBetaAcceptanceManifest(await template());

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toMatch(/^(candidate|artifacts|host|upgradeBaseline)\b/);
    }
    expect((await template()).rows.map((entry: Manifest) => entry.id)).toEqual(
      BETA_ACCEPTANCE_ROWS.map((entry) => entry.id),
    );
    expect((await template()).rows.every((entry: Manifest) => entry.outcome === 'pending')).toBe(true);
  });

  it('has the 25 rows of the #555 case ledger, grouped by gate', () => {
    const count = (gate: string) => BETA_ACCEPTANCE_ROWS.filter((entry) => entry.gate === gate).length;

    expect(BETA_ACCEPTANCE_ROWS).toHaveLength(25);
    expect([count('G1'), count('G2'), count('G3'), count('G4')]).toEqual([6, 9, 6, 4]);
    expect(new Set(BETA_ACCEPTANCE_ROWS.map((entry) => entry.id)).size).toBe(25);
    for (const entry of BETA_ACCEPTANCE_ROWS) expect(entry.id.startsWith(`${entry.gate}.`)).toBe(true);
  });

  it('accepts an identified manifest as incomplete, and a fully succeeded one as accepted', async () => {
    expect(validateBetaAcceptanceManifest(await identified())).toEqual([]);
    expect(
      validateBetaAcceptanceManifest(await accepted(), { requireComplete: true, requireAccepted: true }),
    ).toEqual([]);
  });

  it('ties the candidate id, version and artifact names to the exact source SHA', async () => {
    const cases: Array<[(manifest: Manifest) => void, RegExp]> = [
      [(m) => (m.candidate.sha = SHA.slice(0, 12)), /candidate\.sha must be a full 40-character/],
      [(m) => (m.candidate.id = 'rc-ffffffffffff'), /candidate\.id must be rc- followed by the first 12/],
      [(m) => (m.candidate.version = '0.0.3-rc.1'), /candidate\.version must be a final MAJOR\.MINOR\.PATCH/],
      [(m) => (m.candidate.version = 'v0.0.3'), /candidate\.version must be a final MAJOR\.MINOR\.PATCH/],
      [(m) => (m.artifacts[0].filename = 'Psyche-Build-v0.0.3-aarch64.dmg'), /artifacts\[0\]\.filename must be/],
      [(m) => (m.artifacts[1].sha256 = 'not-a-digest'), /artifacts\[1\]\.sha256 must be a SHA-256/],
      [(m) => m.artifacts.pop(), /artifacts is missing x86_64/],
      [(m) => (m.artifacts[1].architecture = 'aarch64'), /artifacts\[1\]\.architecture is duplicated/],
      [(m) => (m.candidate.provenanceSha256 = null), /candidate\.provenanceSha256 must be a SHA-256/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await identified();
      mutate(manifest);
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }
  });

  it('refuses any tag identity: acceptance creates no tag', async () => {
    for (const key of ['tag', 'tagObjectSha', 'intendedReleaseTag']) {
      const manifest = await identified();
      manifest.candidate[key] = 'v0.0.3';
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toContain(
        `candidate must not name a tag (${key})`,
      );
    }
    const manifest = await identified();
    manifest.tag = 'v0.0.3';
    expect(validateBetaAcceptanceManifest(manifest).join('\n')).toContain(
      'manifest contains unsupported field tag',
    );
  });

  it('requires the host to match one candidate artifact and the upgrade baseline', async () => {
    const cases: Array<[(manifest: Manifest) => void, RegExp]> = [
      [(m) => (m.host.architecture = 'riscv'), /host\.architecture must be aarch64, arm64, x86_64, or x64/],
      [(m) => (m.host.macOS = ''), /host\.macOS is required/],
      [(m) => (m.upgradeBaseline.filename = 'Psyche-Build-v0.0.2-x86_64.dmg'), /upgradeBaseline\.filename must be Psyche-Build-v0\.0\.2-aarch64\.dmg/],
      [(m) => (m.upgradeBaseline.version = '0.0.1'), /upgradeBaseline\.version must be 0\.0\.2/],
      [(m) => (m.upgradeBaseline.sourceSha = SHA), /upgradeBaseline\.sourceSha must identify the published v0\.0\.2 source/],
      [(m) => (m.upgradeBaseline.sha256 = null), /upgradeBaseline\.sha256 must be a SHA-256/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await identified();
      mutate(manifest);
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }
  });

  it('requires exactly the ledger rows, once each', async () => {
    const missing = await identified();
    missing.rows = missing.rows.filter((entry: Manifest) => entry.id !== 'G3.4');
    expect(validateBetaAcceptanceManifest(missing).join('\n')).toContain('rows is missing G3.4');

    const duplicated = await identified();
    duplicated.rows.push({ ...row(duplicated, 'G1.1') });
    expect(validateBetaAcceptanceManifest(duplicated).join('\n')).toMatch(/rows\[25\]\.id is duplicated/);

    const unknown = await identified();
    row(unknown, 'G1.1').id = 'G9.9';
    expect(validateBetaAcceptanceManifest(unknown).join('\n')).toMatch(/rows\[0\]\.id is unsupported/);
  });

  it('never lets a row pass without an observation', async () => {
    const cases: Array<[(entry: Manifest) => void, RegExp]> = [
      [(r) => (r.outcome = 'passed'), /outcome is unsupported/],
      [(r) => (r.outcome = 'succeeded'), /evidenceDigests must contain retained evidence/],
      [(r) => Object.assign(r, { outcome: 'succeeded', evidenceDigests: ['short'] }), /non-SHA-256 digest/],
      [(r) => Object.assign(r, { outcome: 'gap' }), /gapReason is required for a gap/],
      [(r) => Object.assign(r, { outcome: 'succeeded', evidenceDigests: [digest('x')], gapReason: 'not run' }), /gapReason is only allowed for a gap/],
      [(r) => Object.assign(r, { outcome: 'pending', evidenceDigests: [digest('x')] }), /pending row must not carry evidence/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await identified();
      mutate(row(manifest, 'G1.2'));
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }
  });

  it('requires a failure to say whether the message was actionable and what to do next', async () => {
    const failed = (extra: Manifest) => ({
      outcome: 'failed',
      evidenceDigests: [digest('x')],
      messageClass: 'actionable',
      safeNextAction: 'Reinstall the agent and retry the launch.',
      workPreserved: true,
      ...extra,
    });
    const cases: Array<[Manifest, RegExp]> = [
      [failed({ messageClass: null }), /messageClass must be actionable, not_actionable, or none_shown/],
      [failed({ messageClass: 'the raw error text' }), /messageClass must be actionable, not_actionable, or none_shown/],
      [failed({ safeNextAction: ' ' }), /safeNextAction is required for failed or recovery_required/],
      [failed({ workPreserved: null }), /workPreserved must be true or false for failed or recovery_required/],
      [{ ...failed({}), outcome: 'recovery_required', safeNextAction: null }, /safeNextAction is required/],
      [{ ...failed({}), outcome: 'succeeded' }, /messageClass is only allowed for a failed row/],
    ];
    for (const [fields, expected] of cases) {
      const manifest = await identified();
      Object.assign(row(manifest, 'G3.1'), fields);
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }

    const ok = await identified();
    Object.assign(row(ok, 'G3.1'), failed({}));
    expect(validateBetaAcceptanceManifest(ok)).toEqual([]);
  });

  it('does not count a failure-path or upgrade row as succeeded unless work was preserved', async () => {
    for (const id of ['G3.3', 'G3.6', 'G4.2', 'G4.4']) {
      const manifest = await identified();
      Object.assign(row(manifest, id), { outcome: 'succeeded', evidenceDigests: [digest(id)], workPreserved: false });
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(
        /workPreserved must be true for a succeeded failure-path or upgrade row/,
      );
    }
  });

  it('records which agent was launched and agrees with the published prompt exposure', async () => {
    const launch = (agent: unknown) => ({ outcome: 'succeeded', evidenceDigests: [digest('agent')], agent });
    const cases: Array<[unknown, RegExp]> = [
      [null, /agent is required when the launch was observed/],
      [{ id: 'not-an-agent', version: null, promptInArgv: false }, /agent\.id must be a registry agent/],
      [{ id: 'claude', version: null, promptInArgv: false }, /agent\.promptInArgv must be true for claude/],
      [{ id: 'cline', version: null, promptInArgv: true }, /agent\.promptInArgv must be false for cline/],
    ];
    for (const [agent, expected] of cases) {
      const manifest = await identified();
      Object.assign(row(manifest, 'G2.4'), launch(agent));
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }

    const other = await identified();
    row(other, 'G2.3').agent = { id: 'cline', version: null, promptInArgv: false };
    expect(validateBetaAcceptanceManifest(other).join('\n')).toMatch(/rows\[\d+\] contains unsupported field agent/);
  });

  it('keeps the agent list and the exposed set equal to the registry', () => {
    expect([...BETA_AGENT_IDS]).toEqual([...AGENT_IDS]);
    expect([...BETA_AGENTS_WITH_PROMPT_IN_ARGV]).toEqual(AGENT_IDS.filter(promptReachesAgentArgv));
  });

  it('refuses personal paths and unbounded text in retained fields', async () => {
    const cases: Array<[(manifest: Manifest) => void, RegExp]> = [
      [(m) => Object.assign(row(m, 'G1.1'), { outcome: 'gap', gapReason: 'see /Users/someone/Library/logs' }), /gapReason must not contain a personal path/],
      [(m) => Object.assign(row(m, 'G1.1'), { outcome: 'gap', gapReason: 'kept in ~/notes' }), /gapReason must not contain a personal path/],
      [(m) => Object.assign(row(m, 'G1.1'), { outcome: 'gap', gapReason: 'x'.repeat(281) }), /gapReason must be one line of at most 280 characters/],
      [(m) => Object.assign(row(m, 'G1.1'), { outcome: 'gap', gapReason: 'line one\nline two' }), /gapReason must be one line/],
      [(m) => (m.host.machineClass = 'C:\\Users\\someone'), /host\.machineClass must not contain a personal path/],
      [(m) => (m.sanitization.omissions = ['raw log at /home/someone/out.txt']), /sanitization\.omissions\[0\] must not contain a personal path/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await identified();
      mutate(manifest);
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }
  });

  it('accepts only when every row succeeded, and never treats a gap as a pass', async () => {
    for (const outcome of ['gap', 'failed', 'recovery_required', 'pending']) {
      const manifest = await accepted();
      const target = row(manifest, 'G3.2');
      Object.assign(target, {
        outcome,
        evidenceDigests: outcome === 'pending' || outcome === 'gap' ? [] : [digest('x')],
        gapReason: outcome === 'gap' ? 'The interruption could not be staged on this host.' : null,
        messageClass: outcome === 'failed' ? 'actionable' : null,
        safeNextAction: outcome === 'failed' || outcome === 'recovery_required' ? 'Run the recovery view.' : null,
        workPreserved: outcome === 'failed' || outcome === 'recovery_required' ? true : null,
      });
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toContain(
        `accepted manifest requires every row succeeded: G3.2 is ${outcome}`,
      );
    }
  });

  it('records a finished pass that was not accepted as its own terminal state', async () => {
    const manifest = await accepted();
    Object.assign(row(manifest, 'G4.3'), {
      outcome: 'gap',
      evidenceDigests: [],
      workPreserved: null,
      gapReason: 'No v0.0.2 installer was available on this host.',
    });
    manifest.terminalState = 'not_accepted';
    expect(validateBetaAcceptanceManifest(manifest, { requireComplete: true })).toEqual([]);
    expect(validateBetaAcceptanceManifest(manifest, { requireAccepted: true }).join('\n')).toContain(
      'terminalState is not accepted',
    );

    const pending = await accepted();
    Object.assign(row(pending, 'G4.3'), { outcome: 'pending', evidenceDigests: [], workPreserved: null });
    pending.terminalState = 'not_accepted';
    expect(validateBetaAcceptanceManifest(pending).join('\n')).toContain(
      'not_accepted manifest cannot contain a pending row: G4.3',
    );

    const allGood = await accepted();
    allGood.terminalState = 'not_accepted';
    expect(validateBetaAcceptanceManifest(allGood).join('\n')).toContain(
      'not_accepted manifest requires at least one row that did not succeed',
    );

    expect(validateBetaAcceptanceManifest(await identified(), { requireComplete: true }).join('\n')).toContain(
      'terminalState is incomplete',
    );
  });

  it('requires a named operator and a named sanitization review before a terminal state', async () => {
    const cases: Array<[(manifest: Manifest) => void, RegExp]> = [
      [(m) => (m.operator.githubLogin = null), /terminal manifest requires the operator identity and observation time/],
      [(m) => (m.operator.observedAt = 'yesterday'), /operator\.observedAt must be an ISO-8601 timestamp/],
      [(m) => (m.sanitization.reviewed = false), /terminal manifest requires a named sanitization review/],
      [(m) => (m.sanitization.reviewerGitHubLogin = ''), /terminal manifest requires a named sanitization review/],
      [(m) => (m.sanitization.omissions = 'none'), /sanitization\.omissions must be an array/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await accepted();
      mutate(manifest);
      expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
    }
  });

  it('accepts only a GitHub login, or null, where a person is named', async () => {
    const cases: Array<[(manifest: Manifest) => void, RegExp]> = [
      [(m) => (m.operator.githubLogin = 'see /Users/someone/notes'), /operator\.githubLogin must be a GitHub login or null/],
      [(m) => (m.operator.githubLogin = 'two words'), /operator\.githubLogin must be a GitHub login or null/],
      [(m) => (m.operator.githubLogin = 42), /operator\.githubLogin must be a GitHub login or null/],
      [(m) => (m.operator.githubLogin = 'a'.repeat(40)), /operator\.githubLogin must be a GitHub login or null/],
      [(m) => (m.sanitization.reviewerGitHubLogin = '-leading'), /sanitization\.reviewerGitHubLogin must be a GitHub login or null/],
      [(m) => (m.sanitization.reviewed = 'yes'), /sanitization\.reviewed must be true or false/],
    ];
    // The rule holds before a terminal state too: an incomplete manifest is retained evidence.
    for (const base of [identified, accepted]) {
      for (const [mutate, expected] of cases) {
        const manifest = await base();
        mutate(manifest);
        expect(validateBetaAcceptanceManifest(manifest).join('\n')).toMatch(expected);
      }
    }

    const hyphenated = await accepted();
    hyphenated.operator.githubLogin = 'octo-cat-9';
    expect(validateBetaAcceptanceManifest(hyphenated)).toEqual([]);
  });

  it('cross-checks the manifest against the candidate provenance and checksum files', async () => {
    const files = () => ({ provenanceText: JSON.stringify(provenance()), sha256sumsText: sha256sums() });
    expect(validateBetaAcceptanceManifest(await accepted(), files())).toEqual([]);

    const cases: Array<[(manifest: Manifest, given: ReturnType<typeof files>) => void, RegExp]> = [
      [(m) => (m.artifacts[0].sha256 = digest('other')), /artifacts\[0\]\.sha256 does not match SHA256SUMS/],
      [(m) => (m.candidate.provenanceSha256 = digest('other')), /candidate\.provenanceSha256 does not match the provenance file/],
      [(m) => (m.candidate.sha256sumsSha256 = digest('other')), /candidate\.sha256sumsSha256 does not match the SHA256SUMS file/],
      [(_m, g) => (g.sha256sumsText = `${digest('arm')}  ${ARM}\n`), /SHA256SUMS has no entry for/],
      [(_m, g) => (g.provenanceText = 'not json'), /provenance file is not valid JSON/],
    ];
    for (const [mutate, expected] of cases) {
      const manifest = await accepted();
      const given = files();
      mutate(manifest, given);
      expect(validateBetaAcceptanceManifest(manifest, given).join('\n')).toMatch(expected);
    }

    const tamper: Array<[(record: Manifest) => void, RegExp]> = [
      [(p) => (p.schema = 'something-else'), /provenance schema must be psyche-build\.release-candidate-provenance\.v1/],
      [(p) => (p.candidate.sha = 'f'.repeat(40)), /provenance candidate does not match the manifest/],
      [(p) => (p.publication.tagCreated = true), /provenance records a publication \(tagCreated\)/],
      [(p) => (p.builds[1].artifact.sha256 = digest('other')), /provenance build for x86_64 does not match the manifest artifact/],
      [(p) => (p.builds[0].signing.notarization = 'pending'), /provenance build for aarch64 is not signed, notarized, stapled and accepted/],
    ];
    for (const [mutate, expected] of tamper) {
      const manifest = await accepted();
      const record = provenance();
      mutate(record);
      const provenanceText = JSON.stringify(record);
      manifest.candidate.provenanceSha256 = digest(provenanceText);
      expect(
        validateBetaAcceptanceManifest(manifest, { provenanceText, sha256sumsText: sha256sums() }).join('\n'),
      ).toMatch(expected);
    }
  });

  it('is reachable: the command, the runbook and the template name each other', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const runbook = await readFile('docs/BETA-ACCEPTANCE.md', 'utf8');

    expect(packageJson.scripts['acceptance:validate:beta']).toBe(
      'node scripts/validate-beta-acceptance.mjs',
    );
    // The historical command still runs the historical validator.
    expect(packageJson.scripts['acceptance:validate']).toBe(
      'node scripts/validate-operator-acceptance.mjs',
    );
    expect(packageJson.files).toContain('docs/BETA-ACCEPTANCE.md');
    expect(runbook).toContain('pnpm acceptance:validate:beta');
    expect(runbook).toContain(`./templates/${templatePath.split('/').pop()}`);
    for (const flag of ['--provenance', '--sha256sums', '--require-complete', '--require-accepted']) {
      expect(runbook, flag).toContain(flag);
    }
    for (const outcome of ['succeeded', 'failed', 'recovery_required', 'gap', 'pending']) {
      expect(runbook, outcome).toContain(`\`${outcome}\``);
    }
    expect(await readFile('docs/RELEASE-ACCEPTANCE.md', 'utf8')).toContain('./BETA-ACCEPTANCE.md');
    expect(await readFile('docs/OPERATOR-ACCEPTANCE-SLICE.md', 'utf8')).toContain('./BETA-ACCEPTANCE.md');
  });

  it('is a separate contract: neither validator accepts the other manifest', async () => {
    const historical = JSON.parse(await readFile('docs/templates/operator-acceptance-v0.0.1.json', 'utf8'));
    expect(validateOperatorAcceptanceManifest(historical)).toEqual([]);
    expect(validateBetaAcceptanceManifest(historical).length).toBeGreaterThan(0);
    expect(validateOperatorAcceptanceManifest(await accepted()).length).toBeGreaterThan(0);
  });
});
