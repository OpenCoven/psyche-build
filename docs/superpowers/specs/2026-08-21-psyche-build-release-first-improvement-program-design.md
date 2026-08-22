# Psyche Build Release-First Improvement Program Design

## Status

- Approved in conversation on 2026-08-21.
- Scope: repository, delivery process, macOS distribution, reliability,
  desktop maintainability, and open-source contributor readiness.
- North star: ship the first credible public macOS release without making iOS
  completion or broad architectural cleanup a prerequisite.

## Current State

The repository has a broad and actively developed product surface, a clean
`main` branch, and green CI at the audited head. Delivery and ownership are
less mature than the implementation:

- no GitHub Release has been published;
- the public GitHub issue surface does not represent the implementation
  backlog held in Beads;
- multiple large feature pull requests are active concurrently;
- historical specifications and implementation plans are difficult to
  distinguish from active work;
- the primary desktop Rust and JavaScript entry points have accumulated many
  unrelated responsibilities;
- several visible product and test gaps remain in otherwise supported flows;
- the public repository lacks standard contribution and security metadata.

This program closes the delivery loop first, creates a reliable acceptance
baseline, and then uses that baseline to support incremental architectural
decomposition.

## Decision

Use a release-first stabilization sequence:

1. reconcile ownership, trackers, and active pull requests;
2. establish and pass a release acceptance baseline;
3. publish the signed and notarized macOS release and Homebrew Cask;
4. harden failure recovery and diagnostics;
5. decompose desktop concentration behind preserved contracts;
6. complete the repository's external-contributor surface.

The program does not pause all feature work indefinitely. It makes release
blockers explicit, defers unrelated expansion, and allows independently safe
work to continue when it does not overlap a release-critical seam.

## Goals

### 1. Complete the macOS distribution loop

Publish signed and notarized Apple Silicon and Intel artifacts from one
immutable release commit. The GitHub Release must include checksums,
provenance, and curated notes. The native Homebrew Cask must install, launch,
upgrade, and uninstall the public application on a clean machine.

iOS and TestFlight remain separate delivery work. An iOS-only failure does
not block the macOS release unless it proves a defect in a shared protocol or
shared implementation contract used by macOS.

### 2. Create one authoritative delivery roadmap

GitHub represents public outcomes, release milestones, and externally legible
status. Beads represents implementation tasks and dependency ordering. Every
active Bead maps to one GitHub outcome or to a clearly internal maintenance
bucket. Historical specs and plans are labeled by status rather than treated
as executable backlog.

### 3. Reduce desktop architectural concentration

Turn the desktop Rust and JavaScript entry points into composition roots by
extracting existing capability boundaries. This is an incremental
reorganization, not a rewrite or framework migration. Public Tauri commands,
wire schemas, persisted state, and user behavior remain compatible unless a
separate approved feature design changes them.

### 4. Build a release-grade reliability loop

Convert current release checks into a reproducible acceptance system covering
installation, startup, pane and worktree lifecycle, persistence, recovery,
Git integration, updates, diagnostics, and removal. Visible incomplete
controls are implemented narrowly or removed from the supported release
surface. Skipped tests in supported interactions are restored or replaced by
equivalent executable coverage.

### 5. Make the repository credible for external contributors

Add the standard security, ownership, issue, pull-request, support, and conduct
surfaces. Document the architecture and the smallest supported contributor
loop. Keep historical engineering records available without presenting them
as the current roadmap.

## Non-Goals

- Completing public iOS or TestFlight distribution before macOS ships.
- Rewriting the desktop application or changing its UI framework.
- Making cloud terminals, hosted orchestration, team collaboration, or a
  plugin marketplace part of the first release.
- Turning every historical plan checkbox into active work.
- Performing broad product redesign while closing release blockers.
- Weakening project, worktree, capability, approval, or recovery boundaries
  to make acceptance tests pass.

## Workstreams and Ownership Boundaries

### Release

Owns version coherence, release commit preparation, protected credentials,
signing, notarization, DMGs, checksums, provenance, GitHub Release publication,
Homebrew Cask publication, and clean-machine distribution verification.

Does not own iOS/TestFlight completion.

### Roadmap

Owns GitHub milestones and outcome issues, Beads dependency reconciliation,
pull-request ownership, active/deferred status, and historical-plan labeling.

Does not own implementation changes simply because they are tracked.

### Reliability

Owns the acceptance matrix, skipped interaction coverage, supported lifecycle
gaps, bounded redacted diagnostics, failure injection, recovery proof, and
release-candidate evidence.

Does not own unrelated visual redesign.

### Architecture

Owns incremental extraction from concentrated desktop entry points behind
existing contracts, with focused tests for each extracted capability.

Does not own a rewrite, framework migration, or release-blocking cleanup
campaign.

### Community

Owns GitHub templates, ownership and security metadata, contributor guidance,
the public architecture map, and active-roadmap presentation.

Does not own a marketing launch or unrelated documentation expansion.

## Delivery Rules

- Release-critical work is P0 until the public macOS installation path is
  verified.
- Each public outcome has one GitHub issue; dependent implementation steps are
  maintained in Beads.
- Beads schema migration is performed and published by exactly one designated
  clone. Other clones adopt the published schema instead of migrating
  independently.
- Existing pull requests are reconciled before overlapping work begins.
- Pull requests should be independently testable and squashable. A change
  substantially larger than approximately 800 changed lines should explain
  why it cannot be split safely; generated outputs and indivisible protocol or
  extraction slices are acceptable exceptions.
- Documentation is evidence of intent, not evidence that behavior shipped.
- Every phase ends in executable proof with retained commands and outcomes.
- Architecture extraction starts after the release acceptance baseline exists
  and cannot become a prerequisite for publication unless it fixes a proven
  release blocker.

## Phase 0: Reconcile Control State

### Work

- Choose the single Beads schema migrator and reconcile all other clones.
- Inventory active pull requests, their review state, owning Beads, overlap,
  and relationship to the release.
- Create five GitHub outcomes for release, roadmap, reliability, architecture,
  and community readiness, using sub-issues or task lists only where they
  remain externally useful.
- Map all open Beads to those outcomes or mark them explicitly deferred.
- Mark historical specs and plans as implemented, superseded, active, or
  reference without rewriting their historical content.
- Establish the macOS release milestone and its exact blockers.

### Gate

No unowned P0 work, unresolved overlapping pull requests, ambiguous release
blockers, or blocked writes in the authoritative implementation tracker.

## Phase 1: Establish the Release Baseline

### Work

- Decide each visible incomplete release-path control by implementing its
  smallest correct behavior or removing it from the supported UI.
- Restore skipped text-input interaction coverage with the current input
  contract.
- Verify workspace persistence, restart restoration, pane and worktree
  recovery, Git inspection and integration actions, updater behavior, and
  diagnostics.
- Run the repository TypeScript, package, smoke, Rust, desktop web, and
  supported cross-platform compilation gates.
- Define one clean-machine macOS acceptance run with retained evidence.

### Gate

One clean release commit passes local and CI validation, and every documented
release capability has executable acceptance evidence or an explicit deferral.

## Phase 2: Publish macOS

### Work

- Provision protected signing, notarization, GitHub, and Homebrew credentials
  in the approval-protected release environment.
- Create the immutable signed release tag from the verified release commit.
- Produce and verify both notarized DMGs and `SHA256SUMS`.
- Validate code signatures, Gatekeeper acceptance, version coherence,
  provenance, asset names, release notes, and downloadability.
- Publish or update the native Homebrew Cask from the verified assets.
- Test installation, launch, upgrade, and uninstall on a clean machine.

### Gate

The documented public Homebrew command installs and launches the expected
signed application. GitHub marks the release public and stable, artifacts and
checksums agree, and the Cask points to those exact artifacts.

## Phase 3: Harden Operations

### Work

- Complete bounded, recent, automatically redacted diagnostic reports with
  versioned schemas and copyable operator output.
- Replace polling-based daemon attachment with the planned `tmux -C`
  lifecycle while preserving fallback and failure semantics where required.
- Add failure scenarios for restart, corrupt persisted state, unavailable
  providers, interrupted cleanup, stale identities, and upgrade recovery.
- Convert the release acceptance run into a reusable harness or checklist with
  evidence capture.

### Gate

Common operator failures produce actionable diagnostics, preserve evidence,
and recover without losing or silently mutating panes, sessions, worktrees, or
project state.

## Phase 4: Decompose Desktop Architecture

Extract one capability at a time in this order:

1. application lifecycle and Tauri command registration;
2. workspace persistence and recovery;
3. pane, PTY, and process lifecycle;
4. browser and Git control;
5. desktop web state, rendering, and event wiring.

Each extraction must:

- preserve public commands, protocol schemas, persistence formats, and error
  behavior;
- introduce a narrow interface owned by the extracted module;
- move focused tests beside or directly against that capability;
- regenerate checked-in bundles through their canonical build path;
- avoid simultaneous product behavior changes;
- retain a rollback path until the full validation surface passes.

### Gate

The primary Rust and JavaScript entry points primarily compose capability
modules. Extracted modules own their state, errors, and tests, and the release
acceptance surface remains green after every slice.

## Phase 5: Open-Source Readiness

### Work

- Add `SECURITY.md`, issue forms, a pull-request template, CODEOWNERS, support
  guidance, and a code of conduct.
- Publish a concise architecture map showing the Node/TUI, desktop web, Tauri
  Rust, shared protocol, and iOS boundaries.
- Document a first-contribution path with exact build, focused-test, full-test,
  and pull-request commands.
- Separate active roadmap navigation from historical specs and plans.
- State pull-request scope, generated-file, validation, and review-thread
  expectations.

### Gate

GitHub community health reaches 100 percent, all repository links resolve, and
a clean checkout can complete the documented contributor loop without
maintainer-only knowledge.

## Evidence Flow

Every outcome follows the same evidence chain:

```text
GitHub outcome and milestone
        |
        v
Dependency-ordered Beads
        |
        v
Focused pull requests with acceptance criteria
        |
        v
Local and CI verification evidence
        |
        v
Release or phase-gate verification
        |
        v
Tracker closure and public status update
```

GitHub communicates the outcome and current status. Beads records executable
dependencies and ownership. Pull requests carry the implementation and focused
proof. Release and phase gates provide independent end-to-end evidence.

## Failure Handling

- Missing, invalid, or uncertain signing and notarization evidence blocks
  publication.
- Unknown pane, Git, cleanup, update, or recovery effects fail closed and
  retain evidence for operator reconciliation.
- Beads migration ambiguity blocks Beads writes, not safe repository analysis
  or implementation already tracked elsewhere.
- A failing architecture extraction is narrowed or reverted; it cannot hold
  the release hostage unless it exposes a proven release defect.
- An iOS-only failure blocks iOS delivery. It blocks macOS only when the same
  failure exists in a shared contract required by macOS.
- A pull request with unresolved review findings, ambiguous ownership, or
  missing required checks does not pass its phase gate.
- A documentation claim never substitutes for a downloadable artifact,
  executable test, runtime observation, or verified tracker state.

## Testing Strategy

### Focused validation

Each task begins with a failing or missing executable contract and runs the
smallest relevant test surface during implementation. Generated desktop and
iOS artifacts are checked only through their canonical generators.

### Repository validation

The normal repository surface includes:

- `pnpm test`;
- `pnpm typecheck`;
- `pnpm build`;
- `pnpm smoke`;
- `pnpm smoke:pack`;
- desktop Rust formatting and locked tests;
- desktop web bundle generation and parity checks;
- supported macOS, Windows, and Linux compilation checks;
- iOS project generation, core tests, app tests, and build checks when the
  changed surface requires them.

### Release acceptance

The macOS release candidate additionally verifies:

- clean installation on supported macOS hardware;
- first launch and onboarding;
- project open, pane creation, agent and terminal launch;
- persistence across restart;
- worktree inspection, integration, close, and recovery;
- diagnostic report generation and redaction;
- update behavior from the previous public build when one exists;
- uninstall and reinstall;
- signatures, notarization, Gatekeeper, checksums, provenance, GitHub assets,
  and Homebrew Cask integrity.

### Architecture regression policy

Every extraction runs focused contracts before and after movement, then the
full owning surface. Source and generated bundle parity must be explicit.
Passing source-text assertions alone is not sufficient proof of runtime
behavior.

## Completion Criteria

The improvement program is complete when:

1. the first public macOS release installs through Homebrew and all release
   integrity checks pass;
2. GitHub outcomes and Beads dependencies agree on active work and ownership;
3. the release acceptance loop is repeatable and diagnostics are bounded and
   redacted;
4. desktop entry points have been reduced to composition-oriented roles by
   incremental verified extraction;
5. the repository presents a complete security, ownership, contribution, and
   support surface to external contributors;
6. iOS work proceeds through its own explicit delivery gates without being
   presented as a prerequisite for macOS completion.
