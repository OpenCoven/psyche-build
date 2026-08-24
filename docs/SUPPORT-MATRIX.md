# Psyche Build support matrix

**Status:** Active release contract

**Applies to:** released `v0.0.1` and current post-release `main` unless a later
release document supersedes it

**Roadmap:** [ROADMAP.md](./ROADMAP.md)

This document defines what Psyche Build may claim as supported. A feature is
not supported merely because source exists, a simulator passes, or a platform
compiles. Support requires an intentional distribution path, documented user
contract, executable validation, and an owned recovery path.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Supported** | Intended for real use in the named distribution, covered by acceptance evidence, and owned for recovery |
| **Source-supported** | Supported from a repository checkout for contributors or operators; not separately distributed |
| **Internal beta** | Available only to authorized internal testers, with distributed-build evidence; behavior and distribution may change |
| **Compile-only** | CI checks compilation compatibility; no application artifact, install path, or support commitment is published |
| **Optional integration** | Extends a complete standalone product through a typed, bounded interface and fails in isolation when unavailable |
| **Planned** | Roadmapped but not a current product or availability claim |
| **Unavailable** | Deliberately not distributed or supported in this release |

## Distribution surfaces

| Surface | `v0.0.1` status | Contract |
|---|---|---|
| macOS native application | **Supported** | Signed and notarized Apple Silicon and Intel DMGs, checksums, stable [GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1), and native [Homebrew Cask](https://github.com/OpenCoven/homebrew-tap/blob/main/Casks/psyche-build.rb) |
| TUI / Node CLI from source checkout | **Source-supported** | Contributor/operator interface invoked from the repository checkout; its package archive is validated |
| npm package | **Unavailable** | `psyche-build` is not published as an npm release for `v0.0.1` |
| iOS application | **Planned internal beta pending #200** | No live TestFlight availability is claimed until an immutable distributed build and physical-device acceptance are linked from #200 |
| External TestFlight | **Unavailable** | Not part of the first delivery contract |
| Public App Store | **Unavailable** | Not part of the first delivery contract |
| Windows application | **Compile-only** | Cross-platform compilation compatibility is retained as evidence; no public installer or supported application is shipped |
| Linux application | **Compile-only** | Cross-platform compilation compatibility is retained as evidence; no public package or supported application is shipped |
| Android application | **Unavailable** | No release artifact or supported runtime |
| Browser-hosted application | **Unavailable** | Psyche Build is not currently a hosted web product |
| Cloud execution / hosted terminals | **Planned** | Future work only; not required for local use or the first release |

The `v0.0.1` macOS release was published on 2026-08-23 from commit
`57c6c71bd5264fde960b062e95de278c8438c94f`. Publication evidence includes the
successful
[release workflow](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508),
the immutable release assets, and the public tap Cask. [#194](https://github.com/OpenCoven/psyche-build/issues/194)
and [#203](https://github.com/OpenCoven/psyche-build/issues/203) are closed.

The product contract keeps iOS-only failures off an explicitly selected
desktop-only macOS release while retaining shared validation and every iOS gate
for coordinated releases. The verified desktop-only publication skipped iOS
distribution while preserving shared validation. iOS remains a separate
planned surface rather than a macOS prerequisite.

## Core capability contract

| Capability | macOS / source status | iOS status | Notes |
|---|---|---|---|
| Open and manage explicit projects | Supported / source-supported | Planned observation pending #200 | Project identity and canonical scope must be proven |
| Plain terminal panes | Supported / source-supported | Planned control where wired | Does not require an agent CLI |
| Agent-backed panes | Supported / source-supported | Planned observation/control where wired | Requires an installed supported launcher; absence must not disable plain terminals |
| Git worktree isolation | Supported / source-supported | Planned observation | Cleanup remains explicit; a pane close must not silently delete the only copy of work |
| Multi-project cockpit | Supported / source-supported | Planned workspace view | Project ownership and active scope remain explicit |
| File browsing and bounded diff inspection | Supported / source-supported | Not a first mobile-beta claim unless separately accepted | Large content must remain bounded |
| Ritual discovery and launch | Supported from source where current paths are accepted | Blocked pending #192 live-path repair | Fixtures or simulator menus do not establish production support |
| Merge, pull request, and cleanup workflows | Supported / source-supported | Not a first mobile-beta claim unless explicitly accepted | Consequential effects remain operator-visible and explicit |
| Pane/browser control over MCP | Source-supported bounded interface | Not a direct mobile claim | Requires project scope, exact generations, leases, approvals where necessary, receipts, and revocation |
| Local daemon / bridge | Source-supported and used by companion paths | Planned companion path | Unavailable optional providers fail closed without disabling core local workflows |
| Bonjour host discovery | Not a desktop product claim | Planned pending #193 | Local discovery only; not the remote-connectivity architecture |
| Remote/off-LAN continuity | Planned | Planned under #200 | Must preserve identity and authority across transport changes |
| Diagnostics/support bundle | Current visible diagnostics only; versioned support bundle planned under #199 | Planned | The first release does not claim the bounded support bundle before #199 delivers it |
| Automatic update | Supported only when release acceptance proves the configured path | Planned distribution-specific behavior | Update claims must identify source, version, integrity, rollback, and failure behavior |
| Team collaboration | Planned | Planned | Not a first-release claim |
| Marketplace/plugin ecosystem | Planned | Planned | Must wait for stable capability, identity, and compatibility contracts |

## Optional integration contract

Psyche Build remains usable for ordinary projects, terminals, worktrees, file
browsing, rituals, merge/PR workflows, settings, and cleanup when optional
providers are absent.

An optional provider must:

- register a typed, bounded capability or session interface;
- prove canonical project scope and resource ownership;
- expose exact lifecycle and compatibility state;
- fail closed when unavailable or incompatible;
- avoid whole-desktop, coordinate, raw-shell, or unscoped tmux fallback;
- route consequential effects through the authoritative policy, approval,
  receipt, idempotency, revocation, and recovery path;
- avoid owning durable Psyche Build identity.

## iOS companion contract

The planned first internal iOS delivery is a companion, not an independent
authority. After #200's distribution and physical-device gates pass, it may
discover or select a host, authenticate, restore an authoritative workspace,
observe bounded state, and invoke explicitly supported mobile commands.

Until then, source, simulator, and UI-test behavior are development evidence,
not a live TestFlight availability claim.

The companion must not:

- present a newly loaded workspace as live when readiness failed;
- infer success from a local UI transition without an authoritative host
  result;
- expose a control whose production executor or publication path is not wired;
- turn a caller-supplied task, project, pane, or session identifier into proof
  of authority;
- treat Bonjour as sufficient for durable remote connectivity;
- silently re-pair or create a replacement identity after revocation.

The complete iOS delivery and continuity gate is
[#200](https://github.com/OpenCoven/psyche-build/issues/200).

## Identity and persistence invariants

Current implementation identifiers may be used as adapters, but durable user
work must not be defined solely by:

- a Bead ID;
- a tmux pane or session ID;
- a process ID;
- a filesystem path;
- a branch or worktree name;
- a provider-specific session ID;
- a device address or transport endpoint;
- a UI component or navigation selection.

The future protocol-owned identity and Threads execution contract is tracked in
[#201](https://github.com/OpenCoven/psyche-build/issues/201). That outcome is
not a claim that the complete model has already shipped.

## Release-claim rules

A public claim may move from planned to supported only when:

1. the exact artifact or source commit is immutable and identified;
2. the intended distribution path succeeds from a clean environment;
3. the primary user path and representative failure paths are observed;
4. security and scope boundaries remain intact;
5. recovery ownership and known limitations are documented;
6. retained evidence is linked from the owning GitHub issue.

Documentation, source presence, compile success, simulator success, test count,
or a generated artifact alone is insufficient.

## Current known deferrals

The following were not prerequisites for `v0.0.1` and remain post-release work
unless they expose a shared defect in the supported macOS path:

- internal, public, or external iOS distribution and mobile feature completion;
- remote/off-LAN companion transport;
- graphics diagnostics in #190 unless release acceptance proves them required;
- desktop architecture decomposition;
- complete community-health work beyond the minimum security and ownership
  floor;
- cloud terminals or hosted orchestration;
- team collaboration;
- marketplace/plugin behavior;
- complete Threads and AgentFS convergence.

## Changing this contract

Any pull request that changes a support status must update this file, the
canonical [roadmap](./ROADMAP.md), and the owning issue. The pull request must
identify the executable evidence that justifies the change or explicitly mark
the new state as planned/internal/compile-only rather than supported.
