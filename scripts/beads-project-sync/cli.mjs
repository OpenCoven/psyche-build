// @ts-check

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { readSyncConfig } from './config.mjs';
import { createGhClient } from './github.mjs';
import { parseBeadExport, summarizeInventory } from './model.mjs';
import {
  applyReconciliation,
  assertSafePlan,
  planReconciliation,
  ReconciliationApplyError,
} from './reconcile.mjs';
import {
  LEGACY_ISSUE_MARKERS,
  LEGACY_PROJECT_MARKERS,
} from './markers.mjs';
import { toPublicBead } from './sanitize.mjs';
import { createExecFileRun, loadBeadsSource } from './source.mjs';

/**
 * @typedef {'dry-run' | 'apply' | 'provision'} CliMode
 */

/**
 * @typedef {{
 *   mode: CliMode,
 *   provision: boolean,
 *   allowMassClose: boolean,
 *   inventoryFile: string | null,
 * }} CliOptions
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
 * }} CliDependencies
 */

/**
 * @typedef {{
 *   mode: CliMode,
 *   inventory: ReturnType<typeof summarizeInventory>,
 *   plannedOperationCount: number,
 *   appliedOperationCount: number,
 *   operationCounts: import('./reconcile.mjs').ReconciliationOperationCounts,
 *   visibilityDrift: boolean,
 *   closureCandidates: import('./reconcile.mjs').ReconciliationClosureCandidate[],
 *   warnings: string[],
 *   projectUrl: string | null,
 *   failure?: {
 *     kind: 'apply',
 *     failingOperation: Record<string, string | number | readonly number[] | null>,
 *     cause: string,
 *     resolvedIssueNumbersByBeadId?: Record<string, number>,
 *     resolvedProjectItemIdsByBeadId?: Record<string, string>,
 *   } | {
 *     kind: 'mass-close-safety',
 *     cause: string,
 *     closeIssueCount: number,
 *     maxCloseCount: number,
 *   },
 * }} CliSummary
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {readonly string[]} argv
 * @returns {CliOptions}
 */
export function parseCliOptions(argv) {
  let dryRun = false;
  let apply = false;
  let provision = false;
  let allowMassClose = false;
  let inventoryFile = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--apply':
        apply = true;
        break;
      case '--provision':
        provision = true;
        break;
      case '--allow-mass-close':
        allowMassClose = true;
        break;
      case '--inventory-file': {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          fail('--inventory-file requires a path');
        }
        if (inventoryFile != null) {
          fail('--inventory-file may only be supplied once');
        }
        inventoryFile = value;
        index += 1;
        break;
      }
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  if (dryRun && (apply || provision)) {
    fail('--dry-run cannot be combined with --apply or --provision');
  }
  if (!dryRun && !apply && !provision) {
    fail('Choose one mode: --dry-run, --apply, or --provision');
  }
  if (allowMassClose && provision && !apply) {
    fail('--allow-mass-close only applies to reconciliation modes');
  }

  return {
    mode: apply ? 'apply' : provision ? 'provision' : 'dry-run',
    provision,
    allowMassClose,
    inventoryFile,
  };
}

/**
 * @param {string} value
 * @param {readonly string[]} secrets
 * @returns {string}
 */
function redactSecrets(value, secrets) {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join('<redacted>');
    }
  }
  return sanitized
    .replace(/(?:github_pat|gh[pousr])_[A-Za-z0-9_]+/gu, '<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, '******');
}

/**
 * @param {unknown} error
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
function errorMessage(error, secrets = []) {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : typeof error === 'string' && error.trim()
      ? error
      : 'Unknown Beads Project sync failure';

  return redactSecrets(message, secrets)
    .replace(/(?:github_pat|gh[pousr])_[A-Za-z0-9_]+/gu, '<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer <redacted>')
    .replace(/\{[\s\S]*\}/gu, '<record redacted>')
    .replace(/\[[\s\S]*\]/gu, '<record redacted>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * @param {import('./reconcile.mjs').ReconciliationOperation} operation
 * @returns {Record<string, string | number | readonly number[] | null>}
 */
function summarizeFailingOperation(operation) {
  /** @type {Record<string, string | number | readonly number[] | null>} */
  const summary = {
    type: operation.type,
    phase: operation.phase,
  };
  for (const key of [
    'beadId',
    'issueNumber',
    'itemId',
    'path',
    'parentIssueNumber',
    'blockerIssueNumbers',
  ]) {
    if (key in operation) {
      const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (operation))[key];
      if (
        typeof value === 'string'
        || typeof value === 'number'
        || value === null
        || (Array.isArray(value) && value.every((item) => typeof item === 'number'))
      ) {
        summary[key] = value;
      }
    }
  }
  return summary;
}

/**
 * @template {number | string} TValue
 * @param {ReadonlyMap<string, TValue>} values
 * @returns {Record<string, TValue>}
 */
function sortedRecord(values) {
  return Object.fromEntries(
    [...values.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
}

/**
 * @param {ReconciliationApplyError} error
 * @param {readonly string[]} secrets
 */
function summarizeApplyFailure(error, secrets) {
  const resolvedIssueNumbersByBeadId = sortedRecord(error.issueNumbersByBeadId);
  const resolvedProjectItemIdsByBeadId = sortedRecord(error.projectItemIdsByBeadId);
  return {
    kind: /** @type {const} */ ('apply'),
    failingOperation: summarizeFailingOperation(error.failingOperation),
    cause: errorMessage(error.cause, secrets),
    ...(Object.keys(resolvedIssueNumbersByBeadId).length === 0
      ? {}
      : { resolvedIssueNumbersByBeadId }),
    ...(Object.keys(resolvedProjectItemIdsByBeadId).length === 0
      ? {}
      : { resolvedProjectItemIdsByBeadId }),
  };
}

/**
 * @param {ReconciliationApplyError} error
 * @param {number} plannedOperationCount
 * @param {ReturnType<typeof summarizeApplyFailure>} failure
 * @param {WritableStream} stderr
 */
function writeApplyFailureDiagnostics(error, plannedOperationCount, failure, stderr) {
  stderr.write(
    `Beads Project sync apply failed after ${error.applied.length} of `
    + `${plannedOperationCount} operations.\n`,
  );
  stderr.write(`Failing operation: ${JSON.stringify(failure.failingOperation)}\n`);
  if (failure.resolvedIssueNumbersByBeadId) {
    stderr.write(
      `Resolved issue numbers: ${JSON.stringify(failure.resolvedIssueNumbersByBeadId)}\n`,
    );
  }
  if (failure.resolvedProjectItemIdsByBeadId) {
    stderr.write(
      `Resolved project item IDs: ${JSON.stringify(failure.resolvedProjectItemIdsByBeadId)}\n`,
    );
  }
  stderr.write(`Cause: ${failure.cause}\n`);
}

/**
 * @param {number} managedOpenCount
 * @param {{minimum: number, fraction: number}} massClose
 * @returns {number}
 */
function massCloseLimit(managedOpenCount, massClose) {
  return Math.max(massClose.minimum, Math.ceil(managedOpenCount * massClose.fraction));
}

/**
 * @param {import('./reconcile.mjs').ReconciliationPlan} plan
 * @param {{minimum: number, fraction: number}} massClose
 * @param {boolean} allowMassClose
 * @returns {number}
 */
function validatePlanSafety(plan, massClose, allowMassClose) {
  const maxCloseCount = allowMassClose
    ? Number.MAX_SAFE_INTEGER
    : massCloseLimit(plan.summary.managedOpenCount, massClose);
  assertSafePlan(plan, {
    maxCloseCount,
  });
  return maxCloseCount;
}

/**
 * @param {import('./reconcile.mjs').ReconciliationPlan} plan
 * @param {readonly string[]} secrets
 */
function summarizePlan(plan, secrets) {
  return {
    plannedOperationCount: plan.operations.length,
    operationCounts: { ...plan.summary.operationCounts },
    visibilityDrift: plan.summary.visibilityDrift,
    closureCandidates: plan.summary.closureCandidates.map((candidate) => ({
      ...candidate,
      issueTitle: candidate.issueTitle == null
        ? null
        : redactSecrets(candidate.issueTitle, secrets)
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 256),
    })),
  };
}

/**
 * @param {import('./reconcile.mjs').ReconciliationPlan} plan
 * @returns {string}
 */
function plannedReadme(plan) {
  const operation = plan.operations.find((candidate) => candidate.type === 'updateReadme');
  if (!operation || operation.type !== 'updateReadme') {
    fail('Provisioning requires a generated Project README operation');
  }
  return operation.body;
}

/**
 * @param {import('./github.mjs').ProjectContext | null} project
 * @param {string} projectNodeId
 * @returns {asserts project is import('./github.mjs').ProjectContext}
 */
function assertPinnedPublicProject(project, projectNodeId) {
  if (!project) {
    fail(
      `Pinned Project ${projectNodeId} was not found; review the immutable GitHub Project `
        + 'binding in .github/beads-project-sync.json before rerunning.',
    );
  }
  if (project.id !== projectNodeId) {
    fail(
      `GitHub discovery returned Project ${project.id}, but configuration pins ${projectNodeId}; `
        + 'refusing to mutate either Project.',
    );
  }
  if (!project.public) {
    fail(
      `Pinned GitHub Project ${projectNodeId} is private; manual maintainer review and a manual `
        + 'Project visibility change to public are required before rerunning. Automatic visibility '
        + 'changes are disabled.',
    );
  }
}

/**
 * @param {CliSummary} summary
 * @param {WritableStream} stdout
 */
function writeSummary(summary, stdout) {
  stdout.write(`${JSON.stringify(summary)}\n`);
}

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{owner: string, runId: string, leaseId: string}}
 */
function createApplyLockIdentity(env) {
  const actionsRunId = env.GITHUB_RUN_ID?.trim();
  const actionsAttempt = env.GITHUB_RUN_ATTEMPT?.trim();
  return {
    owner: actionsRunId ? 'github-actions' : 'local-cli',
    runId: actionsRunId
      ? `actions-${actionsRunId}-${actionsAttempt || '1'}`
      : `local-${randomUUID()}`,
    leaseId: randomUUID(),
  };
}

/**
 * @param {readonly string[]} argv
 * @param {CliDependencies} [dependencies]
 * @returns {Promise<number>}
 */
export async function runBeadsProjectCli(argv, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  /** @type {string[]} */
  const diagnosticSecrets = [];

  try {
    const options = parseCliOptions(argv);
    const config = await readSyncConfig(
      dependencies.configPath ?? join(cwd, '.github/beads-project-sync.json'),
    );
    const token = env.BEADS_PROJECT_TOKEN?.trim() || null;
    if (token) {
      diagnosticSecrets.push(token);
    }
    if (options.mode !== 'dry-run' && !token) {
      fail(`BEADS_PROJECT_TOKEN is required for --${options.mode}`);
    }

    const run = dependencies.run ?? createExecFileRun();
    const jsonl = await loadBeadsSource({
      cwd,
      mode: options.mode,
      inventoryFile: options.inventoryFile,
      run,
    });
    const parsedInventory = parseBeadExport(jsonl, {
      assigneeMap: config.assigneeMap,
    });
    const inventory = parsedInventory.map((bead) => toPublicBead(bead));
    const inventorySummary = summarizeInventory(inventory);
    const renderContext = {
      projectName: config.projectTitle,
      repositoryIdentity: `${config.owner}/${config.repository}`,
      sourceRepositoryUrl: `https://github.com/${config.owner}/${config.repository}`,
      sourceRef: env.GITHUB_SHA?.trim() || 'main',
      projectMarker: config.projectMarker,
      issueMarker: config.issueMarker,
      legacyProjectMarkers: [
        ...LEGACY_PROJECT_MARKERS,
        ...(config.legacyProjectMarkers ?? []),
      ],
      legacyIssueMarkers: LEGACY_ISSUE_MARKERS,
    };
    const warnings = [];

    if (options.allowMassClose) {
      warnings.push('Mass-close safety threshold overridden for this run.');
    }

    if (!token) {
      const plan = planReconciliation({
        inventory,
        existingIssues: [],
        readme: null,
        renderContext,
      });
      validatePlanSafety(plan, config.massClose, options.allowMassClose);
      warnings.push(
        'BEADS_PROJECT_TOKEN is not set; remote state was not read and this is a first-run plan.',
      );
      stderr.write('Beads Project sync dry run completed with a first-run plan; GitHub was not contacted.\n');
      writeSummary({
        mode: options.mode,
        inventory: inventorySummary,
        ...summarizePlan(plan, diagnosticSecrets),
        appliedOperationCount: 0,
        warnings,
        projectUrl: null,
      }, stdout);
      return 0;
    }

    const gh = (dependencies.createGhClient ?? createGhClient)({
      run,
      owner: config.owner,
      repo: config.repository,
      token,
      projectNodeId: config.projectNodeId,
      projectMarker: config.projectMarker,
      issueMarker: config.issueMarker,
      legacyProjectMarkers: [
        ...LEGACY_PROJECT_MARKERS,
        ...(config.legacyProjectMarkers ?? []),
      ],
      legacyIssueMarkers: LEGACY_ISSUE_MARKERS,
    });
    await gh.verifyAccess();
    let project = await gh.discoverProject();
    assertPinnedPublicProject(project, config.projectNodeId);
    let provisionedThisRun = false;
    const firstRunPlan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext,
    });
    validatePlanSafety(firstRunPlan, config.massClose, false);
    const desiredProjectReadme = plannedReadme(firstRunPlan);
    const applyLock = options.mode === 'dry-run'
      ? null
      : await gh.acquireApplyLock(createApplyLockIdentity(env));
    const applyLease = applyLock == null
      ? null
      : gh.startApplyLockLease(applyLock);

    try {
      if (options.mode !== 'dry-run' && project) {
        await applyLease?.assertOwned();
        const repairedProject = await gh.ensureProject({
          title: config.projectTitle,
          readme: desiredProjectReadme,
        });
        if (options.mode === 'provision') {
          project = repairedProject;
        }
      }

      if (options.provision) {
        if (!project) {
          await applyLease?.assertOwned();
          const provisioned = await gh.provisionProject({
            title: config.projectTitle,
            readme: desiredProjectReadme,
          });
          project = provisioned.project;
          provisionedThisRun = true;
        }

        if (options.mode === 'provision') {
          await applyLease?.assertOwned();
          const url = project.url
            ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`;
          if (provisionedThisRun) {
            warnings.push(
              'Project infrastructure was provisioned; run --apply to reconcile issues and items.',
            );
            stderr.write(`Provisioned marked GitHub Project at ${url}.\n`);
          } else {
            warnings.push(
              'The marked Project already exists; provisioning verified and repaired its managed configuration.',
            );
            stderr.write(`Marked GitHub Project at ${url} was verified and repaired.\n`);
          }
          writeSummary({
            mode: options.mode,
            inventory: inventorySummary,
            ...summarizePlan(firstRunPlan, diagnosticSecrets),
            appliedOperationCount: 0,
            warnings,
            projectUrl: url,
          }, stdout);
          return 0;
        }
      }

      if (!project && options.mode === 'apply') {
        fail('No marked GitHub Project exists; run --provision first');
      }

      const existingIssues = await gh.listManagedIssues();
      const plan = planReconciliation({
        inventory,
        existingIssues,
        readme: project == null ? null : { body: project.readme, public: project.public },
        renderContext,
      });
      const url = project == null
        ? null
        : project.url ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`;
      try {
        validatePlanSafety(plan, config.massClose, options.allowMassClose);
      } catch (error) {
        const maxCloseCount = massCloseLimit(plan.summary.managedOpenCount, config.massClose);
        const failure = {
          kind: /** @type {const} */ ('mass-close-safety'),
          cause: errorMessage(error, diagnosticSecrets),
          closeIssueCount: plan.summary.closeIssueCount,
          maxCloseCount,
        };
        stderr.write(`Beads Project sync safety check failed: ${failure.cause}\n`);
        writeSummary({
          mode: options.mode,
          inventory: inventorySummary,
          ...summarizePlan(plan, diagnosticSecrets),
          appliedOperationCount: 0,
          warnings,
          projectUrl: url,
          failure,
        }, stdout);
        return 1;
      }

      if (options.mode === 'dry-run') {
        if (!project) {
          warnings.push('No marked GitHub Project exists; this remains a first-run plan.');
        }
        stderr.write(`Beads Project sync dry run planned ${plan.operations.length} operations.\n`);
        writeSummary({
          mode: options.mode,
          inventory: inventorySummary,
          ...summarizePlan(plan, diagnosticSecrets),
          appliedOperationCount: 0,
          warnings,
          projectUrl: project == null
            ? null
            : project.url ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`,
        }, stdout);
        return 0;
      }

      if (!provisionedThisRun) {
        await applyLease?.assertOwned();
        await gh.ensureLabels();
        await applyLease?.assertOwned();
        await gh.ensureFields();
        await applyLease?.assertOwned();
        await gh.ensureViews();
      }
      let applied;
      try {
        applied = await applyReconciliation(plan, gh);
      } catch (error) {
        if (!(error instanceof ReconciliationApplyError)) {
          throw error;
        }
        const failure = summarizeApplyFailure(error, diagnosticSecrets);
        writeApplyFailureDiagnostics(error, plan.operations.length, failure, stderr);
        writeSummary({
          mode: options.mode,
          inventory: inventorySummary,
          ...summarizePlan(plan, diagnosticSecrets),
          appliedOperationCount: error.applied.length,
          warnings,
          projectUrl: url,
          failure,
        }, stdout);
        return 1;
      }
      await applyLease?.assertOwned();
      stderr.write(`Applied ${applied.applied.length} Beads Project reconciliation operations.\n`);
      writeSummary({
        mode: options.mode,
        inventory: inventorySummary,
        ...summarizePlan(plan, diagnosticSecrets),
        appliedOperationCount: applied.applied.length,
        warnings,
        projectUrl: url,
      }, stdout);
      return 0;
    } finally {
      if (applyLease) {
        await applyLease.release();
      }
    }
  } catch (error) {
    stderr.write(`Beads Project sync failed: ${errorMessage(error, diagnosticSecrets)}\n`);
    return 1;
  }
}
