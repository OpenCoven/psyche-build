# Tiered CI Design

## Goal

Reduce pull-request feedback time and runner waste without weakening the checks
that protect shared TypeScript, desktop, iOS, package, and release surfaces.
Pull requests should receive fast, parallel correctness signals. Pushes to
`main` and release tags should retain the expensive end-to-end coverage.

## Current Problems

The current pull-request workflow repeats several expensive operations:

- desktop web bundles are built in the primary job and on every desktop OS;
- Rust formatting, tests, and checks run in the primary job and on every OS;
- platform-neutral desktop Vitest contracts run three times;
- every pull request runs the full iOS Core, app build, app test, and UI test
  sequence;
- package installation smoke runs on every pull request even though the release
  workflow independently verifies the exact release tag;
- Linux Tauri prerequisite installation is slow and has repeatedly stalled all
  otherwise-green pull requests.

These repetitions increase wall-clock latency and expose PRs to unrelated
runner failures without adding equivalent independent coverage.

## Validation Tiers

### Pull requests

Pull requests use small jobs that begin in parallel.

#### `changes`

A read-only classifier compares the pull-request base and head commits and
publishes `desktop` and `ios` booleans. It uses repository-owned shell logic and
`git diff --name-only`; no mutable third-party path-filter action is added.

Desktop-sensitive paths include:

- `native/desktop/**`;
- Rust manifests, lockfiles, and toolchain configuration;
- desktop contract tests and desktop build scripts;
- workflow and package-manager configuration used by desktop jobs.

iOS-sensitive paths include:

- `native/ios/**`;
- iOS project-generation actions and scripts;
- protocol, control, and shared contract surfaces consumed by mobile;
- workflow and package-manager configuration used by iOS jobs.

If classification cannot establish a valid base or encounters an unknown
event, it fails open by enabling both platform groups.

#### `quality`

This job always runs on macOS because repository tests depend on tmux.

It performs:

- locked dependency installation;
- the complete root Vitest suite;
- production and test typechecks;
- the root build;
- the public-documentation focus check and production docs build when those
  commands exist on the integrated branch.

It does not run Rust commands, desktop bundle parity, iOS builds, or package
installation smoke.

#### `desktop-web`

This job runs when `changes.desktop` is true and performs the platform-neutral
desktop contract tests and one authoritative desktop web bundle build/parity
check. No desktop matrix member repeats these commands.

#### `rust-test`

This job runs when `changes.desktop` is true on macOS. It performs Rust
formatting and the complete Rust test suite once.

#### `desktop-check`

This macOS, Windows, and Ubuntu matrix runs when `changes.desktop` is true. Each
member performs only locked dependency setup and `cargo check` for its native
platform. Linux installs the Tauri system prerequisites before checking.

The matrix remains fail-fast false so one platform failure does not hide
results from another. The Linux job receives a tighter timeout around package
installation so a stalled mirror cannot hold a PR for an hour.

#### `ios-core`

This job runs when `changes.ios` is true and performs:

- pinned Xcode and simulator validation;
- generated Xcode project parity;
- `PsycheCore` tests.

It does not run the separate `PsycheApp` build or app/UI test suite.

### Pushes to `main`

The same workflow escalates coverage on `main`:

- desktop platform jobs run regardless of path classification;
- full Rust tests and native checks run;
- the complete iOS Core, app build, app test, and UI test sequence runs;
- package installation smoke runs against the integrated commit.

This catches cross-surface integration defects before a release tag is cut
without making every pull request wait for the longest native suites.

### Releases

The release workflow remains fail-closed and verifies the exact signed tag.
Release-only or release-critical work includes:

- release version and signed-tag consistency;
- package archive and clean-install smoke;
- full TypeScript, Rust, desktop web, and native verification;
- full iOS Core, app, and UI tests before TestFlight;
- native Apple Silicon and Intel builds;
- signing, notarization, stapling, checksums, draft release publication, and
  Homebrew/TestFlight publication.

Release jobs must not accept a prior branch artifact or status as proof for the
tag being published.

## Job Dependencies and Required Checks

`quality` is independent of platform classifiers and starts immediately.
Platform jobs depend only on `changes`; they do not form a serial chain.

Stable aggregate jobs provide branch-protection targets:

- `TypeScript and Rust` preserves the existing required check name and depends
  on `quality`, `desktop-web`, `rust-test`, and `desktop-check`, succeeding only
  when desktop jobs pass or are intentionally skipped by the classifier;
- `iOS` preserves the existing required check name, uses `always()`, and
  succeeds when `ios-core` passes or is intentionally skipped.

The aggregates fail when a required upstream job fails or is cancelled. This
keeps the repository's current branch-protection checks stable while allowing
safe path-based skips. No branch-protection API mutation is required during
rollout.

## Failure Handling

- Unknown or malformed change classification enables the affected platform
  jobs rather than skipping them.
- Every command remains fail-closed; no validation step uses
  `continue-on-error`.
- Linux prerequisite installation has explicit noninteractive apt settings and
  a bounded timeout.
- Main and release events do not use path-based platform skips.
- Release verification remains independent of prior workflow conclusions.

## Test Contract

Workflow contract tests will verify:

- stable aggregate required-check names;
- pull-request jobs run in parallel after classification;
- desktop bundle parity and Rust tests occur exactly once on pull requests;
- the desktop matrix performs platform checks without repeated web or Vitest
  work;
- pull requests run only `PsycheCore`, while `main` and release run the app/UI
  sequence;
- package installation smoke is absent from ordinary PR jobs and present on
  `main` and release;
- path classification fails open and covers shared protocol/control,
  workflow, lockfile, desktop, and iOS surfaces;
- action pins, read-only permissions, credential handling, and release secret
  boundaries remain unchanged.

## Success Criteria

- A documentation-only pull request completes without desktop or iOS runner
  allocation.
- A typical TypeScript pull request receives its required result from the
  quality job without waiting for full iOS UI tests.
- A desktop change receives one web parity build, one Rust test run, and three
  parallel native compile checks.
- An iOS change receives Core tests on the pull request and the full app/UI
  suite after integration to `main`.
- Pushes to `main` and release tags retain comprehensive platform validation.
