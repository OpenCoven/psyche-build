import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { normalizeOperatorArchitecture } from './validate-operator-acceptance.mjs';

// Manifest contract for the macOS public beta acceptance pass (#555): gates
// G1-G4 observed on ONE packaged release candidate built by the non-publishing
// `Release candidate` workflow.
//
// It is separate from validate-operator-acceptance.mjs, which is pinned to the
// published v0.0.1 release and stays as it is. A candidate has no tag and no
// published hashes to pin, so its identity is an input here: the exact source
// SHA, the candidate id derived from it, and the final version it embeds.
//
// This file validates the SHAPE and the internal consistency of a manifest. A
// valid manifest is a well-formed record of what an operator reports; it is not
// evidence that anything was observed.

const SCHEMA = 'psyche-build.beta-acceptance.v1';
const PROVENANCE_SCHEMA = 'psyche-build.release-candidate-provenance.v1';

/** The upgrade and rollback baseline for G4: the latest published release. */
const UPGRADE_BASELINE = Object.freeze({
  version: '0.0.2',
  sourceSha: 'a4546f45bb0ee05cfbb388a0fc5f9e951596be51',
});

/** One row per observation in the #555 case ledger. */
export const BETA_ACCEPTANCE_ROWS = Object.freeze(
  [
    ['G1.1', 'Clean install through the Cask on an account with no prior state'],
    ['G1.2', 'Clean install from the DMG downloaded directly'],
    ['G1.3', 'Bundle identity and version match the candidate source SHA'],
    ['G1.4', 'codesign verification of the installed app'],
    ['G1.5', 'Gatekeeper assessment on first open'],
    ['G1.6', 'Notarization ticket is stapled and validates'],
    ['G2.1', 'Onboarding on first launch completes'],
    ['G2.2', 'Select a project, then select a pane'],
    ['G2.3', 'Open a terminal pane and run a command'],
    ['G2.4', 'Launch an agent in a pane'],
    ['G2.5', 'Keyboard navigation and focus move as documented'],
    ['G2.6', 'File view and diff view on a changed file'],
    ['G2.7', 'Merge a pane, open a pull request, clean up the worktree'],
    ['G2.8', 'Navigate between two projects'],
    ['G2.9', 'Quit and reopen: projects, panes and settings persist'],
    ['G3.1', 'Agent launch fails because the agent binary is absent'],
    ['G3.2', 'A Git mutation is interrupted part-way'],
    ['G3.3', 'The app is killed mid-transition with a live pane, then restarted'],
    ['G3.4', 'Storage is full during a state write'],
    ['G3.5', 'Storage is unwritable during a state write'],
    ['G3.6', 'After each failure case the user repository is intact'],
    ['G4.1', 'Install the candidate over a working v0.0.2'],
    ['G4.2', 'v0.0.2 state is preserved, or quarantined with a stated reason'],
    ['G4.3', 'Roll back to v0.0.2'],
    ['G4.4', 'State after rollback is usable or reported, never silently dropped'],
  ].map(([id, title]) => Object.freeze({ id, gate: id.slice(0, 2), title })),
);

/**
 * Agent ids and the set whose initial prompt is in the agent's own argv. These
 * repeat `AGENT_IDS` and `promptReachesAgentArgv` from src/utils/agentLaunch.ts
 * because this script runs without a build; __tests__/betaAcceptanceManifest
 * holds both lists equal to the registry.
 */
export const BETA_AGENT_IDS = Object.freeze([
  'coven-code',
  'claude',
  'opencode',
  'codex',
  'cline',
  'gemini',
  'qwen',
  'amp',
  'pi',
  'cursor',
  'copilot',
  'crush',
]);
export const BETA_AGENTS_WITH_PROMPT_IN_ARGV = Object.freeze([
  'claude',
  'opencode',
  'codex',
  'gemini',
  'qwen',
  'pi',
  'cursor',
  'copilot',
]);

const ROW_IDS = new Set(BETA_ACCEPTANCE_ROWS.map((row) => row.id));
const AGENT_ROW = 'G2.4';
const OUTCOMES = new Set(['pending', 'succeeded', 'failed', 'recovery_required', 'gap']);
const OBSERVED = new Set(['succeeded', 'failed', 'recovery_required']);
const MESSAGE_CLASSES = new Set(['actionable', 'not_actionable', 'none_shown']);
const TERMINAL_STATES = new Set(['incomplete', 'accepted', 'not_accepted']);
const ARCHITECTURES = ['aarch64', 'x86_64'];
const TAG_KEYS = ['tag', 'tagObjectSha', 'intendedReleaseTag'];

const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const FINAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
// Fail closed on anything that looks like a home directory: retained evidence
// must not carry personal paths (AGENTS.md, protected data).
const PERSONAL_PATH = /(?:\/Users\/|\/home\/|\/var\/folders\/|~\/|[A-Za-z]:\\)/;
const MAX_TEXT = 280;
// A person is named by GitHub login only, so a name field cannot carry prose.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

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

function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A retained free-text field: one bounded line with no personal path. */
function boundedText(value, path, errors) {
  if (typeof value !== 'string') return;
  if (value.length > MAX_TEXT || /[\r\n]/.test(value)) {
    errors.push(`${path} must be one line of at most ${MAX_TEXT} characters`);
  }
  if (PERSONAL_PATH.test(value)) errors.push(`${path} must not contain a personal path`);
}

/** A field that names a person: a GitHub login, or null while unfilled. */
function githubLogin(value, path, errors) {
  if (value !== null && (typeof value !== 'string' || !GITHUB_LOGIN.test(value))) {
    errors.push(`${path} must be a GitHub login or null`);
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function validateCandidate(candidate, errors) {
  if (object(candidate)) {
    for (const key of TAG_KEYS) {
      if (key in candidate) errors.push(`candidate must not name a tag (${key})`);
    }
  }
  const keys = ['id', 'sha', 'version', 'provenanceSha256', 'sha256sumsSha256'];
  if (!object(candidate)) {
    errors.push('candidate must be an object');
    return;
  }
  for (const key of Object.keys(candidate)) {
    if (!keys.includes(key) && !TAG_KEYS.includes(key)) {
      errors.push(`candidate contains unsupported field ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in candidate)) errors.push(`candidate is missing ${key}`);
  }

  const shaOk = typeof candidate.sha === 'string' && SHA40.test(candidate.sha);
  if (!shaOk) errors.push('candidate.sha must be a full 40-character commit SHA');
  if (!shaOk || candidate.id !== `rc-${candidate.sha.slice(0, 12)}`) {
    errors.push('candidate.id must be rc- followed by the first 12 characters of candidate.sha');
  }
  if (typeof candidate.version !== 'string' || !FINAL_VERSION.test(candidate.version)) {
    errors.push('candidate.version must be a final MAJOR.MINOR.PATCH, never a prerelease');
  }
  for (const key of ['provenanceSha256', 'sha256sumsSha256']) {
    if (typeof candidate[key] !== 'string' || !SHA256.test(candidate[key])) {
      errors.push(`candidate.${key} must be a SHA-256 digest of the retained file`);
    }
  }
}

function validateArtifacts(artifacts, candidate, errors) {
  if (!Array.isArray(artifacts)) {
    errors.push('artifacts must be an array');
    return;
  }
  const seen = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const path = `artifacts[${index}]`;
    if (!exactKeys(artifact, ['architecture', 'filename', 'sha256'], path, errors)) continue;
    if (!ARCHITECTURES.includes(artifact.architecture)) {
      errors.push(`${path}.architecture must be aarch64 or x86_64`);
    } else if (seen.has(artifact.architecture)) {
      errors.push(`${path}.architecture is duplicated`);
    }
    seen.add(artifact.architecture);
    const expected =
      object(candidate) &&
      typeof candidate.version === 'string' &&
      typeof candidate.id === 'string' &&
      ARCHITECTURES.includes(artifact.architecture)
        ? `Psyche-Build-v${candidate.version}-${candidate.id}-${artifact.architecture}.dmg`
        : null;
    if (expected === null || artifact.filename !== expected) {
      errors.push(`${path}.filename must be ${expected ?? 'the candidate DMG for its architecture'}`);
    }
    if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      errors.push(`${path}.sha256 must be a SHA-256 digest`);
    }
  }
  for (const architecture of ARCHITECTURES) {
    if (!seen.has(architecture)) errors.push(`artifacts is missing ${architecture}`);
  }
}

function validateHost(host, errors) {
  if (!exactKeys(host, ['macOS', 'architecture', 'machineClass'], 'host', errors)) return 'unknown';
  for (const key of ['macOS', 'machineClass']) {
    if (!filled(host[key])) errors.push(`host.${key} is required`);
    boundedText(host[key], `host.${key}`, errors);
  }
  const architecture = normalizeOperatorArchitecture(host.architecture);
  if (architecture === 'unknown') {
    errors.push('host.architecture must be aarch64, arm64, x86_64, or x64');
  }
  return architecture;
}

function validateUpgradeBaseline(baseline, hostArchitecture, errors) {
  if (
    !exactKeys(baseline, ['version', 'sourceSha', 'filename', 'sha256'], 'upgradeBaseline', errors)
  ) {
    return;
  }
  if (baseline.version !== UPGRADE_BASELINE.version) {
    errors.push(`upgradeBaseline.version must be ${UPGRADE_BASELINE.version}`);
  }
  if (baseline.sourceSha !== UPGRADE_BASELINE.sourceSha) {
    errors.push('upgradeBaseline.sourceSha must identify the published v0.0.2 source');
  }
  const expected =
    hostArchitecture === 'unknown'
      ? null
      : `Psyche-Build-v${UPGRADE_BASELINE.version}-${hostArchitecture}.dmg`;
  if (expected === null || baseline.filename !== expected) {
    errors.push(
      `upgradeBaseline.filename must be ${expected ?? 'the v0.0.2 DMG for the host architecture'}`,
    );
  }
  if (typeof baseline.sha256 !== 'string' || !SHA256.test(baseline.sha256)) {
    errors.push('upgradeBaseline.sha256 must be a SHA-256 digest of the installer that was used');
  }
}

function validateAgent(agent, path, errors) {
  if (!exactKeys(agent, ['id', 'version', 'promptInArgv'], `${path}.agent`, errors)) return;
  if (!BETA_AGENT_IDS.includes(agent.id)) {
    errors.push(`${path}.agent.id must be a registry agent`);
    return;
  }
  if (agent.version !== null) {
    if (!filled(agent.version)) errors.push(`${path}.agent.version must be a version string or null`);
    boundedText(agent.version, `${path}.agent.version`, errors);
  }
  const exposed = BETA_AGENTS_WITH_PROMPT_IN_ARGV.includes(agent.id);
  if (agent.promptInArgv !== exposed) {
    errors.push(`${path}.agent.promptInArgv must be ${exposed} for ${agent.id}`);
  }
}

function validateRow(row, path, errors) {
  const keys = [
    'id',
    'outcome',
    'messageClass',
    'safeNextAction',
    'gapReason',
    'workPreserved',
    'evidenceDigests',
  ];
  const isAgentRow = object(row) && row.id === AGENT_ROW;
  if (!exactKeys(row, isAgentRow ? [...keys, 'agent'] : keys, path, errors)) return;
  if (!OUTCOMES.has(row.outcome)) {
    errors.push(`${path}.outcome is unsupported`);
    return;
  }
  const { outcome } = row;
  const observed = OBSERVED.has(outcome);

  if (!Array.isArray(row.evidenceDigests)) {
    errors.push(`${path}.evidenceDigests must be an array`);
  } else {
    for (const digest of row.evidenceDigests) {
      if (typeof digest !== 'string' || !SHA256.test(digest)) {
        errors.push(`${path}.evidenceDigests contains a non-SHA-256 digest`);
      }
    }
    if (observed && row.evidenceDigests.length === 0) {
      errors.push(`${path}.evidenceDigests must contain retained evidence`);
    }
    if (outcome === 'pending' && row.evidenceDigests.length > 0) {
      errors.push(`${path}: a pending row must not carry evidence`);
    }
  }

  if (outcome === 'gap') {
    if (!filled(row.gapReason)) errors.push(`${path}.gapReason is required for a gap`);
  } else if (row.gapReason !== null) {
    errors.push(`${path}.gapReason is only allowed for a gap`);
  }
  boundedText(row.gapReason, `${path}.gapReason`, errors);

  if (outcome === 'failed') {
    if (!MESSAGE_CLASSES.has(row.messageClass)) {
      errors.push(`${path}.messageClass must be actionable, not_actionable, or none_shown`);
    }
  } else if (row.messageClass !== null) {
    errors.push(`${path}.messageClass is only allowed for a failed row`);
  }

  const needsNextAction = outcome === 'failed' || outcome === 'recovery_required';
  if (needsNextAction) {
    if (!filled(row.safeNextAction)) {
      errors.push(`${path}.safeNextAction is required for failed or recovery_required`);
    }
    if (typeof row.workPreserved !== 'boolean') {
      errors.push(`${path}.workPreserved must be true or false for failed or recovery_required`);
    }
  } else if (row.safeNextAction !== null) {
    errors.push(`${path}.safeNextAction is only allowed for failed or recovery_required`);
  }
  boundedText(row.safeNextAction, `${path}.safeNextAction`, errors);

  const guardsWork = typeof row.id === 'string' && /^G[34]\./.test(row.id);
  if (outcome === 'succeeded' && guardsWork && row.workPreserved !== true) {
    errors.push(`${path}.workPreserved must be true for a succeeded failure-path or upgrade row`);
  }
  if (row.workPreserved !== null && typeof row.workPreserved !== 'boolean') {
    errors.push(`${path}.workPreserved must be true, false, or null`);
  }

  if (isAgentRow) {
    if (row.agent === null) {
      if (observed) errors.push(`${path}.agent is required when the launch was observed`);
    } else {
      validateAgent(row.agent, path, errors);
    }
  }
}

function validateProvenance(manifest, provenanceText, errors) {
  let record;
  try {
    record = JSON.parse(provenanceText);
  } catch {
    errors.push('provenance file is not valid JSON');
    return;
  }
  if (!object(record) || record.schema !== PROVENANCE_SCHEMA) {
    errors.push(`provenance schema must be ${PROVENANCE_SCHEMA}`);
    return;
  }
  const candidate = object(manifest.candidate) ? manifest.candidate : {};
  if (candidate.provenanceSha256 !== sha256(provenanceText)) {
    errors.push('candidate.provenanceSha256 does not match the provenance file');
  }
  if (
    !object(record.candidate) ||
    record.candidate.id !== candidate.id ||
    record.candidate.sha !== candidate.sha ||
    record.candidate.embeddedVersion !== candidate.version
  ) {
    errors.push('provenance candidate does not match the manifest');
  }
  for (const [key, value] of Object.entries(object(record.publication) ? record.publication : {})) {
    if (value !== false) errors.push(`provenance records a publication (${key})`);
  }
  if (!object(record.publication)) errors.push('provenance has no publication record');

  const builds = Array.isArray(record.builds) ? record.builds : [];
  for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    if (!object(artifact)) continue;
    const build = builds.find((entry) => object(entry) && entry.arch === artifact.architecture);
    if (
      !build ||
      !object(build.artifact) ||
      build.artifact.file !== artifact.filename ||
      build.artifact.sha256 !== artifact.sha256 ||
      build.candidateSha !== candidate.sha
    ) {
      errors.push(
        `provenance build for ${artifact.architecture} does not match the manifest artifact`,
      );
      continue;
    }
    const signing = object(build.signing) ? build.signing : {};
    if (
      signing.codesign !== 'verified' ||
      signing.notarization !== 'accepted' ||
      signing.stapled !== true ||
      signing.gatekeeper !== 'accepted'
    ) {
      errors.push(
        `provenance build for ${artifact.architecture} is not signed, notarized, stapled and accepted`,
      );
    }
  }
}

function validateSha256sums(manifest, sha256sumsText, errors) {
  const candidate = object(manifest.candidate) ? manifest.candidate : {};
  if (candidate.sha256sumsSha256 !== sha256(sha256sumsText)) {
    errors.push('candidate.sha256sumsSha256 does not match the SHA256SUMS file');
  }
  const listed = new Map();
  for (const line of sha256sumsText.split('\n')) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trim());
    if (match) listed.set(match[2], match[1]);
  }
  for (const [index, artifact] of (Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : []
  ).entries()) {
    if (!object(artifact)) continue;
    if (!listed.has(artifact.filename)) {
      errors.push(`SHA256SUMS has no entry for ${artifact.filename}`);
    } else if (listed.get(artifact.filename) !== artifact.sha256) {
      errors.push(`artifacts[${index}].sha256 does not match SHA256SUMS`);
    }
  }
}

/**
 * Validate a beta acceptance manifest. Returns a list of errors; an empty list
 * means the manifest is well formed for the terminal state it declares.
 *
 * - `requireComplete`: the pass must be finished (`accepted` or `not_accepted`).
 * - `requireAccepted`: the pass must be `accepted`.
 * - `provenanceText`, `sha256sumsText`: contents of the candidate's
 *   `release-candidate-provenance.json` and `SHA256SUMS`; when given, the
 *   manifest's identity, artifacts and file digests are checked against them.
 */
export function validateBetaAcceptanceManifest(
  manifest,
  { requireComplete = false, requireAccepted = false, provenanceText, sha256sumsText } = {},
) {
  const errors = [];
  if (
    !exactKeys(
      manifest,
      [
        'schema',
        'terminalState',
        'candidate',
        'artifacts',
        'host',
        'upgradeBaseline',
        'rows',
        'operator',
        'sanitization',
      ],
      'manifest',
      errors,
    )
  ) {
    return errors;
  }

  if (manifest.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!TERMINAL_STATES.has(manifest.terminalState)) {
    errors.push('terminalState must be incomplete, accepted, or not_accepted');
  }

  validateCandidate(manifest.candidate, errors);
  validateArtifacts(manifest.artifacts, manifest.candidate, errors);
  const hostArchitecture = validateHost(manifest.host, errors);
  validateUpgradeBaseline(manifest.upgradeBaseline, hostArchitecture, errors);

  const rows = Array.isArray(manifest.rows) ? manifest.rows.filter(object) : [];
  if (!Array.isArray(manifest.rows)) {
    errors.push('rows must be an array');
  } else {
    const seen = new Set();
    for (const [index, row] of manifest.rows.entries()) {
      const path = `rows[${index}]`;
      if (!object(row)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (!ROW_IDS.has(row.id)) {
        errors.push(`${path}.id is unsupported`);
      } else if (seen.has(row.id)) {
        errors.push(`${path}.id is duplicated`);
      }
      seen.add(row.id);
      validateRow(row, path, errors);
    }
    for (const id of ROW_IDS) {
      if (!seen.has(id)) errors.push(`rows is missing ${id}`);
    }
  }

  if (exactKeys(manifest.operator, ['githubLogin', 'observedAt'], 'operator', errors)) {
    githubLogin(manifest.operator.githubLogin, 'operator.githubLogin', errors);
    if (
      manifest.operator.observedAt !== null &&
      (typeof manifest.operator.observedAt !== 'string' ||
        !ISO_TIMESTAMP.test(manifest.operator.observedAt) ||
        Number.isNaN(Date.parse(manifest.operator.observedAt)))
    ) {
      errors.push('operator.observedAt must be an ISO-8601 timestamp');
    }
  }

  if (
    exactKeys(
      manifest.sanitization,
      ['reviewed', 'reviewerGitHubLogin', 'omissions'],
      'sanitization',
      errors,
    )
  ) {
    if (typeof manifest.sanitization.reviewed !== 'boolean') {
      errors.push('sanitization.reviewed must be true or false');
    }
    githubLogin(
      manifest.sanitization.reviewerGitHubLogin,
      'sanitization.reviewerGitHubLogin',
      errors,
    );
    if (!Array.isArray(manifest.sanitization.omissions)) {
      errors.push('sanitization.omissions must be an array');
    } else {
      for (const [index, omission] of manifest.sanitization.omissions.entries()) {
        const path = `sanitization.omissions[${index}]`;
        if (!filled(omission)) errors.push(`${path} must be a non-empty string`);
        boundedText(omission, path, errors);
      }
    }
  }

  const state = manifest.terminalState;
  if (state === 'accepted' || state === 'not_accepted') {
    if (
      !object(manifest.operator) ||
      !filled(manifest.operator.githubLogin) ||
      !filled(manifest.operator.observedAt)
    ) {
      errors.push('terminal manifest requires the operator identity and observation time');
    }
    if (
      !object(manifest.sanitization) ||
      manifest.sanitization.reviewed !== true ||
      !filled(manifest.sanitization.reviewerGitHubLogin)
    ) {
      errors.push('terminal manifest requires a named sanitization review');
    }
  }
  if (state === 'accepted') {
    for (const row of rows) {
      if (row.outcome !== 'succeeded') {
        errors.push(`accepted manifest requires every row succeeded: ${row.id} is ${row.outcome}`);
      }
    }
  }
  if (state === 'not_accepted') {
    for (const row of rows) {
      if (row.outcome === 'pending') {
        errors.push(`not_accepted manifest cannot contain a pending row: ${row.id}`);
      }
    }
    if (rows.length > 0 && rows.every((row) => row.outcome === 'succeeded')) {
      errors.push('not_accepted manifest requires at least one row that did not succeed');
    }
  }

  if (requireComplete && state !== 'accepted' && state !== 'not_accepted') {
    errors.push(`terminalState is ${state}`);
  }
  if (requireAccepted && state !== 'accepted') errors.push('terminalState is not accepted');

  if (typeof provenanceText === 'string') validateProvenance(manifest, provenanceText, errors);
  if (typeof sha256sumsText === 'string') validateSha256sums(manifest, sha256sumsText, errors);

  return errors;
}

const USAGE =
  'Usage: node scripts/validate-beta-acceptance.mjs <manifest.json> ' +
  '[--provenance <release-candidate-provenance.json>] [--sha256sums <SHA256SUMS>] ' +
  '[--require-complete] [--require-accepted]';

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const options = { requireComplete: false, requireAccepted: false };
  const files = {};
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-complete') options.requireComplete = true;
    else if (arg === '--require-accepted') options.requireAccepted = true;
    else if (arg === '--provenance' || arg === '--sha256sums') {
      files[arg] = args[(index += 1)];
    } else if (arg.startsWith('--')) {
      paths.length = 2;
      break;
    } else paths.push(arg);
  }
  if (paths.length !== 1 || Object.values(files).some((value) => value === undefined)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths[0], 'utf8'));
    if (files['--provenance']) options.provenanceText = await readFile(files['--provenance'], 'utf8');
    if (files['--sha256sums']) options.sha256sumsText = await readFile(files['--sha256sums'], 'utf8');
  } catch (error) {
    // The message may carry a path: print its class, not the text.
    console.error(
      `Unable to read an input file: ${error instanceof SyntaxError ? 'invalid JSON' : 'not readable'}`,
    );
    process.exitCode = 2;
    return;
  }

  const errors = validateBetaAcceptanceManifest(manifest, options);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }

  const checked = [
    options.provenanceText === undefined ? null : 'provenance',
    options.sha256sumsText === undefined ? null : 'SHA256SUMS',
  ].filter(Boolean);
  console.log(
    `Beta acceptance manifest is structurally valid and ${manifest.terminalState}` +
      (checked.length > 0
        ? `; cross-checked against ${checked.join(' and ')}.`
        : '; not cross-checked against candidate files.'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
