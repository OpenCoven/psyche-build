// @ts-check

import { join } from 'node:path';

import { createApplyLockIdentity } from './cli.mjs';
import { readSyncConfig } from './config.mjs';
import { createGhClient } from './github.mjs';
import { createExecFileRun } from './source.mjs';

/**
 * @typedef {import('./github.mjs').DuplicateManagedIssueGroup} DuplicateManagedIssueGroup
 */

/**
 * @typedef {{
 *   write(chunk: string): unknown,
 * }} WritableStream
 */

/**
 * @typedef {{
 *   configPath?: string,
 *   cwd?: string,
 *   env?: Readonly<Record<string, string | undefined>>,
 *   run?: import('./source.mjs').ExecFileRun,
 *   createGhClient?: typeof createGhClient,
 *   stdout?: WritableStream,
 *   stderr?: WritableStream,
 * }} ReconcileDuplicatesCliDependencies
 */

/**
 * @typedef {{
 *   apply: boolean,
 *   confirmIssueNumbers: number[] | null,
 * }} ReconcileDuplicatesCliOptions
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * A minimal, standalone CLI mode for #420: detects Bead identities mirrored
 * onto more than one open managed issue and, only with explicit operator
 * confirmation of the exact plan, retires every duplicate in favor of its
 * lowest-numbered survivor. Deliberately kept out of the primary
 * `runBeadsProjectCli` reconciliation path (`--dry-run`/`--apply`/
 * `--provision`) so this narrow, higher-risk operation cannot destabilize
 * the well-tested critical sync flow, and so it fails closed independently
 * of it.
 *
 * @param {readonly string[]} argv
 * @returns {ReconcileDuplicatesCliOptions}
 */
export function parseReconcileDuplicatesCliOptions(argv) {
  let apply = false;
  /** @type {number[] | null} */
  let confirmIssueNumbers = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument.startsWith('--confirm-issue-numbers=')) {
      const raw = argument.slice('--confirm-issue-numbers='.length);
      if (confirmIssueNumbers != null) {
        fail('--confirm-issue-numbers may only be supplied once');
      }
      const parsed = raw
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .map((token) => {
          const value = Number(token);
          if (!Number.isInteger(value) || value <= 0) {
            fail(`--confirm-issue-numbers contains a non-issue-number token: "${token}"`);
          }
          return value;
        });
      confirmIssueNumbers = parsed;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }

  if (apply && confirmIssueNumbers == null) {
    fail('--apply requires --confirm-issue-numbers=<comma-separated issue numbers> naming every duplicate to retire');
  }
  if (!apply && confirmIssueNumbers != null) {
    fail('--confirm-issue-numbers only applies with --apply');
  }

  return { apply, confirmIssueNumbers };
}

/**
 * @param {readonly DuplicateManagedIssueGroup[]} groups
 * @returns {number[]}
 */
function plannedDuplicateIssueNumbers(groups) {
  /** @type {number[]} */
  const numbers = [];
  for (const group of groups) {
    numbers.push(...group.duplicateIssueNumbers);
  }
  return numbers.sort((left, right) => left - right);
}

/**
 * @param {readonly number[]} confirmed
 * @param {readonly number[]} planned
 * @returns {string | null}
 */
function confirmationMismatch(confirmed, planned) {
  const confirmedSorted = [...confirmed].sort((left, right) => left - right);
  const plannedSorted = [...planned].sort((left, right) => left - right);
  if (
    confirmedSorted.length === plannedSorted.length
    && confirmedSorted.every((value, index) => value === plannedSorted[index])
  ) {
    return null;
  }
  const missing = plannedSorted.filter((value) => !confirmedSorted.includes(value));
  const unexpected = confirmedSorted.filter((value) => !plannedSorted.includes(value));
  const parts = [];
  if (missing.length > 0) {
    parts.push(`missing from --confirm-issue-numbers: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    parts.push(`not part of the current detected plan: ${unexpected.join(', ')}`);
  }
  return `--confirm-issue-numbers does not match the freshly detected duplicate plan (${parts.join('; ')}). Re-run without --apply to see the current plan and re-confirm explicitly.`;
}

/**
 * @param {readonly string[]} argv
 * @param {ReconcileDuplicatesCliDependencies} [dependencies]
 * @returns {Promise<number>}
 */
export async function runReconcileDuplicatesCli(argv, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  try {
    const options = parseReconcileDuplicatesCliOptions(argv);
    const config = await readSyncConfig(
      dependencies.configPath ?? join(cwd, '.github/beads-project-sync.json'),
    );
    const token = env.BEADS_PROJECT_TOKEN?.trim() || null;
    if (!token) {
      fail('BEADS_PROJECT_TOKEN is required');
    }

    const run = dependencies.run ?? createExecFileRun();
    const gh = (dependencies.createGhClient ?? createGhClient)({
      run,
      owner: config.owner,
      repo: config.repository,
      token: /** @type {string} */ (token),
      projectNodeId: config.projectNodeId,
      projectMarker: config.projectMarker,
      issueMarker: config.issueMarker,
      applyLockRef: config.applyLockRef,
      trustedIssueAuthors: config.trustedIssueAuthors,
    });
    await gh.verifyAccess();

    const groups = await gh.detectDuplicateManagedIssues();
    const planned = plannedDuplicateIssueNumbers(groups);

    if (!options.apply) {
      stdout.write(`${JSON.stringify({ groups, plannedDuplicateIssueNumbers: planned }, null, 2)}\n`);
      if (groups.length === 0) {
        stderr.write('No duplicate managed issues detected; nothing to reconcile.\n');
      } else {
        stderr.write(
          `Detected ${planned.length} duplicate issue(s) across ${groups.length} Bead identit${groups.length === 1 ? 'y' : 'ies'}. `
          + `Re-run with --apply --confirm-issue-numbers=${planned.join(',')} to retire them.\n`,
        );
      }
      return 0;
    }

    const mismatch = confirmationMismatch(
      /** @type {number[]} */ (options.confirmIssueNumbers),
      planned,
    );
    if (mismatch != null) {
      fail(mismatch);
    }
    if (planned.length === 0) {
      stderr.write('No duplicate managed issues detected; nothing to retire.\n');
      stdout.write(`${JSON.stringify({ groups: [], retired: [] }, null, 2)}\n`);
      return 0;
    }

    const applyLock = await gh.acquireApplyLock(createApplyLockIdentity(env));
    const applyLease = gh.startApplyLockLease(applyLock);
    /** @type {{ issueNumber: number, survivorIssueNumber: number }[]} */
    const retired = [];
    try {
      for (const group of groups) {
        for (const issueNumber of group.duplicateIssueNumbers) {
          await applyLease.assertOwned();
          const result = await gh.retireDuplicateIssue({
            issueNumber,
            survivorIssueNumber: group.survivorIssueNumber,
            beadId: group.beadId,
          });
          retired.push(result);
          stderr.write(
            `Retired duplicate issue #${result.issueNumber} in favor of #${result.survivorIssueNumber}.\n`,
          );
        }
      }
    } finally {
      await applyLease.release();
    }

    stdout.write(`${JSON.stringify({ groups, retired }, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Beads duplicate reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
