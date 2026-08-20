# GPU Runtime Diagnostics and Stress Mode Design

## Scope

Complete `psyche-z7c.4` by delivering child tasks `psyche-z7c.4.2` through
`psyche-z7c.4.6` in dependency order. The work resumes the existing
`feat/graphics-evidence-diagnostics` branch and preserves the issue's evidence
policy: acceleration and software fallback are reported only from runtime
evidence, unsupported fields are omitted, and hosted compilation never proves
physical GPU acceleration.

Each child task is completed as a reviewable commit with focused tests and
verification before the next dependent task begins.

## Architecture

### Graphics evidence

Implement graphics diagnostics as two separable units:

- A pure classifier that converts explicit WebGPU or strict WebGL evidence into
  `accelerated`, `software`, `unknown`, or `unavailable`.
- A browser probe that gathers only supported runtime evidence and merges its
  result with the existing native runtime report.

The probe attempts WebGPU first, then WebGL2 and WebGL contexts created with
`failIfMajorPerformanceCaveat` and a high-performance preference. Backend and
adapter fields are included only when the evidence is unambiguous. Startup
emits one structured `[psyche:graphics]` summary.

### Performance metrics

Add bounded collectors that accept counters and timing samples from the
terminal pane controller and frame scheduler. Collectors retain at most 20,000
frame samples, summarize deterministic percentiles and threshold counts, and
expose snapshots for the diagnostics panel and stress harness.

The collectors measure frame cadence, long tasks when supported, throughput,
IPC batching, queue high-water marks, coalesced updates, acknowledgement
latency, backpressure, and renderer lifecycle. Native CPU and RSS metrics are
merged no faster than once per second. Terminal contents are never captured.

### Stress harness

Implement the frontend harness as a deterministic scenario state machine for
1, 6, 12, and 24 terminal panes. Each scenario has a 10-second warmup,
30-second measurement interval, and 5-second restore/context-loss interval.
The harness controls fixed focus, geometry, visibility, editor/browser
adjacency, minimize/restore, and context-loss steps.

Native fixture commands are debug-only and require startup authorization
through `PSYCHE_RENDER_DIAGNOSTICS=1`. They accept only the fixed `steady`,
`burst`, and `rewrite` fixtures and never accept arbitrary commands. The
frontend tracks all spawned fixtures and resources so cancellation and failure
always perform complete cleanup.

### Developer diagnostics surface

Add a development-only titlebar action and diagnostics panel that consume the
same report, metric snapshot, and harness interfaces. The panel renders only
present fields, highlights software fallback, copies deterministic JSON, and
shows accessible scenario progress and cancellation controls only when stress
authorization is active.

The panel uses the existing transform/opacity transition helper. It does not
expand CSP or Tauri capabilities. Startup graphics logging remains active even
when the panel is unavailable.

### Verification matrix

Document exact macOS, Windows, and Linux evidence collection in
`docs/GPU-VERIFICATION.md` and link it from the smoke documentation. Repository
gates, desktop CI, startup reports, stress scenario JSON, context-loss and
minimize/restore behavior, process metrics, and machine/driver metadata are
recorded separately.

Physical macOS evidence is collected on the available machine. Hosted Windows
and Linux CI proves build and test compatibility only. Missing physical
Windows or Linux acceleration evidence remains an explicit proof gap rather
than a guessed success.

## Data Flow

1. Startup requests native runtime diagnostics and runs browser graphics
   probing independently.
2. The results are normalized into a deterministic runtime graphics report
   with unsupported fields omitted.
3. Bounded collectors receive timing and counter updates from existing runtime
   components and publish immutable snapshots.
4. Stress scenarios reset and read those snapshots around fixed scenario
   phases.
5. The diagnostics panel renders the current report, metrics, and scenario
   state and can copy the same deterministic JSON used by verification.

No classifier or UI layer infers facts from the operating system, CPU, user
agent, hosted build target, or unavailable APIs.

## Error Handling

- Browser probe failures produce `unknown` or `unavailable`; they never produce
  an acceleration claim.
- Conflicting or masked renderer evidence omits backend and adapter details and
  records unsupported fields or fallback reasons.
- Unsupported observers and native process metrics are omitted without
  fabricating zero values.
- Unauthorized stress runs fail before allocating resources.
- Native fixture errors, scenario failures, and cancellation are surfaced
  explicitly and run the same cleanup path.
- Copy and panel actions report failures through the existing accessible status
  surface.

## Testing and Completion

Each child task follows test-driven development:

1. Add focused failing tests for the child contract.
2. Implement the smallest complete production change.
3. Regenerate the runtime bundle and verify bundle freshness.
4. Run focused TypeScript or Rust checks and independent code review.
5. Commit the completed child before starting its dependent child.

The cumulative completion gate includes repository build, typecheck, tests,
smoke and package smoke checks, Rust formatting/tests/checks, CSP and capability
assertions, bundle freshness, and `git diff --check`. The feature branch is then
pushed, opened as a pull request, and driven through terminal desktop CI and
review feedback.

`psyche-z7c.4` is complete when all child tasks are closed, the pull request is
merged or otherwise accepted by the repository workflow, available physical
evidence is recorded, and unavailable physical platforms are listed as open
proof gaps.
