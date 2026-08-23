// @ts-check

import { join } from 'node:path';

import { readSyncConfig } from './config.mjs';
import { createGhClient } from './github.mjs';
import { parseBeadExport, summarizeInventory } from './model.mjs';
import {
  applyReconciliation,
  assertSafePlan,
  planReconciliation,
} from './reconcile.mjs';
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
 *   warnings: string[],
 *   projectUrl: string | null,
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
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/github_pat_[A-Za-z0-9_]+/gu, '<redacted>');
  }
  return 'Unknown Beads Project sync failure';
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
 */
function validatePlanSafety(plan, massClose, allowMassClose) {
  assertSafePlan(plan, {
    maxCloseCount: allowMassClose
      ? Number.MAX_SAFE_INTEGER
      : massCloseLimit(plan.summary.managedOpenCount, massClose),
  });
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
 * @param {CliSummary} summary
 * @param {WritableStream} stdout
 */
function writeSummary(summary, stdout) {
  stdout.write(`${JSON.stringify(summary)}\n`);
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

  try {
    const options = parseCliOptions(argv);
    const config = await readSyncConfig(
      dependencies.configPath ?? join(cwd, '.github/beads-project-sync.json'),
    );
    const token = env.BEADS_PROJECT_TOKEN?.trim() || null;
    if (options.mode !== 'dry-run' && !token) {
      fail(`BEADS_PROJECT_TOKEN is required for --${options.mode}`);
    }

    const run = dependencies.run ?? createExecFileRun();
    const jsonl = await loadBeadsSource({
      cwd,
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
      sourceRepositoryUrl: `https://github.com/${config.owner}/${config.repository}`,
      sourceRef: env.GITHUB_SHA?.trim() || 'main',
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
        plannedOperationCount: plan.operations.length,
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
    });
    await gh.verifyAccess();
    let project = await gh.discoverProject();
    let provisionedThisRun = false;

    if (options.provision) {
      const firstRunPlan = planReconciliation({
        inventory,
        existingIssues: [],
        readme: null,
        renderContext,
      });
      validatePlanSafety(firstRunPlan, config.massClose, false);
      if (!project) {
        const provisioned = await gh.provisionProject({
          title: config.projectTitle,
          readme: plannedReadme(firstRunPlan),
        });
        project = provisioned.project;
        provisionedThisRun = true;
      }

      if (options.mode === 'provision') {
        const url = project.url
          ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`;
        if (provisionedThisRun) {
          warnings.push('Project infrastructure was provisioned; run --apply to reconcile issues and items.');
          stderr.write(`Provisioned marked GitHub Project at ${url}.\n`);
        } else {
          warnings.push('The marked Project already exists; provisioning made no changes.');
          stderr.write(`Marked GitHub Project already exists at ${url}; provisioning made no changes.\n`);
        }
        writeSummary({
          mode: options.mode,
          inventory: inventorySummary,
          plannedOperationCount: firstRunPlan.operations.length,
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
      readme: project == null ? null : { body: project.readme },
      renderContext,
    });
    validatePlanSafety(plan, config.massClose, options.allowMassClose);

    if (options.mode === 'dry-run') {
      if (!project) {
        warnings.push('No marked GitHub Project exists; this remains a first-run plan.');
      }
      stderr.write(`Beads Project sync dry run planned ${plan.operations.length} operations.\n`);
      writeSummary({
        mode: options.mode,
        inventory: inventorySummary,
        plannedOperationCount: plan.operations.length,
        appliedOperationCount: 0,
        warnings,
        projectUrl: project == null
          ? null
          : project.url ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`,
      }, stdout);
      return 0;
    }

    if (!provisionedThisRun) {
      await gh.ensureLabels();
      await gh.ensureFields();
      await gh.ensureViews();
    }
    const applied = await applyReconciliation(plan, gh);
    const url = project == null
      ? null
      : project.url ?? `https://github.com/orgs/${config.owner}/projects/${project.number}`;
    stderr.write(`Applied ${applied.applied.length} Beads Project reconciliation operations.\n`);
    writeSummary({
      mode: options.mode,
      inventory: inventorySummary,
      plannedOperationCount: plan.operations.length,
      appliedOperationCount: applied.applied.length,
      warnings,
      projectUrl: url,
    }, stdout);
    return 0;
  } catch (error) {
    stderr.write(`Beads Project sync failed: ${errorMessage(error)}\n`);
    return 1;
  }
}
