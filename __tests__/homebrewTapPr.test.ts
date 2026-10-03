import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createGitHubApi,
  openHomebrewTapPullRequest,
  verifyHomebrewTapPullRequest,
  type GitHubApi,
} from '../scripts/homebrew-tap-pr.mjs';
import { renderHomebrewCask } from '../scripts/render-homebrew-cask.mjs';

const currentCask = readFileSync(path.resolve('__tests__/fixtures/homebrew-tap/psyche-build.rb'), 'utf8');
const release = { version: '0.0.3', arm: 'a'.repeat(64), intel: 'b'.repeat(64) };
const repo = '/repos/OpenCoven/homebrew-tap';
const CASK = 'Casks/psyche-build.rb';

interface Pull {
  number: number;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: string;
}

/** In-memory model of the parts of the tap the script touches. */
class FakeTap implements GitHubApi {
  branches = new Map<string, string>();
  commits = new Map<string, string>();
  pulls: Pull[] = [];
  calls: string[] = [];
  private nextSha = 1;

  constructor(cask: string) {
    this.branches.set('main', this.commit(cask));
  }

  commit(cask: string): string {
    const sha = (this.nextSha++).toString(16).padStart(40, '0');
    this.commits.set(sha, cask);
    return sha;
  }

  writes(): string[] {
    return this.calls.filter((call) => !call.startsWith('GET '));
  }

  fileResponse(cask: string) {
    return {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(cask).toString('base64').replace(/(.{60})/g, '$1\n'),
      sha: `blob-${Buffer.from(cask).length}-${cask.includes(release.arm) ? 'new' : 'old'}`,
    };
  }

  patchFor(head: string): string {
    const before = this.commits.get(this.branches.get('main')!)!.split('\n');
    const after = this.commits.get(this.branches.get(head)!)!.split('\n');
    const lines: string[] = ['@@ -3,9 +3,9 @@'];
    before.forEach((line, index) => {
      if (line !== after[index]) lines.push(`-${line}`);
    });
    after.forEach((line, index) => {
      if (line !== before[index]) lines.push(`+${line}`);
    });
    return lines.join('\n');
  }

  async request(method: string, url: string, body?: any, options?: { allowNotFound?: boolean }) {
    this.calls.push(`${method} ${url}`);
    const [route, query = ''] = url.replace(repo, '').split('?');
    const params = new URLSearchParams(query);
    const notFound = () => {
      if (options?.allowNotFound) return null;
      throw new Error(`404 ${url}`);
    };

    let match: RegExpMatchArray | null;
    if (method === 'GET' && (match = route.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = this.branches.get(match[1]);
      return sha ? { object: { sha } } : notFound();
    }
    if (method === 'POST' && route === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (this.branches.has(name)) throw new Error('422 Reference already exists');
      this.branches.set(name, body.sha);
      return { ref: body.ref };
    }
    if (method === 'GET' && route === `/contents/${CASK}`) {
      const ref = params.get('ref')!;
      const sha = this.branches.get(ref) ?? ref;
      const cask = this.commits.get(sha);
      return cask === undefined ? notFound() : this.fileResponse(cask);
    }
    if (method === 'PUT' && route === `/contents/${CASK}`) {
      const tip = this.commits.get(this.branches.get(body.branch)!)!;
      if (body.sha !== this.fileResponse(tip).sha) throw new Error('409 sha mismatch');
      this.branches.set(body.branch, this.commit(Buffer.from(body.content, 'base64').toString('utf8')));
      return {};
    }
    if (method === 'GET' && route === '/pulls') {
      const head = params.get('head')!.replace('OpenCoven:', '');
      return this.pulls
        .filter((pull) => pull.head === head)
        .map((pull) => ({ ...pull, html_url: `https://github.com/OpenCoven/homebrew-tap/pull/${pull.number}` }));
    }
    if (method === 'POST' && route === '/pulls') {
      const pull: Pull = { number: 10 + this.pulls.length, state: 'open', merged_at: null, head: body.head };
      this.pulls.push(pull);
      return { number: pull.number, html_url: `https://github.com/OpenCoven/homebrew-tap/pull/${pull.number}` };
    }
    if (method === 'GET' && (match = route.match(/^\/pulls\/(\d+)$/))) {
      const pull = this.pulls.find((candidate) => candidate.number === Number(match![1]));
      if (!pull) return notFound();
      return {
        number: pull.number,
        state: pull.state,
        merged: Boolean(pull.merged_at),
        base: { ref: 'main', repo: { full_name: 'OpenCoven/homebrew-tap' } },
        head: { ref: pull.head, sha: this.branches.get(pull.head), repo: { full_name: 'OpenCoven/homebrew-tap' } },
      };
    }
    if (method === 'GET' && (match = route.match(/^\/pulls\/(\d+)\/files$/))) {
      const pull = this.pulls.find((candidate) => candidate.number === Number(match![1]))!;
      return [{ filename: CASK, status: 'modified', patch: this.patchFor(pull.head) }];
    }
    if (route.includes('/merge') || route.includes('auto-merge') || route.includes('/dispatches')) {
      throw new Error(`forbidden call ${method} ${url}`);
    }
    throw new Error(`unexpected call ${method} ${url}`);
  }
}

describe('opening the tap pull request', () => {
  it('creates a branch, commits only the rendered Cask, and opens one PR without merging', async () => {
    const tap = new FakeTap(currentCask);
    const opened = await openHomebrewTapPullRequest(tap, release);

    expect(opened).toMatchObject({ result: 'open', branch: 'psyche-build-0.0.3', prNumber: 10 });
    expect(tap.commits.get(tap.branches.get('psyche-build-0.0.3')!)).toBe(
      renderHomebrewCask(currentCask, release).cask,
    );
    expect(tap.commits.get(tap.branches.get('main')!)).toBe(currentCask);
    expect(tap.writes()).toEqual([
      `POST ${repo}/git/refs`,
      `PUT ${repo}/contents/${CASK}`,
      `POST ${repo}/pulls`,
    ]);
    expect(tap.calls.some((call) => /merge|dispatches/.test(call))).toBe(false);
  });

  it('is idempotent: a re-run reuses the branch, commit, and open PR and writes nothing', async () => {
    const tap = new FakeTap(currentCask);
    const first = await openHomebrewTapPullRequest(tap, release);
    tap.calls = [];
    const second = await openHomebrewTapPullRequest(tap, release);

    expect(second).toEqual(first);
    expect(tap.writes()).toEqual([]);
    expect(tap.pulls).toHaveLength(1);
  });

  it('resumes after a run that created the branch but stopped before committing', async () => {
    const tap = new FakeTap(currentCask);
    tap.branches.set('psyche-build-0.0.3', tap.branches.get('main')!);
    const opened = await openHomebrewTapPullRequest(tap, release);

    expect(opened.result).toBe('open');
    expect(tap.writes()).toEqual([`PUT ${repo}/contents/${CASK}`, `POST ${repo}/pulls`]);
  });

  it('reports already-current and writes nothing when main carries the release', async () => {
    const tap = new FakeTap(renderHomebrewCask(currentCask, release).cask);
    const opened = await openHomebrewTapPullRequest(tap, release);

    expect(opened).toMatchObject({ result: 'already-current', prNumber: null });
    expect(tap.writes()).toEqual([]);
  });

  it('refuses to overwrite a branch holding some other Cask', async () => {
    const tap = new FakeTap(currentCask);
    tap.branches.set('psyche-build-0.0.3', tap.commit(currentCask.replace('Psyche Build"', 'Edited"')));
    await expect(openHomebrewTapPullRequest(tap, release)).rejects.toThrow(/refusing to overwrite/);
    expect(tap.writes()).toEqual([]);
  });

  it('refuses to reopen a pull request a maintainer closed without merging', async () => {
    const tap = new FakeTap(currentCask);
    await openHomebrewTapPullRequest(tap, release);
    tap.pulls[0].state = 'closed';
    tap.calls = [];
    await expect(openHomebrewTapPullRequest(tap, release)).rejects.toThrow(/closed without merging/);
    expect(tap.writes()).toEqual([]);
  });

  it('fails closed before any write when the tap Cask is a newer version', async () => {
    const tap = new FakeTap(renderHomebrewCask(currentCask, { ...release, version: '0.0.9' }).cask);
    await expect(openHomebrewTapPullRequest(tap, release)).rejects.toThrow(/downgrade/);
    expect(tap.writes()).toEqual([]);
  });
});

describe('verifying the tap pull request by reading the tap', () => {
  it('accepts a PR whose head Cask and diff carry exactly the SHA256SUMS values', async () => {
    const tap = new FakeTap(currentCask);
    const opened = await openHomebrewTapPullRequest(tap, release);
    tap.calls = [];
    await expect(verifyHomebrewTapPullRequest(tap, release, opened)).resolves.toMatchObject({
      verified: expect.stringContaining('#10'),
    });
    expect(tap.writes()).toEqual([]);
  });

  it('fails when the PR head carries a different checksum', async () => {
    const tap = new FakeTap(currentCask);
    const opened = await openHomebrewTapPullRequest(tap, release);
    tap.branches.set(
      'psyche-build-0.0.3',
      tap.commit(renderHomebrewCask(currentCask, { ...release, intel: 'c'.repeat(64) }).cask),
    );
    await expect(verifyHomebrewTapPullRequest(tap, release, opened)).rejects.toThrow();
  });

  it('fails when the PR changes any line beyond version and sha256', async () => {
    const tap = new FakeTap(currentCask);
    const opened = await openHomebrewTapPullRequest(tap, release);
    const head = tap.commits.get(tap.branches.get('psyche-build-0.0.3')!)!;
    tap.branches.set('psyche-build-0.0.3', tap.commit(head.replace('depends_on macos: :monterey', 'depends_on macos: :sonoma')));
    await expect(verifyHomebrewTapPullRequest(tap, release, opened)).rejects.toThrow(/beyond version and sha256/);
  });

  it('fails when the PR was closed without merging', async () => {
    const tap = new FakeTap(currentCask);
    const opened = await openHomebrewTapPullRequest(tap, release);
    tap.pulls[0].state = 'closed';
    await expect(verifyHomebrewTapPullRequest(tap, release, opened)).rejects.toThrow(/not open/);
  });

  it('verifies main directly in the already-current case and fails if main disagrees', async () => {
    const tap = new FakeTap(renderHomebrewCask(currentCask, release).cask);
    await expect(
      verifyHomebrewTapPullRequest(tap, release, { result: 'already-current', prNumber: null }),
    ).resolves.toBeTruthy();
    await expect(
      verifyHomebrewTapPullRequest(tap, { ...release, arm: 'd'.repeat(64) }, { result: 'already-current', prNumber: null }),
    ).rejects.toThrow(/arm/);
  });

  it('refuses to verify when no PR number was recorded', async () => {
    const tap = new FakeTap(currentCask);
    await expect(verifyHomebrewTapPullRequest(tap, release, { result: 'open', prNumber: null })).rejects.toThrow(
      /no tap pull request number/,
    );
    await expect(verifyHomebrewTapPullRequest(tap, release, { result: undefined, prNumber: null })).rejects.toThrow();
  });
});

describe('GitHub API client', () => {
  it('sends the token only in the Authorization header and never in errors', async () => {
    const token = 'github_pat_secretvalue';
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const api = createGitHubApi(token, async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    });

    const error = await api.request('GET', `${repo}/git/ref/heads/main`).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain('HTTP 401: Bad credentials');
    expect(String(error.message)).not.toContain(token);
    expect(seen[0].url).not.toContain(token);
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it('returns null for 404 only when asked and requires a token', async () => {
    const api = createGitHubApi('t', async () => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(api.request('GET', '/x', undefined, { allowNotFound: true })).resolves.toBeNull();
    await expect(api.request('GET', '/x')).rejects.toThrow(/HTTP 404/);
    expect(() => createGitHubApi('')).toThrow(/token is required/);
  });
});
