# GitHub Pull Request Provider Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the typed, read-only GitHub provider, branch association, caching, and stale-response foundation for branch-associated pull request overviews without changing runtime or UI behavior.

**Architecture:** Add a focused `src/github/` domain. Git and `gh` process execution are injected behind narrow interfaces; the provider returns validated domain values and typed failure states, while the service owns repository context, cache isolation, and request identity. Existing create-PR mutations remain untouched.

**Tech Stack:** TypeScript 5.9, Node.js 18 child processes, Git, GitHub CLI JSON output, Vitest.

---

## File Structure

- Create `src/github/types.ts` — transport-independent account, repository, PR overview, and query-state types plus runtime validators.
- Create `src/github/remotes.ts` — GitHub SSH/HTTPS remote normalization and deterministic remote preference.
- Create `src/github/repositoryContext.ts` — read-only Git branch/upstream/remote discovery for a selected worktree.
- Create `src/github/commandRunner.ts` — bounded, timeout-aware process runner that never exposes raw environment or unbounded output.
- Create `src/github/githubCliProvider.ts` — authenticated account lookup, candidate PR queries, JSON validation, and provider error classification.
- Create `src/github/pullRequestOverviewService.ts` — association orchestration, account/repository cache isolation, TTL/LRU behavior, refresh, and stale-write suppression.
- Create `src/github/index.ts` — explicit public exports for later control-plane integration.
- Create `__tests__/githubTypes.test.ts`.
- Create `__tests__/githubRemotes.test.ts`.
- Create `__tests__/githubRepositoryContext.test.ts`.
- Create `__tests__/githubCommandRunner.test.ts`.
- Create `__tests__/githubCliProvider.test.ts`.
- Create `__tests__/pullRequestOverviewService.test.ts`.
- Create `__tests__/fixtures/github/account.json`.
- Create `__tests__/fixtures/github/repository.json`.
- Create `__tests__/fixtures/github/pull-requests.json`.
- Create `__tests__/fixtures/github/checks-all.json`.
- Create `__tests__/fixtures/github/checks-required.json`.

Do not modify `src/utils/githubPullRequest.ts` or
`src/actions/implementations/createPullRequestAction.ts` in this plan.

### Task 1: Define the GitHub domain and exhaustive query states

**Files:**
- Create: `src/github/types.ts`
- Create: `__tests__/githubTypes.test.ts`

- [ ] **Step 1: Write the failing domain validation tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseGitHubAccount,
  parsePullRequestOverview,
  type PullRequestOverviewResult,
} from '../src/github/types.js';

describe('GitHub domain validation', () => {
  it('normalizes an authenticated account without accepting a token', () => {
    expect(parseGitHubAccount({
      login: 'BunsDev',
      id: 123,
      url: 'https://github.com/BunsDev',
    }, 'github.com')).toEqual({
      host: 'github.com',
      login: 'BunsDev',
      id: '123',
      source: 'gh',
    });
  });

  it('parses a bounded pull request overview', () => {
    const overview = parsePullRequestOverview({
      number: 184,
      url: 'https://github.com/OpenCoven/psyche-build/pull/184',
      title: 'Add branch-associated PR overview',
      body: 'A'.repeat(4_500),
      state: 'OPEN',
      isDraft: false,
      author: { login: 'BunsDev' },
      baseRefName: 'main',
      headRefName: 'feat/pr-overview',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      additions: 214,
      deletions: 38,
      changedFiles: 6,
      commits: [{ oid: 'abc' }, { oid: 'def' }],
      labels: [{ name: 'feature', color: '8250df' }],
      assignees: [{ login: 'BunsDev' }],
      reviewRequests: [{ login: 'reviewer' }],
      updatedAt: '2026-08-06T18:00:00Z',
    }, {
      host: 'github.com',
      owner: 'OpenCoven',
      name: 'psyche-build',
      url: 'https://github.com/OpenCoven/psyche-build',
    }, {
      admin: false,
      maintain: true,
      pull: true,
      push: true,
      triage: true,
    }, [{
      bucket: 'pass',
      link: 'https://github.com/OpenCoven/psyche-build/actions/runs/1',
      name: 'test',
      state: 'SUCCESS',
      workflow: 'CI',
    }], [{
      bucket: 'pass',
      link: 'https://github.com/OpenCoven/psyche-build/actions/runs/1',
      name: 'test',
      state: 'SUCCESS',
      workflow: 'CI',
    }], '2026-08-06T18:01:00Z');

    expect(overview.bodyPreview).toHaveLength(4_000);
    expect(overview.commitCount).toBe(2);
    expect(overview.checks).toEqual({
      total: 1,
      pending: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      required: { total: 1, pending: 0, passed: 1, failed: 0 },
      optional: { total: 0, pending: 0, passed: 0, failed: 0 },
    });
  });

  it('rejects malformed provider values instead of partially rendering them', () => {
    expect(() => parsePullRequestOverview(
      { number: '184', url: 'not-a-url' },
      { host: 'github.com', owner: 'OpenCoven', name: 'psyche-build', url: 'https://github.com/OpenCoven/psyche-build' },
      null,
      [],
      [],
      '2026-08-06T18:01:00Z',
    )).toThrow('invalid pull request overview');
  });

  it('keeps every terminal query state discriminated', () => {
    const result: PullRequestOverviewResult = {
      requestId: 'req-1',
      projectId: '/repo',
      worktreePath: '/repo/.worktrees/pr',
      selectionGeneration: 7,
      observedAt: '2026-08-06T18:01:00Z',
      state: { kind: 'providerUnavailable', installMessage: 'brew install gh' },
    };
    expect(result.state.kind).toBe('providerUnavailable');
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
pnpm vitest --run __tests__/githubTypes.test.ts
```

Expected: FAIL because `src/github/types.ts` does not exist.

- [ ] **Step 3: Implement the domain types and parsers**

Create `src/github/types.ts` with these exported contracts:

```ts
export const MAX_PR_BODY_PREVIEW = 4_000;

export interface GitHubAccountRef {
  host: string;
  login: string;
  id?: string;
  source: 'gh';
}

export interface GitHubRepositoryRef {
  host: string;
  owner: string;
  name: string;
  url: string;
  visibility?: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  archived?: boolean;
  fork?: boolean;
}

export interface PullRequestCheckSummary {
  total: number;
  pending: number;
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  required: {
    total: number;
    pending: number;
    passed: number;
    failed: number;
  };
  optional: {
    total: number;
    pending: number;
    passed: number;
    failed: number;
  };
}

export interface PullRequestOverview {
  repository: GitHubRepositoryRef;
  number: number;
  url: string;
  title: string;
  bodyPreview: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  authorLogin: string;
  baseRefName: string;
  headRefName: string;
  labels: readonly { name: string; color: string }[];
  assignees: readonly string[];
  requestedReviewers: readonly string[];
  viewerPermissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    triage: boolean;
    pull: boolean;
  } | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  mergeStateStatus: string | null;
  checks: PullRequestCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  updatedAt: string;
  fetchedAt: string;
}

export type PullRequestQueryState =
  | { kind: 'ready'; account: GitHubAccountRef; overview: PullRequestOverview; stale: boolean }
  | { kind: 'noPullRequest'; account: GitHubAccountRef; repository: GitHubRepositoryRef; branch: string }
  | { kind: 'detachedHead' }
  | { kind: 'unsupportedRemote'; remotes: readonly string[] }
  | { kind: 'ambiguousAssociation'; candidates: readonly { number: number; url: string; repository: GitHubRepositoryRef }[] }
  | { kind: 'unauthenticated'; host: string; loginCommand: string }
  | { kind: 'permissionDenied'; host: string; repository?: GitHubRepositoryRef }
  | { kind: 'rateLimited'; host: string; resetAt?: string }
  | { kind: 'offline'; host?: string }
  | { kind: 'providerUnavailable'; installMessage: string }
  | { kind: 'invalidProviderResponse'; operation: string }
  | { kind: 'failed'; code: string; message: string };

export interface PullRequestOverviewQuery {
  requestId: string;
  projectId: string;
  projectRoot: string;
  worktreePath: string;
  selectionGeneration: number;
  refresh?: boolean;
}

export interface PullRequestOverviewResult {
  requestId: string;
  projectId: string;
  worktreePath: string;
  selectionGeneration: number;
  observedAt: string;
  state: PullRequestQueryState;
}
```

Also implement `parseGitHubAccount()`, `parseRepositoryPermissions()`, and
`parsePullRequestOverview()` with explicit object/string/number/URL guards.
Pass the parsed all-check and required-check arrays into
`parsePullRequestOverview()`. Count checks by treating buckets
`pending` as pending, `pass` as passed, `fail` as failed, `skipping` as
skipped, and `cancel` as cancelled. Match required checks to all checks by
`workflow + "\0" + name + "\0" + link`; unmatched all checks are optional.
Throw only
`Error('invalid GitHub account response')` or
`Error('invalid pull request overview')`; never include provider payloads.

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm vitest --run __tests__/githubTypes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the domain**

```bash
git add src/github/types.ts __tests__/githubTypes.test.ts
git commit -m "feat: add GitHub pull request domain"
```

### Task 2: Normalize GitHub remotes and read repository context

**Files:**
- Create: `src/github/remotes.ts`
- Create: `src/github/repositoryContext.ts`
- Create: `__tests__/githubRemotes.test.ts`
- Create: `__tests__/githubRepositoryContext.test.ts`

- [ ] **Step 1: Write failing remote normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeGitHubRemote, orderGitHubRemotes } from '../src/github/remotes.js';

describe('GitHub remotes', () => {
  it.each([
    ['https://github.com/OpenCoven/psyche-build.git', 'github.com'],
    ['git@github.com:OpenCoven/psyche-build.git', 'github.com'],
    ['ssh://git@ghe.example.test/OpenCoven/psyche-build.git', 'ghe.example.test'],
  ])('normalizes %s', (url, host) => {
    expect(normalizeGitHubRemote('origin', url)).toMatchObject({
      name: 'origin',
      repository: { host, owner: 'OpenCoven', name: 'psyche-build' },
    });
  });

  it('rejects local paths and non-GitHub schemes', () => {
    expect(normalizeGitHubRemote('origin', '../repo')).toBeNull();
    expect(normalizeGitHubRemote('origin', 'file:///tmp/repo')).toBeNull();
  });

  it('prefers branch upstream, then origin, then stable name order', () => {
    const remotes = [
      normalizeGitHubRemote('fork', 'git@github.com:BunsDev/psyche-build.git')!,
      normalizeGitHubRemote('upstream', 'git@github.com:OpenCoven/psyche-build.git')!,
      normalizeGitHubRemote('origin', 'git@github.com:BunsDev/psyche-build.git')!,
    ];
    expect(orderGitHubRemotes(remotes, 'upstream').map((remote) => remote.name))
      .toEqual(['upstream', 'origin', 'fork']);
  });
});
```

- [ ] **Step 2: Write the failing repository-context test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { readRepositoryContext } from '../src/github/repositoryContext.js';

it('reads branch, upstream, and all remote URLs without mutating Git', async () => {
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    const key = args.join(' ');
    if (key === 'branch --show-current') return { stdout: 'feat/pr\n', stderr: '', exitCode: 0 };
    if (key === 'config branch.feat/pr.remote') return { stdout: 'upstream\n', stderr: '', exitCode: 0 };
    if (key === 'remote') return { stdout: 'origin\nupstream\n', stderr: '', exitCode: 0 };
    if (key === 'remote get-url origin') return { stdout: 'git@github.com:BunsDev/psyche-build.git\n', stderr: '', exitCode: 0 };
    if (key === 'remote get-url upstream') return { stdout: 'git@github.com:OpenCoven/psyche-build.git\n', stderr: '', exitCode: 0 };
    throw new Error(`unexpected git args: ${key}`);
  });

  const context = await readRepositoryContext('/repo/.worktrees/pr', { run });
  expect(context.branch).toBe('feat/pr');
  expect(context.remotes.map((remote) => remote.name)).toEqual(['upstream', 'origin']);
  expect(run).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']), expect.anything());
});
```

- [ ] **Step 3: Run both tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/githubRemotes.test.ts __tests__/githubRepositoryContext.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement normalization and context discovery**

`src/github/remotes.ts` must export:

```ts
export interface GitHubRemote {
  name: string;
  rawUrl: string;
  repository: GitHubRepositoryRef;
}

export function normalizeGitHubRemote(name: string, rawUrl: string): GitHubRemote | null;
export function orderGitHubRemotes(
  remotes: readonly GitHubRemote[],
  upstreamRemote: string | null,
): GitHubRemote[];
```

Normalize hostnames to lowercase, strip one `.git` suffix, reject empty owner
or repository segments, and generate `https://${host}/${owner}/${name}`.

`src/github/repositoryContext.ts` must export:

```ts
export interface ReadOnlyCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; allowFailure?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RepositoryContext {
  worktreePath: string;
  branch: string | null;
  upstreamRemote: string | null;
  remotes: readonly GitHubRemote[];
}

export async function readRepositoryContext(
  worktreePath: string,
  runner: ReadOnlyCommandRunner,
): Promise<RepositoryContext>;
```

Only run `git branch --show-current`, `git config branch.<branch>.remote`,
`git remote`, and `git remote get-url <name>`. Pass every returned GitHub
remote through `orderGitHubRemotes`.

- [ ] **Step 5: Run the focused tests**

```bash
pnpm vitest --run __tests__/githubRemotes.test.ts __tests__/githubRepositoryContext.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit remote discovery**

```bash
git add src/github/remotes.ts src/github/repositoryContext.ts \
  __tests__/githubRemotes.test.ts __tests__/githubRepositoryContext.test.ts
git commit -m "feat: discover GitHub repository context"
```

### Task 3: Add a bounded process runner

**Files:**
- Create: `src/github/commandRunner.ts`
- Create: `__tests__/githubCommandRunner.test.ts`

- [ ] **Step 1: Write failing timeout and output-bound tests**

```ts
import { describe, expect, it } from 'vitest';
import { createCommandRunner, GitHubCommandError } from '../src/github/commandRunner.js';

describe('GitHub command runner', () => {
  it('returns stdout for a successful bounded command', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 1_024 });
    await expect(runner.run(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: process.cwd() }))
      .resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });
  });

  it('terminates commands that exceed the timeout', async () => {
    const runner = createCommandRunner({ timeoutMs: 25, maxOutputBytes: 1_024 });
    await expect(runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: process.cwd() }))
      .rejects.toMatchObject<Partial<GitHubCommandError>>({ kind: 'timeout' });
  });

  it('rejects output beyond the configured bound without echoing it', async () => {
    const runner = createCommandRunner({ timeoutMs: 2_000, maxOutputBytes: 64 });
    await expect(runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { cwd: process.cwd() }))
      .rejects.toMatchObject<Partial<GitHubCommandError>>({ kind: 'outputLimit' });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm vitest --run __tests__/githubCommandRunner.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the runner**

Create a Promise-based `spawn()` runner with:

```ts
export type GitHubCommandErrorKind =
  | 'spawn'
  | 'timeout'
  | 'outputLimit'
  | 'exit';

export class GitHubCommandError extends Error {
  constructor(
    public readonly kind: GitHubCommandErrorKind,
    public readonly command: string,
    public readonly exitCode?: number,
    public readonly stderrSummary?: string,
  ) {
    super(`GitHub command failed: ${kind}`);
  }
}

export function createCommandRunner(options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): ReadOnlyCommandRunner;
```

Use argument arrays, `shell: false`, `stdio: ['ignore', 'pipe', 'pipe']`, a
15-second default timeout, and a 2 MiB combined stdout/stderr limit. On a
nonzero exit, retain at most 512 sanitized stderr characters in
`stderrSummary`; remove control characters and strings matching
`gh[pousr]_[A-Za-z0-9_]+`. Never include `process.env` in an error.

- [ ] **Step 4: Run the focused test**

```bash
pnpm vitest --run __tests__/githubCommandRunner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the process boundary**

```bash
git add src/github/commandRunner.ts __tests__/githubCommandRunner.test.ts
git commit -m "feat: add bounded GitHub command runner"
```

### Task 4: Implement the authenticated GitHub CLI provider

**Files:**
- Create: `src/github/githubCliProvider.ts`
- Create: `__tests__/githubCliProvider.test.ts`
- Create: `__tests__/fixtures/github/account.json`
- Create: `__tests__/fixtures/github/repository.json`
- Create: `__tests__/fixtures/github/pull-requests.json`
- Create: `__tests__/fixtures/github/checks-all.json`
- Create: `__tests__/fixtures/github/checks-required.json`

- [ ] **Step 1: Add fixed provider fixtures**

`__tests__/fixtures/github/account.json`:

```json
{"id":123,"login":"BunsDev","url":"https://github.com/BunsDev"}
```

`__tests__/fixtures/github/repository.json`:

```json
{"archived":false,"fork":false,"name":"psyche-build","owner":{"login":"OpenCoven"},"permissions":{"admin":false,"maintain":true,"pull":true,"push":true,"triage":true},"private":false}
```

`__tests__/fixtures/github/pull-requests.json`:

```json
[{"additions":214,"assignees":[{"login":"BunsDev"}],"author":{"login":"BunsDev"},"baseRefName":"main","body":"Adds a read-only PR overview.","changedFiles":6,"commits":[{"oid":"abc"},{"oid":"def"}],"deletions":38,"headRefName":"feat/pr-overview","isDraft":false,"labels":[{"color":"8250df","name":"feature"}],"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":184,"reviewDecision":"REVIEW_REQUIRED","reviewRequests":[{"login":"reviewer"}],"state":"OPEN","statusCheckRollup":[{"conclusion":"SUCCESS","status":"COMPLETED"}],"title":"Add branch-associated PR overview","updatedAt":"2026-08-06T18:00:00Z","url":"https://github.com/OpenCoven/psyche-build/pull/184"}]
```

`__tests__/fixtures/github/checks-all.json`:

```json
[{"bucket":"pass","link":"https://github.com/OpenCoven/psyche-build/actions/runs/1","name":"test","state":"SUCCESS","workflow":"CI"}]
```

`__tests__/fixtures/github/checks-required.json`:

```json
[{"bucket":"pass","link":"https://github.com/OpenCoven/psyche-build/actions/runs/1","name":"test","state":"SUCCESS","workflow":"CI"}]
```

- [ ] **Step 2: Write failing provider tests**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GitHubCliProvider } from '../src/github/githubCliProvider.js';

const account = readFileSync('__tests__/fixtures/github/account.json', 'utf8');
const repository = readFileSync('__tests__/fixtures/github/repository.json', 'utf8');
const pulls = readFileSync('__tests__/fixtures/github/pull-requests.json', 'utf8');
const checksAll = readFileSync('__tests__/fixtures/github/checks-all.json', 'utf8');
const checksRequired = readFileSync('__tests__/fixtures/github/checks-required.json', 'utf8');

it('uses host-scoped gh API and bounded PR fields', async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ stdout: account, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: pulls, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: pulls.slice(1, -1), stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: repository, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: checksAll, stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: checksRequired, stderr: '', exitCode: 0 });
  const provider = new GitHubCliProvider({ run }, () => '2026-08-06T18:01:00Z');

  const activeAccount = await provider.getActiveAccount({
    cwd: '/repo',
    host: 'github.com',
  });
  const result = await provider.findAssociatedPullRequests({
    cwd: '/repo',
    account: activeAccount,
    headBranch: 'feat/pr-overview',
    headRepository: { host: 'github.com', owner: 'BunsDev', name: 'psyche-build', url: 'https://github.com/BunsDev/psyche-build' },
    candidateBaseRepositories: [
      { host: 'github.com', owner: 'OpenCoven', name: 'psyche-build', url: 'https://github.com/OpenCoven/psyche-build' },
    ],
  });

  expect(activeAccount.login).toBe('BunsDev');
  expect(result[0].number).toBe(184);
  expect(result[0].viewerPermissions?.push).toBe(true);
  expect(result[0].checks.required.passed).toBe(1);
  expect(run.mock.calls[0][1]).toEqual(['api', 'user', '--hostname', 'github.com']);
  expect(run.mock.calls[1][1]).toContain('BunsDev:feat/pr-overview');
});

it.each([
  ['not logged into any GitHub hosts', 'unauthenticated'],
  ['HTTP 403: Resource not accessible by integration', 'permissionDenied'],
  ['API rate limit exceeded', 'rateLimited'],
  ['Could not resolve host: github.com', 'offline'],
])('classifies %s', async (stderrSummary, kind) => {
  const run = vi.fn().mockRejectedValue({
    kind: 'exit',
    exitCode: 1,
    stderrSummary,
  });
  const provider = new GitHubCliProvider({ run });
  await expect(provider.getActiveAccount({
    cwd: '/repo',
    host: 'github.com',
  })).rejects.toMatchObject({ kind });
});
```

- [ ] **Step 3: Run the provider test and verify it fails**

```bash
pnpm vitest --run __tests__/githubCliProvider.test.ts
```

Expected: FAIL because the provider does not exist.

- [ ] **Step 4: Implement the provider**

Export:

```ts
export interface AssociationProviderInput {
  cwd: string;
  account: GitHubAccountRef;
  headBranch: string;
  headRepository: GitHubRepositoryRef;
  candidateBaseRepositories: readonly GitHubRepositoryRef[];
}

export class GitHubProviderError extends Error {
  constructor(
    public readonly kind:
      | 'unauthenticated'
      | 'permissionDenied'
      | 'rateLimited'
      | 'offline'
      | 'providerUnavailable'
      | 'invalidProviderResponse'
      | 'failed',
    public readonly host?: string,
    public readonly resetAt?: string,
  ) {
    super(`GitHub provider failed: ${kind}`);
  }
}
```

`GitHubCliProvider` exposes:

```ts
getActiveAccount(input: {
  cwd: string;
  host: string;
}): Promise<GitHubAccountRef>;

findAssociatedPullRequests(
  input: AssociationProviderInput,
): Promise<readonly PullRequestOverview[]>;
```

`getActiveAccount()` runs `gh api user --hostname <host>` and parses the active
account. `findAssociatedPullRequests()` must:

1. Require `input.account.host === input.headRepository.host`.
2. Query every unique candidate base repository on the same host for candidates:

```text
gh pr list
  --repo <host>/<owner>/<name>
  --head <headOwner>:<headBranch>
  --state all
  --limit 10
  --json number,url,updatedAt
```

3. Deduplicate candidate URLs and cap the set at 10.
4. For each remaining candidate, run:

```text
gh pr view <number>
  --repo <host>/<owner>/<name>
  --json additions,assignees,author,baseRefName,body,changedFiles,commits,
         deletions,headRefName,isDraft,labels,mergeStateStatus,mergeable,number,
         reviewDecision,reviewRequests,state,title,updatedAt,url
gh api repos/<owner>/<name> --hostname <host>
gh pr checks <number> --repo <host>/<owner>/<name>
  --json bucket,link,name,state,workflow
gh pr checks <number> --repo <host>/<owner>/<name> --required
  --json bucket,link,name,state,workflow
```

Run both `gh pr checks` commands with `allowFailure: true`; treat exit 1 as
data-bearing when stdout is valid JSON because failed checks intentionally use
a nonzero exit. Any other invalid or empty result is a provider failure.
5. Parse the repository permissions, all checks, required checks, and full PR
   through the runtime validators.
6. Throw `GitHubProviderError('invalidProviderResponse')` for invalid JSON or
   fields without copying provider data into the error.

Use `buildMissingGitHubCliMessage()` only for the provider-unavailable install
message mapping performed by the service; do not change the existing helper.

- [ ] **Step 5: Run the provider tests**

```bash
pnpm vitest --run __tests__/githubCliProvider.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the provider**

```bash
git add src/github/githubCliProvider.ts __tests__/githubCliProvider.test.ts \
  __tests__/fixtures/github/account.json \
  __tests__/fixtures/github/repository.json \
  __tests__/fixtures/github/pull-requests.json \
  __tests__/fixtures/github/checks-all.json \
  __tests__/fixtures/github/checks-required.json
git commit -m "feat: query pull request overviews with gh"
```

### Task 5: Add cache isolation and stale-response protection

**Files:**
- Create: `src/github/pullRequestOverviewService.ts`
- Create: `__tests__/pullRequestOverviewService.test.ts`

- [ ] **Step 1: Write failing association, cache, and race tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PullRequestOverviewService } from '../src/github/pullRequestOverviewService.js';

it('returns detachedHead without invoking GitHub', async () => {
  const provider = {
    getActiveAccount: vi.fn(),
    findAssociatedPullRequests: vi.fn(),
  };
  const service = new PullRequestOverviewService({
    readContext: vi.fn().mockResolvedValue({ branch: null, remotes: [], upstreamRemote: null, worktreePath: '/repo' }),
    provider,
    now: () => '2026-08-06T18:01:00Z',
  });
  const result = await service.query({
    requestId: 'req-1',
    projectId: '/repo',
    projectRoot: '/repo',
    worktreePath: '/repo',
    selectionGeneration: 1,
  });
  expect(result.state).toEqual({ kind: 'detachedHead' });
  expect(provider.findAssociatedPullRequests).not.toHaveBeenCalled();
});

it('isolates cached data by host and active account', async () => {
  const provider = {
    getActiveAccount: vi.fn()
      .mockResolvedValueOnce({ host: 'github.com', login: 'one', source: 'gh' })
      .mockResolvedValueOnce({ host: 'github.com', login: 'two', source: 'gh' }),
    findAssociatedPullRequests: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]),
  };
  const service = makeService(provider);
  await service.query(makeQuery('req-1', false));
  service.invalidateAccount('github.com', 'one');
  await service.query(makeQuery('req-2', false));
  expect(provider.findAssociatedPullRequests).toHaveBeenCalledTimes(2);
});

it('does not let an older request overwrite a newer cache entry', async () => {
  const first = deferred<readonly PullRequestOverview[]>();
  const second = deferred<readonly PullRequestOverview[]>();
  const provider = {
    getActiveAccount: vi.fn().mockResolvedValue({
      host: 'github.com',
      login: 'BunsDev',
      source: 'gh',
    }),
    findAssociatedPullRequests: vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise),
  };
  const service = makeService(provider);
  const oldRequest = service.query(makeQuery('old', true, 1));
  const newRequest = service.query(makeQuery('new', true, 2));
  second.resolve([pullRequestOverview(200)]);
  await newRequest;
  first.resolve([pullRequestOverview(100)]);
  await oldRequest;
  const cached = await service.query(makeQuery('cached', false, 3));
  expect(cached.state).toMatchObject({
    kind: 'ready',
    overview: { number: 200 },
  });
});
```

Include local `deferred()`, `makeService()`, `makeQuery()`,
and `pullRequestOverview()` helpers in the test file.

- [ ] **Step 2: Run the service test and verify it fails**

```bash
pnpm vitest --run __tests__/pullRequestOverviewService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service**

Create `PullRequestOverviewService` with:

```ts
export interface PullRequestOverviewServiceDeps {
  readContext: typeof readRepositoryContext;
  provider: Pick<
    GitHubCliProvider,
    'getActiveAccount' | 'findAssociatedPullRequests'
  >;
  now?: () => string;
  ttlMs?: number;
  maxEntries?: number;
  missingProviderMessage?: () => string;
}

export class PullRequestOverviewService {
  constructor(deps: PullRequestOverviewServiceDeps);
  query(query: PullRequestOverviewQuery): Promise<PullRequestOverviewResult>;
  invalidateProject(projectId: string): void;
  invalidateAccount(host: string, login: string): void;
}
```

Behavior:

- detached branch -> `detachedHead`;
- no normalized GitHub remotes -> `unsupportedRemote`;
- first ordered remote is the head repository;
- all unique repositories are candidate bases;
- read the active account before cache lookup;
- include host and login in every cache key;
- one overview -> `ready`;
- zero -> `noPullRequest`;
- multiple distinct URLs -> `ambiguousAssociation`;
- cache only validated `ready` and `noPullRequest` results;
- default TTL 60 seconds and maximum 64 entries;
- `refresh: true` bypasses reads but may replace the cache;
- every key includes host, active login, head repository, and branch;
- when the observed login changes for a host, invalidate entries for the
  previous login before querying;
- each key owns an incrementing write generation so older completions cannot
  replace newer entries;
- map `GitHubProviderError` exhaustively to `PullRequestQueryState`;
- return only sanitized generic messages for `failed`.

- [ ] **Step 4: Run all GitHub foundation tests**

```bash
pnpm vitest --run \
  __tests__/githubTypes.test.ts \
  __tests__/githubRemotes.test.ts \
  __tests__/githubRepositoryContext.test.ts \
  __tests__/githubCommandRunner.test.ts \
  __tests__/githubCliProvider.test.ts \
  __tests__/pullRequestOverviewService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the service**

```bash
git add src/github/pullRequestOverviewService.ts \
  __tests__/pullRequestOverviewService.test.ts
git commit -m "feat: associate branches with pull requests"
```

### Task 6: Export the foundation and verify Checkpoint A

**Files:**
- Create: `src/github/index.ts`
- Modify: `docs/superpowers/plans/2026-08-06-github-pr-provider-foundation.md`

- [ ] **Step 1: Export only supported provider APIs**

```ts
export * from './types.js';
export {
  normalizeGitHubRemote,
  orderGitHubRemotes,
  type GitHubRemote,
} from './remotes.js';
export {
  readRepositoryContext,
  type RepositoryContext,
  type ReadOnlyCommandRunner,
} from './repositoryContext.js';
export {
  createCommandRunner,
  GitHubCommandError,
} from './commandRunner.js';
export {
  GitHubCliProvider,
  GitHubProviderError,
} from './githubCliProvider.js';
export { PullRequestOverviewService } from './pullRequestOverviewService.js';
```

- [ ] **Step 2: Run type checking and the focused suite**

```bash
pnpm run typecheck
pnpm vitest --run \
  __tests__/githubTypes.test.ts \
  __tests__/githubRemotes.test.ts \
  __tests__/githubRepositoryContext.test.ts \
  __tests__/githubCommandRunner.test.ts \
  __tests__/githubCliProvider.test.ts \
  __tests__/pullRequestOverviewService.test.ts \
  __tests__/githubPullRequest.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full suite and compare with the accepted baseline**

```bash
pnpm run test
```

Expected on the current macOS environment: no new failures beyond the accepted
baseline:

- `__tests__/appStoreConnect.test.ts` pnpm 10.14.0 vs host 10.33.2;
- two `__tests__/releaseWorkflow.test.ts` GNU/BSD `stat` environment failures.

If any additional test fails, stop and fix it before continuing.

- [ ] **Step 4: Run the production build**

```bash
pnpm run build
```

Expected: PASS.

- [ ] **Step 5: Mark Checkpoint A complete in this plan and the durable goal**

Change completed checkboxes to `[x]`. Update `.copilot/goals.md` with the
provider commit, focused test count, accepted baseline exceptions, and:

```text
next: Rebase onto the canonical per-project control endpoint and execute the native PR overview integration plan.
```

- [ ] **Step 6: Commit Checkpoint A**

```bash
git add src/github/index.ts \
  docs/superpowers/plans/2026-08-06-github-pr-provider-foundation.md
git commit -m "feat: complete GitHub PR provider foundation"
```
