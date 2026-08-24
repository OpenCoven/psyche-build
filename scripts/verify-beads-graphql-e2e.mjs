#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBeadsProjectCli } from './beads-project-sync/cli.mjs';
import { createExecFileRun } from './beads-project-sync/source.mjs';

/** @typedef {import('./verify-beads-graphql-e2e.mjs').GraphqlE2eOptions} GraphqlE2eOptions */
/** @typedef {import('./verify-beads-graphql-e2e.mjs').GraphqlE2eReport} GraphqlE2eReport */
/** @typedef {import('./beads-project-sync/source.mjs').ExecFileRun} ExecFileRun */

const REQUIRED_OPERATIONS = Object.freeze([
  'DiscoverManagedProject',
  'DiscoverManagedProjectItems',
]);
const REQUIRED_OPERATION_NAMES = new Set(REQUIRED_OPERATIONS);
const ALLOWED_OPERATION_NAMES = new Set([
  ...REQUIRED_OPERATIONS,
  'DiscoverLinkedProjectRepositories',
]);
const MAX_GRAPHQL_REQUESTS = 200;
const MAX_PAGES_PER_OPERATION = 100;

/**
 * @returns {{
 *   stream: { write(chunk: string): boolean },
 *   read(): string,
 * }}
 */
function captureStream() {
  let value = '';
  return {
    stream: {
      write(chunk) {
        value += chunk;
        return true;
      },
    },
    read() {
      return value;
    },
  };
}

/**
 * @param {string | undefined} stdin
 * @returns {{
 *   kind: 'query' | 'mutation',
 *   name: string,
 *   signature: string,
 *   cursorKey: string,
 * }}
 */
function parseGraphqlRequest(stdin) {
  if (typeof stdin !== 'string' || !stdin.trim()) {
    throw new Error('GraphQL request is missing JSON stdin');
  }
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    throw new Error('GraphQL request contains invalid JSON stdin');
  }
  const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
  const match = query.match(/^(query|mutation)\s+([A-Za-z0-9_]+)/u);
  if (!match) {
    throw new Error('GraphQL request is missing a named operation');
  }
  const variables = payload?.variables;
  if (
    variables != null
    && (typeof variables !== 'object' || Array.isArray(variables))
  ) {
    throw new Error('GraphQL request variables must be an object when present');
  }
  const cursor = variables == null
    ? undefined
    : /** @type {Record<string, unknown>} */ (variables).cursor;
  if (cursor != null && typeof cursor !== 'string') {
    throw new Error(`GraphQL pagination cursor for "${match[2]}" must be a string or null`);
  }
  return {
    kind: match[1],
    name: match[2],
    signature: createHash('sha256').update(stdin).digest('hex'),
    cursorKey: cursor === undefined
      ? 'missing'
      : cursor === null
        ? 'null'
        : `string:${cursor}`,
  };
}

/**
 * @param {string} stdout
 * @returns {import('./beads-project-sync/cli.mjs').CliSummary}
 */
function parseSummary(stdout) {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const finalLine = lines.at(-1);
  if (!finalLine) {
    throw new Error('Beads GraphQL E2E did not emit a summary');
  }
  try {
    return JSON.parse(finalLine);
  } catch {
    throw new Error('Beads GraphQL E2E emitted an invalid summary');
  }
}

/**
 * @param {string} value
 * @param {string} token
 */
function redact(value, token) {
  return value.split(token).join('[REDACTED]');
}

/**
 * @param {GraphqlE2eOptions} [options]
 * @returns {Promise<GraphqlE2eReport>}
 */
export async function runBeadsGraphqlE2e(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const token = env.BEADS_PROJECT_TOKEN?.trim();
  if (!token) {
    throw new Error('BEADS_PROJECT_TOKEN is required for the live GraphQL E2E');
  }

  const delegateRun = options.run ?? createExecFileRun();
  const runCli = options.runCli ?? runBeadsProjectCli;
  const operations = /** @type {{
   *   kind: 'query',
   *   name: string,
   *   signature: string,
   *   cursorKey: string,
   * }[]} */ ([]);
  const signatures = new Set();
  const cursorsByOperation = new Map(
    [...ALLOWED_OPERATION_NAMES].map((name) => [name, new Set()]),
  );
  let graphqlAttemptCount = 0;

  /** @type {ExecFileRun} */
  const tracedRun = async (command, args, runOptions) => {
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      const operation = parseGraphqlRequest(runOptions.stdin);
      if (operation.kind === 'mutation') {
        throw new Error(
          `GraphQL mutation "${operation.name}" is forbidden during the read-only E2E`,
        );
      }
      if (!ALLOWED_OPERATION_NAMES.has(operation.name)) {
        throw new Error(`Unexpected GraphQL operation "${operation.name}" during read-only E2E`);
      }
      if (graphqlAttemptCount >= MAX_GRAPHQL_REQUESTS) {
        throw new Error(
          `GraphQL request ceiling exceeded: ${graphqlAttemptCount + 1} > `
            + `${MAX_GRAPHQL_REQUESTS}`,
        );
      }
      graphqlAttemptCount += 1;
      if (signatures.has(operation.signature)) {
        throw new Error(`Duplicate GraphQL request detected for "${operation.name}"`);
      }
      const cursors = cursorsByOperation.get(operation.name);
      if (!cursors) {
        throw new Error(`Unexpected GraphQL operation "${operation.name}" during read-only E2E`);
      }
      if (cursors.has(operation.cursorKey)) {
        throw new Error(
          `Duplicate GraphQL pagination cursor detected for "${operation.name}"`,
        );
      }
      if (cursors.size >= MAX_PAGES_PER_OPERATION) {
        throw new Error(
          `GraphQL pagination page ceiling exceeded for "${operation.name}": `
            + `${cursors.size + 1} > ${MAX_PAGES_PER_OPERATION}`,
        );
      }
      const result = await delegateRun(command, args, runOptions);
      if ((result.exitCode ?? 0) === 0) {
        signatures.add(operation.signature);
        cursors.add(operation.cursorKey);
        operations.push({
          kind: 'query',
          name: operation.name,
          signature: operation.signature,
          cursorKey: operation.cursorKey,
        });
      }
      return result;
    }
    return delegateRun(command, args, runOptions);
  };

  const stdout = captureStream();
  const stderr = captureStream();
  let exitCode;
  try {
    exitCode = await runCli(['--dry-run'], {
      cwd,
      env,
      run: tracedRun,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown dry-run failure';
    throw new Error(redact(message, token));
  }
  if (exitCode !== 0) {
    const detail = redact(stderr.read().trim(), token);
    throw new Error(detail || `Beads GraphQL E2E failed with exit code ${exitCode}`);
  }

  if (graphqlAttemptCount > MAX_GRAPHQL_REQUESTS) {
    throw new Error(
      `GraphQL request ceiling exceeded: ${graphqlAttemptCount} > ${MAX_GRAPHQL_REQUESTS}`,
    );
  }
  for (const required of REQUIRED_OPERATIONS) {
    if (!operations.some((operation) => operation.name === required)) {
      throw new Error(`Required GraphQL operation "${required}" was not observed`);
    }
  }

  const summary = parseSummary(stdout.read());
  if (summary?.mode !== 'dry-run' || summary?.appliedOperationCount !== 0) {
    throw new Error('Beads GraphQL E2E did not remain read-only');
  }
  const pageCounts = {
    DiscoverManagedProject:
      cursorsByOperation.get('DiscoverManagedProject')?.size ?? 0,
    DiscoverLinkedProjectRepositories:
      cursorsByOperation.get('DiscoverLinkedProjectRepositories')?.size ?? 0,
    DiscoverManagedProjectItems:
      cursorsByOperation.get('DiscoverManagedProjectItems')?.size ?? 0,
  };

  return {
    graphqlRequestCount: operations.length,
    operations: operations.map(({ kind, name }) => ({ kind, name })),
    pageCounts,
    summary,
    diagnostics: redact(stderr.read().trim(), token),
  };
}

async function main() {
  try {
    const report = await runBeadsGraphqlE2e();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown GraphQL E2E failure';
    process.stderr.write(`Beads GraphQL E2E failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
