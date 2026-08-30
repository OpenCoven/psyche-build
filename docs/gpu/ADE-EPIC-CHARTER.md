# GPU-Accelerated Multiplatform Desktop ADE — Epic Charter

- **Epic:** Bead `psyche-z7c` — [OpenCoven/psyche-build#228](https://github.com/OpenCoven/psyche-build/issues/228) `[psyche-z7c] GPU-accelerated multiplatform desktop ADE` (P1, `in_progress`)
- **Canonical outcome:** gh-199 ([OpenCoven/psyche-build#199](https://github.com/OpenCoven/psyche-build/issues/199), *Harden Psyche Build operations, diagnostics, and recovery*). Per the issue's implementation note (2026-08-28), gh-199 is the source of truth for the remaining post-release track; earlier broad prose references for this GPU family are historical/superseded.
- **Design doc:** [docs/superpowers/specs/2026-08-10-gpu-accelerated-multiplatform-ade-design.md](../superpowers/specs/2026-08-10-gpu-accelerated-multiplatform-ade-design.md)
- **Charter scope:** planning and contract only. This charter records the epic objective, the four-slice architecture with current status, the verbatim-faithful constraints, and the evidence policy. It ships no runtime behavior and proves nothing by existing; acceptance comes from the recorded evidence below and the slice verification owned by #229/#230/#231/#232.
- **Machine-checkable counterpart:** [`src/gpu/adeEvidencePolicy.ts`](../../src/gpu/adeEvidencePolicy.ts) (policy v1: `classifyRenderer()`, `resolveEvidenceConflict()`, `mergeEvidenceReports()`).

## Objective

Ship a runnable macOS, Windows, and Linux Tauri ADE that uses the platform WebView compositor, bounded PTY transport, isolated per-pane rendering, strict runtime acceleration evidence, and a repeatable diagnostics stress harness.

Concretely, the epic keeps the platform WebView (WKWebView, WebView2, WebKitGTK) and its compositor instead of adding a custom renderer, makes terminal delivery bounded and frame-aware without discarding or reordering process bytes, gives every pane an independent terminal/renderer/visibility/queue/disposal lifecycle, recovers safely from WebGL context loss, suspends expensive work outside visible panes, and reports acceleration from runtime evidence rather than assumption.

## Architecture — four sequential slices

Per the epic: "Deliver four sequential slices: cross-platform runtime; bounded acknowledged PTY batching; per-pane xterm/WebGL lifecycle and frame scheduling; diagnostics and 1/6/12/24-pane stress verification." Each slice must pass its focused tests and leave the application runnable before the next begins.

Status values below are stated from repository inspection on 2026-08-30 at upstream `main` `63667f3` ("Report pane recovery failures visibly (#283)"); each claim names the exact artifact observed, and open gaps are named as gaps, not successes.

### Slice 1 — Cross-platform runtime

**Contracts.** Desktop source lives at `native/desktop/psyche-build-tauri` (migrated from the macOS-named tree) with a portable base `tauri.conf.json` and platform overlays that restore only supported presentation details: macOS uses WKWebView with overlay title-bar presentation, optional vibrancy, and transparent background; Windows uses WebView2 with a normal opaque decorated window; Linux uses WebKitGTK the same way. A `platform` module behind one shared interface owns platform/architecture identity, default interactive shell selection (macOS `$SHELL`→`/bin/zsh`, Linux `$SHELL`→`/bin/sh`, Windows PowerShell→`COMSPEC`), PATH augmentation via `std::env::split_paths`/`join_paths`, stable working-directory preparation, optional window effects (unavailable effects degrade visually, never fail startup), WebView engine identity/version when reliably exposed, and process CPU/memory sampling. PTYs use `portable-pty` on all three targets; Unix-only integrations return typed `unsupported`/`unavailable` results on Windows instead of failing startup. CI gains a change-classified desktop matrix on `macos-15`, `windows-2025`, and `ubuntu-24.04` running web bundle construction, Rust fmt/test/check, and platform-neutral TypeScript/source-contract tests. CI compilation proves platform compatibility only — it never asserts a hosted runner has an accelerated GPU.

**Status: delivered on `main`.** Observed: `native/desktop/psyche-build-tauri/` present (the legacy `native/macos/comux-tauri` prototype remains separate); `src-tauri/src/platform/` contains `mod.rs`, `macos.rs`, `windows.rs`, `linux.rs`; `.github/workflows/ci.yml` defines the "Desktop check" matrix `macos-15`/`windows-2025`/`ubuntu-24.04`, change-classified and skippable when the change set does not touch the desktop surface. Windows/Linux development builds and their CI runs are supplied by GitHub-hosted runners; no signed or distributable Windows/Linux release artifacts exist by design.

### Slice 2 — Bounded acknowledged PTY batching

**Contracts.** Replace per-read PTY emission with a per-session output pump: bounded byte-budget queue → cadence/size batcher → acknowledged in-flight window → batched event → per-pane frontend consumer → xterm write callback → acknowledgement. Flow control is per pane: a slow pane cannot consume another pane's byte budget or acknowledgement window. When the byte budget is full the native reader blocks, propagating normal PTY/OS backpressure to the child instead of dropping bytes or allocating without limit; bytes remain ordered and unchanged. Bounds are explicit constants reported by diagnostics: 2 MiB native pending budget and 128 fragments per pane, 64 KiB emitted batch limit, at most two unacknowledged batches per pane, hidden/background cadence no faster than 100 ms, and a 2-second exit drain timeout that is reported explicitly when hit. Batches carry thread id, monotonically increasing sequence, bytes, byte count, monotonic enqueue/emission timestamps, and native queue depth/byte count. The frontend acknowledges a sequence only from xterm's write-completion callback; duplicate acknowledgements are idempotent; unknown, skipped, or future acknowledgements are rejected without advancing the window. PTY exit waits for already-read data to drain before the exit event.

**Status: delivered on `main`.** Observed: `native/desktop/psyche-build-tauri/src-tauri/src/pty_transport.rs` defines `MAX_PENDING_BYTES = 2 MiB`, `MAX_PENDING_FRAGMENTS = 128`, `MAX_BATCH_BYTES = 64 KiB`, `MAX_IN_FLIGHT = 2`, `HIDDEN_CADENCE = 100 ms`, and `EXIT_DRAIN_TIMEOUT = 2 s`, implements acknowledgement sequencing with explicit unknown/skipped-acknowledgement errors, and carries its Rust unit tests (`mod tests`) in the same file; the frontend consumer side lives in `web/runtime/pty-client.ts`. Visible panes are paced by acknowledgement credit rather than a timer floor. Physical-platform throughput and backpressure behavior remain execution evidence to be collected per the verification matrix (Slice 4 status).

### Slice 3 — Per-pane xterm/WebGL lifecycle and frame scheduling

**Contracts.** One terminal pane controller per terminal owns the xterm instance with bounded scrollback, fit and WebGL addons, current renderer state, output batch queue and write-in-progress state, resize/intersection observer state, effective visibility, scheduled frame handles, context-loss retry state, and input/bell/link/resize/disposal registrations. Creating, hiding, moving, or closing one pane must not recreate or rerender unrelated terminals. `webgl` is recorded only after WebGL addon initialization succeeds; a WebGL context loss disposes the failed addon without disposing xterm, recreates once on a stable visible frame, and otherwise stays on xterm's supported fallback renderer with the reason recorded; a second loss inside a 30-second cooldown does not loop, and renderer failure never crashes the terminal or PTY. A keyed frame scheduler coalesces terminal output flush, fit/PTY resize, pane-tree geometry, browser bounds, and transient presentation to at most one scheduled operation per animation frame per key. Hidden, collapsed, off-screen, backgrounded, and minimized panes suspend fitting and painting while their parsers keep consuming ordered output at reduced cadence; a restored pane fits once before painting resumes. Terminal history uses xterm viewport virtualization with `scrollback: 10_000`; long collections use a fixed/estimated-row virtual list that switches to windowing past 200 items without changing selection state. Animated CSS properties are limited to `transform` and `opacity`, and `will-change` is never global or persistent.

**Status: delivered on `main` (core artifacts).** Observed: `web/runtime/` contains `terminal-pane-controller.ts`, `frame-scheduler.ts` (keyed `schedule(key, callback)` with pending-value replacement), `pty-client.ts`, `virtual-list.ts` (exports `VIRTUAL_LIST_THRESHOLD = 200`), and `runtime-entry.ts`; `terminal-pane-controller.ts` configures `scrollback: 10_000` and contains the WebGL/context-loss handling. Slice-level behavioral proof (context-loss recovery on physical hardware, suspension under minimize/background, once-per-frame coalescing under stress) is execution evidence owned by the verification matrix and remains an open gap until physical sessions record it.

### Slice 4 — Runtime graphics diagnostics and stress verification

**Contracts.** One merged startup/runtime report combines Rust-supplied platform/native WebView facts and process metrics with frontend standards-based graphics probe results and renderer lifecycle facts. The report uses omission instead of guessed placeholder values, and its acceleration status is exactly one of the four evidence values defined below. Known software markers (SwiftShader, llvmpipe, softpipe, software rasterizer, Microsoft Basic Render Driver) are tested and versioned; a successful ordinary WebGL context alone never proves acceleration. Developer diagnostics display the report in-app and can copy/export deterministic JSON. The stress harness runs only in debug builds when `PSYCHE_RENDER_DIAGNOSTICS=1` is present at native startup (the frontend never trusts a query parameter to authorize spawning; production builds compile the controls out and reject stress commands regardless of environment). It runs separate 1, 6, 12, and 24-terminal scenarios with platform-native deterministic output generators (sequence-numbered text, ANSI color, line rewrites, bursts), plus split/sidebar resizing, rapid focus switching, a large generated editor document, a local self-contained browser page, minimize/background/restore, forced WebGL loss through `WEBGL_lose_context`, and hidden/off-screen suspension. Each scenario reports frame-time average/p95/max, frames over 16.7/33.4/50 ms, long and estimated dropped frames, bytes read/rendered per second, IPC batch count/size/frequency, native and frontend queue depth high-water marks, coalesced visual updates, PTY backpressure time, renderer losses/recoveries/fallbacks, and process CPU/resident memory. Machine-dependent values are evidence, not universal CI assertions. The six-pane acceptance run on supported non-virtualized hardware targets p95 frame time ≤ 33.4 ms and focus/resize input-to-next-paint < 100 ms; results outside the target block the responsiveness acceptance claim without making unrelated compile tests flaky.

**Status: in progress.** Observed from the public tracker and fork: the slice parent #229 and its children #230 (debug-authorized rendering stress harness) and #231 (in-app developer GPU diagnostics surface, bead-blocked) are open; #232 (document and execute the GPU verification matrix) is open and bead-blocked, and its matrix documentation plus the evidence-manifest validator (`src/gpu/verificationMatrix.ts`, `docs/gpu/VERIFICATION-MATRIX.md`, 33 focused tests) are shipped on fork PR CompleteDotTech/psyche-build#7 (ready, pending merge). The epic-level evidence policy module of this charter (`src/gpu/adeEvidencePolicy.ts`) is new in this slice of work. **Physical acceleration/stress evidence on macOS, Windows, and Linux: not collected — open proof gap.** No acceleration claim is made for any platform; hosted CI compilation does not close this gap.

## Constraints (verbatim-faithful)

The epic's constraints, verbatim: *"Never drop or reorder raw PTY bytes, weaken CSP/capabilities, guess acceleration details, add GPU-disabling flags, or claim physical-platform evidence that was not collected."*

Operationally, each clause binds the whole epic and every slice:

- **Never drop or reorder raw PTY bytes.** Saturation applies backpressure (the native reader blocks) instead of discarding; every byte accepted from the PTY is processed in order by the terminal parser; bounded queues and scrollback bound memory, not fidelity. Sequence gaps stop acknowledgement advancement and surface a protocol error.
- **Never weaken CSP/capabilities.** No remote origins, unsafe script directives, devtools in production, shell passthrough from web content, or broad Tauri permissions; stress commands are fixed native development fixtures, not user-supplied strings; CSP and capability diffs versus the release base must audit as unchanged or strengthened — a `weakened` verdict fails review.
- **Never guess acceleration details.** Every reported acceleration/adapter/backend/version value comes from runtime observation; unsupported fields are omitted and named; conflicting or masked evidence classifies `unknown`; software markers come from the tested, versioned list; engine identity (user agent, WebView family) never proves acceleration.
- **No GPU-disabling flags.** Nothing in the epic adds switches that force software rendering or disable hardware compositing for convenience; diagnostics environment variables only enable observation (and only in debug builds), never degradation.
- **No unobserved physical-platform claims.** Hosted CI compilation never proves physical GPU acceleration; virtual machines, remote desktops, and CI runners cannot support acceleration or responsiveness targets; physical runtime/stress evidence is recorded per the verification matrix or named as an open gap.

## Evidence policy

The acceleration vocabulary is closed — every classification is one of:

- **`accelerated`** — a context created with `failIfMajorPerformanceCaveat`, or a WebGPU adapter, plus available renderer evidence that does not identify software rendering;
- **`software`** — renderer/adapter evidence identifies a known software implementation (SwiftShader, llvmpipe, softpipe, software rasterizer, Microsoft Basic Render Driver);
- **`unknown`** — the engine masks the necessary evidence, a probe is unsupported, or evidence conflicts;
- **`unavailable`** — neither WebGL nor WebGPU can create a usable context.

Rules, enforced by [`src/gpu/adeEvidencePolicy.ts`](../../src/gpu/adeEvidencePolicy.ts) and its focused tests:

1. **Evidence values come only from runtime evidence.** Accelerated/software/unknown/unavailable classifications are produced by `classifyRenderer()` from observed probe facts (strict-context success, WebGPU adapter acquisition, unmasked renderer/adapter strings), never from platform assumption, browser family, CPU architecture, or vendor id.
2. **Omission over placeholders.** A reportable field (WebView engine/version, graphics backend, GPU adapter) appears in a merged report only when a collector observed it. Missing, empty, or explicitly unsupported fields are omitted and named in `omittedFields` — never defaulted, never filled with placeholders.
3. **Conflicts and masking classify `unknown`; the merge never guesses.** `resolveEvidenceConflict()` keeps two agreeing affirmative classifications, classifies disagreement between affirmative claims as `unknown` with no tie-breaking, and treats a masked/absent classification as absence of evidence rather than a contradiction. `mergeEvidenceReports()` deterministically combines the native and browser reports: a field either collector declares unsupported is omitted even when the other collector supplies a value, differing values for one field are omitted and named in `conflictedFields`, and repeated merges of the same inputs are deep-equal.
4. **Hosted compilation never proves physical GPU acceleration.** Deterministic repository gates and CI build/test results are compatibility evidence; acceleration and responsiveness acceptance requires the per-platform physical evidence sessions defined by the #232 verification matrix, tied to an exact released version and commit SHA in a validating evidence manifest. Untested machine-dependent values stay visible evidence and open gaps.
5. **Versioned marker vocabulary.** The software-marker and hardware-backend token lists are exported constants of the policy module so marker detection is testable and reproducible across runs and platforms.

The manifest-level structural contract (provenance, machine/driver metadata, bounded records, digest-only machine identity, closed status vocabulary including `not-run`) is owned by the #232 verification matrix module and stays in its file; the two modules are complementary and neither duplicates the other's scope.

## Execution protocol notes

From the epic, verbatim-faithful: *"Work only in the canonical local checkout (path redacted in the public mirror). Use TDD for every behavior change. One implementer owns one task at a time; independent spec-compliance and code-quality reviews must approve each task before its successor starts. Local verified commits are allowed; no push, PR, merge, or canonical-checkout edits without explicit approval."*

Current pipeline note: upstream OpenCoven writes (push, PR creation, issue comments) are token-denied for the delegated implementation pipeline, so reviewable slices run as pull requests on the fork `CompleteDotTech/psyche-build` with real CI under explicit orchestrator authorization, ready for a maintainer one-click PR to upstream. Beads remains the authoritative planning store for the epic's task graph (mirrors are generated; never hand-edit a mirror body), and gh-199 remains the canonical outcome for the remaining post-release track.

## Acceptance criteria

From the epic, verbatim-faithful:

- All four slice parents and every child task are closed in dependency order.
- Fresh focused and slice-level verification precedes every implementation commit.
- Native/frontend queues, scrollback, metrics retention, and shutdown drains are bounded.
- Runtime reports omit unsupported fields and distinguish accelerated/software/unknown/unavailable from evidence only.
- Deterministic repository gates pass.
- macOS, Windows, and Linux CI reaches terminal success.
- Physical runtime/stress evidence and any remaining proof gaps are recorded honestly.
- Final spec and code-quality review approve the complete cumulative implementation.

## Charter scope and boundaries

This charter does not implement slices and does not own slice files: the stress harness belongs to #230, the in-app diagnostics surface to #231, and the verification matrix (document + manifest validator) to #232 (shipped on fork PR CompleteDotTech/psyche-build#7). It modifies no workflow, lockfile, package script, Beads record, or generated output, and it records no evidence beyond what is cited above. Status statements reflect repository inspection on 2026-08-30 at upstream `main` `63667f3` and must be re-verified against the live tracker and release heads when slices close.
