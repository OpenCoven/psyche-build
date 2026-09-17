# Psyche Build release acceptance

**Status:** Reusable release gate; macOS `v0.0.1` and `v0.0.2` published

**Active stabilization owner:** [#196](https://github.com/OpenCoven/psyche-build/issues/196)  
**Executable evidence slice:** [#239](https://github.com/OpenCoven/psyche-build/issues/239)  
**Bounded operator runbook:** [OPERATOR-ACCEPTANCE-SLICE.md](./OPERATOR-ACCEPTANCE-SLICE.md)  
**Graphics evidence procedure:** [GPU-VERIFICATION-MATRIX.md](./GPU-VERIFICATION-MATRIX.md) (#232 under #199; no physical acceptance asserted)<br>
**Completed publication outcomes:** [#194](https://github.com/OpenCoven/psyche-build/issues/194) and [#203](https://github.com/OpenCoven/psyche-build/issues/203)  
**Support contract:** [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md)  
**Execution order:** [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)

This document defines the evidence required to call a Psyche Build release
supported. It complements the mechanical [release runbook](./RELEASE.md): the
runbook explains how to publish; this file distinguishes what has already been
proven for `v0.0.1`, what remains open operator-observed stabilization work, and
what must be repeated for a future release.

A green CI run, a passing unit-test count, source presence, or a successful
build job does not by itself prove that a clean user can install, launch,
operate, recover, and remove the application.

## Evidence status for `v0.0.1`

| Evidence class | Status | Owner and proof |
|---|---|---|
| Immutable source, signed tag, dual-architecture artifacts, checksums, signing, notarization, stapling, Gatekeeper, and public download verification | **Complete** | #194; accepted source `57c6c71bd5264fde960b062e95de278c8438c94f` |
| Desktop-only release independence while retaining shared validation | **Complete** | #203 and protected run `32629730508` |
| Stable GitHub Release and native Homebrew Cask | **Complete** | #194, `OpenCoven/homebrew-tap#2`, and native Apple Silicon/Intel lifecycle runs |
| Operator-observed first-run, ordinary lifecycle, persistence/recovery, Git/cleanup, and optional-provider isolation | **Open post-release stabilization debt** | #196 executed through #239 |
| Administrator-enforced required checks and resolved review threads, with no bypass actors | **Complete; corrected 2026-09-05** | [#31](https://github.com/OpenCoven/psyche-build/issues/31) correction and PR #351 (`23cace08`); historical `GH013` direct-push proof remains valid |
| iOS distributed-build and physical-device acceptance | **Not part of the macOS `v0.0.1` claim** | Planned under #200 |
| Versioned bounded support bundle | **Schema complete; production surface partial** | Schema #243 via PR #278 (`69769cc5`); CLI and bounded persistence via PR #462; provenance, persistence, lifecycle and updater collectors via PRs #462 and #467. Provider, graphics, receipt and terminal collectors, and any UI, remain absent. All of it postdates `v0.0.1`, which contains none of it |
| Reusable recovery harness | **Delivered on source only** | #199 via PRs #354-#359; eleven bounded scenarios in the default run plus the opt-in `pnpm recovery:restart` observation, with CI-retained reports. Source coverage, not a `v0.0.1` feature and not the observed operator case |
| Operator-observed failure scenarios | **Open post-release stabilization debt** | #196/#239; source harness results do not establish packaged GUI or provider acceptance |

The open #196/#239 row does not make the already-delivered macOS artifact
unreleased. It is an explicit post-release correctness obligation. Conversely,
completed publication evidence does not invent the operator-observed acceptance
work that remains open.

## `v0.0.2` publication is separate from acceptance

The [v0.0.2 release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.2)
was published on 2026-08-31 from verified signed tag source
`a4546f45bb0ee05cfbb388a0fc5f9e951596be51`.
[Release run 33311851717](https://github.com/OpenCoven/psyche-build/actions/runs/33311851717)
completed shared verification, both signed/notarized DMG jobs, publication,
and tap notification; iOS upload was skipped. Its dispatch workflow SHA
`63667f300bbdccea4dfede4e9e19fedb90876356` is not the release tag source.

The Homebrew Cask still selects `v0.0.1` as of 2026-09-06, at tap commit
[`d080d361`](https://github.com/OpenCoven/homebrew-tap/blob/d080d3618f0dc02239f75625d34518b8c61209e1/Casks/psyche-build.rb).
Do not label a fresh Cask install as `v0.0.2`, infer a successful tap update
from its notification job, or transfer `v0.0.1` lifecycle evidence to the newer
DMGs. A separate exact-artifact record is required for `v0.0.2` operator
acceptance and upgrade/rollback observations.

#196 was reopened on 2026-09-06 after a quoted closing phrase in PR #350
changed issue state without new acceptance evidence. #239 remains open; its
latest update records 15 evidence digests and `terminal_state: incomplete`.
Neither release publication nor issue closure can replace that manifest.

## `v0.0.1` publication record

The first public macOS release is available at
[GitHub Releases](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1)
and through the native
[`opencoven/tap/psyche-build`](https://github.com/OpenCoven/homebrew-tap/blob/main/Casks/psyche-build.rb)
Cask. The immutable signed tag resolves to
`57c6c71bd5264fde960b062e95de278c8438c94f`.

The successful
[desktop-only release workflow](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508)
published signed, notarized, and stapled Apple Silicon and Intel DMGs plus
`SHA256SUMS`. It skipped iOS-only verification and distribution while preserving
shared protocol/schema, TypeScript, package, Rust, Tauri, and publication
validation required by macOS. PR #235 repaired the future desktop-only Homebrew
notification path, and the public Cask passed native Apple Silicon and Intel
audit, install, trust validation, launch, no-op upgrade, uninstall, reinstall,
zap, and cleanup coverage.

This is completed publication evidence. The sections marked for #239 below are
operator-observed acceptance work and must not be checked off based solely on
the publication workflow.

## Evidence classification rules

Use these classifications in every retained manifest:

- **automated:** deterministic repository or workflow evidence;
- **operator-observed:** a named operator exercised the actual source, artifact,
  application, or policy path;
- **independently verified:** a second actor or clean environment reproduced the
  result;
- **failed:** the expected terminal state was not reached;
- **retried:** a failure was repeated, with the original result retained;
- **deferred:** intentionally outside the current support claim with an owner;
- **inapplicable:** the condition cannot apply to the named release and the
  reason is recorded;
- **unknown:** the effect or terminal state cannot be proven and requires
  reconciliation.

Never convert `unknown` into success because a local UI advanced, a timeout
expired, or a retry appeared to work.

## Evidence directory and manifest contract

Retain evidence in a durable operator-controlled location and link it from the
owning issue. Do not commit secrets, unrestricted terminal output, private
repository contents, or personal filesystem data merely to satisfy this shape.

```text
release-evidence/
  v0.0.1/
    57c6c71bd5264fde960b062e95de278c8438c94f/
      manifest.json
      automated-gates.txt
      operator-smoke.txt
      clean-machine-macos.md
      lifecycle-and-recovery.md
      git-and-cleanup.md
      optional-provider-isolation.md
      artifact-integrity.md
      homebrew.md
      known-deferrals.md
```

`manifest.json` records:

- release version, exact release SHA, and signed tag identity;
- macOS version, architecture, and machine class;
- application and artifact identifiers plus SHA-256 digests;
- automated, operator-observed, independently verified, failed, retried,
  deferred, inapplicable, and unknown checks separately;
- operator and verifier GitHub identities where appropriate;
- CI and workflow URLs;
- evidence file digests;
- terminal state and safe recovery action for each failure-oriented case;
- explicit confirmation that retained material was reviewed for credentials,
  prompts, unrestricted terminal output, repository contents, environment
  variables, infrastructure details, and unnecessary full paths.

## Exact-source automated gate

The protected release workflow runs the following repository commands against
the exact candidate:

```sh
pnpm install --frozen-lockfile
pnpm docs:focus:check
pnpm --dir docs build
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
```

It also retains Rust formatting, locked tests, and checks for the Tauri
manifest; canonical desktop-web generation and parity; release-version
coherence; diff/generated-file cleanliness; and iOS validation in coordinated
full-release mode.

The command list must remain aligned with the actual workflow. A required check
not executed there must name its environment and exact invocation separately.

## Tmux-equipped exact-source smoke — #239

`pnpm smoke` requires a working tmux environment and is not established by the
publication workflow. Run it on a supported tmux-equipped Mac against the exact
accepted source:

```sh
pnpm install --frozen-lockfile
pnpm smoke
```

- [ ] Record the release SHA, Node, pnpm, tmux, Git, macOS, architecture,
  command, exit status, and reviewed output.
- [ ] Confirm the checkout is the accepted source rather than an arbitrary
  development tree.
- [ ] Confirm missing optional providers or agent CLIs do not block ordinary
  local operation.
- [ ] Treat a failure as a supported-surface defect or remove the unsupported
  claim explicitly; do not waive it silently.

## Platform compatibility evidence

The public artifact gate is macOS-specific. Windows and Linux remain
compile-only targets. Their evidence may use either the exact candidate matrix
or a source-equivalent successful ancestor only when a path-scoped diff proves
that no relevant source, manifest, lockfile, build script, workflow input, or
generated artifact changed.

Documentation-only classification is not proof that a later source candidate
remains compatible. Rerun the matrix whenever the equivalence proof is
uncertain.

## macOS and iOS release-train separation

The implemented workflow makes iOS/TestFlight a separate, non-blocking train
only when an operator explicitly selects desktop-only mode. Tag pushes and
manual full releases remain coordinated and retain every iOS gate. Shared
protocol/schema, TypeScript, package, Rust, and Tauri validation remains
mandatory in both modes.

Auditable manual invocations against the immutable tag are:

```sh
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=false
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=true
```

Tag pushes have no desktop-only input and resolve `desktop_only` to `false`.
They must not silently choose the macOS-only path.

Completed #203 evidence proves:

- desktop-only mode skips only iOS-specific setup, simulator, project, app,
  UI-test, credential, archive, and upload work;
- shared validation required by macOS still runs;
- full mode continues to require iOS verification and upload/reuse;
- shared or macOS failure prevents publication;
- a protected desktop-only run reached both `build-macos` jobs, left
  `upload-ios` skipped, and reached `publish` without requesting iOS
  distribution credentials.

The retained live workflow run URL is
`https://github.com/OpenCoven/psyche-build/actions/runs/32629730508`. Its exact
release SHA is `57c6c71bd5264fde960b062e95de278c8438c94f`; the resolved mode was
`desktop_only=true`. Future desktop-only releases must retain the workflow run
URL, release SHA, resolved mode, `verify` result, both `build-macos` results,
`upload-ios` result, `publish` result, protected-environment approval, Homebrew
notification result, and signed/notarized artifact evidence.

## Clean-machine and ordinary lifecycle — #239

Execute these checks against the public application in a clean or disposable
user context, not merely a development checkout.

### Installation and first launch

- [ ] Install through the public Homebrew Cask or named immutable release
  artifact.
- [ ] Verify application identity, version, architecture, and provenance.
- [ ] Launch through Finder or `open -a "Psyche Build"`.
- [ ] Complete first-run onboarding without unexplained errors.
- [ ] Confirm missing optional providers do not prevent ordinary local use.

### Project and lane lifecycle

- [ ] Open a disposable Git repository through the supported UI.
- [ ] Create and use a plain terminal pane without an agent CLI.
- [ ] When a supported launcher is installed, create one agent-backed lane.
- [ ] Verify explicit selected project, lane, branch, worktree, and focus state.
- [ ] Exercise split, focus, resize, hide, restore, pane close, project close,
  and active-project handoff.
- [ ] Confirm close operations never silently delete the only copy of
  uncommitted work, a worktree, or a branch.

### Persistence and restart

- [ ] Quit normally and confirm the intended workspace restores without
  duplicate projects, panes, sessions, or worktrees.
- [ ] Confirm tmux/process survival or termination matches documentation.
- [ ] Force-quit during a disposable transition and verify deterministic
  recovery or explicit `recovery_required` state.
- [ ] Corrupt disposable persisted state and confirm the input is preserved or
  quarantined rather than silently overwritten.
- [ ] Verify stale or replaced tmux/resource identities are reported and never
  rebound to unrelated state.
- [ ] Exercise unwritable/full state storage and confirm persistence is not
  falsely reported as successful.

### Git integration and cleanup

- [ ] Inspect files and a bounded diff.
- [ ] Exercise supported merge and pull-request success paths.
- [ ] Exercise merge conflict, failed PR prerequisite, interrupted cleanup, and
  unknown cleanup result.
- [ ] Confirm failed or unknown paths preserve work and expose reconciliation or
  a safe retry.
- [ ] Confirm duplicate retries return or reconcile the existing canonical
  outcome rather than duplicating the effect.

### Optional integrations and authority

- [ ] Use projects, terminals, worktrees, files, rituals, merge/PR, settings,
  and cleanup with optional Coven/session providers absent.
- [ ] Connect an optional provider, then remove or interrupt it during a
  disposable session.
- [ ] Confirm provider-specific operations fail closed without broad fallback
  authority or loss of unrelated local workflows.
- [ ] Verify revoked or stale authority is rejected on reconnect and before the
  next protected action.

## Current error and diagnostic surfaces

The first release does not claim a support bundle, and nothing since changes
that. The v1 schema merged later under #243 (PR #278), and its CLI, bounded
persistence and first collectors later still under PRs #462 and #467 — all
after `v0.0.1`, so the released build has no `psyche support-bundle` command.
The reusable harness remains owned by #199. Do not satisfy acceptance for this
release with a command it does not contain.

- [ ] Verify visible application errors identify the failed operation and a
  safe next action without dumping credentials, prompts, unrestricted terminal
  output, repository contents, environment variables, or infrastructure
  secrets.
- [ ] Verify release version and source provenance are available through the
  accepted application/release evidence path.
- [ ] For the source-supported CLI, use `node ./psyche doctor --json` only as a
  local operator diagnostic and retain a reviewed/redacted summary rather than
  raw output.
- [ ] Record the bounded support-bundle capability as explicitly deferred to
  #199 (schema delivered under #243; no production wiring in `v0.0.1`).

## Update, uninstall, and reinstall

- [ ] For the first release, record previous-version upgrade as inapplicable;
  exercise it for later releases.
- [ ] Uninstall through the public distribution path.
- [ ] Confirm uninstall does not unexpectedly delete repositories, worktrees,
  branches, or other user work.
- [ ] Reinstall and verify prior state is safely restored or deliberately
  quarantined with a recovery path.

## Disposable recovery harness

The reusable harness owned by [#199](https://github.com/OpenCoven/psyche-build/issues/199)
runs source-level regressions for observed failures and additional bounded
failure classes. It is not packaged GUI acceptance and does not complete #239.
From a clean checkout:

```bash
pnpm recovery:harness
```

Each scenario builds a throwaway project workspace outside the repository,
injects one bounded failure, drives the real production recovery path, and
asserts the invariants that failure must preserve. It exits non-zero when any
invariant fails, so the command gates evidence rather than merely reporting.

The Quality CI job runs the same command on every pull request and uploads the
report as the `recovery-harness-<run>-<attempt>` artifact, so a run's evidence
is retained without anyone remembering to ask for it. The step runs under
`set -euo pipefail`; without it `tee` would return success for a failing
harness. The upload is unconditional, so a failed run still produces a report
recording which invariant failed rather than no evidence at all.

Nothing in the harness mocks the code under test. That is the point: the
pre-#283 defect reported a corrupt config correctly *and* replaced the bytes,
so a test asserting only the thrown error passes while the user's pane layout
is destroyed. The harness compares content digests before and after, which is
what makes the data-loss invariant observable.

Current scenarios:

| Scenario | Injected failure | Invariants |
|---|---|---|
| `corrupt-pane-config` | Pane config replaced with invalid JSON | `failure-classified-as-corrupt`, `corrupt-bytes-preserved`, `uncommitted-work-untouched` |
| `stale-pane-config-lock` | Lease held by an unreachable owner | `stale-lease-taken-over`, `stale-lease-released`, `persisted-config-unchanged`, `persisted-config-readable`, `uncommitted-work-untouched` |
| `unwritable-state-storage` | `.psyche` made read-only after its runtime subdirectory exists | `persistence-failure-surfaced`, `persisted-config-unchanged`, `uncommitted-work-untouched` |
| `duplicate-command-retry` | The same command replayed after the control journal is reopened | `effect-executed-exactly-once`, `retry-reconciles-canonical-outcome`, `reconciliation-survives-restart`, `uncommitted-work-untouched` |
| `stale-owner-epoch` | A valid capability lease asserted with the pre-restart owner epoch | `stale-epoch-assertion-rejected`, `current-epoch-assertion-accepted` |
| `interrupted-cleanup-recovery-marker` | Cleanup abandoned after publishing its recovery marker | `worktree-retained-after-interruption`, `recovery-marker-discoverable`, `recovery-marker-names-the-worktree`, `recovery-marker-carries-operator-instructions`, `uncommitted-work-untouched` |
| `interrupted-cleanup-owner` | Real cleanup worker killed after acquiring its project lease, before Git mutation | `cleanup-owner-interrupted`, `cleanup-project-lease-recovered`, `cleanup-retry-blocked-by-marker`, `worktree-retained-after-interruption`, `worktree-branch-unchanged`, `clean-worktree-control-removed`, `uncommitted-work-untouched`, `persisted-config-unchanged` |
| `unavailable-providers` | An unregistered capability provider and an absent Coven daemon socket | `provider-failure-classified`, `available-provider-still-executes`, `plain-terminal-lane-remains-usable`, `persisted-config-unchanged`, `uncommitted-work-untouched` |
| `stale-pane-identity` | A replaced tmux server that hands the recorded pane ID to a pane the persisted record never owned | `replaced-server-reused-pane-id`, `stale-pane-identity-reported`, `reused-pane-id-not-adopted`, `live-pane-rebinds-to-current-identity`, `rebind-clears-stale-background-windows`, `persisted-config-unchanged`, `uncommitted-work-untouched` |
| `interrupted-git-mutation` | Cleanup owner killed while its supervised `git worktree remove` is live | `mutation-observed-in-flight`, `cleanup-owner-killed-during-mutation`, `worktree-state-self-consistent`, `interrupted-mutation-left-no-orphan`, `cleanup-project-lease-recovered`, `worktree-branch-unchanged`, `uncommitted-work-untouched`, `persisted-config-unchanged` |

### Opt-in: application restart

`pnpm recovery:restart` runs one further scenario, `application-restart`, which
is deliberately **not** part of `pnpm recovery:harness` and therefore not part
of the required Quality check. It launches the real cockpit twice, so it costs
seconds rather than milliseconds and depends on first-run prompt text — a flake
surface a required check should not carry. This is the same shape as
`PSYCHE_AGENT_CHECK_IOS` for the iOS simulator gate: an expensive observation an
operator asks for deliberately. Its evidence is retained the same way and its
exit code still gates.

It covers the #199 case listed first and previously uncovered, and the #196
requirement to "restore without duplicate projects, panes, sessions, or
worktrees". The cockpit is launched in a disposable project with a disposable
`HOME` on a private tmux socket, first-run onboarding is declined, the cockpit
is quit the way a person quits it — it confirms on the first Ctrl+C and exits on
the second — and then relaunched into the session that survived.

Whether the tmux session outlives the quit is **recorded but not asserted**. It
depends on whether managed panes exist: a cockpit whose own pane is the last one
takes the session with it, which is what `pnpm smoke` documents and relies on,
while one with live panes leaves them running. This fixture creates no panes, so
both shapes occur and the restart handles each. The scenario therefore checks
that the cockpit process ended, that it is running again afterwards, and that
the restart restored the same project without duplicating projects, panes,
sessions, worktrees, or the live panes it found.

`restart-restored-workspace` requires the cockpit process to be live again, not
merely that the persisted config is readable: the config outlives the quit, so
readability alone would pass even if the relaunch never happened.

The fixture seeds a managed worktree and, after the quit, one worktree-pane
record pointing at it — with a tmux pane id that no longer exists, which is the
state a restart actually finds once its panes died with the old server. The
restart must recreate that pane and rebind the record, leaving exactly one pane
record and both worktrees. Those comparisons are load-bearing rather than
zero-against-zero.

The record is **written rather than created through the interface**,
deliberately. The product has no non-interactive path that creates a worktree
pane, and driving the cockpit's own shortcuts is unreliable for a fixture: it
gates shortcuts on pane focus — its own status line says so — and ignores them
while loading, so a keystroke is silently dropped depending on timing. What is
seeded is the persisted format a restart reads, which is what #196 asks about.

Quitting retries within a bound rather than assuming a fixed number of Ctrl+C
presses. The cockpit confirms on one press and exits on the next, but the
interface can consume a press. Assuming two leaves the cockpit running, and the
relaunch then puts a second cockpit beside it — which
`restart-did-not-duplicate-live-panes` catches by counting cockpit processes.

Restoration is asynchronous, so the restored pane is waited for rather than
sampled once, and teardown waits for the cockpit to exit before the workspace is
removed: a cockpit still writing into a directory being deleted fails the
removal and costs the run its evidence.

`first-run-reached-workspace` is the setup control, and `restart_unavailable`
records a host where the cockpit could not be launched at all, so a run that
observed nothing cannot read as a pass.

A hard guard refuses any project root at or beneath this checkout. The cockpit
adopts its working directory as its project and rewrites that project's
`.psyche` state on startup, so a mis-scoped launch would destroy a developer's
own workspace. The comparison is made on **canonicalized** paths: a lexical one
is bypassed by a symlink that points into the checkout, which reads as outside
while resolving inside. The guard has its own tests, including that symlink,
and is not a convention.

The scenario separates containment from preservation. `uncommitted-work-untouched`
reads the restarted project's own work file; `restart-stayed-inside-its-project`
reads the outer fixture's files, which the cockpit must never touch. Asserting
equality on the restarted project's own config would be wrong — a restart
rewrites it, which is the point — so `restart-kept-its-project-config` asserts
it stays readable and `restart-preserved-project-identity` asserts it still
names the same project.

Scope: it observes quit and relaunch of a workspace whose panes run no agents.
It does not observe a crash mid-transition, a restart with live agent panes, or
the packaged application bundle, and it is source evidence rather than packaged
operator acceptance.

`stale-lease-released` is verified by reacquiring the lease rather than by
trusting `release()` to have returned. A lease still held by the live harness
process is not stale, so a second acquisition blocks and times out instead of
taking over, which is what makes an unreleased lock observable.

The emitted report is bounded and sanitized by construction. Every field is a
member of a closed union declared in the harness module, a boolean, or a
SHA-256 digest, including invariant identifiers and digest keys. The types are
the enforcement: there is no field a future change could set to a path, a
file's contents, or a raw error message without first widening a union. A
report can therefore be attached to a public outcome without a redaction
pass.

`unwritable-state-storage` covers a source-level unwritable-directory failure:
it asserts a failed persist surfaces as an error rather than being reported as
success. Full-volume failure and the packaged GUI path remain unproven under
#239. The directory is made read-only only
after its runtime subdirectory exists, so the lease can still be acquired and
the failure isolates to the config write. The harness first proves the
directory is genuinely unwritable and reports `injection_ineffective` when it
is not — a process running as root ignores the mode bits, and that must never
be read as the product silently succeeding. Do not run the harness as root.

`duplicate-command-retry` covers the #239 item requiring that duplicate
retries reconcile a canonical outcome rather than duplicate an effect. The
control journal is reopened between the two attempts, so a pass proves durable
reconciliation rather than an in-memory cache that a restart would lose.

`stale-owner-epoch` covers the #199 "old owner epochs" case: an actor holding
authority from before an owner restart must not be able to act after it. It
asserts a currently-valid lease using the pre-restart epoch, which is what a
client that never observed the restart would present, and expects
`owner_restarted`. The scenario also asserts that the *current* epoch is still
accepted — a deliberate positive control, because a change that rejected every
assertion would satisfy the rejection invariant while breaking all authority.

`interrupted-cleanup-recovery-marker` covers the #196 and #239 requirement
that a close or cleanup never silently discards the only copy of uncommitted
work, and that an interrupted cleanup leaves an explicit reconciliation action.
Its scope is deliberately narrow: it proves the durable-evidence half — the
worktree and its uncommitted file survive, and the published marker names the
worktree and carries operator instructions. It does **not** interrupt
`WorktreeCleanupService` mid-flight, so it must not be read as covering the
full cleanup path; `interrupted-git-mutation` below covers that boundary.

`interrupted-git-mutation` covers the boundary the two scenarios above
deliberately avoid. It kills the same real cleanup queue while its supervised
`git worktree remove` is live: the leases are claimed, the pending mutation is
recorded, and the Git process group is tracked, but Git has not reported a
result. A shim on the child's `PATH` holds that one command at its first
instruction so the window can be hit deterministically, then execs the real Git
binary — Git is never replaced or simulated, and no product code is mocked.

Its invariants are about the state an operator is left in rather than which
side of the race won. The worktree must be either fully removed and
unregistered or fully present and still registered; a directory removed while
its registration survives, or the reverse, is how the only copy of work
disappears silently. No Git process from the interrupted mutation may outlive
the interruption, because one that does keeps mutating a repository nobody
supervises. The project lifecycle lease must be recoverable rather than
stranded by an owner that died holding it, and the branch, persisted config,
and uncommitted work must be untouched.

`mutation-observed-in-flight` is the injection's positive control, reported as
`injection_ineffective` when the queue never reached its mutation, so a run
that interrupted nothing cannot report every preservation invariant as held.

When the interrupted mutation cannot be confirmed finished — an orphan
survives, or the queue never goes idle — the scenario retains its disposable
workspace instead of deleting it, mirroring `RecoveryCleanupRetentionError` in
the pre-Git scenario. Deleting a repository a live Git process may still be
writing to would both destroy the evidence and pull the ground out from under
that process. The branch is queried independently of the worktree for the same
reason: reading it only when the worktree survived would let a cleanup that
removed the worktree *and* moved the branch pass unchallenged. A completed
cleanup may delete the branch it owns; it may never repoint it.

Scope: the interruption lands between the product handing off to Git and Git
answering. It does not prove interruption *after* Git has begun writing to the
object store or the worktree administrative files; that needs a fault injected
inside Git rather than around it.

`interrupted-cleanup-owner` extends that coverage through the real
`WorktreeCleanupService` queue in disposable child processes. The harness holds
the exact-worktree lease, observes the worker's durable project lease, and
terminates only that worker before any Git mutation can begin. It then proves
stale-project-lease takeover, publishes an explicit harness/operator recovery
marker, and starts a fresh cleanup worker. The retry must report that the marker
blocks cleanup while the worktree bytes, branch OID, and persisted config remain
unchanged. A separate clean-worktree control must actually remove its worktree
and branch; a no-op queue cannot pass.

`stale-pane-identity` covers the #196 requirement that a stale or replaced
tmux identity is reported and never rebound to unrelated state. It is the one
scenario that ages the pane identity itself rather than a lease. A real tmux
server is replaced; the replacement restarts pane numbering, so the recorded
`%0` now names a pane the persisted record never owned. Production
`paneTmuxIdentityIsCurrent` must refuse that ID because its server generation
differs — not merely because the ID is absent, which it is not — and
`rebindPaneByTitle` must leave the stale record alone rather than adopting the
pane its title now resolves to. A cross-generation rebind must also drop the
background test/dev window bindings the retired server allocated, since
carrying those across is the same reuse defect one level down.

`live-pane-rebinds-to-current-identity` is a deliberate positive control:
refusing every rebind would satisfy both fail-closed invariants while
stranding every pane that legitimately moved across the restart. The scenario
reports `injection_ineffective` when the replacement server does not reuse the
recorded ID, so a run in which the collision never occurred cannot be read as
the product having rejected anything.

Its tmux server is pinned to a socket inside the disposable workspace and the
inherited `TMUX`/`TMUX_PANE` variables are cleared for the duration, so a
harness run started from inside tmux reads and terminates only its own server.
Scope: this observes the identity and rebinding boundary that persisted records
pass through on load. It does not observe the application restarting, and it
does not prove that a pane which dies mid-command reports a terminal outcome.

The child uses a disposable home and tmux socket directory, with global Git
configuration excluded. The harness rejects ambient `GIT_DIR`, `GIT_WORK_TREE`,
or `GIT_COMMON_DIR` overrides before parent-side worktree-lease discovery.
Before disposing the fixture, it reacquires the project lifecycle lease to
confirm no supervised mutation remains active. If that bounded barrier fails,
it retains the fixture and reports an explicit error rather than deleting
the leases of a possibly live Git child.
Reports never include child output, process identifiers,
paths, or branch names. The marker is published by the harness, not automatically
by the cleanup service. This scenario does not prove interruption during a Git
mutation, automatic crash reconciliation, application restart, or packaged GUI
acceptance; `interrupted-git-mutation` covers the Git-mutation boundary
separately. It does not close #196, #199, or #239.

Application restart and upgrade recovery now have source coverage — the opt-in
`pnpm recovery:restart` scenario and the `upgrade-recovery` scenario's
versioned-state boundary — and source coverage is not the observed operator
case. Neither is established by a passing default run, and PR #465 records that
its restart scenario supplies no packaged GUI evidence. The
`unavailable-providers` scenario observes the routing and detection boundary
only: an agent CLI that disappears mid-session is sent into a live shell and
has no product classification, so it stays unobserved. No scenario launches, terminates, and relaunches the application: the
restart-adjacent scenarios reopen the control journal, construct a restarted
owner epoch in process, or replace the tmux server rather than the application.
Upgrade recovery is additionally blocked by a missing production surface; its
prerequisites are recorded in
[POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md#upgrade-recovery-prerequisites).

## Failure-oriented acceptance — #239

Use disposable data and fail closed.

| Scenario | Required invariant |
|---|---|
| Corrupt persisted workspace | Preserve or quarantine the corrupt input; never silently overwrite it |
| Dead or replaced tmux session | Never attach to an unrelated session or reuse stale resource authority |
| Process termination during save | Restore the last atomic durable state or enter `recovery_required` |
| Interrupted pane/worktree cleanup | Preserve user work and expose known, unknown, and safe-to-retry state |
| Optional provider unavailable | Keep core local workflows available; fail provider operations closed |
| Duplicate action retry | Return or reconcile the canonical outcome without duplicating the effect |
| Old owner epoch or revoked subject | Reject stale authority on reconnect and before the next protected action |
| Unwritable/full state directory | Report failure; never claim persistence succeeded or discard prior state |
| Incompatible schema/version | Negotiate, migrate through an approved path, or fail actionably |
| Upgrade and rollback | Preserve supported state or quarantine incompatibility without silent mutation |

A case is complete only when the observed terminal state, retained evidence,
safe retry/recovery behavior, and affected identities are recorded.

## Completed artifact integrity record

For both public DMGs, the `v0.0.1` publication evidence records:

- [x] filename and embedded application version match the release contract;
- [x] application and nested code pass strict `codesign` verification;
- [x] Gatekeeper accepts the mounted application as Notarized Developer ID;
- [x] notarization is valid and tickets are stapled where required;
- [x] artifact SHA-256 values match `SHA256SUMS`;
- [x] provenance identifies the exact source and workflow;
- [x] assets download without privileged repository credentials;
- [x] release notes describe the supported surface and known deferrals.

The signed annotated tag points to the exact accepted commit on `origin/main`,
and the remote tag object has a verified signature.

## Completed Homebrew publication record

The native Cask uses the immutable public release assets and their verified
checksums. Native Apple Silicon and Intel jobs exercised audit, installation,
trust validation, launch, no-op upgrade, uninstall, reinstall, zap, and cleanup.
The Cask installs only `Psyche Build.app`; it does not claim to install the Node
CLI.

The public command is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

Future releases repeat the Homebrew gate against their own immutable assets.
#239 still owns application-level first-run, ordinary lifecycle, persistence,
and representative failure observations that package lifecycle automation does
not prove.

## Release-candidate invariants for future releases

For source-only preparation of a **new** macOS candidate, the
[explicit app-local acceptance profile](./OPERATOR-ACCEPTANCE-SLICE.md#new-candidate-app-local-profile-explicit-opt-in-not-historical-release-proof)
requests separate persistent WebKit stores through explicit builders and provides
local workspace/session routing (source tests are not GUI store-isolation proof),
without changing production defaults. It requires macOS 14+, a separate
acceptance bundle, private disposable projects and an explicit launch command.
Its state/API/path matrix names the non-isolated OS surfaces and excluded
integration rows. Construction and source tests do not constitute GUI,
distribution, clean-machine, historical-release or full #196/#239 acceptance.
Independent review and an owner decision are required before launching it.

A future candidate must have:

- one exact commit SHA on `origin/main`;
- one coherent version across package, native application, update, and release
  metadata;
- no unresolved current review finding on included work;
- all required checks passing on the exact candidate;
- no unowned P0 blocker or undocumented support claim;
- a signed annotated immutable release tag created only after acceptance;
- no repository-level fallback copy of protected release credentials.

After freeze, a new change enters only when it names the failed acceptance case
it repairs. The full candidate gate then runs again.

## Secrets and operator safety

- Never paste certificate material, app-specific passwords, tokens, private
  keys, encoded secrets, raw prompts, unrestricted terminal output, private
  repository contents, or complete environment dumps into issues, PRs, logs,
  artifacts, or documentation.
- Provision protected values only through an operator-controlled terminal or an
  approved secret-management path.
- Verify secret names and presence separately from values.
- Require configured release-environment approval before jobs receive protected
  credentials.
- Confirm repository-level fallback secret copies are absent.
- Treat missing, invalid, or uncertain signing/notarization evidence as a hard
  publication failure.

## Closure decisions

[#239](https://github.com/OpenCoven/psyche-build/issues/239) is eligible for
closure when its sanitized manifest contains exact-source smoke and all
required operator observations. #196 is eligible when that manifest proves
the supported ordinary and representative failure paths and every reusable
gap is transferred to #199 or #243. Do not use closing-keyword syntax in PR
prose that only discusses these gates; a quoted phrase can close an issue
without proving its outcome.

#31 closed on 2026-08-30 with administrator enforcement, direct-push rejection,
and protected proof PR #283. Its 2026-09-05 correction and PR #351 supersede
the original named-owner bypass claim: the active ruleset now has no bypass
actors and zero required approving reviews, while exact-head checks and
review-thread resolution remain enforced. This is not a waiver of independent
R3/R4 review or release acceptance.

#194 and #203 remain complete. #196/#239 does not require republishing
`v0.0.1` unless new evidence proves a defect in the immutable public artifacts
or their supported installation path.
