#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSyncConfig } from './beads-project-sync/config.mjs';
import { validateTrackerDrift } from './beads-project-sync/drift.mjs';
import { BEAD_ID_PATTERN, parseBeadExport } from './beads-project-sync/model.mjs';
import { loadBeadsSource } from './beads-project-sync/source.mjs';

const DEFAULT_MAX_GITHUB_ISSUE_PAGES = 1_000;
const GITHUB_ISSUE_PAGE_SIZE = 100;

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  let inventoryFile = null;
  let issuesFile = null;
  let maxIssuePages = DEFAULT_MAX_GITHUB_ISSUE_PAGES;
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
    if (argument === '--max-issue-pages') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a positive integer`);
      maxIssuePages = Number(value);
      if (!Number.isSafeInteger(maxIssuePages) || maxIssuePages <= 0) {
        fail(`${argument} requires a positive integer`);
      }
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  return { inventoryFile, issuesFile, maxIssuePages };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function objectRecord(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? value
    : {};
}

function normalizeIssue(rawValue, config, trustedIssueAuthors) {
  const rawIssue = objectRecord(rawValue);
  if (Object.keys(rawIssue).length === 0 || rawIssue.pull_request != null) return null;
  const rawUser = objectRecord(rawIssue.user);
  const author = typeof rawUser.login === 'string' ? rawUser.login.trim().toLowerCase() : '';
  if (!trustedIssueAuthors.has(author)) return null;
  const number = rawIssue.number;
  const body = typeof rawIssue.body === 'string' ? rawIssue.body : '';
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const marker = escapeRegExp(config.issueMarker);
  const beadMatches = [...body.matchAll(new RegExp(
    `<!--\\s*${marker}\\s+bead-id=([^>]*)-->`,
    'giu',
  ))];
  if (beadMatches.length === 0) return null;
  const beadIds = beadMatches.map((match) => match[1]?.trim() ?? '');
  const markerFindingKinds = [];
  if (beadMatches.length > 1) markerFindingKinds.push('duplicate_bead_marker');
  if (beadIds.some((beadId) => !beadId)) markerFindingKinds.push('empty_bead_marker');
  if (beadIds.some((beadId) => beadId && !BEAD_ID_PATTERN.test(beadId))) {
    markerFindingKinds.push('malformed_bead_marker');
  }
  const uniqueBeadIds = [...new Set(beadIds.filter((beadId) => BEAD_ID_PATTERN.test(beadId)))];
  const beadId = uniqueBeadIds.length === 1 ? uniqueBeadIds[0] : null;
  const state = rawIssue.state === 'closed' ? 'closed' : 'open';
  if (markerFindingKinds.length > 0) {
    return { beadId, number, state, markerFindingKinds };
  }

  const renderMatches = [...body.matchAll(new RegExp(
    `<!--\\s*${marker}\\s+render-hash=([a-f0-9]{64})\\s*-->`,
    'giu',
  ))];
  if (renderMatches.length > 1) fail(`Issue #${number} contains duplicate render hashes`);

  const labels = Array.isArray(rawIssue.labels)
    ? rawIssue.labels.map((label) => {
      if (typeof label === 'string') return label;
      const record = objectRecord(label);
      return typeof record.name === 'string' ? record.name : '';
    }).filter(Boolean)
    : [];

  return {
    beadId,
    number,
    state,
    labels,
    body,
    renderHash: renderMatches[0]?.[1] ?? null,
    markerFindingKinds,
  };
}

function nextPageUrl(linkHeader, config) {
  if (typeof linkHeader !== 'string' || !linkHeader.trim()) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/iu);
    if (match == null || !match[2].split(/\s+/u).includes('next')) continue;
    const url = new URL(match[1]);
    const namedRepositoryPath = `/repos/${config.owner}/${config.repository}/issues`.toLowerCase();
    const repositoryIdPath = /^\/repositories\/[1-9]\d*\/issues$/u;
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'api.github.com'
      || url.username
      || url.password
      || (
        url.pathname.toLowerCase() !== namedRepositoryPath
        && !repositoryIdPath.test(url.pathname)
      )
    ) {
      fail('Public GitHub issue inventory returned an invalid next-page link');
    }
    return url;
  }
  return null;
}

export async function loadPublicGitHubIssues(
  config,
  fetchImpl = fetch,
  options = {},
) {
  const maxPages = options.maxPages ?? DEFAULT_MAX_GITHUB_ISSUE_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    fail('GitHub issue page safety bound must be a positive integer');
  }
  const issues = [];
  let url = new URL(`https://api.github.com/repos/${config.owner}/${config.repository}/issues`);
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', String(GITHUB_ISSUE_PAGE_SIZE));
  url.searchParams.set('page', '1');
  for (let pageCount = 1; ; pageCount += 1) {
    const response = await fetchImpl(url, {
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
    const linkedNextPage = nextPageUrl(response.headers.get('link'), config);
    if (linkedNextPage == null && pageItems.length < GITHUB_ISSUE_PAGE_SIZE) {
      return issues;
    }
    if (pageCount >= maxPages) {
      fail(`Public GitHub issue inventory exceeded the configured safety bound of ${maxPages} pages`);
    }
    if (linkedNextPage != null) {
      url = linkedNextPage;
    } else {
      const nextPage = Number(url.searchParams.get('page') ?? pageCount) + 1;
      url.searchParams.set('page', String(nextPage));
    }
  }
}

async function loadIssueInventory(options, config, dependencies) {
  if (options.issuesFile) {
    const parsed = JSON.parse(await readFile(resolve(dependencies.cwd, options.issuesFile), 'utf8'));
    if (!Array.isArray(parsed)) fail('--issues-file must contain a JSON array of GitHub issue objects');
    return parsed;
  }
  return loadPublicGitHubIssues(
    config,
    dependencies.fetchImpl,
    { maxPages: options.maxIssuePages },
  );
}

export async function runTrackerDriftCheck(argv, suppliedDependencies = {}) {
  const options = parseOptions(argv);
  const dependencies = {
    cwd: suppliedDependencies.cwd ?? process.cwd(),
    stdout: suppliedDependencies.stdout ?? process.stdout,
    stderr: suppliedDependencies.stderr ?? process.stderr,
    configPath: suppliedDependencies.configPath,
    rawIssues: suppliedDependencies.rawIssues,
    fetchImpl: suppliedDependencies.fetchImpl ?? fetch,
  };
  try {
    const config = await readSyncConfig(
      dependencies.configPath ?? resolve(dependencies.cwd, '.github/beads-project-sync.json'),
    );
    const source = await loadBeadsSource({
      cwd: dependencies.cwd,
      mode: 'dry-run',
      inventoryFile: options.inventoryFile == null
        ? null
        : resolve(dependencies.cwd, options.inventoryFile),
    });
    const beads = parseBeadExport(source, { assigneeMap: config.assigneeMap });
    const rawIssues = dependencies.rawIssues ?? await loadIssueInventory(options, config, dependencies);
    const trustedIssueAuthors = new Set(
      config.trustedIssueAuthors.map((login) => login.trim().toLowerCase()),
    );
    const managedIssues = rawIssues
      .map((issue) => normalizeIssue(issue, config, trustedIssueAuthors))
      .filter((issue) => issue != null);
    const report = validateTrackerDrift(beads, managedIssues, config.canonicalTargets);
    dependencies.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.result === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown tracker drift validation failure';
    dependencies.stderr.write(
      `Tracker drift validation failed: ${message.replace(/\s+/gu, ' ').slice(0, 1_000)}\n`,
    );
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = await runTrackerDriftCheck(process.argv.slice(2));
}
