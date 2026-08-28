#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { readSyncConfig } from './beads-project-sync/config.mjs';
import { validateTrackerDrift } from './beads-project-sync/drift.mjs';
import { parseBeadExport } from './beads-project-sync/model.mjs';
import { loadBeadsSource } from './beads-project-sync/source.mjs';

const MAX_GITHUB_ISSUE_PAGES = 10;
const GITHUB_ISSUE_PAGE_SIZE = 100;

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  let inventoryFile = null;
  let issuesFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--inventory-file' || argument === '--issues-file') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a path`);
      if (argument === '--inventory-file') inventoryFile = value;
      else issuesFile = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  return { inventoryFile, issuesFile };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeIssue(rawIssue, config) {
  if (typeof rawIssue !== 'object' || rawIssue == null || Array.isArray(rawIssue)) return null;
  if ('pull_request' in rawIssue && rawIssue.pull_request != null) return null;
  const author = typeof rawIssue.user === 'object' && rawIssue.user != null
    ? String(rawIssue.user.login ?? '').toLowerCase()
    : '';
  if (!config.trustedIssueAuthors.includes(author)) return null;
  const number = rawIssue.number;
  const body = typeof rawIssue.body === 'string' ? rawIssue.body : '';
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const marker = escapeRegExp(config.issueMarker);
  const beadMatches = [...body.matchAll(new RegExp(
    `<!--\\s*${marker}\\s+bead-id=([^\\s>]+)\\s*-->`,
    'giu',
  ))];
  if (beadMatches.length === 0) return null;
  if (beadMatches.length !== 1) fail(`Issue #${number} contains duplicate managed Bead markers`);
  const beadId = beadMatches[0][1];
  const renderMatches = [...body.matchAll(new RegExp(
    `<!--\\s*${marker}\\s+render-hash=([a-f0-9]{64})\\s*-->`,
    'giu',
  ))];
  if (renderMatches.length > 1) fail(`Issue #${number} contains duplicate render hashes`);

  const labels = Array.isArray(rawIssue.labels)
    ? rawIssue.labels.map((label) => (
      typeof label === 'string'
        ? label
        : typeof label === 'object' && label != null
          ? String(label.name ?? '')
          : ''
    )).filter(Boolean)
    : [];

  return {
    beadId,
    number,
    state: rawIssue.state === 'closed' ? 'closed' : 'open',
    labels,
    body,
    renderHash: renderMatches[0]?.[1] ?? null,
  };
}

async function loadPublicGitHubIssues(config) {
  const issues = [];
  for (let page = 1; page <= MAX_GITHUB_ISSUE_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/repos/${config.owner}/${config.repository}/issues`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', String(GITHUB_ISSUE_PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'psyche-build-tracker-drift-check',
      },
      redirect: 'error',
    });
    if (!response.ok) {
      fail(`Public GitHub issue inventory failed with HTTP ${response.status}`);
    }
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) fail('Public GitHub issue inventory returned a non-array payload');
    issues.push(...pageItems);
    if (pageItems.length < GITHUB_ISSUE_PAGE_SIZE) return issues;
  }
  fail(`Public GitHub issue inventory exceeded ${MAX_GITHUB_ISSUE_PAGES} pages`);
}

async function loadIssueInventory(options, config) {
  if (options.issuesFile) {
    const parsed = JSON.parse(await readFile(resolve(options.issuesFile), 'utf8'));
    if (!Array.isArray(parsed)) fail('--issues-file must contain a JSON array of GitHub issue objects');
    return parsed;
  }
  return loadPublicGitHubIssues(config);
}

export async function runTrackerDriftCheck(argv, dependencies = {}) {
  const options = parseOptions(argv);
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const config = await readSyncConfig(
      dependencies.configPath ?? resolve(cwd, '.github/beads-project-sync.json'),
    );
    const source = await loadBeadsSource({
      cwd,
      mode: 'dry-run',
      inventoryFile: options.inventoryFile == null ? null : resolve(cwd, options.inventoryFile),
    });
    const beads = parseBeadExport(source, { assigneeMap: config.assigneeMap });
    const rawIssues = dependencies.rawIssues ?? await loadIssueInventory(options, config);
    const managedIssues = rawIssues
      .map((issue) => normalizeIssue(issue, config))
      .filter((issue) => issue != null);
    const report = validateTrackerDrift(beads, managedIssues, config.canonicalTargets);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.result === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown tracker drift validation failure';
    stderr.write(`Tracker drift validation failed: ${message.replace(/\s+/gu, ' ').slice(0, 1_000)}\n`);
    return 2;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await runTrackerDriftCheck(process.argv.slice(2));
}
