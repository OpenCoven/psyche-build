# Psyche Build release acceptance

**Status:** Reusable release gate; macOS `v0.0.1` published 2026-08-23  
**Active stabilization owner:** [#196](https://github.com/OpenCoven/psyche-build/issues/196)  
**Executable evidence slice:** [#239](https://github.com/OpenCoven/psyche-build/issues/239)  
**Active governance owner:** [#31](https://github.com/OpenCoven/psyche-build/issues/31)  
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
| Administrator-enforced required checks/review and removal of standing bypasses | **Open governance debt** | #31 |
| iOS distributed-build and physical-device acceptance | **Not part of the macOS `v0.0.1` claim** | Planned under #200 |
| Versioned bounded support bundle and reusable recovery harness | **Planned post-release capability** | #199 and #243 |

The open #196/#239 and #31 rows do not make the already-delivered macOS artifact
unreleased. They are explicit post-release correctness and governance
obligations. Conversely, completed publication evidence does not invent the
operator observations that remain open.

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

The first release does not claim the versioned support bundle owned by #199 and
#243. Do not invent a nonexistent command or schema to satisfy acceptance.

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
  #199/#243.

## Update, uninstall, and reinstall

- [ ] For the first release, record previous-version upgrade as inapplicable;
  exercise it for later releases.
- [ ] Uninstall through the public distribution path.
- [ ] Confirm uninstall does not unexpectedly delete repositories, worktrees,
  branches, or other user work.
- [ ] Reinstall and verify prior state is safely restored or deliberately
  quarantined with a recovery path.

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

Close [#239](https://github.com/OpenCoven/psyche-build/issues/239) when its
sanitized manifest contains exact-source smoke and all required operator
observations. Close #196 when that manifest proves the supported ordinary and
representative failure paths and every reusable gap is transferred to #199 or
#243.

Close #31 only after administrators are subject to required checks/review, no
standing actor can silently bypass the protected path, and a successful proof
PR plus sanitized before/after policy evidence is linked.

#194 and #203 remain complete. Neither #196/#239 nor #31 requires republishing
`v0.0.1` unless new evidence proves a defect in the immutable public artifacts
or their supported installation path.
