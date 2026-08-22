# Psyche Build support matrix

**Status:** Active release contract  
**Applies to:** planned `v0.0.1` unless a later release document supersedes it  
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
| **Internal beta** | Available only to authorized internal testers; behavior and distribution may change |
| **Compile-only** | CI checks compilation compatibility; no application artifact, install path, or support commitment is published |
| **Optional integration** | Extends a complete standalone product through a typed, bounded interface and fails in isolation when unavailable |
| **Planned** | Roadmapped but not a current product claim |
| **Unavailable** | Deliberately not distributed or supported in this release |

## Distribution surfaces

| Surface | `v0.0.1` status | Contract |
|---|---|---|
| macOS native application | **Planned public supported surface** after #194 closes | Signed and notarized Apple Silicon and Intel DMGs, checksums, stable GitHub Release, and native Homebrew Cask |
| TUI / Node CLI from source checkout | **Source-supported** | Contributor/operator interface invoked from the repository checkout; its package archive is validated |
| npm package | **Unavailable** | `psyche-build` is not published as an npm release for `v0.0.1` |
| iOS application | **Internal beta** | Authorized internal TestFlight companion; tracked independently in #200 |
| External TestFlight | **Unavailable** | Not part of the first delivery contract |
| Public App Store | **Unavailable** | Not part of the first delivery contract |
| Windows application | **Compile-only** | Cross-platform compilation may be validated; no public installer or supported application is shipped |
| Linux application | **Compile-only** | Cross-platform compilation may be validated; no public package or supported application is shipped |
| Android application | **Unavailable** | No release artifact or supported runtime |
| Browser-hosted application | **Unavailable** | Psyche Build is not currently a hosted web product |
| Cloud execution / hosted terminals | **Planned** | Future work only; not required for local use or the first release |

Until [#194](https://github.com/OpenCoven/psyche-build/issues/194)
closes with retained distribution evidence, public copy must describe the
macOS installation path as pending rather than already available.

## Core capability contract

| Capability | macOS / source status | iOS status | Notes |
|---|---|---|---|
| Open and manage explicit projects | Supported after release acceptance / source-supported | Internal beta observation | Project identity and canonical scope must be proven |
| Plain terminal panes | Supported after release acceptance / source-supported | Internal beta control where wired | Does not require an agent CLI |
| Agent-backed panes | Supported after release acceptance / source-supported | Internal beta observation/control where wired | Requires an installed supported launcher; absence must not disable plain terminals |
| Git worktree isolation | Supported after release acceptance / source-supported | Internal beta observation | Cleanup remains explicit; a pane close must not silently delete the only copy of work |
| Multi-project cockpit | Supported after release acceptance / source-supported | Internal beta workspace view | Project ownership and active scope remain explicit |
| File browsing and bounded diff inspection | Supported after release acceptance / source-supported | Not a first-release mobile claim unless separately accepted | Large content must remain bounded |
| Ritual discovery and launch | Supported from source where current paths are accepted | Blocked pending #192 live-path repair | Fixtures or simulator menus do not establish production support |
| Merge, pull request, and cleanup workflows | Supported after release acceptance / source-supported | Not a first internal-beta claim unless explicitly accepted | Consequential effects remain operator-visible and explicit |
| Pane/browser control over MCP | Source-supported bounded interface | Not a direct mobile claim | Requires project scope, exact generations, leases, approvals where necessary, receipts, and revocation |
| Local daemon / bridge | Source-supported and used by companion paths | Internal beta | Unavailable optional providers fail closed without disabling core local workflows |
| Bonjour host discovery | Not a desktop product claim | Internal beta pending #193 | Local discovery only; not the remote-connectivity architecture |
| Remote/off-LAN continuity | Planned | Planned under #200 | Must preserve identity and authority across transport changes |
| Diagnostics/support bundle | Partial; release minimum under #196, hardened under #199 | Partial/internal | Must be bounded, recent, versioned, and automatically redacted |
| Automatic update | Supported only when release acceptance proves the configured path | Internal distribution-specific | Update claims must identify source, version, integrity, rollback, and failure behavior |
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

The first internal iOS delivery is a companion, not an independent authority.
It may discover or select a host, authenticate, restore an authoritative
workspace, observe bounded state, and invoke explicitly supported mobile
commands.

It must not:

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

The following do not block `v0.0.1` unless they expose a shared defect in the
supported macOS path:

- public or external iOS distribution;
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
