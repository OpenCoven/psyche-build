# Psyche Build release acceptance

**Status:** Required gate for the planned public macOS `v0.0.1` release  
**Owning outcomes:** [#196](https://github.com/OpenCoven/psyche-build/issues/196),
[#31](https://github.com/OpenCoven/psyche-build/issues/31), and
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

## Automated repository gate

Run the repository's canonical commands on the exact candidate. At minimum,
retain results for:

```sh
pnpm install --frozen-lockfile
pnpm docs:focus:check
pnpm --dir docs build
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
```

Also retain:

- Rust formatting, locked tests, and checks for the Tauri manifest;
- canonical desktop-web bundle generation and parity validation;
- supported macOS, Windows, and Linux compilation checks;
- iOS project-generation and shared-contract checks when the changed surface
  requires them;
- release-version coherence checks;
- diff and generated-file cleanliness.

An iOS-only failure blocks the iOS train. It blocks the macOS release only when
it demonstrates a defect in a shared contract or implementation required by
macOS.

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

### Diagnostics

- [ ] Generate the release-minimum diagnostic output.
- [ ] Confirm it is bounded by size/time/count.
- [ ] Confirm it excludes tokens, credentials, raw prompts, unrestricted
  terminal output, repository contents, environment variables, infrastructure
  secrets, and unnecessary full user paths.
- [ ] Confirm a user or operator can identify version, platform, relevant
  lifecycle state, and a next action from the output.

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

1. every required automated gate passes on the exact SHA;
2. every supported capability in the support matrix has executable evidence;
3. every clean-machine and integrity item is complete or explicitly
   inapplicable;
4. every known limitation is reflected in public copy;
5. no current review finding, ambiguous consequential effect, or unowned P0
   blocker remains;
6. protected credentials and release rules are verified;
7. an independent verifier reproduces the public Homebrew install and launch.

Close #196 when the acceptance baseline is complete. Close #31 when the
credential and protection gate is complete. Close #194 only after the public
GitHub Release and Homebrew path are independently verified.
