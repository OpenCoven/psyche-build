#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSyncConfig } from './beads-project-sync/config.mjs';
import { validateTrackerDrift } from './beads-project-sync/drift.mjs';
import { partitionRecoveryIssues, retirementNotice } from './beads-project-sync/recovery.mjs';
import {
  LEGACY_ISSUE_MARKERS,
  recognizedMarkers,
} from './beads-project-sync/markers.mjs';
import { BEAD_ID_PATTERN, parseBeadExport } from './beads-project-sync/model.mjs';
import { loadBeadsSource } from './beads-project-sync/source.mjs';

const DEFAULT_MAX_GITHUB_ISSUE_PAGES = 1_000;
const GITHUB_ISSUE_PAGE_SIZE = 100;

class TrackerDriftCliError extends Error {}

function fail(message) {
  throw new TrackerDriftCliError(message);
}

function parseOptions(argv) {
  let inventoryFile = null;
  let issuesFile = null;
  let maxIssuePages = DEFAULT_MAX_GITHUB_ISSUE_PAGES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--inventory-file' || argument === '--issues-file') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('invalid command-line options');
      if (argument === '--inventory-file') inventoryFile = value;
      else issuesFile = value;
      index += 1;
      continue;
    }
    if (argument === '--max-issue-pages') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('invalid command-line options');
      maxIssuePages = Number(value);
      if (!Number.isSafeInteger(maxIssuePages) || maxIssuePages <= 0) {
        fail('invalid command-line options');
      }
      index += 1;
      continue;
    }
    fail('invalid command-line options');
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

function normalizeIssue(rawValue, config, trustedIssueAuthors, issueMarkers) {
  const rawIssue = objectRecord(rawValue);
  if (Object.keys(rawIssue).length === 0 || rawIssue.pull_request != null) return null;
  const rawUser = objectRecord(rawIssue.user);
  const author = typeof rawUser.login === 'string' ? rawUser.login.trim().toLowerCase() : '';
  if (!trustedIssueAuthors.has(author)) return null;
  const number = rawIssue.number;
  const body = typeof rawIssue.body === 'string' ? rawIssue.body : '';
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const markerAlternatives = issueMarkers.map(escapeRegExp).join('|');
  const markerTokens = new Set(issueMarkers.map((value) => value.toLowerCase()));
  const markerComments = [...body.matchAll(/<!--[\s\S]*?-->/gu)]
    .map((match) => match[0])
    .filter((comment) => {
      const markerToken = comment
        .slice(4, -3)
        .trim()
        .match(/^([A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,199}))(?=\s|$)/u)?.[1];
      return markerToken != null && markerTokens.has(markerToken.toLowerCase());
    });
  if (markerComments.length === 0) return null;

  const exactBeadMarker = new RegExp(
    `^<!-- (?:${markerAlternatives}) bead-id=([^\\r\\n>]*) -->$`,
    'u',
  );
  const exactRenderHashMarker = new RegExp(
    `^<!-- (?:${markerAlternatives}) render-hash=([^\\r\\n>]*) -->$`,
    'u',
  );
  const beadIds = [];
  const renderValues = [];
  let beadMarkerCount = 0;
  let renderHashMarkerCount = 0;
  let emptyRenderHashMarker = false;
  let malformedBeadMarker = false;
  let malformedRenderHashMarker = false;

  for (const comment of markerComments) {
    const beadMatch = comment.match(exactBeadMarker);
    if (beadMatch != null) {
      beadMarkerCount += 1;
      beadIds.push(beadMatch[1] ?? '');
      continue;
    }
    const renderMatch = comment.match(exactRenderHashMarker);
    if (renderMatch != null) {
      renderHashMarkerCount += 1;
      const value = renderMatch[1] ?? '';
      renderValues.push(/^[a-f0-9]{64}$/u.test(value) ? value : null);
      if (value === '') {
        emptyRenderHashMarker = true;
      } else if (!/^[a-f0-9]{64}$/u.test(value)) {
        malformedRenderHashMarker = true;
      }
      continue;
    }

    const hasBeadField = /\bbead-id\b/iu.test(comment);
    const hasRenderHashField = /\brender-hash\b/iu.test(comment);
    if (hasBeadField || !hasRenderHashField) {
      beadMarkerCount += 1;
      malformedBeadMarker = true;
    }
    if (hasRenderHashField) {
      renderHashMarkerCount += 1;
      malformedRenderHashMarker = true;
    }
  }

  const markerFindingKinds = [];
  if (beadMarkerCount === 0 && renderHashMarkerCount > 0) {
    markerFindingKinds.push('missing_bead_marker');
  }
  if (beadMarkerCount > 1) markerFindingKinds.push('duplicate_bead_marker');
  if (beadIds.some((beadId) => beadId === '')) markerFindingKinds.push('empty_bead_marker');
  if (malformedBeadMarker || beadIds.some((beadId) => !BEAD_ID_PATTERN.test(beadId))) {
    markerFindingKinds.push('malformed_bead_marker');
  }
  const uniqueBeadIds = [...new Set(
    beadIds.filter((beadId) => BEAD_ID_PATTERN.test(beadId)),
  )];
  const beadId = uniqueBeadIds.length === 1 ? uniqueBeadIds[0] : null;
  const state = rawIssue.state === 'closed' ? 'closed' : 'open';

  if (renderHashMarkerCount > 1) markerFindingKinds.push('duplicate_render_hash_marker');
  if (emptyRenderHashMarker) {
    markerFindingKinds.push('empty_render_hash_marker');
  }
  if (malformedRenderHashMarker) {
    markerFindingKinds.push('malformed_render_hash_marker');
  }

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
    renderHash: renderValues.find((value) => value != null) ?? null,
    markerFindingKinds,
  };
}

function nextPageUrl(linkHeader, config) {
  if (linkHeader == null) return null;
  let next = null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/iu);
    if (match == null) fail('Public GitHub issue inventory returned an invalid next-page link');
    if (!match[2].split(/\s+/u).includes('next')) continue;
    if (next != null || !URL.canParse(match[1])) {
      fail('Public GitHub issue inventory returned an invalid next-page link');
    }
    const url = new URL(match[1]);
    const namedRepositoryPath = `/repos/${config.owner}/${config.repository}/issues`;
    const repositoryIdPath = /^\/repositories\/[1-9]\d*\/issues$/u;
    const parameters = url.searchParams;
    if (
      url.origin !== 'https://api.github.com'
      || url.username
      || url.password
      || url.hash
      || (
        url.pathname.toLowerCase() !== namedRepositoryPath.toLowerCase()
        && !repositoryIdPath.test(url.pathname)
      )
      || parameters.get('state') !== 'all'
      || parameters.get('per_page') !== '100'
      || !/^[1-9]\d*$/u.test(parameters.get('page') ?? '')
      || [...parameters.keys()].some((key) =>
        !['state', 'per_page', 'page', 'after'].includes(key)
        || parameters.getAll(key).length !== 1)
    ) {
      fail('Public GitHub issue inventory returned an invalid next-page link');
    }
    // Match the sync client's numeric-alias handling: never leave the configured repository.
    next = new URL(`https://api.github.com${namedRepositoryPath}${url.search}`);
  }
  return next;
}

function assertRepositoryIdentity(config) {
  if (typeof config.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(config.owner)
    || typeof config.repository !== 'string'
    || !/^[A-Za-z0-9_.-]+$/u.test(config.repository)
    || ['.', '..'].includes(config.repository)) {
    fail('Invalid GitHub repository identity');
  }
}

async function readGitHub(url, fetchImpl, env) {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  try {
    return await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'psyche-build-tracker-drift-check',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
    });
  } catch {
    fail('GitHub read request failed');
  }
}

export async function loadPublicGitHubIssues(
  config,
  fetchImpl = fetch,
  options = {},
) {
  assertRepositoryIdentity(config);
  const env = options.env ?? process.env;
  const maxPages = options.maxPages ?? DEFAULT_MAX_GITHUB_ISSUE_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    fail('GitHub issue page safety bound must be a positive integer');
  }
  const issues = [];
  let url = new URL(`https://api.github.com/repos/${config.owner}/${config.repository}/issues`);
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', String(GITHUB_ISSUE_PAGE_SIZE));
  url.searchParams.set('page', '1');
  const seenUrls = new Set();
  for (let pageCount = 1; ; pageCount += 1) {
    if (seenUrls.has(url.href)) fail('Public GitHub issue inventory returned a repeated next-page link');
    seenUrls.add(url.href);
    const response = await readGitHub(url, fetchImpl, env);
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
    { maxPages: options.maxIssuePages, env: dependencies.env },
  );
}

async function assertRetiredRelationshipsEmpty(number, config, fetchImpl, env) {
  assertRepositoryIdentity(config);
  for (const suffix of ['sub_issues', 'dependencies/blocking', 'dependencies/blocked_by', 'parent']) {
    const response = await readGitHub(
      `https://api.github.com/repos/${config.owner}/${config.repository}/issues/${number}/${suffix}${suffix === 'parent' ? '' : '?per_page=100&page=1'}`,
      fetchImpl,
      env,
    );
    if (suffix === 'parent' && response.status === 404) continue;
    if (!response.ok) fail('Recovery relationship inventory is unavailable');
    const values = await response.json();
    // Only a complete empty connection proves retirement; partial/offline issue
    // inventories alone cannot establish the absence of incoming references.
    if (suffix === 'parent' || !Array.isArray(values) || values.length !== 0
      || response.headers.get('link') != null) {
      fail('Recovery relationships remain or the relationship inventory is incomplete');
    }
  }
}

export async function runTrackerDriftCheck(argv, suppliedDependencies = {}) {
  const dependencies = {
    cwd: suppliedDependencies.cwd ?? process.cwd(),
    stdout: suppliedDependencies.stdout ?? process.stdout,
    stderr: suppliedDependencies.stderr ?? process.stderr,
    configPath: suppliedDependencies.configPath,
    rawIssues: suppliedDependencies.rawIssues,
    fetchImpl: suppliedDependencies.fetchImpl ?? fetch,
    env: suppliedDependencies.env ?? process.env,
  };
  try {
    const options = parseOptions(argv);
    let config;
    try {
      config = await readSyncConfig(
        dependencies.configPath ?? resolve(dependencies.cwd, '.github/beads-project-sync.json'),
      );
    } catch {
      fail('unable to read or validate sync configuration');
    }

    let source;
    try {
      source = await loadBeadsSource({
        cwd: dependencies.cwd,
        mode: 'dry-run',
        inventoryFile: options.inventoryFile == null
          ? null
          : resolve(dependencies.cwd, options.inventoryFile),
      });
    } catch {
      fail(options.inventoryFile == null
        ? 'unable to establish Beads inventory'
        : 'unable to read or parse inventory input');
    }

    let beads;
    try {
      beads = parseBeadExport(source, {
        assigneeMap: config.assigneeMap,
        deferCanonicalOutcomeValidation: true,
      });
    } catch {
      fail(options.inventoryFile == null
        ? 'unable to parse Beads inventory'
        : 'unable to read or parse inventory input');
    }

    let rawIssues;
    if (dependencies.rawIssues != null) {
      rawIssues = dependencies.rawIssues;
    } else {
      try {
        rawIssues = await loadIssueInventory(options, config, dependencies);
      } catch (error) {
        if (error instanceof TrackerDriftCliError && options.issuesFile == null) {
          throw error;
        }
        fail(options.issuesFile == null
          ? 'unable to establish public issue inventory'
          : 'unable to read or parse issues input');
      }
    }
    const trustedIssueAuthors = new Set(
      config.trustedIssueAuthors.map((login) => login.trim().toLowerCase()),
    );
    const issueMarkers = recognizedMarkers(
      config.issueMarker,
      LEGACY_ISSUE_MARKERS,
      'tracker drift issue marker',
    );
    const recovery = partitionRecoveryIssues(rawIssues.map((raw) => {
      const issue = objectRecord(raw);
      return {
        number: issue.number,
        body: issue.body,
        state: issue.state,
        repository: `${config.owner}/${config.repository}`,
        author: objectRecord(issue.user).login,
      };
    }));
    const retired = new Set(recovery.aliases.filter(({ issue, beadId, survivor }) =>
      issue.state === 'closed'
      && issue.body?.endsWith(retirementNotice(beadId, survivor, issue.number)))
      .map(({ issue }) => issue.number));
    if (retired.size && (options.issuesFile || dependencies.rawIssues != null)
      && suppliedDependencies.fetchImpl == null) {
      fail('Recovery relationship verification requires a live inventory or an explicit fixture reader');
    }
    for (const number of retired) {
      await assertRetiredRelationshipsEmpty(number, config, dependencies.fetchImpl, dependencies.env);
    }
    const managedIssues = rawIssues.filter((issue) => !retired.has(objectRecord(issue).number))
      .map((issue) => normalizeIssue(issue, config, trustedIssueAuthors, issueMarkers))
      .filter((issue) => issue != null);
    const report = validateTrackerDrift(
      beads,
      managedIssues,
      config.canonicalTargets,
      { issueMarkers },
    );
    dependencies.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.result === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof TrackerDriftCliError
      ? error.message
      : 'unexpected validation failure';
    dependencies.stderr.write(
      `Tracker drift validation failed: ${message.replace(/\s+/gu, ' ').slice(0, 256)}\n`,
    );
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = await runTrackerDriftCheck(process.argv.slice(2));
}
