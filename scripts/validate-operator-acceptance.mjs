import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RELEASE = Object.freeze({
  version: '0.0.2',
  tag: 'v0.0.2',
  tagObjectSha: '87e23c17b3fcff38d33e37a70f56679c475edd43',
  sourceSha: 'a4546f45bb0ee05cfbb388a0fc5f9e951596be51',
});

const ARTIFACTS = new Map([
  [
    'aarch64',
    {
      filename: 'Psyche-Build-v0.0.2-aarch64.dmg',
      sha256: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
    },
  ],
  [
    'x86_64',
    {
      filename: 'Psyche-Build-v0.0.2-x86_64.dmg',
      sha256: 'f9e19a77d0d7bc746226fa510bf3e34e5d96185e6563e53bb1898f0d9423033e',
    },
  ],
]);

const REQUIRED_OBSERVATIONS = new Set([
  'first-run-onboarding',
  'plain-terminal-lifecycle',
  'supported-agent-lane',
  'project-pane-focus-handoff',
  'pane-close-work-preservation',
  'normal-restart-restore',
  'force-quit-transition',
  'merge-conflict-interrupted-cleanup',
  'provider-interruption-revocation',
  'corrupt-persisted-state',
  'stale-tmux-identity',
  'unwritable-or-full-storage',
  'duplicate-consequential-retry',
  'uninstall-reinstall',
]);

const STATUSES = new Set([
  'pending',
  'succeeded',
  'failed',
  'recovery_required',
  'deferred',
  'inapplicable',
  'unknown',
]);

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'recovery_required',
  'inapplicable',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, path, errors) {
  if (!object(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unsupported field ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) errors.push(`${path} is missing ${key}`);
  }
  return true;
}

function digestArray(value, path, errors, { required = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (required && value.length === 0) errors.push(`${path} must contain retained evidence`);
  for (const digest of value) {
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      errors.push(`${path} contains a non-SHA-256 digest`);
    }
  }
}

export function validateOperatorAcceptanceManifest(manifest, { requireComplete = false } = {}) {
  const errors = [];

  if (
    !exactKeys(
      manifest,
      [
        'schemaVersion',
        'terminalState',
        'release',
        'sourceSmoke',
        'packagedRuntime',
        'observations',
        'operator',
        'sanitization',
        'transfers',
      ],
      'manifest',
      errors,
    )
  ) {
    return errors;
  }

  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!['incomplete', 'complete'].includes(manifest.terminalState)) {
    errors.push('terminalState must be incomplete or complete');
  }

  if (
    exactKeys(
      manifest.release,
      ['version', 'tag', 'tagObjectSha', 'sourceSha'],
      'release',
      errors,
    )
  ) {
    for (const [key, expected] of Object.entries(RELEASE)) {
      if (manifest.release[key] !== expected) {
        errors.push(`release.${key} must identify the published v0.0.2 subject`);
      }
    }
    if (!SHA40.test(manifest.release.tagObjectSha) || !SHA40.test(manifest.release.sourceSha)) {
      errors.push('release tag and source identities must be full 40-character SHAs');
    }
  }

  if (
    exactKeys(
      manifest.sourceSmoke,
      ['subject', 'status', 'commandExitStatus', 'environment', 'evidenceDigests'],
      'sourceSmoke',
      errors,
    )
  ) {
    if (manifest.sourceSmoke.subject !== 'exact_source') {
      errors.push('sourceSmoke.subject must be exact_source');
    }
    if (!STATUSES.has(manifest.sourceSmoke.status)) {
      errors.push('sourceSmoke.status is unsupported');
    }
    if (
      exactKeys(
        manifest.sourceSmoke.environment,
        ['macOS', 'architecture', 'node', 'pnpm', 'tmux', 'git'],
        'sourceSmoke.environment',
        errors,
      ) &&
      manifest.sourceSmoke.environment.pnpm !== '10.34.5'
    ) {
      errors.push('sourceSmoke.environment.pnpm must match packageManager 10.34.5');
    }
    const smokeObserved = TERMINAL_STATUSES.has(manifest.sourceSmoke.status);
    if (
      smokeObserved &&
      (!Number.isInteger(manifest.sourceSmoke.commandExitStatus) ||
        manifest.sourceSmoke.commandExitStatus < 0)
    ) {
      errors.push('sourceSmoke.commandExitStatus must be a non-negative integer when observed');
    }
    digestArray(
      manifest.sourceSmoke.evidenceDigests,
      'sourceSmoke.evidenceDigests',
      errors,
      { required: smokeObserved },
    );
  }

  if (
    exactKeys(
      manifest.packagedRuntime,
      ['subject', 'filename', 'sha256', 'architecture'],
      'packagedRuntime',
      errors,
    )
  ) {
    if (manifest.packagedRuntime.subject !== 'published_dmg') {
      errors.push('packagedRuntime.subject must be published_dmg');
    }
    const artifact = ARTIFACTS.get(manifest.packagedRuntime.architecture);
    const selected = [manifest.packagedRuntime.filename, manifest.packagedRuntime.sha256].some(
      (value) => value !== null,
    );
    if (selected && !artifact) {
      errors.push('packagedRuntime.architecture must be aarch64 or x86_64');
    } else if (artifact) {
      if (manifest.packagedRuntime.filename !== artifact.filename) {
        errors.push('packagedRuntime.filename does not match its architecture');
      }
      if (manifest.packagedRuntime.sha256 !== artifact.sha256) {
        errors.push('packagedRuntime.sha256 does not match the published v0.0.2 DMG');
      }
    }
  }

  if (!Array.isArray(manifest.observations)) {
    errors.push('observations must be an array');
  } else {
    const seen = new Set();
    for (const [index, observation] of manifest.observations.entries()) {
      const path = `observations[${index}]`;
      if (
        !exactKeys(
          observation,
          ['id', 'status', 'expectationMet', 'workPreserved', 'safeNextAction', 'evidenceDigests'],
          path,
          errors,
        )
      ) {
        continue;
      }
      if (!REQUIRED_OBSERVATIONS.has(observation.id)) {
        errors.push(`${path}.id is unsupported`);
      } else if (seen.has(observation.id)) {
        errors.push(`${path}.id is duplicated`);
      }
      seen.add(observation.id);
      if (!STATUSES.has(observation.status)) errors.push(`${path}.status is unsupported`);

      const observed = TERMINAL_STATUSES.has(observation.status);
      if (observed && typeof observation.expectationMet !== 'boolean') {
        errors.push(`${path}.expectationMet must be boolean when terminal`);
      }
      if (observed && observation.status !== 'inapplicable' && observation.workPreserved !== true) {
        errors.push(`${path}.workPreserved must be true when an applicable case is terminal`);
      }
      if (
        ['failed', 'recovery_required'].includes(observation.status) &&
        (typeof observation.safeNextAction !== 'string' ||
          observation.safeNextAction.trim().length === 0)
      ) {
        errors.push(`${path}.safeNextAction is required for failure or recovery`);
      }
      digestArray(observation.evidenceDigests, `${path}.evidenceDigests`, errors, {
        required: observed,
      });
    }
    for (const id of REQUIRED_OBSERVATIONS) {
      if (!seen.has(id)) errors.push(`observations is missing ${id}`);
    }
  }

  if (
    exactKeys(manifest.operator, ['githubLogin', 'observedAt'], 'operator', errors) &&
    manifest.operator.observedAt !== null &&
    Number.isNaN(Date.parse(manifest.operator.observedAt))
  ) {
    errors.push('operator.observedAt must be an ISO-8601 timestamp');
  }

  if (
    exactKeys(
      manifest.sanitization,
      ['reviewed', 'reviewerGitHubLogin', 'evidenceDigestCountBefore', 'newEvidenceDigests'],
      'sanitization',
      errors,
    )
  ) {
    if (manifest.sanitization.evidenceDigestCountBefore !== 15) {
      errors.push('sanitization.evidenceDigestCountBefore must preserve the existing 15 digests');
    }
    digestArray(
      manifest.sanitization.newEvidenceDigests,
      'sanitization.newEvidenceDigests',
      errors,
      { required: manifest.terminalState === 'complete' },
    );
  }

  if (
    exactKeys(manifest.transfers, ['issue199'], 'transfers', errors) &&
    !Array.isArray(manifest.transfers.issue199)
  ) {
    errors.push('transfers.issue199 must be an array');
  }

  const complete = manifest.terminalState === 'complete';
  if (requireComplete && !complete) errors.push('terminalState is not complete');

  if (complete) {
    if (manifest.sourceSmoke.status !== 'succeeded') {
      errors.push('complete manifest requires successful exact-source smoke');
    }
    if (!ARTIFACTS.has(manifest.packagedRuntime.architecture)) {
      errors.push('complete manifest requires one pinned packaged runtime');
    }
    if (!manifest.operator.githubLogin || !manifest.operator.observedAt) {
      errors.push('complete manifest requires the operator identity and observation time');
    }
    if (
      manifest.sanitization.reviewed !== true ||
      !manifest.sanitization.reviewerGitHubLogin
    ) {
      errors.push('complete manifest requires a named sanitization review');
    }
    for (const observation of manifest.observations ?? []) {
      if (!TERMINAL_STATUSES.has(observation.status)) {
        errors.push(`complete manifest cannot contain ${observation.status}: ${observation.id}`);
      }
      if (observation.expectationMet !== true) {
        errors.push(`complete manifest requires expectationMet=true: ${observation.id}`);
      }
    }
  }

  for (const observation of manifest.observations ?? []) {
    if (observation.status === 'unknown') {
      errors.push(`unknown consequential outcome cannot support handoff: ${observation.id}`);
    }
  }

  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const requireComplete = args.includes('--require-complete');
  const paths = args.filter((arg) => arg !== '--require-complete');
  if (paths.length !== 1) {
    console.error(
      'Usage: node scripts/validate-operator-acceptance.mjs <manifest.json> [--require-complete]',
    );
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths[0], 'utf8'));
  } catch (error) {
    console.error(`Unable to read manifest: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 2;
    return;
  }

  const errors = validateOperatorAcceptanceManifest(manifest, { requireComplete });
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Operator acceptance manifest is structurally valid and ${manifest.terminalState}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
