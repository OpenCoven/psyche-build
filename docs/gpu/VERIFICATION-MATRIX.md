# GPU verification matrix

**Status:** Contract defined; physical execution evidence open  
**Issue:** [OpenCoven/psyche-build#232](https://github.com/OpenCoven/psyche-build/issues/232) (Bead `psyche-z7c.4.6`, P1)  
**Blocked by:** [#231](https://github.com/OpenCoven/psyche-build/issues/231) — expose the in-app developer GPU diagnostics surface  
**Parent slice:** [#229](https://github.com/OpenCoven/psyche-build/issues/229) — runtime graphics diagnostics and stress mode  
**Design plan:** [GPU ADE slice 4](../superpowers/plans/2026-08-10-gpu-ade-slice-4-diagnostics-stress.md)  
**Machine-checkable contract:** [`src/gpu/verificationMatrix.ts`](../../src/gpu/verificationMatrix.ts) (schema v1)

This document defines the exact evidence required before any macOS, Windows, or
Linux hardware-acceleration claim may be made. It pairs each physical evidence
requirement with a deterministic, repeatable procedure and a versioned evidence
manifest that a machine can check for shape and completeness.

## Non-negotiable rules

1. **Hosted CI never substitutes for physical acceleration evidence.** CI
   runners are virtualized, their GPUs are para-virtualized or software
   (SwiftShader/llvmpipe-class), and their results prove buildability and
   fallback reporting — nothing about real hardware acceleration. No CI
   passage, on any runner image, may be recorded as `accelerated` evidence.
2. **Unavailable physical platforms remain open proof gaps.** A platform whose
   physical evidence has not been collected stays an open gap in the issue,
   working records, and release claims — it is never guessed, extrapolated, or
   filled with a success from another platform.
3. **Evidence binds to an exact release head.** Every manifest records the
   exact released version and the full 40-hex commit SHA it was collected on.
4. **Classification comes from the probe, not from the OS.** `accelerated`
   requires a strict WebGL context or WebGPU adapter plus non-software renderer
   evidence. Ordinary contexts, masked renderer strings, and OS/user-agent
   derivation are never promoted to `accelerated`.
5. **Protected data stays out.** Machine identity is recorded only as a SHA-256
   digest of the hostname. Raw hostnames, paths, prompts, terminal output
   dumps, or environment dumps fail validation and must not be committed.

## Evidence manifest contract (schema v1)

Evidence is recorded as one JSON manifest per platform collection session and
validated with `validateEvidenceManifest()` from
[`src/gpu/verificationMatrix.ts`](../../src/gpu/verificationMatrix.ts). The
validator is strict: unknown fields are rejected at every level, records are
bounded, provenance is mandatory, and machine identity must be a digest.

### Typed constant sets

| Constant | Values |
|---|---|
| `GPU_VERIFICATION_PLATFORMS` | `macos`, `windows`, `linux` |
| `GPU_VERIFICATION_ARCHITECTURES` | `x86_64`, `arm64` |
| `GPU_VERIFICATION_GATES` | `build:web`, `test`, `typecheck`, `build`, `smoke`, `smoke:pack`, `rust:fmt`, `rust:test`, `rust:check`, `git:diff-check` |
| `GPU_VERIFICATION_SCENARIO_IDS` | `panes-1`, `panes-6`, `panes-12`, `panes-24` |
| `GPU_VERIFICATION_METRIC_KEYS` | `frame.averageMs`, `frame.p95Ms`, `frame.maxMs`, `frames.droppedEstimated`, `input.focusToPaintMs`, `input.resizeToPaintMs`, `pty.queueHighWater`, `pty.ipcMessagesPerSecond`, `pty.throughputBytesPerSecond`, `process.cpuPercent`, `process.rssMb` |
| `GPU_VERIFICATION_STATUSES` | `succeeded`, `failed`, `unknown`, `recovery_required`, `unavailable`, `not-run` |
| `GPU_VERIFICATION_ACCELERATION_VALUES` | `accelerated`, `software`, `unknown`, `unavailable` |
| `GPU_VERIFICATION_LIFECYCLE_CHECKS` | `contextLoss`, `minimize`, `background`, `restore` |
| `GPU_VERIFICATION_DIFF_VERDICTS` | `unchanged`, `weakened`, `strengthened`, `unknown` |
| `GPU_VERIFICATION_REVIEW_STATUSES` | `pending`, `approved`, `changes-requested` |

Status semantics: `succeeded` means the check ran and met its requirement;
`failed` means it ran and did not; `unknown` means the outcome could not be
determined; `recovery_required` means the check only passed after a recovery
path ran (for example a rendering context restored after forced loss);
`unavailable` means the capability does not exist on that platform; `not-run`
means a required check never executed (always an open gap — never recorded as a
pass).

### Manifest shape (v1)

A valid manifest contains exactly these top-level fields — nothing more:

| Field | Contents |
|---|---|
| `schemaVersion` | `1` |
| `provenance` | `releaseVersion` (≤32 chars), `commitSha` (full 40-hex lowercase), `platform`, `architecture`, `collectedAt` (ISO-8601 UTC, `Z`-terminated), `collector` (≤128 chars) |
| `machine` | `hostnameDigest` (64-hex SHA-256 of hostname — never the raw hostname), `osName`, `osVersion`, `physicalHardware` (boolean) |
| `driver` | `webviewEngine`, optional `webviewVersion`/`gpuBackend`/`gpuAdapter`, `acceleration`, `softwareMarkers[]` (≤8); unobservable fields are omitted, never placeholder-filled |
| `gates` | Exactly one record per entry in `GPU_VERIFICATION_GATES` (10 records, no duplicates, no extras) |
| `scenarios` | Exactly one record per entry in `GPU_VERIFICATION_SCENARIO_IDS` (4 records), each with ≤8 metric records |
| `lifecycle` | `contextLoss`, `minimize`, `background`, `restore` — each an explicit status |
| `metrics` | Host-level metric records, ≤16, unique keys |
| `cspCapabilityAudit` | `cspDiff`, `capabilityDiff`, optional note |
| `reviews` | `specReview` and `codeReview`, each `{ status, reviewer? }` |

Metric values must be finite numbers between `0` and `1,000,000,000`. Notes are
capped at 512 characters. The validator returns a bounded error list rather
than throwing, so collection tooling can surface every violation at once.

`validateEvidenceManifest()` checks structure only. A structurally valid
manifest is still not proof; the collection procedure below is what makes the
evidence real.

## Deterministic repository gates

Run all gates from a clean checkout of the exact release head and record one
status per gate in the manifest:

| Gate id | Command |
|---|---|
| `build:web` | `pnpm --dir native/desktop/psyche-build-tauri build:web` |
| `test` | `pnpm test` |
| `typecheck` | `pnpm typecheck` |
| `build` | `pnpm build` |
| `smoke` | `pnpm smoke` |
| `smoke:pack` | `pnpm smoke:pack` |
| `rust:fmt` | `cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check` |
| `rust:test` | `cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked` |
| `rust:check` | `cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked` |
| `git:diff-check` | `git diff --check` |

Every gate must be recorded, even when its status is `not-run` on a host that
cannot execute it. A manifest that omits a gate is invalid; a host that skips a
gate owes an explicit explanation in the working record.

## Per-platform evidence-collection protocol

Perform on non-virtualized physical hardware only, from the exact release head,
with the debug desktop app built from `pnpm --dir
native/desktop/psyche-build-tauri build:web` and launched through
`scripts/dev-tauri-diagnostics.mjs` so `PSYCHE_RENDER_DIAGNOSTICS=1` is set.

1. Record provenance: release version, full commit SHA, platform,
   architecture, UTC timestamp, collector identity.
2. Build and launch the debug desktop app with rendering diagnostics
   authorized.
3. Copy the startup `[psyche:graphics]` JSON and require
   `acceleration: "accelerated"` before any hardware-acceleration claim for
   that platform. Record `software`, `unknown`, or `unavailable` exactly as
   reported.
4. Run all four scenarios (`panes-1`, `panes-6`, `panes-12`, `panes-24`) in
   order and copy each scenario JSON.
5. Force context loss (`WEBGL_lose_context` where supported) and record the
   outcome, including whether recovery was required.
6. Minimize the window, background the app, restore it, and record each outcome.
7. Copy the final diagnostics JSON; record machine metadata (digest-only host
   identity, OS name/version, physical-hardware flag) and driver metadata
   (engine, engine version, backend, adapter, acceleration classification,
   software markers) separately.
8. Diff the build's CSP and capabilities against the release base and record
   both verdicts.
9. Record all ten deterministic gate outcomes for this platform.
10. Validate the manifest with `validateEvidenceManifest()` and archive it with
    the working record.

### macOS specifics

- Engine: WKWebView. Backend is Metal via ANGLE when accelerated.
- Probe must confirm acceleration from renderer evidence; "Apple silicon"
  alone proves nothing.
- Collect on both `arm64` and `x86_64` when claiming architecture-wide
  acceleration; otherwise scope the claim to the collected architecture.

### Windows specifics

- Engine: WebView2 (Chromium). Backend is typically Direct3D via ANGLE.
- Software fallback commonly appears as `SwiftShader` or `Microsoft Basic Render
  Driver` in the renderer string; record it in `softwareMarkers` and never
  record such a session as `accelerated`.
- Guard against masked adapter strings; masked probes stay `unknown` with the
  field listed as unsupported, not guessed.

### Linux specifics

- Engine: WebKitGTK. Backends are commonly Vulkan or OpenGL via ANGLE.
- Software fallback commonly appears as `llvmpipe`; record it in
  `softwareMarkers` and never record such a session as `accelerated`.
- Fractional scaling and compositor differences affect frame timing: record the
  compositor and scale factor in scenario notes when they could skew targets.

## Stress scenario matrix

Each scenario runs a 10-second warmup, a 30-second measured interval, and a
5-second restore/context-loss interval. Focus cycles every 250 ms across panes;
deterministic split/sidebar geometry updates run every frame; half the panes
hide at the midpoint; the window minimizes and restores; context loss is forced
in the final interval. Every scenario ends with full disposal.

| Scenario id | Panes | Required evidence |
|---|---|---|
| `panes-1` | 1 | Startup graphics JSON, frame metrics, focus/resize input-to-paint metrics, context-loss outcome, lifecycle outcomes, CPU/RSS sample |
| `panes-6` | 6 | All of `panes-1` plus the performance targets below |
| `panes-12` | 12 | All of `panes-1`; record queue/IPC/throughput under doubled pane load |
| `panes-24` | 24 | All of `panes-1`; record queue high-water and dropped-frame estimates under maximum configured pane load |

## Performance targets

Targets apply on supported, non-virtualized hardware only
(`machine.physicalHardware: true`). Virtualized or software-rendered sessions
report what they measured but cannot satisfy the targets.

| Metric key | Target | Condition |
|---|---|---|
| `frame.p95Ms` | ≤ 33.4 ms | Six-pane (`panes-6`) measured interval |
| `input.focusToPaintMs` | < 100 ms | Six-pane, focus input to next painted frame |
| `input.resizeToPaintMs` | < 100 ms | Six-pane, resize input to next painted frame |

Failure to meet a target is recorded as `failed` with the measured values —
never rounded, retried into compliance, or omitted.

## Resilience checks

| Check | Procedure | Recording |
|---|---|---|
| Context loss | Force `WEBGL_lose_context` (where supported) during the final scenario interval; verify the probe reports loss and the app recovers or degrades honestly | `lifecycle.contextLoss`; `recovery_required` when recovery ran |
| Minimize | Minimize the window mid-scenario; verify rendering pauses and no error spam | `lifecycle.minimize` |
| Background | Background the app (occlusion/workspace switch); verify rAF suspension and transport recovery on return | `lifecycle.background` |
| Restore | Restore/foreground; verify frames resume, panes re-render, no stale viewport | `lifecycle.restore` |

Any crash, hung pane, or unrecoverable context is `failed`, with the bounded
diagnostics JSON attached to the working record (never raw unlimited logs).

## Resource and transport metrics

Sample at one-second cadence through the bounded collectors — never per frame:

- **Process:** `process.cpuPercent`, `process.rssMb`.
- **Terminal transport:** `pty.queueHighWater`, `pty.ipcMessagesPerSecond`,
  `pty.throughputBytesPerSecond`.
- **Frames:** `frame.averageMs`, `frame.p95Ms`, `frame.maxMs`,
  `frames.droppedEstimated` (estimated as `max(0, round(delta / 16.7) - 1)`).

Collectors retain bounded samples (fixed-size rings); manifests carry summaries,
not sample dumps.

## Machine and driver metadata

Machine and driver metadata are separate manifest sections and must never be
merged or inferred from one another:

- **Machine:** digest-only hostname, OS name/version, `physicalHardware`
  boolean. Virtualized hosts are recorded as such and their evidence cannot
  support acceleration or performance-target claims.
- **Driver:** WebView engine identity and version, graphics backend, GPU
  adapter string (omitted when masked), strict acceleration classification, and
  detected software-renderer markers. Fields the probe could not observe are
  omitted, never placeholder-filled.

## CSP and capability diff audit

For every collection build, diff the effective CSP and Tauri capability
configuration against the release base and record both verdicts:

- `unchanged` — the required, non-negotiable outcome for evidence builds.
- `weakened` — the build is invalid for evidence collection; the audit fails.
- `strengthened` — record and explain; capabilities must never expand.
- `unknown` — the diff could not be computed; treat as an open gap, never a pass.

No evidence session may run with an expanded capability set or a weakened CSP.

## Final cumulative review requirements

A platform claim is complete only when:

1. The manifest validates and every gate/scenario/lifecycle record exists with
   an honest status.
2. The **spec review** independently confirms the evidence satisfies this
   matrix (all four scenarios, targets on supported hardware, resilience
   checks, CSP/capability audit) against the exact head.
3. The **code review** independently confirms no capability expansion, no CSP
   weakening, and no diagnostics behavior change beyond the authorized
   development-only surface.
4. The completion report lists: commits, changed files, exact commands and
   observed results, stress metrics per scenario, physical evidence per
   platform, and remaining gaps.

Both reviews must be separate from the implementation and recorded
(`reviews.specReview`, `reviews.codeReview`) as `approved` before any
acceleration claim ships. `pending` or `changes-requested` keeps the claim open.

## Hosted CI versus physical evidence

| CI can prove | CI can never prove |
|---|---|
| Gates compile and pass on macOS/Linux/Windows runners | That any real GPU accelerated a frame |
| The strict probe runs and reports fallback honestly on virtualized/software stacks | `accelerated` status for any platform |
| Scenario harness code executes deterministically | Performance targets on supported hardware |
| No CSP weakening or capability expansion in the diff | Context-loss/minimize/restore behavior on real window managers and GPUs |

CI results are recorded through the same gate statuses as everything else; they
are necessary, never sufficient. The acceleration row for a platform turns
`accelerated` only from physical hardware evidence collected by the protocol
above.

## Current evidence status and open proof gaps

- **#231 (diagnostics surface) is unresolved and blocks this bead.** The
  in-app surface that presents and exports scenario/diagnostics JSON is not
  merged, so end-to-end collection depends on its landing first.
- **macOS physical evidence:** open gap — no non-virtualized macOS collection
  session has been executed against this matrix.
- **Windows physical evidence:** open gap — no physical Windows collection
  session has been executed against this matrix.
- **Linux physical evidence:** open gap — no physical Linux collection session
  has been executed against this matrix. This authoring host has no GPU
  collection path, no tmux, and no Rust toolchain, so no physical-platform
  evidence could be collected while defining this contract.
- **Deterministic gates on the authoring host:** only the TypeScript-side
  gates could run locally (`test` subset for the new files, `typecheck`,
  `git:diff-check`); `build:web`, `build`, `smoke`, `smoke:pack`, and the Rust
  gates are supplied by CI and remain to be recorded per release head in a
  real manifest.

Per rule 2, these gaps stay open until physical sessions close them. No
acceleration claim for any platform is made or implied by this document.
