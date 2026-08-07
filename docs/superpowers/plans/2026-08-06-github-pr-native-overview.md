# Native Branch-Associated Pull Request Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the shared GitHub pull request provider through Psyche's canonical per-project endpoint and render a complete read-only PR inspector in the native macOS workspace.

**Architecture:** Register a read-only control feature and handler beside the host-owned runtime, then add a native authenticated client for the canonical per-project endpoint. The no-bundler frontend renders one request-generation-safe PR panel; it never invokes `git` or `gh` directly.

**Tech Stack:** TypeScript 5.9, canonical Psyche control protocol, Unix-domain WebSocket transport, Rust 2021/Tauri 2, vanilla JavaScript/CSS, Vitest, Cargo tests.

---

## Prerequisite Gate

This plan starts only after the host-control-plane branch has landed the
following files from `2026-08-03-psyche-host-control-plane.md`:

```text
src/control/client.ts
src/control/credentials.ts
src/control/endpoint.ts
src/control/host.ts
src/control/server.ts
```

The provider foundation plan must also be complete.

### Task 1: Rebase onto the canonical endpoint and prove the gate

**Files:**
- Verify: `src/control/client.ts`
- Verify: `src/control/credentials.ts`
- Verify: `src/control/endpoint.ts`
- Verify: `src/control/host.ts`
- Verify: `src/control/server.ts`
- Verify: `src/github/index.ts`

- [ ] **Step 1: Rebase the feature branch onto the landed host-control-plane head**

```bash
git fetch origin
git rebase origin/main
```

Expected: the rebase completes without dropping the committed provider
foundation.

- [ ] **Step 2: Verify every integration seam exists**

```bash
for file in \
  src/control/client.ts \
  src/control/credentials.ts \
  src/control/endpoint.ts \
  src/control/host.ts \
  src/control/server.ts \
  src/github/index.ts
do
  test -f "$file" || { echo "missing prerequisite: $file"; exit 1; }
done
```

Expected: exit 0. If any file is missing, stop; do not add an interim transport.

- [ ] **Step 3: Run the control-plane and provider baselines**

```bash
pnpm run typecheck
pnpm vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlServer.test.ts \
  __tests__/githubTypes.test.ts \
  __tests__/githubCliProvider.test.ts \
  __tests__/pullRequestOverviewService.test.ts
```

Expected: PASS.

### Task 2: Add the read capability and protocol fixture

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `protocol-fixtures/fixtures.ts`
- Modify: `scripts/generate-protocol-fixtures.ts`
- Create: `protocol-fixtures/control-github-pr-overview.json`
- Modify: `__tests__/controlProtocol.test.ts`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/workspace_contract.rs`

- [ ] **Step 1: Write failing TypeScript protocol tests**

Add:

```ts
it('encodes the GitHub PR overview request and advertises the read feature', () => {
  const request: ControlRequest = {
    version: CONTROL_PROTOCOL_VERSION,
    type: 'github.pullRequest.overview',
    requestId: 'pr-1',
    projectId: '/repo',
    worktreePath: '/repo/.worktrees/pr',
    selectionGeneration: 7,
    refresh: false,
  };
  expect(decodeControlRequest(encodeControlMessage(request))).toEqual(request);

  const welcome: ControlResponse = {
    version: CONTROL_PROTOCOL_VERSION,
    type: 'welcome',
    requestId: 'welcome',
    projectRoot: '/repo',
    ownerEpoch: 3,
    features: ['github.pullRequest.overview'],
    principal: {
      id: 'desktop',
      kind: 'operator',
      capabilities: ['github.pullRequest.read'],
    },
  };
  expect(encodeControlMessage(welcome)).toContain('"github.pullRequest.overview"');
});
```

- [ ] **Step 2: Add the typed control contracts**

In `src/control/protocol.ts`:

```ts
import type { PullRequestOverviewResult } from '../github/types.js';

export type ControlFeature = 'github.pullRequest.overview';

// Add to ControlRequest:
| {
    version: 1;
    type: 'github.pullRequest.overview';
    requestId: string;
    projectId: string;
    worktreePath: string;
    selectionGeneration: number;
    refresh: boolean;
  }

// Add to welcome:
features: readonly ControlFeature[];

// Add to ControlResponse:
| {
    version: 1;
    type: 'github.pullRequest.overview.result';
    requestId: string;
    result: PullRequestOverviewResult;
  }
```

Extend `decodeControlRequest()` to require a nonempty `projectId`,
`worktreePath`, integer `selectionGeneration >= 0`, and boolean `refresh`.

- [ ] **Step 3: Add the fixed cross-language fixture**

Add a typed `CONTROL_GITHUB_PR_OVERVIEW_FIXTURE` to
`protocol-fixtures/fixtures.ts` with fixed timestamps:

```ts
export const CONTROL_GITHUB_PR_OVERVIEW_FIXTURE = {
  version: 1,
  type: 'github.pullRequest.overview.result',
  requestId: 'pr-1',
  result: {
    requestId: 'pr-1',
    projectId: '/repo',
    worktreePath: '/repo/.worktrees/pr',
    selectionGeneration: 7,
    observedAt: '2026-08-06T18:01:00Z',
    state: {
      kind: 'ready',
      stale: false,
      account: {
        host: 'github.com',
        login: 'BunsDev',
        id: '123',
        source: 'gh',
      },
      overview: {
        repository: {
          host: 'github.com',
          owner: 'OpenCoven',
          name: 'psyche-build',
          url: 'https://github.com/OpenCoven/psyche-build',
        },
        number: 184,
        url: 'https://github.com/OpenCoven/psyche-build/pull/184',
        title: 'Add branch-associated PR overview',
        bodyPreview: 'Adds a read-only PR overview.',
        state: 'OPEN',
        isDraft: false,
        authorLogin: 'BunsDev',
        baseRefName: 'main',
        headRefName: 'feat/pr-overview',
        labels: [{ name: 'feature', color: '8250df' }],
        assignees: ['BunsDev'],
        requestedReviewers: ['reviewer'],
        viewerPermissions: {
          admin: false,
          maintain: true,
          pull: true,
          push: true,
          triage: true,
        },
        reviewDecision: 'REVIEW_REQUIRED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        checks: {
          total: 1,
          pending: 0,
          passed: 1,
          failed: 0,
          skipped: 0,
          cancelled: 0,
          required: { total: 1, pending: 0, passed: 1, failed: 0 },
          optional: { total: 0, pending: 0, passed: 0, failed: 0 },
        },
        additions: 214,
        deletions: 38,
        changedFiles: 6,
        commitCount: 2,
        updatedAt: '2026-08-06T18:00:00Z',
        fetchedAt: '2026-08-06T18:01:00Z',
      },
    },
  },
} satisfies CompleteDaemonMessage<Extract<
  ControlResponse,
  { type: 'github.pullRequest.overview.result' }
>>;
```

Add it to `OUTPUTS` as `control-github-pr-overview.json`, run:

```bash
pnpm run fixtures:generate
```

- [ ] **Step 4: Add Rust fixture decoding**

In `workspace_contract.rs`, add serde structs or an internally tagged enum that
decodes every `PullRequestQueryState` variant. Add:

```rust
#[test]
fn decodes_the_generated_github_pr_overview_fixture() {
    let fixture = include_str!(
        "../../../../../protocol-fixtures/control-github-pr-overview.json"
    );
    let envelope: GithubPullRequestOverviewEnvelope =
        serde_json::from_str(fixture).expect("PR fixture should decode");
    assert_eq!(envelope.r#type, "github.pullRequest.overview.result");
    assert_eq!(envelope.result.selection_generation, 7);
    match envelope.result.state {
        GithubPullRequestState::Ready { overview, .. } => {
            assert_eq!(overview.number, 184);
        }
        other => panic!("expected ready state, got {other:?}"),
    }
}
```

- [ ] **Step 5: Run contract tests**

```bash
pnpm vitest --run __tests__/controlProtocol.test.ts
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  decodes_the_generated_github_pr_overview_fixture
```

Expected: PASS.

- [ ] **Step 6: Commit the protocol**

```bash
git add src/control/protocol.ts protocol-fixtures/fixtures.ts \
  protocol-fixtures/control-github-pr-overview.json \
  scripts/generate-protocol-fixtures.ts __tests__/controlProtocol.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/workspace_contract.rs
git commit -m "feat: add PR overview control protocol"
```

### Task 3: Register the read-only host handler

**Files:**
- Create: `src/control/resources/github.ts`
- Modify: `src/control/credentials.ts`
- Modify: `src/control/host.ts`
- Modify: `src/control/server.ts`
- Create: `__tests__/controlGithubRead.test.ts`

- [ ] **Step 1: Write the failing host-handler test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGitHubReadResource } from '../src/control/resources/github.js';

it('validates project scope and delegates to the shared overview service', async () => {
  const query = vi.fn().mockResolvedValue({
    requestId: 'pr-1',
    projectId: '/repo',
    worktreePath: '/repo/.worktrees/pr',
    selectionGeneration: 7,
    observedAt: '2026-08-06T18:01:00Z',
    state: { kind: 'detachedHead' },
  });
  const resource = createGitHubReadResource({
    projectRoot: '/repo',
    service: { query },
    resolveScopedPath: vi.fn().mockReturnValue('/repo/.worktrees/pr'),
  });

  await expect(resource.overview({
    requestId: 'pr-1',
    projectId: '/repo',
    worktreePath: '/repo/.worktrees/pr',
    selectionGeneration: 7,
    refresh: false,
  })).resolves.toMatchObject({ state: { kind: 'detachedHead' } });
  expect(query).toHaveBeenCalledWith(expect.objectContaining({
    projectRoot: '/repo',
    worktreePath: '/repo/.worktrees/pr',
  }));
});
```

- [ ] **Step 2: Implement the resource**

`src/control/resources/github.ts`:

```ts
export interface GitHubReadResource {
  overview(input: {
    requestId: string;
    projectId: string;
    worktreePath: string;
    selectionGeneration: number;
    refresh: boolean;
  }): Promise<PullRequestOverviewResult>;
}

export function createGitHubReadResource(deps: {
  projectRoot: string;
  service: Pick<PullRequestOverviewService, 'query'>;
  resolveScopedPath: (projectRoot: string, requested: string) => string;
}): GitHubReadResource;
```

Require `projectId === canonical projectRoot`, resolve the worktree through the
existing control scope helper, and call the service. This module is read-only
and must not import mutation adapters.

- [ ] **Step 3: Wire the host and server**

`createHostControlPlane()` constructs one `PullRequestOverviewService` and
advertises:

```ts
features: ['github.pullRequest.overview']
```

Add `github.pullRequest.read` to the operator credential's allowed
capabilities. Agent and compatibility credentials do not receive it in this
slice.

`src/control/server.ts` handles the request outside `command.submit`:

```ts
case 'github.pullRequest.overview': {
  if (!session.principal.capabilities.includes('github.pullRequest.read')) {
    return session.send(errorResponse(
      msg.requestId,
      'forbidden',
      'GitHub pull request read capability required',
    ));
  }
  const result = await resources.github.overview(msg);
  return session.send({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'github.pullRequest.overview.result',
    requestId: msg.requestId,
    result,
  });
}
```

Return sanitized protocol errors for invalid scope or internal failures. Do not
append this read to the mutation command journal.

- [ ] **Step 4: Run focused tests**

```bash
pnpm vitest --run \
  __tests__/controlGithubRead.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlServer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the host integration**

```bash
git add src/control/resources/github.ts src/control/credentials.ts \
  src/control/host.ts src/control/server.ts __tests__/controlGithubRead.test.ts
git commit -m "feat: expose PR overview from control host"
```

### Task 4: Add the native canonical-endpoint client

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.lock`
- Create: `native/macos/psyche-build-tauri/src-tauri/src/control_client.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Create: `__tests__/tauriPullRequestOverview.test.ts`

- [ ] **Step 1: Write the failing source-contract test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lib = readFileSync(
  'native/macos/psyche-build-tauri/src-tauri/src/lib.rs',
  'utf8',
);
const client = readFileSync(
  'native/macos/psyche-build-tauri/src-tauri/src/control_client.rs',
  'utf8',
);

it('queries the canonical control endpoint without invoking gh in native code', () => {
  expect(lib).toMatch(/fn\s+github_pull_request_overview\(/);
  expect(lib).toMatch(/\n\s*github_pull_request_overview,/);
  expect(client).toContain('github.pullRequest.overview');
  expect(client).toContain('github.pullRequest.overview.result');
  expect(client).toContain('github.pullRequest.overview');
  expect(lib + client).not.toMatch(/Command::new\(["']gh["']\)|spawn\(["']gh["']/);
});
```

- [ ] **Step 2: Add transport dependencies**

Add pinned compatible versions:

```toml
futures-util = "0.3"
sha2 = "0.10"
tokio-tungstenite = "0.24"
```

Run:

```bash
cargo update --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

- [ ] **Step 3: Implement the native client**

`control_client.rs` exports:

```rust
pub(crate) async fn request_pull_request_overview(
    project_root: &str,
    worktree_path: &str,
    selection_generation: u64,
    refresh: bool,
) -> Result<GithubPullRequestOverviewResult, String>;
```

The implementation must:

1. Reuse the landed endpoint and credential file contracts exactly.
2. Canonicalize `project_root` and `worktree_path`; reject an escaped worktree.
3. Connect to the per-project Unix-domain WebSocket.
4. Send `hello` with the operator credential.
5. Require a `welcome` containing `github.pullRequest.overview`.
6. Send the request with a UUID-like request ID generated from time plus an
   atomic counter; do not add a UUID dependency.
7. Ignore unrelated frames and accept only the matching result or error.
8. Enforce a 15-second timeout and a 2 MiB frame limit.
9. Return concise errors without including the operator credential or raw
   frames.

In `lib.rs`:

```rust
#[tauri::command]
async fn github_pull_request_overview(
    project_root: String,
    worktree_path: String,
    selection_generation: u64,
    refresh: bool,
) -> Result<GithubPullRequestOverviewResult, String> {
    control_client::request_pull_request_overview(
        &project_root,
        &worktree_path,
        selection_generation,
        refresh,
    )
    .await
}
```

Register the command in `tauri::generate_handler!`.

- [ ] **Step 4: Add Rust tests with an injected fake transport**

Factor frame exchange behind an internal async function accepting a connected
stream. Test:

- missing feature -> `unsupported by host`;
- matching ready result decodes;
- mismatched request IDs are ignored;
- timeout returns a concise error;
- escaped worktree is rejected before connection;
- credential text never appears in errors.

- [ ] **Step 5: Run focused native tests**

```bash
pnpm vitest --run __tests__/tauriPullRequestOverview.test.ts
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  control_client
```

Expected: PASS.

- [ ] **Step 6: Commit the native client**

```bash
git add native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/Cargo.lock \
  native/macos/psyche-build-tauri/src-tauri/src/control_client.rs \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriPullRequestOverview.test.ts
git commit -m "feat: connect native app to PR overview endpoint"
```

### Task 5: Add the accessible PR panel shell and pure view model

**Files:**
- Modify: `native/macos/psyche-build-tauri/package.json`
- Create: `native/macos/psyche-build-tauri/web/github/pr-overview-model.mjs`
- Create: `native/macos/psyche-build-tauri/web/github/pr-overview-entry.js`
- Create: `native/macos/psyche-build-tauri/web/github.bundle.js`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriPullRequestOverview.test.ts`

- [ ] **Step 1: Write failing shell and view-model tests**

Require:

```ts
expect(indexHtml).toContain('data-panel-btn="pr"');
expect(indexHtml).toContain('class="panel panel-pr"');
expect(indexHtml).toContain('id="pr-view"');
expect(indexHtml).toContain('id="pr-refresh"');
expect(indexHtml).toContain('id="pr-open-github"');
expect(indexHtml).toContain('aria-live="polite"');
expect(mainJs).not.toMatch(/invoke\(["']gh/);
expect(stylesCss).toMatch(/\.pr-status-label/);
expect(stylesCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
```

Add pure model tests:

```ts
const model = await import(
  pathToFileURL(join(webRoot, 'github/pr-overview-model.mjs')).href
);

expect(model.describePullRequestState({ kind: 'detachedHead' })).toEqual({
  tone: 'neutral',
  title: 'Detached HEAD',
  message: 'Check out a branch to find an associated pull request.',
  retryable: false,
});
expect(model.describePullRequestState({
  kind: 'rateLimited',
  host: 'github.com',
  resetAt: '2026-08-06T19:00:00Z',
}).retryable).toBe(true);
```

- [ ] **Step 2: Implement the pure model**

Export:

```js
export function describePullRequestState(state) {
  switch (state.kind) {
    case 'ready':
      return { tone: 'ready', title: '', message: '', retryable: true };
    case 'noPullRequest':
      return {
        tone: 'neutral',
        title: 'No pull request',
        message: `No pull request is associated with ${state.branch}.`,
        retryable: true,
      };
    case 'detachedHead':
      return {
        tone: 'neutral',
        title: 'Detached HEAD',
        message: 'Check out a branch to find an associated pull request.',
        retryable: false,
      };
    case 'unsupportedRemote':
      return {
        tone: 'neutral',
        title: 'Unsupported remote',
        message: 'This worktree has no supported GitHub remote.',
        retryable: false,
      };
    case 'ambiguousAssociation':
      return {
        tone: 'warning',
        title: 'Multiple pull requests found',
        message: 'Psyche will not guess which fork pull request is associated.',
        retryable: true,
      };
    case 'unauthenticated':
      return {
        tone: 'warning',
        title: `Sign in to ${state.host}`,
        message: state.loginCommand,
        retryable: true,
      };
    case 'permissionDenied':
      return {
        tone: 'warning',
        title: 'Permission denied',
        message: 'The active GitHub account cannot read this repository.',
        retryable: true,
      };
    case 'rateLimited':
      return {
        tone: 'warning',
        title: 'GitHub rate limit reached',
        message: state.resetAt
          ? `Try again after ${state.resetAt}.`
          : 'Try again after the GitHub rate limit resets.',
        retryable: true,
      };
    case 'offline':
      return {
        tone: 'warning',
        title: 'GitHub is offline',
        message: 'Reconnect and retry to refresh pull request state.',
        retryable: true,
      };
    case 'providerUnavailable':
      return {
        tone: 'warning',
        title: 'GitHub CLI is unavailable',
        message: state.installMessage,
        retryable: true,
      };
    case 'invalidProviderResponse':
      return {
        tone: 'error',
        title: 'Incompatible GitHub response',
        message: 'Psyche could not validate the GitHub response.',
        retryable: true,
      };
    case 'failed':
      return {
        tone: 'error',
        title: 'Unable to load pull request',
        message: state.message,
        retryable: true,
      };
    default:
      return {
        tone: 'error',
        title: 'Invalid pull request state',
        message: 'Psyche received an unsupported pull request state.',
        retryable: true,
      };
  }
}

export function statusLabels(overview) {
  var checks = overview.checks;
  return [
    { kind: 'state', text: overview.isDraft ? 'Draft' : overview.state },
    {
      kind: 'review',
      text: overview.reviewDecision === 'APPROVED'
        ? 'Approved'
        : overview.reviewDecision === 'CHANGES_REQUESTED'
          ? 'Changes requested'
          : 'Review required',
    },
    {
      kind: 'checks',
      text: checks.failed > 0
        ? `${checks.failed} checks failed`
        : checks.pending > 0
          ? `${checks.pending} checks pending`
          : `${checks.passed}/${checks.total} checks passed`,
    },
  ];
}

export function blockerSummary(overview) {
  if (overview.mergeable === 'CONFLICTING') return 'Blocked by merge conflicts.';
  if (overview.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Blocked by requested changes.';
  }
  if (overview.checks.failed > 0) return 'Blocked by failing checks.';
  if (overview.checks.pending > 0) return 'Waiting for checks to complete.';
  if (overview.reviewDecision !== 'APPROVED') return 'Waiting for review approval.';
  return overview.mergeStateStatus === 'CLEAN'
    ? 'No merge blockers reported.'
    : 'GitHub is still computing merge readiness.';
}

export function isMatchingPullRequestResult(result, selection) {
  return result &&
    result.projectId === selection.projectId &&
    result.worktreePath === selection.worktreePath &&
    result.selectionGeneration === selection.generation;
}
```

The state switch must cover every domain state. Unknown values return
`Invalid pull request state` with `tone: 'error'`; they are never treated as
`noPullRequest`.

- [ ] **Step 3: Bundle the model for the static shell**

`pr-overview-entry.js` assigns the pure exports to
`window.PsychePullRequest`. Extend `build:web`:

```json
"build:web": "esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js && esbuild web/github/pr-overview-entry.js --bundle --minify --format=iife --global-name=PsychePullRequest --outfile=web/github.bundle.js"
```

Load `github.bundle.js` after `sessions.bundle.js` and before `main.js`.

- [ ] **Step 4: Add panel markup**

Add a fifth panel and rail button. The panel includes:

```html
<div class="panel panel-pr">
  <header class="pane-header panel-bar">
    <span class="panel-title">Pull Request</span>
    <span class="panel-crumb" id="pr-crumb"></span>
    <button id="pr-open-github" class="icon-btn ghost-btn"
            title="Open pull request on GitHub"
            aria-label="Open pull request on GitHub" disabled>↗</button>
    <button id="pr-refresh" class="icon-btn ghost-btn"
            title="Refresh pull request"
            aria-label="Refresh pull request">↻</button>
  </header>
  <div class="panel-body">
    <div class="pr-view" id="pr-view" aria-live="polite"></div>
  </div>
</div>
```

Use an SVG rail icon, `aria-pressed`, and the existing rail-button pattern.

- [ ] **Step 5: Add constrained, semantic styles**

Add `.panel-pr` to the shared panel grid selectors. Style internal scrolling,
focus-visible controls, status labels with text plus icons, monospaced
repository/branch metadata, wrapped long content, a stable loading skeleton,
stale banner, metric grid, and blocker box. Use existing palette variables.
Do not add page-level horizontal scrolling.

- [ ] **Step 6: Run panel-model tests and build the bundle**

```bash
pnpm --dir native/macos/psyche-build-tauri run build:web
pnpm vitest --run __tests__/tauriPullRequestOverview.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the panel shell**

```bash
git add native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/github \
  native/macos/psyche-build-tauri/web/github.bundle.js \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriPullRequestOverview.test.ts
git commit -m "feat: add native pull request inspector"
```

### Task 6: Wire selection-safe loading, refresh, stale data, and navigation

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriPullRequestOverview.test.ts`

- [ ] **Step 1: Write failing request-generation tests**

Extract and compile the new functions as existing editor tests do. Require:

```ts
expect(mainJs).toMatch(/var\s+prSelectionGeneration\s*=\s*0/);
expect(mainJs).toMatch(/invoke\("github_pull_request_overview"/);
expect(mainJs).toMatch(/PsychePullRequest\.isMatchingPullRequestResult/);
expect(mainJs).toMatch(/document\.addEventListener\("visibilitychange"/);
expect(mainJs).toMatch(/if\s*\(panelIsVisible\("pr"\)\)\s*renderPullRequestPanel/);
```

Add an async test where generation 1 resolves after generation 2 and assert
only generation 2 renders.

- [ ] **Step 2: Add panel state**

```js
var prSelectionGeneration = 0;
var prCache = window.PsycheCodeEditor.createLruCache(32);
var prLastReadyBySelection = Object.create(null);
var prOpenUrl = null;
```

The cache key is:

```js
project.id + "\0" + activeWorkspaceRoot(project)
```

- [ ] **Step 3: Implement rendering and refresh**

Add:

```js
async function renderPullRequestPanel(options) {
  if (!panelIsVisible("pr")) return;
  options = options || {};
  var project = activeProject();
  if (!project) return renderPrMessage("No project open — ⌘O to add one.");
  var worktreePath = activeWorkspaceRoot(project);
  var generation = ++prSelectionGeneration;
  var selection = {
    projectId: project.id,
    worktreePath: worktreePath,
    generation: generation,
  };
  var key = project.id + "\0" + worktreePath;
  var cached = prCache.get(key);
  var fresh = cached && Date.now() - cached.fetchedAt < 60_000;
  if (cached) renderPullRequestResult(cached.result, { stale: !fresh });
  if (fresh && !options.refresh) return;
  if (!cached) renderPrLoading();
  try {
    var result = await invoke("github_pull_request_overview", {
      projectRoot: project.root,
      worktreePath: worktreePath,
      selectionGeneration: generation,
      refresh: !!options.refresh,
    });
    if (!window.PsychePullRequest.isMatchingPullRequestResult(result, selection)) return;
    if (result.state && result.state.kind === "ready") {
      prCache.set(key, { result: result, fetchedAt: Date.now() });
      prLastReadyBySelection[key] = result;
    }
    renderPullRequestResult(result, { stale: false });
  } catch (error) {
    if (generation !== prSelectionGeneration || !panelIsVisible("pr")) return;
    var lastReady = prLastReadyBySelection[key];
    if (lastReady) {
      renderPullRequestResult(lastReady, {
        stale: true,
        refreshError: String(error),
      });
    } else {
      renderPrMessage("Unable to load pull request: " + String(error), "panel-error");
    }
  }
}
```

Implement `renderPrLoading()`, `renderPrMessage(text, className)`,
`renderPullRequestResult(result, options)`, and
`renderReadyPullRequest(overview, options)` with DOM construction plus
`textContent`; do not render provider strings through `innerHTML`.
`renderPullRequestResult()` calls `describePullRequestState()` for every
non-ready state. `renderReadyPullRequest()` renders the title, status labels,
branch relationship, bounded description, labels/reviewers, metrics, blocker
summary, stale banner, and observation time. It sets `prOpenUrl` only after:

```js
var parsed = new URL(overview.url);
if (parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== overview.repository.host.toLowerCase()) {
  throw new Error("invalid pull request URL");
}
prOpenUrl = parsed.toString();
```

Add:

- PR branch selection rerender in the worktree click handler;
- `renderPanel('pr')`;
- refresh button -> `renderPullRequestPanel({ refresh: true })`;
- open button -> existing `openUrl(prOpenUrl)`;
- focus/visibility refresh after 60 seconds;
- project removal/switch invalidation;
- panel collapse increments generation to invalidate in-flight requests.

- [ ] **Step 4: Run the native UI tests**

```bash
pnpm vitest --run \
  __tests__/tauriPullRequestOverview.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the UI behavior**

```bash
git add native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriPullRequestOverview.test.ts
git commit -m "feat: load branch-associated PR overviews"
```

### Task 7: Verify Slice 1 end to end

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-github-pr-native-overview.md`
- Modify: `.copilot/goals.md`

- [ ] **Step 1: Run focused TypeScript and native tests**

```bash
pnpm vitest --run \
  __tests__/githubTypes.test.ts \
  __tests__/githubRemotes.test.ts \
  __tests__/githubRepositoryContext.test.ts \
  __tests__/githubCommandRunner.test.ts \
  __tests__/githubCliProvider.test.ts \
  __tests__/pullRequestOverviewService.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlGithubRead.test.ts \
  __tests__/tauriPullRequestOverview.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository gates**

```bash
pnpm run typecheck
pnpm run build
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm --dir native/macos/psyche-build-tauri build
```

Expected: PASS.

- [ ] **Step 3: Run the full suite and compare with baseline**

```bash
pnpm run test
```

Expected: no new failures beyond any explicitly accepted environment baseline.
Investigate and fix every additional failure.

- [ ] **Step 4: Exercise real GitHub states manually without mutations**

With an authenticated `gh` account, verify:

1. branch with an open PR;
2. branch with no PR;
3. detached HEAD;
4. unauthenticated host;
5. rapid switching between two projects/worktrees;
6. offline refresh preserving stale ready data;
7. `Open on GitHub`;
8. no `git push`, `gh pr edit`, comment, review, rerun, close, or merge command.

- [ ] **Step 5: Review logs and persisted state**

Confirm no token, operator credential, raw `gh` output, PR body beyond the
bounded preview, or provider stderr appears in logs, Tauri errors, saved
workspace JSON, protocol fixtures, or activity history.

- [ ] **Step 6: Mark the plan and durable goal complete**

Change completed checkboxes to `[x]`. Update `.copilot/goals.md`:

```text
progress: 1/10 lifecycle slices
next: Design the searchable pull request discovery and repository views slice.
```

Append commit IDs, focused test counts, packaged build result, manual scenarios,
and any still-accepted baseline exceptions.

- [ ] **Step 7: Commit the completed slice**

```bash
git add docs/superpowers/plans/2026-08-06-github-pr-native-overview.md
git commit -m "feat: complete branch-associated PR overview"
```
