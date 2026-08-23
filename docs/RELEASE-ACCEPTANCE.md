# Psyche Build release acceptance

**Status:** Required gate for the planned public macOS `v0.0.1` release  
**Owning outcomes:** [#196](https://github.com/OpenCoven/psyche-build/issues/196),
[#31](https://github.com/OpenCoven/psyche-build/issues/31),
[#203](https://github.com/OpenCoven/psyche-build/issues/203), and
[#194](https://github.com/OpenCoven/psyche-build/issues/194)  
**Support contract:** [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md)

This document defines the minimum evidence required to call a Psyche Build
macOS release supported. It complements the mechanical
[release runbook](./RELEASE.md): the runbook explains how to publish; this
checklist defines what must be proven before and after publication.

A green CI run, a passing unit-test count, or a successful build job does not
by itself prove that a clean user can install, launch, recover, and remove the
application.

## Release-candidate invariants

The candidate must have:

- one exact commit SHA on `origin/main`;
- one version coherent across package, native application, update, and release
  metadata;
- no unresolved current review finding on an included change;
- all required status checks passing on the exact candidate;
- no unowned P0 blocker;
- no undocumented support claim;
- a signed annotated immutable release tag created only after acceptance;
- no repository-level fallback copy of protected release credentials.

After candidate freeze, a new change may enter only when it names the failed
acceptance case it repairs. The full candidate gate must then run again.

## Evidence directory contract

Retain release evidence in a durable operator-controlled location and link it
from the owning issue. Do not commit secrets, unrestricted terminal output,
private repository contents, or personal filesystem data merely to satisfy the
shape below.

```text
release-evidence/
  v0.0.1/
    <candidate-sha>/
      manifest.json
      automated-gates.txt
      operator-smoke.txt
      compatibility-evidence.md
      clean-machine-macos.md
      lifecycle-and-recovery.md
      signatures.txt
      gatekeeper.txt
      checksums.txt
      provenance.txt
      homebrew.md
      known-deferrals.md
```

`manifest.json` should record:

- version and exact candidate SHA;
- release tag after publication;
- macOS version, architecture, and machine class;
- application and artifact identifiers;
- artifact SHA-256 digests;
- automated, manual, deferred, failed, and rerun checks;
- operator and independent verifier GitHub identities where appropriate;
- CI and workflow URLs;
- evidence file digests;
- explicit confirmation that captured evidence was reviewed for secrets and
  unnecessary user data.

## Exact-candidate automated gate

The protected release workflow currently runs these repository commands on the
exact tagged candidate:

```sh
pnpm install --frozen-lockfile
pnpm docs:focus:check
pnpm --dir docs build
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
```

It also retains:

- Rust formatting, locked tests, and checks for the Tauri manifest;
- canonical desktop-web bundle generation and parity validation;
- release-version coherence checks;
- diff and generated-file cleanliness;
- iOS validation in full coordinated-release mode.

The command list in this section must stay aligned with the actual release
workflow. A required check that is not executed there must be classified in a
separate evidence section with its concrete environment and invocation.

## Tmux-equipped operator smoke

`pnpm smoke` requires a working `tmux` environment and is not currently run by
the release workflow. Run it separately on a tmux-equipped supported macOS
machine against the exact candidate checkout and retain its output:

```sh
pnpm install --frozen-lockfile
pnpm smoke
```

- [ ] Record the candidate SHA, Node/pnpm/tmux versions, machine architecture,
  command, exit status, and sanitized output.
- [ ] Confirm the smoke run uses the exact candidate rather than an arbitrary
  development tree.
- [ ] Treat a failure as a release blocker until the test is fixed or the
  support claim it protects is explicitly removed.

## Platform compatibility evidence

The public artifact gate is macOS-specific. Windows and Linux remain
compile-only targets, so their evidence may come from either:

1. a successful matrix run on the exact candidate; or
2. the nearest successful ancestor whose relevant desktop/Rust/package source
   tree is byte-identical to the candidate.

When using a source-equivalent ancestor:

- [ ] record its SHA and workflow URL;
- [ ] retain a path-scoped diff proving that no Windows/Linux-relevant source,
  manifest, lockfile, build script, workflow input, or generated artifact
  changed between that SHA and the candidate;
- [ ] rerun the matrix on the exact candidate whenever any relevant path
  changed or the equivalence proof is uncertain.

Documentation-only change classification is not itself proof that a future
source candidate remains compatible.

## macOS and iOS release-train separation

The intended contract is that an iOS-only failure blocks the iOS train and
blocks macOS only when it demonstrates a defect in a shared contract or
implementation required by macOS.

The current release workflow does not yet enforce that contract: its verify job
runs iOS simulator and project/app tests unconditionally, and the macOS build
jobs depend on verify. [#203](https://github.com/OpenCoven/psyche-build/issues/203)
is therefore P0 and must close before publication.

Required #203 evidence:

- [ ] desktop-only mode skips only iOS-specific setup, simulator, project, app,
  UI-test, credential, archive, and upload work;
- [ ] shared protocol/schema validation required by macOS still runs;
- [ ] full release mode continues to require iOS validation and upload/reuse;
- [ ] a desktop-only dry run reaches both macOS build jobs and the publication
  condition when iOS-only validation is unavailable;
- [ ] a failed shared or macOS check still prevents publication.

Until that evidence exists, do not describe desktop-only independence as an
implemented workflow property.

## Clean-machine macOS matrix

Execute against the installable release candidate, not a development checkout.
Record commands and observed outcomes.

### Installation and first launch

- [ ] Install the application from the candidate artifact without relying on a
  source checkout.
- [ ] Verify the application identity, version, and candidate SHA/provenance.
- [ ] Launch through Finder or `open -a "Psyche Build"`.
- [ ] Complete first-run onboarding without unexplained errors.
- [ ] Confirm missing optional providers do not prevent ordinary local use.

### Project and lane lifecycle

- [ ] Open a disposable Git repository through the supported UI.
- [ ] Create and use a plain terminal pane without an agent CLI.
- [ ] When a supported agent CLI is installed, launch one agent-backed lane.
- [ ] Verify explicit project scope, selected project, active lane, and
  worktree/branch identity.
- [ ] Exercise focus, split, resize, hide, restore, and close behavior.
- [ ] Confirm closing a pane does not silently delete uncommitted work, its
  worktree, or its branch.
- [ ] Close a project through the supported lifecycle and verify focus and
  active-project handoff remain coherent.

### Persistence and restart

- [ ] Quit normally and relaunch.
- [ ] Confirm the intended durable workspace restores without duplicate panes,
  sessions, projects, or worktrees.
- [ ] Confirm long-running tmux/process state survives or terminates exactly as
  documented.
- [ ] Force-quit during a disposable state transition and verify recovery is
  deterministic and evidence is retained.
- [ ] Verify stale or unavailable identities are reported rather than silently
  replaced.

### Git integration

- [ ] Inspect the worktree and bounded diff.
- [ ] Exercise the supported review/integration menu.
- [ ] Verify merge, pull-request, archive, and cleanup actions remain explicit
  and fail safely when preconditions are not satisfied.
- [ ] Verify a failed or unknown cleanup result preserves the work and exposes
  a reconciliation path.

### Optional integrations and authority

- [ ] Run core project, terminal, worktree, file, ritual, merge/PR, settings,
  and cleanup flows without Coven or another optional session provider.
- [ ] When an optional provider is present, verify canonical project scope and
  resource ownership.
- [ ] Verify provider disappearance does not grant broader fallback authority
  or disable unrelated local workflows.
- [ ] Verify consequential control actions use exact resource generations,
  scoped leases, approvals where required, canonical receipts, idempotency,
  and revocation behavior.

### Current error and diagnostic surfaces

The first macOS release does **not** claim the versioned, bounded support bundle
owned by #199. Do not invent a nonexistent command or schema to satisfy this
gate.

For the current release surface:

- [ ] Verify visible app errors identify the failed operation and a safe next
  action without dumping credentials, raw prompts, unrestricted terminal
  output, repository contents, environment variables, or infrastructure
  secrets.
- [ ] Verify release version and source provenance are available through the
  accepted application/release evidence path.
- [ ] For the source-supported CLI, run `node ./psyche doctor --json` only as a
  local operator diagnostic. It may contain local configuration paths, so do
  not attach raw output; retain a reviewed/redacted summary instead.
- [ ] Record the full support-bundle capability as explicitly deferred to #199
  in public limitations and evidence.

### Update, uninstall, and reinstall

- [ ] Verify update behavior from the previous public version when one exists;
  for the first release, document the not-applicable case explicitly.
- [ ] Uninstall through the public distribution path.
- [ ] Confirm uninstall does not unexpectedly delete repositories, worktrees,
  branches, or other user work.
- [ ] Reinstall and verify safe prior state is restored or deliberately
  quarantined with a recovery path.

## Failure-oriented acceptance

Use disposable data and fail closed. At minimum, exercise:

| Scenario | Required invariant |
|---|---|
| Corrupt persisted workspace | Preserve the corrupt input for diagnosis, avoid silent overwrite, and start or recover through an explicit path |
| Dead or replaced tmux session | Do not attach to an unrelated session or reuse stale resource authority |
| Process termination during save | Restore the last atomic durable state or explicitly enter recovery-required state |
| Interrupted pane/worktree cleanup | Preserve user work and expose what is known, unknown, and safe to retry |
| Optional provider unavailable | Core local workflows remain available; provider-specific operations fail closed |
| Duplicate action retry | Return or reconcile the existing canonical outcome without duplicating the effect |
| Old owner epoch or revoked subject | Reject the stale authority on reconnect and before the next protected action |
| Unwritable or full state directory | Report the failure; do not claim persistence succeeded or silently discard prior state |
| Incompatible schema/version | Negotiate, migrate through an approved path, or fail with an actionable compatibility error |
| Upgrade and rollback | Preserve supported state or quarantine incompatibility without silently mutating user work |

A failure case is complete only when the observed terminal state, retained
evidence, safe retry/recovery behavior, and affected identities are recorded.

## Artifact integrity gate

For each Apple Silicon and Intel DMG:

- [ ] the filename and embedded application version match the release contract;
- [ ] `codesign` verifies the application and nested code;
- [ ] Gatekeeper accepts the mounted application;
- [ ] notarization evidence is valid and the ticket is stapled where required;
- [ ] the artifact SHA-256 equals its `SHA256SUMS` entry;
- [ ] provenance identifies the exact candidate SHA and workflow;
- [ ] the public asset downloads successfully without privileged repository
  credentials;
- [ ] release notes describe the real supported surface and known deferrals.

The signed annotated tag must point to the exact accepted commit on
`origin/main`, and the remote tag object must have a verified signature.

## Homebrew gate

The native Cask must use the exact immutable public release assets and their
verified checksums.

On a clean supported Mac:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

Verify:

- [ ] install completes from the public tap;
- [ ] the expected signed application launches;
- [ ] version and architecture are correct;
- [ ] upgrade behavior works when applicable;
- [ ] uninstall succeeds;
- [ ] zap behavior removes only documented application state;
- [ ] reinstall succeeds;
- [ ] the Cask does not claim to install the Node CLI.

## Secrets and operator safety

- Never paste certificate material, app-specific passwords, tokens, private
  keys, or encoded secrets into an issue, pull request, comment, log, artifact,
  or document.
- Provision protected values only through an operator-controlled terminal or
  approved secret-management path.
- Verify names and presence separately from values.
- Require the configured release-environment approval before jobs receive
  protected credentials.
- Confirm repository-level fallback secret copies are absent.
- Treat missing, invalid, or uncertain signing/notarization evidence as a hard
  publication failure.

## Release decision

The candidate may be published only when:

1. every required exact-candidate automated gate passes;
2. tmux-equipped smoke and compatibility evidence are retained under the
   procedures above;
3. #203 proves desktop-only workflow independence without skipping shared
   validation;
4. every supported capability in the support matrix has executable evidence;
5. every clean-machine and integrity item is complete or explicitly
   inapplicable;
6. every known limitation is reflected in public copy;
7. no current review finding, ambiguous consequential effect, or unowned P0
   blocker remains;
8. protected credentials and release rules are verified;
9. an independent verifier reproduces the public Homebrew install and launch.

Close #196 when the acceptance baseline is complete. Close #31 when the
credential and protection gate is complete. Close #203 when the workflow
contract and dry-run evidence pass. Close #194 only after the public GitHub
Release and Homebrew path are independently verified.
