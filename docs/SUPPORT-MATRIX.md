# Psyche Build support matrix

**Status:** Active release contract  
**Last reconciled:** 2026-08-30

**Applies to:** released `v0.0.1` and current post-release `main` unless a later
accepted release document supersedes it

**Roadmap:** [ROADMAP.md](./ROADMAP.md)  
**Execution contract:** [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)

This document defines what Psyche Build may claim as supported. A feature is not
supported merely because source exists, a simulator passes, a version string is
updated, a changelog entry exists, or a platform compiles. Support requires an
intentional distribution path, immutable artifact/source identity, executable
acceptance evidence, and an owned recovery path.

## Release truth

The latest supported public release is **`v0.0.1`**, published on 2026-08-23
from immutable source `57c6c71bd5264fde960b062e95de278c8438c94f`.
Publication evidence includes the public
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1),
the protected
[release workflow](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508),
two architecture-specific signed/notarized DMGs, `SHA256SUMS`, and the public
OpenCoven Homebrew Cask. [#194](https://github.com/OpenCoven/psyche-build/issues/194)
and [#203](https://github.com/OpenCoven/psyche-build/issues/203) are closed.

Current `main` identifies package/changelog version `0.0.2`, but no accepted
`v0.0.2` public release, immutable asset set, publication run, clean install and
upgrade evidence, or support-state transition is recorded. `0.0.2` is therefore
an **unreleased candidate**, not a supported distribution. Its eventual release
must be proved independently against the exact final source and artifacts.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Supported** | Intended for real use in the named distribution, covered by acceptance evidence, and owned for recovery |
| **Source-supported** | Supported from a repository checkout for contributors/operators; not separately distributed |
| **Internal beta** | Available only to authorized internal testers, with immutable distributed-build evidence; behavior/distribution may change |
| **Compile-only** | CI checks compilation compatibility; no application artifact, install path, or support commitment is published |
| **Optional integration** | Extends a complete standalone product through a typed, bounded interface and fails in isolation when unavailable |
| **Planned** | Roadmapped but not a current product or availability claim |
| **Unavailable** | Deliberately not distributed or supported in this release |

## Distribution surfaces

| Surface | Current status | Contract |
|---|---|---|
| macOS native application | **Supported — released `v0.0.1` only** | Signed/notarized Apple Silicon and Intel DMGs, checksums, stable GitHub Release, and native Homebrew Cask |
| Current `main` / `0.0.2` candidate | **Unreleased** | Development and candidate evidence only; no public support transition before immutable publication and release acceptance |
| TUI / Node CLI from source checkout | **Source-supported** | Contributor/operator interface invoked from a repository checkout; package archive and canonical agent gates are validated |
| npm package | **Unavailable** | `psyche-build` is not a published npm product release |
| iOS application | **Planned internal beta pending #200** | No TestFlight claim until one immutable distributed build and physical-device acceptance are linked from #200 |
| External TestFlight | **Unavailable** | Not part of the current delivery contract |
| Public App Store | **Unavailable** | Not part of the current delivery contract |
| Windows application | **Compile-only** | Compilation compatibility only; no public installer or supported application |
| Linux application | **Compile-only** | Compilation compatibility only; no public package or supported application |
| Android application | **Unavailable** | No release artifact or supported runtime |
| Browser-hosted application | **Unavailable** | Psyche Build is not currently a hosted web product |
| Cloud execution / hosted terminals | **Planned** | Future work; not required for local use or current macOS support |

Desktop-only publication keeps iOS-only distribution failures off an explicitly
selected macOS release while preserving shared validation and coordinated iOS
gates. iOS remains an independent planned surface rather than a macOS
prerequisite.

## Core capability contract

| Capability | macOS / source status | iOS status | Notes |
|---|---|---|---|
| Open and manage explicit projects | Supported / source-supported | Planned observation pending #200 | Project identity and canonical scope must be proven |
| Plain terminal panes | Supported / source-supported | Planned control where wired | Does not require an agent CLI |
| Agent-backed panes | Supported / source-supported | Planned observation/control where wired | Requires an installed compatible launcher; absence must not disable plain terminals |
| Git worktree isolation | Supported / source-supported | Planned observation | Cleanup remains explicit; pane close must not silently delete the only copy of work |
| Multi-project cockpit | Supported / source-supported | Planned workspace view | Project ownership and active scope remain explicit |
| File browsing and bounded diff inspection | Supported / source-supported | Not a first mobile-beta claim unless separately accepted | Large content remains bounded |
| Ritual discovery and launch | Supported from source where current desktop paths are accepted | Planned under #242 | Fixtures/simulator menus do not establish production mobile support |
| Merge, pull request, and cleanup workflows | Supported / source-supported | Not a first mobile-beta claim unless explicitly accepted | Consequential effects remain operator-visible and explicit |
| Pane/browser control over MCP | Source-supported bounded interface | Not a direct mobile claim | Requires project scope, exact generations, leases, approvals where necessary, receipts, and revocation |
| Local daemon / bridge | Source-supported and used by companion paths | Planned companion path | Optional providers fail closed without disabling core local workflows |
| Native iOS shared action state | Merged product-local composition in PR #274 | Development evidence only | One shared store/client narrows local state duplication; it does not prove pairing, production execution, or TestFlight support |
| Invite authentication | Not a macOS support claim | Planned under #280 after #241 | Draft PR #264 is source material; focused R3 slices and physical evidence are required |
| Bonjour host discovery | Not a desktop product claim | Planned after #241 | Discovery adapter only; not durable identity or remote-connectivity architecture |
| QR/deep-link pairing UX | Not a desktop support claim | Planned under #280 | A code/link/address is not host identity or authority |
| Remote/off-LAN continuity | Planned | Planned under #200 | Must preserve identity and authority across transport changes |
| Diagnostics/support bundle v1 | Existing visible diagnostics only | Planned | PR #278 has changes requested; no bounded support-bundle support claim before #243 acceptance |
| Automatic update | Supported only where release acceptance proves the configured released path | Planned distribution-specific behavior | Update claims identify source, version, integrity, rollback, and failure behavior |
| Team collaboration | Planned | Planned | Not a current-release claim |
| Marketplace/plugin ecosystem | Planned | Planned | Waits for stable capability, identity, and compatibility contracts |

## Optional integration contract

Psyche Build remains usable for ordinary projects, terminals, worktrees, file
browsing, merge/PR workflows, settings, and cleanup when optional providers are
absent.

An optional provider must:

- register a typed, bounded capability or session interface;
- prove canonical project scope and resource ownership;
- expose exact lifecycle and compatibility state;
- fail closed when unavailable, incompatible, or revoked;
- avoid whole-desktop, coordinate, raw-shell, or unscoped tmux fallback;
- route consequential effects through authoritative policy, approval, receipt,
  idempotency, revocation, and recovery paths;
- avoid owning durable Psyche Build or protocol identity.

Direct executable discovery does not prove compatibility. The planned
Coven-mediated product adapter is tracked in
[#279](https://github.com/OpenCoven/psyche-build/issues/279). It must negotiate
an exact supported profile/capability set, show only available adapters, keep raw
prompts out of process arguments and persistent launch metadata, preserve
canonical Coven session/receipt identity, and fail closed without weakening
plain-terminal operation. [PR #277](https://github.com/OpenCoven/psyche-build/pull/277)
is design-correction work, not a current support claim.

## iOS companion contract

The planned first internal iOS delivery is a companion, not an independent
authority. [#241](https://github.com/OpenCoven/psyche-build/issues/241) must first
commit host authority atomically before a new workspace can become visible as
live. [#280](https://github.com/OpenCoven/psyche-build/issues/280) then owns
focused invite-authentication slices. [#242](https://github.com/OpenCoven/psyche-build/issues/242)
owns production action publication/execution. [#200](https://github.com/OpenCoven/psyche-build/issues/200)
owns physical acceptance and distribution.

Until those gates pass, source, simulator, fixture, merged composition, and UI
test behavior are development evidence, not live TestFlight availability.

The companion must not:

- present a newly loaded workspace as live when readiness/authentication failed;
- infer success from local UI transition, socket connection, QR/deep-link parse,
  or PTY creation without an authoritative host result;
- expose a control whose production publisher/executor is not wired;
- turn caller-supplied task/project/pane/session identifiers into proof of
  authority;
- treat Bonjour address, endpoint, QR code, or invite as durable identity;
- persist/log invite material or silently re-pair after revocation;
- change support status without immutable physical-device distribution evidence.

Only an immutable TestFlight build installed by an authorized tester may move
iOS from **Planned** to **Internal beta**.

## Diagnostics and protected-data contract

A future support bundle must be versioned, deterministic, strictly bounded,
cancellable, and fail closed. It must not include raw prompts, unrestricted
terminal output, repository contents, environment maps, credentials, private
keys/certificates, infrastructure URLs, or full user paths merely because a
finite regex did not recognize them.

[#243](https://github.com/OpenCoven/psyche-build/issues/243) owns the first
contract. [PR #278](https://github.com/OpenCoven/psyche-build/pull/278) remains
unaccepted until unrestricted terminal content is omitted or admitted through a
proven-safe typed source, collector ownership conflicts are truthful, the action
vocabulary matches authoritative receipt projections, and traversal/elapsed
bounds are enforceable.

## Identity and persistence invariants

Current implementation identifiers may be adapters, but durable user work must
not be defined solely by:

- a Bead ID;
- a tmux pane/session or process ID;
- a filesystem path or branch/worktree name;
- a provider-specific session ID;
- a device address, transport endpoint, QR/deep-link, or invite;
- executable discovery or UI selection.

The future protocol-owned identity and Threads execution contract is tracked in
[#201](https://github.com/OpenCoven/psyche-build/issues/201). The immutable
Psyche profile/canary remains tracked in
[#253](https://github.com/OpenCoven/psyche-build/issues/253). The merged mapping
in PR #262 is not a conformance claim.

## Release-claim rules

A claim may move from planned/candidate to supported only when:

1. exact source and artifact identities are immutable;
2. the intended distribution succeeds from a clean environment;
3. primary user paths and representative failures are observed;
4. security, authority, scope, and protected-data boundaries remain intact;
5. recovery ownership, rollback, and known limitations are documented;
6. retained evidence is linked from the owning GitHub outcome;
7. roadmap, support matrix, release acceptance, changelog, and public release
   metadata agree.

Documentation, source presence, version strings, compile/simulator success, test
counts, generated artifacts, or a merge to `main` alone are insufficient.

## Current known deferrals

The following are not prerequisites for released `v0.0.1` unless they expose a
shared defect in its supported macOS path:

- internal/public/external iOS distribution and mobile completion;
- invite authentication and physical reconnect evidence;
- remote/off-LAN companion transport;
- support-bundle v1 and broader diagnostics;
- desktop architecture decomposition;
- final live governance/community evidence beyond repository files;
- capability-negotiated Coven convergence;
- cloud terminals/hosted orchestration, team collaboration, and marketplace;
- complete Psyche, Threads, and AgentFS convergence.

## Changing this contract

Any PR changing a support status updates this file, the canonical
[roadmap](./ROADMAP.md), the execution contract, and the owning issue. It names
the executable evidence justifying the transition or explicitly keeps the state
planned, candidate, internal, compile-only, or unavailable.