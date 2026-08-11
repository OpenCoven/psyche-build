# GitHub Branch-Associated Pull Request Overview

**Date:** 2026-08-06
**Status:** Approved design
**Long-running goal:** `comprehensive-github-pr-support`

## Goal

Deliver the first production-quality pull request slice in Psyche: selecting a
Git worktree or branch resolves its associated GitHub pull request and renders a
read-only overview in the native macOS inspector.

This slice establishes the shared GitHub domain, provider, synchronization, and
client contract needed by later discovery, review, checks, creation, agent, and
merge workflows. It must not create a native-only GitHub implementation or a
temporary transport that bypasses Psyche's approved host-control-plane
architecture.

## Product Context

Psyche already has:

- branch and worktree identity in workspace snapshots;
- an explicit TUI create-pull-request flow;
- `gh`-backed PR creation and existing-PR detection;
- a native multi-project cockpit with a left project/session rail, central
  terminal/editor/diff workspace, and right Browser, Files, Diffs, and Git
  inspector;
- typed daemon and bridge protocols; and
- an approved per-project host-control-plane design with collision-free local
  endpoints shared by desktop, TUI, MCP, and compatibility adapters.

The missing foundation is a reusable GitHub read model. Existing PR code is
action-specific, synchronous, local-branch-centric, and not exposed to the
native workspace.

## Program Decomposition

The long-running PR goal remains a sequence of independently useful vertical
slices:

1. Branch association and read-only PR overview.
2. Searchable PR discovery and repository views.
3. Changed files, diff navigation, and persistent review progress.
4. Inline comments, suggestions, threads, and review submission.
5. Checks, workflow hierarchy, annotations, and CI diagnostics.
6. PR creation and metadata editing through the shared provider.
7. Agent-assisted review, failure investigation, and repair preparation.
8. Merge readiness, conflict guidance, and confirmation-gated merge actions.
9. Notifications, requested-review inboxes, and activity history.
10. Native OAuth, multiple accounts, Enterprise administration, webhooks, and
    performance hardening.

This document specifies only Slice 1.

## Selected Architecture

### Shared TypeScript authority

GitHub behavior belongs in a new typed TypeScript domain and provider layer,
not in the native frontend or Tauri backend.

The initial provider uses the authenticated GitHub CLI. `gh` is an official
OAuth-backed GitHub client, keeps credentials outside Psyche, supports GitHub
Enterprise hosts, and is already required by the existing PR creation flow.
The provider interface must not expose command details to consumers, allowing a
future native OAuth or GitHub App adapter to implement the same contract.

### Canonical project endpoint

The provider is exposed through the canonical per-project control endpoint
defined by the Psyche host-control-plane program. Native, TUI, MCP, and future
clients consume the same request and response contract.

The current project-scoped daemon v0 port is not a suitable permanent native
transport because the desktop app manages multiple projects. The PR slice will
not add another fixed port, native-only subprocess protocol, or direct Tauri
`gh` implementation.

### Two implementation checkpoints

Checkpoint A can proceed independently:

- domain models and runtime validation;
- Git remote and branch normalization;
- `gh` account, repository, association, and overview queries;
- typed error classification;
- cache and stale-response protection;
- provider tests and protocol fixtures.

Checkpoint B completes the vertical slice after the canonical per-project
endpoint is available:

- register the read-only PR query with the host owner;
- add the native endpoint client call;
- render the PR inspector and all non-success states;
- run cross-language contract, native, integration, and packaging validation.

Slice 1 is not counted complete until Checkpoint B ships.

## Authority and Security Boundaries

- Git and GitHub remain authoritative for repository and PR state.
- The host owner coordinates requests and publishes typed observations; it does
  not claim cached data is live.
- The native UI never shells out to Git or `gh`.
- Psyche never accepts, prints, persists, or forwards a GitHub token.
- Provider commands use argument arrays, bounded output, explicit working
  directories, and structured JSON fields.
- Provider errors are sanitized before entering protocol responses, logs,
  telemetry, prompts, or persisted activity.
- The initial slice is read-only. It cannot push, comment, review, rerun,
  update metadata, close, or merge.
- Project and worktree paths pass the canonical containment and project-identity
  boundaries already required by the control plane.
- Host and account identity are explicit in cache keys and responses so data
  from one GitHub host or login cannot be reused for another.

## Domain Model

The domain separates transport-independent identity, ready data, and query
state.

### GitHub identity

`GitHubAccountRef` contains:

- normalized hostname;
- active login;
- authentication source, initially `gh`;
- optional stable account identifier when the provider supplies one.

`GitHubRepositoryRef` contains:

- hostname;
- owner;
- repository name;
- canonical web URL;
- visibility when available;
- archived and fork indicators when available.

The first UI supports one active `gh` account per host. The model permits
multiple account references later without changing PR or cache identities.

### Branch association

`PullRequestAssociationInput` contains:

- canonical project ID and root;
- canonical selected worktree path;
- current branch or detached-head state;
- configured remotes and branch upstream;
- a caller-generated request ID and selection generation.

Association prefers the branch's configured upstream remote, then `origin`,
then the first supported GitHub remote. HTTPS and SSH remote forms normalize to
the same host/owner/repository identity.

Detached heads, repositories without GitHub remotes, missing branches,
ambiguous fork heads, and unsupported remote forms return explicit states. They
do not silently fall back to an unrelated repository.

### Pull request overview

`PullRequestOverview` contains the bounded fields needed by the inspector:

- repository, number, URL, title, and bounded description preview;
- author;
- open, draft, merged, or closed state;
- base and head repository/branch identity;
- labels, assignees, and requested reviewers;
- review decision summary;
- required/optional check summary by terminal state;
- mergeability and merge-state summary when GitHub has computed them;
- additions, deletions, changed-file count, and commit count;
- update timestamp;
- viewer permissions relevant to later actions;
- fetch timestamp and freshness metadata.

Large descriptions, review histories, check logs, files, commits, and timeline
events are not included in this overview payload. Later endpoints paginate
those resources.

### Query states

Consumers receive a discriminated state:

- `ready`;
- `noPullRequest`;
- `detachedHead`;
- `unsupportedRemote`;
- `ambiguousAssociation`;
- `unauthenticated`;
- `permissionDenied`;
- `rateLimited`;
- `offline`;
- `providerUnavailable`;
- `invalidProviderResponse`; or
- `failed`.

Loading remains client state associated with an in-flight request. A response
always carries its request ID, selection generation, repository key when known,
and observation time.

The active account is observed provider identity, not user-entered repository
configuration. If `gh` reports a different active login than the one attached
to a cache entry or in-flight request, the service invalidates that state and
restarts the lookup under the newly observed account. It does not render data
from the previous login or invent an account-mismatch error without an
independent expected-account source.

## Provider Behavior

The initial `GitHubCliProvider`:

1. verifies that `gh` is available;
2. reads authentication status for the normalized host;
3. resolves the selected worktree's GitHub repository identity;
4. resolves the current head branch to a pull request;
5. requests only the JSON fields required by `PullRequestOverview`;
6. validates and normalizes the returned shape;
7. classifies errors without copying arbitrary stderr into domain values; and
8. returns a bounded typed result.

The provider may reuse read-side command-runner primitives from the existing
action-specific helpers rather than maintaining another process wrapper.
Checkpoint A must not modify the existing create-PR mutation path or its
confirmation behavior. That flow migrates to the shared provider only in a
later slice after equivalent mutation and confirmation contracts exist.

Fork association is supported when the provider can prove the head repository,
owner, and branch. If more than one candidate remains, the result is
`ambiguousAssociation`; the slice never guesses.

## Caching and Synchronization

The service uses two bounded caches:

- association cache keyed by host, account, repository, and head identity;
- overview cache keyed by host, account, repository, and PR number.

Entries include fetch time and provider identity. Cache size and time-to-live
are finite. Authentication changes, host changes, explicit refresh, repository
identity changes, and branch changes invalidate relevant entries.

The native client requests data when:

- the selected project or worktree changes;
- the PR inspector becomes visible;
- the window regains focus after the freshness interval; or
- the user selects Retry or Refresh.

Every selection increments a generation. A response renders only when its
project ID, worktree path, and generation still match the current selection.
Late responses are ignored.

If refresh fails after a successful fetch, the last ready overview remains
visible with a stale banner and the typed refresh failure. Failure never
becomes an empty success state.

Phase 1 uses bounded refresh rather than webhooks. Event-driven invalidation can
replace or supplement polling later without changing the read model.

## Native Inspector

The existing right rail gains a `PR` panel beside Browser, Files, Diffs, and
Git. Selecting it does not change the central terminal, editor, diff, scroll,
selection, or open-tab state.

The ready view shows:

- repository and PR number;
- title and author;
- state, review, and check-status labels;
- head-to-base branch relationship;
- a collapsed description preview;
- labels, assignees, and requested reviewers with progressive disclosure;
- changed files, additions, deletions, and commits;
- mergeability or the reason it is still unknown;
- a concise blocker summary; and
- `Open on GitHub`.

`Open on GitHub` uses the existing safe external opener. It is navigation, not
a GitHub mutation.

Non-ready states remain in the panel and preserve surrounding workspace
context:

- loading uses a stable skeleton with no layout shift;
- no PR explains that the selected branch has no associated pull request;
- detached or unsupported branches explain why association is unavailable;
- ambiguous association explains that multiple fork/head candidates were found
  and refuses to choose one;
- unauthenticated provides the exact safe `gh auth login --hostname <host>`
  next step without displaying credentials;
- permission and rate-limit states explain the constraint and allow retry;
- offline explains that cached data may be unavailable until connectivity
  returns;
- provider unavailable supplies the existing platform-specific `gh`
  installation guidance;
- an invalid provider response is reported as incompatible GitHub data and
  never rendered partially;
- stale data remains readable with its observation time;
- unexpected failures show a concise sanitized error and Retry.

The panel is keyboard reachable, exposes pressed/selected state, retains a
visible focus indicator, uses semantic labels in addition to color, respects
reduced motion, and contains long paths, branches, titles, and descriptions
without page-level horizontal overflow.

On narrow native layouts, the existing right rail behavior remains
authoritative. The PR panel scrolls internally and keeps the title, state, and
blocker summary ahead of secondary metadata.

## Protocol Contract

The canonical control protocol adds a read-only request similar to:

```text
github.pullRequest.overview {
  requestId,
  projectId,
  worktreePath,
  selectionGeneration,
  refresh
}
```

The response contains the same request identity and one discriminated query
state. It does not contain credentials, raw command output, or arbitrary stderr.

The TypeScript protocol, generated fixture, and native Rust decoder must agree
byte-for-byte on field names, optionality, enum values, and timestamps. Fixtures
use fixed synthetic timestamps.

The canonical endpoint's existing protocol-version rejection remains
fail-closed. Separately, the host advertises supported read capabilities. A new
native client connected to a host that lacks `github.pullRequest.overview`
renders the panel as unsupported and does not send the request. If capability
advertisement is not yet present when Checkpoint B starts, adding it is an
explicit host-control-plane prerequisite, not a PR-specific version fork.

Because the operation is read-only, it does not enter the mutation command
journal. Provider observations may emit bounded audit events containing actor,
project, repository key, operation, outcome class, duration, and cache status,
but never descriptions, source, logs, or credentials.

## Error Handling

- Missing `gh` is `providerUnavailable` and retains the repository's existing
  platform-specific installation guidance.
- Missing authentication is `unauthenticated`, not a generic command failure.
- An active-account change invalidates prior account-keyed cache and in-flight
  state before a new lookup starts.
- Repository or PR permission failures remain distinct from no matching PR.
- Rate limits include a reset time only when the provider supplies a validated
  timestamp.
- Timeouts and network failures are bounded and retryable.
- Malformed JSON or missing required fields is `invalidProviderResponse`.
- Process spawn errors, nonzero exits, and validation failures cannot leak raw
  environment variables or command output.
- Cache writes occur only after full validation.
- A failed or interrupted refresh cannot replace a newer cache entry.

## Testing

### TypeScript unit coverage

- HTTPS and SSH GitHub remote normalization, including Enterprise hosts.
- Remote preference and branch-upstream selection.
- Same-repository, proven fork, ambiguous fork, detached, and no-remote
  association.
- Provider JSON validation and bounded description handling.
- Authentication, permission, rate-limit, offline, unavailable, malformed, and
  generic failure classification.
- Cache key isolation by host and account.
- TTL, refresh, invalidation, size bound, and stale-write rejection.

### Integration coverage

- Temporary Git repositories with main and linked worktrees.
- A fake `gh` executable that records argument arrays and returns controlled
  JSON or errors without using live credentials.
- Branch changes during an in-flight request.
- Concurrent requests for two projects and two hosts.
- Provider restart and cache reconstruction behavior where applicable.
- Canonical endpoint authentication, project scope, capability negotiation, and
  request/response round trips.

### Contract and native coverage

- Shared TypeScript fixture generation and Rust decoding.
- Source-contract tests requiring the PR rail control and canonical endpoint
  call while forbidding direct `gh` invocation in native code.
- Loading plus every response state: ready, no-PR, detached, unsupported remote,
  ambiguous association, unauthenticated, permission denied, rate limited,
  offline, provider unavailable, invalid provider response, and generic failure.
- Stale-ready rendering paired with each refresh failure class.
- Selection-generation suppression for late responses.
- Keyboard focus, visible focus treatment, semantic status labels, reduced
  motion, narrow panel layout, and long-content containment.
- Safe `Open on GitHub` URL handling.

### Repository gates

Run the smallest focused tests during development, then:

```text
pnpm run typecheck
pnpm run test
pnpm run build
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm --dir native/macos/psyche-build-tauri build
```

Release validation continues to distinguish repository smoke coverage from
package-archive and native packaging coverage.

## Acceptance Criteria

- Selecting a supported worktree branch resolves its associated GitHub PR
  through the shared provider and canonical per-project endpoint.
- The native PR inspector renders a real, bounded overview without invoking
  `gh` directly.
- GitHub host and active account identity are explicit and isolated.
- Same-repository and provable fork associations work; ambiguity fails visibly.
- Loading, no-PR, detached, unsupported remote, ambiguous association,
  unauthenticated, permission denied, rate limited, offline, provider
  unavailable, invalid-provider-response, stale, and generic failure states are
  complete and actionable.
- Rapid project/worktree switching cannot render stale PR data.
- No GitHub credential, raw provider output, or sensitive environment data
  enters logs, protocols, prompts, telemetry, or persisted UI state.
- Existing TUI create-PR behavior and native Browser, Files, Diffs, Git,
  terminal, editor, and session behavior remain unchanged.
- Protocol fixtures, focused tests, repository gates, and packaged native build
  pass.

## Deferred Work

This slice does not add global discovery, timeline events, changed-file PR
diffs, comments, pending reviews, review submission, CI logs, metadata
mutations, PR creation migration, notifications, merge actions, native OAuth,
simultaneous accounts, or webhooks. Those features build on the provider,
identity, cache, protocol, and inspector foundations defined here.
