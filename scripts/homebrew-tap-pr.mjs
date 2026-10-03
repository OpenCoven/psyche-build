#!/usr/bin/env node

// Proposes and verifies the Psyche Build Cask bump on OpenCoven/homebrew-tap
// entirely through the GitHub REST API: no clone, no git push, no credential
// in a remote URL. `open` is idempotent and never merges; `verify` re-reads
// what the tap actually holds and fails closed unless it carries exactly the
// release's version and both SHA256SUMS digests.
//
//   HOMEBREW_TAP_TOKEN=… node scripts/homebrew-tap-pr.mjs open   --tag vX.Y.Z --sums SHA256SUMS
//   GH_TOKEN=…           node scripts/homebrew-tap-pr.mjs verify --tag vX.Y.Z --sums SHA256SUMS --result open
//
// The token is read only from the environment, is sent only in the
// Authorization header, and is never included in an error or log line.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  CASK_PATH,
  normalizeVersion,
  parseSha256Sums,
  readCaskRelease,
  renderHomebrewCask,
} from './render-homebrew-cask.mjs';

export const TAP_OWNER = 'OpenCoven';
export const TAP_REPO = 'homebrew-tap';
export const TAP_BASE = 'main';
const API_ROOT = 'https://api.github.com';

export function tapBranchName(version) {
  return `psyche-build-${normalizeVersion(version)}`;
}

export class GitHubApiError extends Error {
  constructor(method, path, status, detail) {
    super(`GitHub API ${method} ${path} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/**
 * Minimal REST client. `request(method, path, body?)` resolves parsed JSON
 * for 2xx, `null` for 404 when `{ allowNotFound: true }`, and throws
 * otherwise. Error messages carry only the method, path, status, and
 * GitHub's `message` field — never request headers.
 */
export function createGitHubApi(token, fetchImpl = globalThis.fetch) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('A GitHub token is required');
  }
  return {
    async request(method, path, body, { allowNotFound = false } = {}) {
      const response = await fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (allowNotFound && response.status === 404) return null;
      const text = await response.text();
      let json = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = json && typeof json.message === 'string' ? json.message : '';
        throw new GitHubApiError(method, path, response.status, detail);
      }
      return json;
    },
  };
}

const repoPath = `/repos/${TAP_OWNER}/${TAP_REPO}`;

function decodeContent(file, where) {
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error(`${CASK_PATH} at ${where} is not a base64 file response`);
  }
  return { text: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
}

async function readCask(api, ref) {
  const file = await api.request(
    'GET',
    `${repoPath}/contents/${CASK_PATH}?ref=${encodeURIComponent(ref)}`,
  );
  return decodeContent(file, ref);
}

function prBody(release) {
  return [
    `Bumps the Psyche Build Cask to the published v${release.version}.`,
    '',
    'Opened by the OpenCoven/psyche-build Release workflow after publication. The version and',
    "both architecture checksums come from the published release's `SHA256SUMS`; every other",
    'Cask stanza is unchanged. The workflow re-reads this pull request and fails unless it carries',
    'exactly these values:',
    '',
    `- version: \`${release.version}\``,
    `- arm (aarch64): \`${release.arm}\``,
    `- intel (x86_64): \`${release.intel}\``,
    '',
    'Merging stays with tap CI and a maintainer; the workflow never merges.',
  ].join('\n');
}

/**
 * Ensures a pull request proposing `release` exists on the tap, or reports
 * that the tap's default branch already carries it. Safe to re-run:
 * an existing branch, commit, or open pull request is reused, and anything
 * it cannot prove is ours (an unexpected Cask on the branch, a pull request
 * a maintainer closed) stops the run instead of being overwritten.
 */
export async function openHomebrewTapPullRequest(api, release, log = () => {}) {
  const branch = tapBranchName(release.version);
  const baseRef = await api.request('GET', `${repoPath}/git/ref/heads/${TAP_BASE}`);
  const baseSha = baseRef?.object?.sha;
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error(`Unable to resolve ${TAP_OWNER}/${TAP_REPO}@${TAP_BASE}`);
  }

  const base = await readCask(api, baseSha);
  const rendered = renderHomebrewCask(base.text, release);
  if (!rendered.changed) {
    log(`${TAP_BASE} already carries psyche-build ${release.version}; no pull request needed`);
    return { result: 'already-current', branch, prNumber: null, prUrl: null };
  }

  const existingBranch = await api.request('GET', `${repoPath}/git/ref/heads/${branch}`, undefined, {
    allowNotFound: true,
  });
  if (!existingBranch) {
    await api.request('POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
    log(`created branch ${branch} at ${baseSha}`);
  } else {
    log(`reusing existing branch ${branch}`);
  }

  const onBranch = await readCask(api, branch);
  if (onBranch.text === rendered.cask) {
    log(`${branch} already carries the rendered Cask`);
  } else if (onBranch.text === base.text) {
    await api.request('PUT', `${repoPath}/contents/${CASK_PATH}`, {
      message: `psyche-build ${release.version}`,
      content: Buffer.from(rendered.cask, 'utf8').toString('base64'),
      sha: onBranch.sha,
      branch,
    });
    log(`committed the rendered Cask to ${branch}`);
  } else {
    throw new Error(
      `${branch} already holds a different ${CASK_PATH}; refusing to overwrite it. ` +
        'Inspect the branch, delete it if stale, and re-run.',
    );
  }

  const pulls = await api.request(
    'GET',
    `${repoPath}/pulls?state=all&base=${TAP_BASE}&head=${encodeURIComponent(`${TAP_OWNER}:${branch}`)}&per_page=100`,
  );
  if (!Array.isArray(pulls)) throw new Error('Unexpected pull request listing');
  const open = pulls.filter((pull) => pull.state === 'open');
  if (open.length > 1) throw new Error(`More than one open pull request uses ${branch}`);
  if (open.length === 1) {
    log(`reusing open pull request #${open[0].number}`);
    return { result: 'open', branch, prNumber: open[0].number, prUrl: open[0].html_url };
  }
  const closedUnmerged = pulls.find((pull) => pull.state === 'closed' && !pull.merged_at);
  if (closedUnmerged) {
    throw new Error(
      `Pull request #${closedUnmerged.number} for ${branch} was closed without merging; ` +
        'refusing to reopen a maintainer decision.',
    );
  }

  const created = await api.request('POST', `${repoPath}/pulls`, {
    title: `psyche-build ${release.version}`,
    head: branch,
    base: TAP_BASE,
    body: prBody(release),
    maintainer_can_modify: true,
  });
  log(`opened pull request #${created.number}`);
  return { result: 'open', branch, prNumber: created.number, prUrl: created.html_url };
}

function assertCaskCarries(caskText, release, where) {
  const actual = readCaskRelease(caskText);
  const mismatches = ['version', 'arm', 'intel'].filter((key) => actual[key] !== release[key]);
  if (mismatches.length > 0) {
    throw new Error(`${where} does not match SHA256SUMS (${mismatches.join(', ')} differ)`);
  }
}

const ALLOWED_PATCH_LINE = /^[+-](?: {2}version "[^"]*"| {2}sha256 arm: +"[^"]*",| +intel: "[^"]*")$/;

/**
 * Re-reads the tap and fails unless it carries exactly `release`. For an
 * open pull request it checks the PR's identity, that it changes only the
 * Cask, that the diff touches only the version and checksum lines, and that
 * the Cask at the PR head carries the expected values.
 */
export async function verifyHomebrewTapPullRequest(api, release, opened) {
  if (opened.result === 'already-current') {
    const base = await readCask(api, TAP_BASE);
    assertCaskCarries(base.text, release, `${TAP_OWNER}/${TAP_REPO}@${TAP_BASE}`);
    return { verified: `${TAP_BASE} already carries psyche-build ${release.version}` };
  }
  if (opened.result !== 'open' || !Number.isInteger(opened.prNumber)) {
    throw new Error('Nothing to verify: no tap pull request number was recorded');
  }

  const branch = tapBranchName(release.version);
  const pull = await api.request('GET', `${repoPath}/pulls/${opened.prNumber}`);
  const fullName = `${TAP_OWNER}/${TAP_REPO}`;
  if (pull.state !== 'open' && !pull.merged) {
    throw new Error(`Tap pull request #${opened.prNumber} is ${pull.state}, not open`);
  }
  if (pull.base?.ref !== TAP_BASE || pull.base?.repo?.full_name !== fullName) {
    throw new Error(`Tap pull request #${opened.prNumber} does not target ${fullName}@${TAP_BASE}`);
  }
  if (pull.head?.ref !== branch || pull.head?.repo?.full_name !== fullName) {
    throw new Error(`Tap pull request #${opened.prNumber} is not from ${fullName}:${branch}`);
  }
  const headSha = pull.head?.sha;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`Tap pull request #${opened.prNumber} has no head commit`);
  }

  const files = await api.request('GET', `${repoPath}/pulls/${opened.prNumber}/files?per_page=100`);
  if (!Array.isArray(files) || files.length !== 1 || files[0].filename !== CASK_PATH) {
    throw new Error(`Tap pull request #${opened.prNumber} must change exactly ${CASK_PATH}`);
  }
  const patch = typeof files[0].patch === 'string' ? files[0].patch : '';
  const changedLines = patch
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !/^(?:\+\+\+|---) /.test(line));
  if (changedLines.length === 0) {
    throw new Error(`Tap pull request #${opened.prNumber} diff is empty or unreadable`);
  }
  const unexpected = changedLines.filter((line) => !ALLOWED_PATCH_LINE.test(line));
  if (unexpected.length > 0) {
    throw new Error(
      `Tap pull request #${opened.prNumber} changes ${unexpected.length} line(s) beyond version and sha256`,
    );
  }
  for (const value of [`"${release.version}"`, release.arm, release.intel]) {
    if (!changedLines.some((line) => line.startsWith('+') && line.includes(value))) {
      throw new Error(`Tap pull request #${opened.prNumber} diff does not add ${value}`);
    }
  }

  const atHead = await readCask(api, headSha);
  assertCaskCarries(atHead.text, release, `Tap pull request #${opened.prNumber} at ${headSha}`);
  return { verified: `pull request #${opened.prNumber} at ${headSha} carries psyche-build ${release.version}` };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!['--tag', '--sums', '--result', '--pr'].includes(key) || value === undefined) {
      throw new Error(`Unknown or incomplete argument ${key ?? ''}`);
    }
    options[key.slice(2)] = value;
  }
  if (!['open', 'verify'].includes(command) || !options.tag || !options.sums) {
    throw new Error(
      'Usage: homebrew-tap-pr.mjs open --tag vX.Y.Z --sums SHA256SUMS\n' +
        '       homebrew-tap-pr.mjs verify --tag vX.Y.Z --sums SHA256SUMS --result open|already-current [--pr N]',
    );
  }
  return { command, options };
}

function writeOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value ?? ''}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(options.tag);
  const release = parseSha256Sums(readFileSync(options.sums, 'utf8'), version);
  const log = (message) => console.log(message);

  if (command === 'open') {
    const api = createGitHubApi(process.env.HOMEBREW_TAP_TOKEN ?? '');
    const opened = await openHomebrewTapPullRequest(api, release, log);
    writeOutputs({ result: opened.result, pr_number: opened.prNumber, pr_url: opened.prUrl });
    return;
  }

  const api = createGitHubApi(process.env.GH_TOKEN ?? '');
  const prNumber = options.pr ? Number(options.pr) : null;
  const { verified } = await verifyHomebrewTapPullRequest(api, release, {
    result: options.result,
    prNumber,
  });
  log(`verified: ${verified}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
