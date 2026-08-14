# Merged Regression Hotfixes Design

**Date:** 2026-08-12
**Status:** Approved

## Goal

Correct two regressions discovered while reviewing branches that merged into
`main`:

1. prevent a stale generation-less pane identity from removing a replacement
   pane owned by a newer tmux server generation; and
2. ensure iOS read-gate tests fail promptly if an expected secure-store read
   never starts.

The fixes will ship as two independent pull requests so production behavior
and test-infrastructure behavior can be reviewed, validated, and reverted
separately.

## Isolation

Create each hotfix branch from the latest `origin/main` in a new clean
worktree. Existing worktrees, including those with uncommitted changes, remain
untouched.

Each branch contains only its focused implementation, regression tests, and
this design's directly relevant documentation. Required checks and a read-only
code review must pass before merging.

## Hotfix A: Symmetric Pane Identity Matching

### Problem

`ProjectPaneConfig` currently treats a missing expected `tmuxServerIdentity` as
a wildcard. A stale UI record containing only `{id, paneId}` can therefore
match a persisted replacement record that has the same identifiers but belongs
to a newer tmux server generation. The close path may then terminate and remove
the replacement pane.

### Design

Make generation matching symmetric:

- when both identities omit `tmuxServerIdentity`, matching continues to use
  `id` and `paneId`;
- when both identities include `tmuxServerIdentity`, they must identify the
  same tmux server generation; and
- when only one identity includes `tmuxServerIdentity`, the records do not
  match.

This preserves legacy-to-legacy cleanup while preventing generation-less state
from authorizing deletion of generation-tagged state.

The close action continues passing the identity available on the selected
pane. No fallback should manufacture or discard generation information.

### Failure behavior

An identity mismatch must follow the existing stale-identity rejection path.
It must not kill the pane, remove the record, or silently report successful
cleanup.

### Testing

Extend focused `ProjectPaneConfig` and close-action coverage to prove:

- generation-less expected identity matches a generation-less record;
- matching generation-tagged identities match;
- different generations do not match;
- generation-less expected identity does not match a generation-tagged
  replacement; and
- the rejected stale close does not invoke pane teardown or remove the
  replacement record.

## Hotfix B: Bounded iOS Read Gates

### Problem

The synchronized test gates introduced for secure-store read races use checked
continuations without a timeout or cancellation path. If production code stops
performing the expected read, the tests can suspend until the CI job's
60-minute timeout instead of producing a focused failure.

### Design

Retain the lock-protected continuation handoff that removed scheduler-dependent
`Task.yield()` polling. Add a bounded async wait around each
`waitUntilReadBegins` call:

- the read-start signal completes the wait normally;
- a short test-only deadline fails the test with a descriptive timeout; and
- timeout cleanup removes or invalidates the pending waiter so a later read
  cannot resume an abandoned continuation.

Use one shared test helper when practical so `ConnectionManagerTests` and
`PairedHostStoreTests` have identical timeout and cleanup semantics.

### Failure behavior

A missing read must fail within seconds with the name of the expected event.
The gate must not leak a continuation, double-resume after timeout, or alter
production secure-store behavior.

### Testing

Cover both outcomes:

- the waiter completes when the secure-store read begins; and
- a deliberately absent read reaches the bounded failure path without hanging.

Run the focused iOS test targets that use both secure-store gate
implementations.

## Integration

For each hotfix:

1. implement and run the smallest focused tests;
2. run the repository's relevant type checks or platform tests;
3. push the isolated branch and open a pull request to `main`;
4. perform a fresh read-only code review of the final PR diff;
5. wait for required GitHub checks; and
6. merge through the pull request using the repository's linear-history
   policy.

If either review or CI reports a blocker, fix that PR independently and do not
delay or broaden the other hotfix.

## Acceptance Criteria

1. A stale generation-less pane close cannot kill or remove a
   generation-tagged replacement pane.
2. Legacy generation-less records can still be removed by matching legacy
   identities.
3. The iOS read-race tests retain deterministic synchronization.
4. Missing expected reads fail promptly rather than consuming the full CI job
   timeout.
5. Existing dirty worktrees remain byte-for-byte untouched.
6. Both hotfixes reach `main` only through reviewed, passing pull requests.
