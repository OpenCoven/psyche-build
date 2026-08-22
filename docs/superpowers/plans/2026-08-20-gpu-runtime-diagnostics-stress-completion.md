# GPU Runtime Diagnostics and Stress Mode Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `psyche-z7c.4` with evidence-based graphics reporting, bounded runtime metrics, a debug-authorized deterministic stress harness, an in-app diagnostics panel, and an honest cross-platform verification record.

**Architecture:** Resume the clean `feat/graphics-evidence-diagnostics` worktree and finish child tasks in dependency order. Keep classification, metrics, stress orchestration, and panel rendering in focused TypeScript modules; keep Rust responsible for native facts, one-second process sampling, authorization, and fixed fixture spawning; keep `main.js` limited to adapting existing pane/window operations to those modules.

**Tech Stack:** TypeScript, Vitest, esbuild, browser WebGPU/WebGL/Performance APIs, xterm.js, Rust, Tauri 2, sysinfo, pnpm, GitHub Actions.

---

## Current State

The branch already contains the implementation commits for `psyche-z7c.4.2`:

- `514e1160 Report runtime graphics acceleration`
- `3cbd8dbc Fix graphics renderer classification regressions`
- `bce1ea73 Fix graphics diagnostics evidence handling`

It also contains the approved design commit:

- `afd71acb docs: design GPU diagnostics completion`

Do not rewrite those commits. Validate and review them before starting the dependent metrics work.

## File Map

### Existing graphics evidence

- `native/desktop/psyche-build-tauri/web/runtime/graphics-diagnostics.ts` — pure graphics evidence classification, browser probing, native/frontend merge, startup summary.
- `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts` — public `PsycheRuntime` exports and startup initialization.
- `__tests__/tauriGraphicsDiagnostics.test.ts` — classification, probing, merge, startup, and committed-bundle coverage.

### Bounded metrics

- Create `native/desktop/psyche-build-tauri/web/runtime/performance-metrics.ts` — frame ring, deterministic summaries, long-task observation, transport deltas, renderer/process merge, one-second polling.
- Create `__tests__/tauriPerformanceMetrics.test.ts` — pure statistics, retention, cadence, omission, transport, renderer, and lifecycle tests.
- Modify `native/desktop/psyche-build-tauri/web/runtime/frame-scheduler.ts` — expose pending/coalesced counters needed by snapshots.
- Modify `native/desktop/psyche-build-tauri/web/runtime/terminal-pane-controller.ts` — expose renderer lifecycle/context-loss counters without terminal content.
- Modify `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts` and `web/runtime.bundle.js` — export the collector and public types.

### Debug stress mode

- Create `native/desktop/psyche-build-tauri/web/runtime/stress-harness.ts` — fixed 1/6/12/24 scenarios, phase timing, progress, cancellation, cleanup, and result JSON.
- Create `__tests__/tauriStressHarness.test.ts` — deterministic scenario and cleanup tests.
- Create `scripts/dev-tauri-diagnostics.mjs` — cross-platform authorized launcher with injectable process/spawn dependencies.
- Create `__tests__/tauriDiagnosticsLauncher.test.ts` — environment and exit/signal propagation tests.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/runtime_diagnostics.rs` — fixture enum, authorization accessor, fixed platform command builders, tests.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs` — trusted main-webview fixture command and registration.
- Modify `native/desktop/psyche-build-tauri/src-tauri/build.rs` — Tauri command manifest.
- Modify `native/desktop/psyche-build-tauri/src-tauri/capabilities/main-runtime-diagnostics.json` — main-webview-only stress permission.
- Create generated allow/deny permission TOML for the stress command.
- Modify root `package.json` — `dev:tauri:diagnostics`.

### Developer panel

- Create `native/desktop/psyche-build-tauri/web/runtime/diagnostics-panel.ts` — deterministic rows/JSON and panel controller.
- Create `__tests__/tauriGpuDiagnosticsPanel.test.ts` — authorization, omission, copy, accessibility, and wiring tests.
- Modify `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts` and `web/runtime.bundle.js` — export the panel controller.
- Modify `native/desktop/psyche-build-tauri/web/index.html` — hidden titlebar action and right-side dialog markup.
- Modify `native/desktop/psyche-build-tauri/web/styles.css` — transform/opacity-only panel transitions and software fallback treatment.
- Modify `native/desktop/psyche-build-tauri/web/main.js` — thin adapters from existing thread/editor/browser/window functions.

### Verification

- Create `docs/GPU-VERIFICATION.md` — exact repository, CI, stress, hardware, and proof-gap matrix.
- Modify `docs/SMOKE.md` — link the diagnostics launch and evidence procedure.

## Task 1: Validate and Close Graphics Evidence Classification

**Files:**
- Verify: `native/desktop/psyche-build-tauri/web/runtime/graphics-diagnostics.ts`
- Verify: `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts`
- Verify: `native/desktop/psyche-build-tauri/web/runtime.bundle.js`
- Test: `__tests__/tauriGraphicsDiagnostics.test.ts`

- [ ] **Step 1: Run the focused graphics suite**

Run:

```bash
pnpm vitest --run __tests__/tauriGraphicsDiagnostics.test.ts
```

Expected: all ANGLE/Direct3D, Metal, Vulkan, OpenGL, SwiftShader, llvmpipe, softpipe, Microsoft Basic Render Driver, masked renderer, strict-context failure, conflicting evidence, and missing-version tests pass.

- [ ] **Step 2: Rebuild and prove the committed runtime bundle is fresh**

Run:

```bash
cp native/desktop/psyche-build-tauri/web/runtime.bundle.js "$TMPDIR/psyche-runtime.bundle.before.js"
pnpm --dir native/desktop/psyche-build-tauri build:web
cmp "$TMPDIR/psyche-runtime.bundle.before.js" native/desktop/psyche-build-tauri/web/runtime.bundle.js
rm "$TMPDIR/psyche-runtime.bundle.before.js"
```

Expected: `cmp` exits `0`; the committed bundle already matches the source.

- [ ] **Step 3: Run type checking for the graphics surface**

Run:

```bash
pnpm typecheck
```

Expected: exit `0`.

- [ ] **Step 4: Request independent specification and code-quality reviews**

Review the branch diff from `b3d8214b` through `bce1ea73`. Fix only high-confidence defects in graphics evidence handling, rerun Steps 1-3, and commit any required correction as:

```bash
git add native/desktop/psyche-build-tauri/web/runtime/graphics-diagnostics.ts \
  native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts \
  native/desktop/psyche-build-tauri/web/runtime.bundle.js \
  __tests__/tauriGraphicsDiagnostics.test.ts
git commit -m "fix: complete graphics evidence classification"
```

Expected: both reviews approve and ordinary WebGL success still never reports `accelerated`.

- [ ] **Step 5: Mark `psyche-z7c.4.2` complete**

Run:

```bash
bd close psyche-z7c.4.2 --reason "Graphics evidence classification, strict probing, startup merge, bundle freshness, tests, and independent reviews passed."
git add .beads/interactions.jsonl
git commit -m "chore: close graphics evidence task"
```

Expected: `bd show psyche-z7c.4.2` reports `CLOSED`.

## Task 2: Build the Pure Bounded Performance Metrics Model

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/runtime/performance-metrics.ts`
- Create: `__tests__/tauriPerformanceMetrics.test.ts`

- [ ] **Step 1: Write failing deterministic frame-summary tests**

Add:

```ts
import {
  FRAME_SAMPLE_LIMIT,
  createPerformanceMetricsCollector,
  summarizeFrames,
} from '../native/desktop/psyche-build-tauri/web/runtime/performance-metrics';

it('summarizes frame samples with nearest-rank p95 and fixed thresholds', () => {
  expect(summarizeFrames([10, 20, 30, 40, 60])).toEqual({
    sampleCount: 5,
    averageMs: 32,
    p95Ms: 60,
    maxMs: 60,
    over16_7: 4,
    over33_4: 2,
    over50: 1,
    estimatedDroppedFrames: 5,
  });
});

it('returns a zero-valued summary for an empty sample set', () => {
  expect(summarizeFrames([])).toEqual({
    sampleCount: 0,
    averageMs: 0,
    p95Ms: 0,
    maxMs: 0,
    over16_7: 0,
    over33_4: 0,
    over50: 0,
    estimatedDroppedFrames: 0,
  });
});
```

- [ ] **Step 2: Run the new suite and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriPerformanceMetrics.test.ts
```

Expected: failure because `performance-metrics.ts` does not exist.

- [ ] **Step 3: Implement the frame ring and summary functions**

Create these public contracts:

```ts
export const FRAME_SAMPLE_LIMIT = 20_000;

export interface FrameSummary {
  sampleCount: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
  over16_7: number;
  over33_4: number;
  over50: number;
  estimatedDroppedFrames: number;
}

export function summarizeFrames(samples: readonly number[]): FrameSummary {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
      maxMs: 0,
      over16_7: 0,
      over33_4: 0,
      over50: 0,
      estimatedDroppedFrames: 0,
    };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    sampleCount: samples.length,
    averageMs: total / samples.length,
    p95Ms: sorted[percentileIndex],
    maxMs: sorted[sorted.length - 1],
    over16_7: samples.filter((sample) => sample > 16.7).length,
    over33_4: samples.filter((sample) => sample > 33.4).length,
    over50: samples.filter((sample) => sample > 50).length,
    estimatedDroppedFrames: samples.reduce(
      (sum, sample) => sum + Math.max(0, Math.round(sample / 16.7) - 1),
      0,
    ),
  };
}
```

Store frame deltas in a circular array with a write index and count; never use an unbounded append-only array.

- [ ] **Step 4: Add failing transport, process, renderer, and retention tests**

Add tests that feed two one-second native transport snapshots and assert:

```ts
expect(snapshot.transport).toMatchObject({
  bytesPerSecond: 4096,
  batchesPerSecond: 4,
  averageBatchBytes: 1024,
  p95BatchBytes: 2048,
  p95BatchIntervalMs: 300,
  queueBytesHighWater: 8192,
  queueDepthHighWater: 6,
  backpressureCount: 3,
  averageAckLatencyMs: 2,
  maxAckLatencyMs: 7,
});
expect(snapshot.renderer).toMatchObject({
  coalescedVisualUpdates: 9,
  webglPanes: 4,
  fallbackPanes: 1,
  contextLosses: 2,
});
expect(snapshot.interactions).toEqual({
  focusToNextPaintMs: 40,
  resizeToNextPaintMs: 72,
});
expect(snapshot.process).toEqual({ rssBytes: 64 * 1024 * 1024 });
expect(snapshot.process).not.toHaveProperty('cpuPercent');
```

Record `FRAME_SAMPLE_LIMIT + 25` deltas and assert the snapshot contains exactly `FRAME_SAMPLE_LIMIT` samples and the oldest 25 were discarded.

- [ ] **Step 5: Implement transport deltas and omission-safe snapshots**

Define:

```ts
export interface RuntimePerformanceSnapshot {
  sampledAt: number;
  frames: FrameSummary;
  longTasks?: { count: number; totalMs: number; maxMs: number };
  transport: {
    bytesPerSecond: number;
    batchesPerSecond: number;
    averageBatchBytes: number;
    p95BatchBytes: number;
    p95BatchIntervalMs: number;
    queueBytesHighWater: number;
    queueDepthHighWater: number;
    blockedProducersHighWater: number;
    backpressureCount: number;
    averageAckLatencyMs?: number;
    maxAckLatencyMs?: number;
  };
  renderer: {
    coalescedVisualUpdates: number;
    webglPanes: number;
    recoveringPanes: number;
    fallbackPanes: number;
    contextLosses: number;
  };
  interactions: {
    focusToNextPaintMs?: number;
    resizeToNextPaintMs?: number;
  };
  process?: { cpuPercent?: number; rssBytes?: number };
}
```

Implement `createPerformanceMetricsCollector()` with `recordFrame(timestamp)`, `recordLongTask(duration)`, `recordInteractionStart(kind, timestamp)`, `recordInteractionPaint(kind, timestamp)`, `mergeNativeSnapshot(input)`, `snapshot()`, and `reset()` methods. Compute rates from monotonic counter deltas divided by elapsed milliseconds. Retain bounded batch-size and batch-interval samples for nearest-rank p95. Omit `process`, `cpuPercent`, `rssBytes`, acknowledgement fields, and interaction fields when source values are unavailable; do not substitute zero.

- [ ] **Step 6: Run the focused suite and commit the pure model**

Run:

```bash
pnpm vitest --run __tests__/tauriPerformanceMetrics.test.ts
pnpm typecheck
```

Expected: both commands exit `0`.

Commit:

```bash
git add native/desktop/psyche-build-tauri/web/runtime/performance-metrics.ts \
  __tests__/tauriPerformanceMetrics.test.ts
git commit -m "feat: add bounded performance metrics model"
```

## Task 3: Wire Frame, Renderer, Transport, and Process Collection

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/runtime/frame-scheduler.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime/terminal-pane-controller.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime/performance-metrics.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime.bundle.js`
- Test: `__tests__/tauriPerformanceMetrics.test.ts`
- Test: `__tests__/tauriTerminalRenderer.test.ts`

- [ ] **Step 1: Write failing lifecycle and polling-cadence tests**

Assert `FrameScheduler.snapshot()` includes `pendingCallbacks` and cumulative `coalescedVisualUpdates`. Assert `rendererSnapshot()` includes cumulative `rendererTransitions` and `contextLosses`. Use a fake interval and fake `invoke` to prove:

```ts
collector.start();
await poll();
clock.advanceBy(999);
expect(invoke).toHaveBeenCalledTimes(2);
clock.advanceBy(1);
await poll();
expect(invoke).toHaveBeenCalledTimes(4);
```

The two calls per poll are exactly `pty_transport_metrics` and `runtime_process_metrics`; no native command is invoked from the rAF callback.

Add a test that records focus at `100 ms` and its next paint at `140 ms`, then resize at `200 ms` and its next paint at `272 ms`; assert the snapshot reports `40 ms` and `72 ms`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPerformanceMetrics.test.ts \
  __tests__/tauriTerminalRenderer.test.ts
```

Expected: failures for missing scheduler/renderer counters and collector lifecycle.

- [ ] **Step 3: Extend existing snapshots without exposing content**

Change the snapshot types to:

```ts
export interface FrameSchedulerSnapshot {
  pendingCallbacks: number;
  coalescedVisualUpdates: number;
}

export interface RendererSnapshot {
  state: RendererState;
  fallbackReason: RendererFallbackReason | null;
  visibility: VisibilityState;
  effectiveVisible: boolean;
  queuedWrites: number;
  syntheticQueuedWrites: number;
  syntheticRetainedBytes: number;
  writeInProgress: boolean;
  rendererTransitions: number;
  contextLosses: number;
}
```

Increment `rendererTransitions` only when renderer state changes. Increment `contextLosses` in `handleWebglContextLoss`. Do not add terminal buffers, strings, byte payloads, or command arguments to any snapshot.

- [ ] **Step 4: Implement one-second native polling and rAF sampling**

Add collector dependencies for `invoke`, `requestFrame`, `cancelFrame`, `setInterval`, `clearInterval`, `now`, `schedulerSnapshot`, and `rendererSnapshots`. `start()` schedules one rAF loop for frame deltas and one 1,000 ms interval for native snapshots. `stop()` cancels both handles and disconnects the optional `PerformanceObserver`.

Use:

```ts
const [transport, process] = await Promise.all([
  invoke('pty_transport_metrics', { threadId: null, thread_id: null }),
  invoke('runtime_process_metrics', {}),
]);
```

Ignore an older poll result when a newer generation has started or the collector has stopped.

- [ ] **Step 5: Export the collector and rebuild the bundle**

Export `createPerformanceMetricsCollector`, `summarizeFrames`, `FRAME_SAMPLE_LIMIT`, and all public snapshot types from `runtime-entry.ts`.

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriPerformanceMetrics.test.ts \
  __tests__/tauriTerminalRenderer.test.ts \
  __tests__/tauriGraphicsDiagnostics.test.ts
pnpm typecheck
```

Expected: all commands exit `0`, and the graphics startup summary remains present in the bundle.

- [ ] **Step 6: Request reviews, commit, and close `.4.3`**

After independent specification and quality reviews approve:

```bash
bd close psyche-z7c.4.3 --reason "Bounded frame, transport, renderer, and process metrics passed focused tests and independent reviews."
git add native/desktop/psyche-build-tauri/web/runtime/frame-scheduler.ts \
  native/desktop/psyche-build-tauri/web/runtime/terminal-pane-controller.ts \
  native/desktop/psyche-build-tauri/web/runtime/performance-metrics.ts \
  native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts \
  native/desktop/psyche-build-tauri/web/runtime.bundle.js \
  __tests__/tauriPerformanceMetrics.test.ts \
  __tests__/tauriTerminalRenderer.test.ts \
  .beads/interactions.jsonl
git commit -m "feat: collect bounded ADE rendering metrics"
```

Expected: `psyche-z7c.4.3` is closed.

## Task 4: Add Native Debug Authorization and Fixed Fixtures

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/runtime_diagnostics.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/build.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/capabilities/main-runtime-diagnostics.json`
- Create: `native/desktop/psyche-build-tauri/src-tauri/permissions/autogenerated/diagnostics_spawn_fixture.toml`

- [ ] **Step 1: Write failing Rust authorization and fixture tests**

Add tests for:

```rust
#[cfg(unix)]
assert_eq!(DiagnosticsFixture::Steady.command_spec().program, "/bin/sh");
#[cfg(windows)]
assert_eq!(
    DiagnosticsFixture::Steady.command_spec().program,
    "powershell.exe"
);
assert!(fixture_start_options("stress-1", DiagnosticsFixture::Burst)
    .unwrap()
    .command
    .is_some());
assert_eq!(
    fixture_start_options("../unsafe", DiagnosticsFixture::Rewrite).unwrap_err(),
    "thread id is unsafe"
);
assert_eq!(
    ensure_stress_authorized(false).unwrap_err(),
    "render diagnostics are not authorized"
);
```

Also serialize each fixture from exactly `"steady"`, `"burst"`, or `"rewrite"` and reject arbitrary strings and unknown fields.

- [ ] **Step 2: Run Rust tests and verify RED**

Run:

```bash
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  runtime_diagnostics --locked
```

Expected: compile failure for missing `DiagnosticsFixture` and fixture builders.

- [ ] **Step 3: Implement fixed platform command specifications**

Add:

```rust
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiagnosticsFixture {
    Steady,
    Burst,
    Rewrite,
}

pub(crate) struct DiagnosticsCommandSpec {
    pub(crate) program: &'static str,
    pub(crate) args: Vec<String>,
}
```

On Unix, select `/bin/sh` with a fixed `-c` script stored in Rust constants. On Windows, select `powershell.exe` with fixed `-NoLogo`, `-NoProfile`, `-NonInteractive`, `-Command` arguments. Each script emits monotonically increasing sequence numbers and deterministic ANSI patterns until the existing `pty_stop` path terminates it. No command, argument, or script fragment comes from the frontend.

- [ ] **Step 4: Expose authorization without exposing environment data**

Add:

```rust
impl RuntimeDiagnosticsState {
    pub(crate) fn ensure_stress_authorized(&self) -> Result<(), String> {
        if self.stress_authorized {
            Ok(())
        } else {
            Err("render diagnostics are not authorized".to_string())
        }
    }
}
```

Keep `PSYCHE_RENDER_DIAGNOSTICS` read only in `from_startup()`. Do not serialize the environment or re-read it per command.

- [ ] **Step 5: Add the trusted Tauri command**

Register:

```rust
#[tauri::command]
async fn diagnostics_spawn_fixture(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, RuntimeDiagnosticsState>,
    thread_id: String,
    fixture: DiagnosticsFixture,
) -> Result<(), String>
```

The command must:

1. call `ensure_trusted_pty_caller(webview.label())`;
2. call `state.ensure_stress_authorized()`;
3. convert only the fixture enum into `StartOptions`;
4. execute the existing `pty_start_blocking` path through `spawn_blocking`;
5. surface join and PTY errors verbatim through the repository-standard `Result`.

- [ ] **Step 6: Register and scope the permission**

Add `diagnostics_spawn_fixture` to `src-tauri/build.rs` and `tauri::generate_handler!`. Generate allow/deny TOML with:

```toml
[[permission]]
identifier = "allow-diagnostics-spawn-fixture"
description = "Enables the diagnostics_spawn_fixture command without any pre-configured scope."
commands.allow = ["diagnostics_spawn_fixture"]

[[permission]]
identifier = "deny-diagnostics-spawn-fixture"
description = "Denies the diagnostics_spawn_fixture command without any pre-configured scope."
commands.deny = ["diagnostics_spawn_fixture"]
```

Add only `allow-diagnostics-spawn-fixture` to `main-runtime-diagnostics.json`. Browser webviews must not receive it.

- [ ] **Step 7: Run Rust and permission tests**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  runtime_diagnostics --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
pnpm vitest --run __tests__/tauriDesktopTabs.test.ts
```

Expected: all commands exit `0`; tests prove production/unauthorized calls reject and browser capabilities remain unchanged.

- [ ] **Step 8: Commit the native stress boundary**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/runtime_diagnostics.rs \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  native/desktop/psyche-build-tauri/src-tauri/build.rs \
  native/desktop/psyche-build-tauri/src-tauri/capabilities/main-runtime-diagnostics.json \
  native/desktop/psyche-build-tauri/src-tauri/permissions/autogenerated/diagnostics_spawn_fixture.toml \
  __tests__/tauriDesktopTabs.test.ts
git commit -m "feat: add authorized rendering fixtures"
```

## Task 5: Add the Deterministic Frontend Stress Harness and Launcher

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/runtime/stress-harness.ts`
- Create: `__tests__/tauriStressHarness.test.ts`
- Create: `scripts/dev-tauri-diagnostics.mjs`
- Create: `__tests__/tauriDiagnosticsLauncher.test.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime.bundle.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing plan and authorization tests**

Add:

```ts
expect(buildStressPlan().map((scenario) => scenario.paneCount))
  .toEqual([1, 6, 12, 24]);
expect(buildStressPlan().every((scenario) =>
  scenario.warmupMs === 10_000 &&
  scenario.measureMs === 30_000 &&
  scenario.restoreMs === 5_000
)).toBe(true);
await expect(runStressPlan({ authorized: false } as StressHarnessDependencies))
  .rejects.toThrow('render diagnostics are not authorized');
```

Add a cancellation test that aborts during warmup and asserts every spawned fixture, editor, browser, timer, frame callback, and visibility change is disposed or restored exactly once.

- [ ] **Step 2: Run the stress suite and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriStressHarness.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Define fixed scenarios and dependency interfaces**

Create:

```ts
export type StressFixture = 'steady' | 'burst' | 'rewrite';
export type StressPhase = 'setup' | 'warmup' | 'measure' | 'restore' | 'cleanup';

export interface StressScenario {
  paneCount: 1 | 6 | 12 | 24;
  warmupMs: 10_000;
  measureMs: 30_000;
  restoreMs: 5_000;
  fixtures: readonly StressFixture[];
}

export interface StressProgress {
  scenarioIndex: number;
  paneCount: StressScenario['paneCount'];
  phase: StressPhase;
  elapsedMs: number;
  phaseDurationMs: number;
}

export interface StressScenarioResult {
  paneCount: StressScenario['paneCount'];
  startedAt: number;
  finishedAt: number;
  contextLossSupported: boolean;
  metrics: unknown;
}

export interface StressRunResult {
  startedAt: number;
  finishedAt: number;
  scenarios: StressScenarioResult[];
}

export interface StressHarnessDependencies {
  authorized: boolean;
  createTerminal(index: number, fixture: StressFixture): Promise<{ id: string; dispose(): Promise<void> }>;
  createEditor(): Promise<{ id: string; dispose(): Promise<void> }>;
  createBrowser(): Promise<{ id: string; dispose(): Promise<void> }>;
  focus(id: string): Promise<void>;
  resize(step: number): Promise<void>;
  setVisible(id: string, visible: boolean): Promise<void>;
  cycleWindow(): Promise<void>;
  loseGraphicsContext(): Promise<boolean>;
  resetMetrics(): void;
  snapshotMetrics(): unknown;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  onProgress(progress: StressProgress): void;
}
```

`buildStressPlan()` returns frozen scenarios. Fixture assignment repeats the fixed `steady`, `burst`, `rewrite` sequence and never accepts user input.

- [ ] **Step 4: Implement phase execution and cleanup**

`runStressPlan()` must:

1. reject before setup when unauthorized;
2. create the requested terminal count plus one generated editor and one local diagnostics browser;
3. focus the next resource every 250 ms during warmup and measurement;
4. apply deterministic split/sidebar resize steps from the scenario index;
5. hide the second half of terminal panes, then restore them;
6. call `cycleWindow()` once in the restore phase;
7. call `loseGraphicsContext()` and record whether it was supported;
8. snapshot metrics before and after measurement;
9. unwind all resources in reverse order in `finally`;
10. preserve the first operational error and attach cleanup errors as an `AggregateError`.

- [ ] **Step 5: Write failing launcher tests**

Test an exported `launchDiagnostics()` with injected `spawn`, `processApi`, `platform`, and `env`. Assert:

```ts
expect(spawn).toHaveBeenCalledWith('pnpm', ['dev:tauri'], {
  env: expect.objectContaining({ PSYCHE_RENDER_DIAGNOSTICS: '1' }),
  shell: true,
  stdio: 'inherit',
});
```

for Windows, `shell: false` elsewhere, exit code propagation for `0` and nonzero codes, and signal propagation through `processApi.kill(processApi.pid, signal)`.

- [ ] **Step 6: Implement the cross-platform launcher**

Create `scripts/dev-tauri-diagnostics.mjs` with:

```js
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function launchDiagnostics(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const processApi = options.processApi || process;
  const platform = options.platform || processApi.platform;
  const env = options.env || processApi.env;
  const child = spawnImpl('pnpm', ['dev:tauri'], {
    env: { ...env, PSYCHE_RENDER_DIAGNOSTICS: '1' },
    shell: platform === 'win32',
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) processApi.kill(processApi.pid, signal);
    else processApi.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchDiagnostics();
}
```

Add `"dev:tauri:diagnostics": "node scripts/dev-tauri-diagnostics.mjs"` to root `package.json`.

- [ ] **Step 7: Export, build, verify, review, and commit**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriStressHarness.test.ts \
  __tests__/tauriDiagnosticsLauncher.test.ts \
  __tests__/tauriPerformanceMetrics.test.ts \
  __tests__/tauriGraphicsDiagnostics.test.ts
pnpm typecheck
```

After independent specification and quality reviews approve:

```bash
bd close psyche-z7c.4.4 --reason "Authorized fixed fixtures, deterministic scenarios, launcher, cancellation cleanup, tests, and reviews passed."
git add native/desktop/psyche-build-tauri/web/runtime/stress-harness.ts \
  native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts \
  native/desktop/psyche-build-tauri/web/runtime.bundle.js \
  scripts/dev-tauri-diagnostics.mjs \
  __tests__/tauriStressHarness.test.ts \
  __tests__/tauriDiagnosticsLauncher.test.ts \
  package.json \
  .beads/interactions.jsonl
git commit -m "feat: add GPU rendering stress harness"
```

Expected: `.4.4` is closed.

## Task 6: Add the In-App Developer GPU Diagnostics Surface

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/runtime/diagnostics-panel.ts`
- Create: `__tests__/tauriGpuDiagnosticsPanel.test.ts`
- Modify: `native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts`
- Modify: `native/desktop/psyche-build-tauri/web/index.html`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `native/desktop/psyche-build-tauri/web/runtime.bundle.js`

- [ ] **Step 1: Write failing pure row and JSON tests**

Add:

```ts
const samplePerformance = {
  sampledAt: 10_000,
  frames: {
    sampleCount: 5,
    averageMs: 16,
    p95Ms: 20,
    maxMs: 20,
    over16_7: 2,
    over33_4: 0,
    over50: 0,
    estimatedDroppedFrames: 0,
  },
  transport: {
    bytesPerSecond: 4096,
    batchesPerSecond: 4,
    averageBatchBytes: 1024,
    p95BatchBytes: 2048,
    p95BatchIntervalMs: 300,
    queueBytesHighWater: 8192,
    queueDepthHighWater: 6,
    blockedProducersHighWater: 1,
    backpressureCount: 3,
  },
  renderer: {
    coalescedVisualUpdates: 9,
    webglPanes: 4,
    recoveringPanes: 0,
    fallbackPanes: 1,
    contextLosses: 2,
  },
  interactions: {
    focusToNextPaintMs: 40,
    resizeToNextPaintMs: 72,
  },
};

expect(buildDiagnosticsRows({
  graphics: {
    os: 'macos',
    arch: 'aarch64',
    engine: 'WKWebView',
    acceleration: 'software',
    fallbackReason: 'software_renderer_detected',
    unsupportedFields: ['adapter', 'backend'],
  },
  performance: samplePerformance,
})).toEqual(expect.arrayContaining([
  { key: 'acceleration', label: 'Acceleration', value: 'software', emphasis: 'warning' },
  { key: 'fallbackReason', label: 'Fallback', value: 'software_renderer_detected' },
]));
expect(rows.some((row) => row.key === 'adapter')).toBe(false);
expect(stableDiagnosticsJson(report)).toBe(stableDiagnosticsJson(report));
```

Add controller tests proving the titlebar toggle stays hidden when `debugBuild` is false, scenario controls stay hidden when `stressAuthorized` is false, copy errors reach the alert/status element, and progress text uses `aria-live`.

- [ ] **Step 2: Run panel tests and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriGpuDiagnosticsPanel.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement deterministic rendering helpers**

Export:

```ts
export interface DiagnosticsPanelReport {
  native: {
    os: string;
    arch: string;
    engine: string;
    engineVersion?: string;
    debugBuild: boolean;
    stressAuthorized: boolean;
  };
  graphics: RuntimeGraphicsReport;
  performance: RuntimePerformanceSnapshot;
  stress?: StressRunResult;
}

export interface DiagnosticsRow {
  key: string;
  label: string;
  value: string;
  emphasis?: 'warning';
}

export interface DiagnosticsPanelOptions {
  toggle: HTMLElement;
  overlay: HTMLElement;
  drawer: HTMLElement;
  rows: HTMLElement;
  progress: HTMLElement;
  alert: HTMLElement;
  copyButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  scenarioButtons: readonly HTMLButtonElement[];
  loadReport(): Promise<DiagnosticsPanelReport>;
  runScenario(paneCount: 1 | 6 | 12 | 24, signal: AbortSignal): Promise<StressRunResult>;
  copyText(text: string): Promise<void>;
  beginTransition(element: HTMLElement): void;
}

export interface DiagnosticsPanelController {
  initialize(): Promise<void>;
  open(): Promise<void>;
  close(): void;
  cancel(): void;
  dispose(): void;
}

export function stableDiagnosticsJson(report: DiagnosticsPanelReport): string;
export function buildDiagnosticsRows(report: DiagnosticsPanelReport): DiagnosticsRow[];
export function createDiagnosticsPanelController(options: DiagnosticsPanelOptions): DiagnosticsPanelController;
```

Order JSON keys explicitly as `native`, `graphics`, `performance`, `stress`. Order rows by the same fixed schema, but emit a row only when its value is present. Give `acceleration: "software"` warning emphasis.

- [ ] **Step 4: Add hidden accessible markup**

Add a hidden `gpu-diagnostics-toggle` beside `agent-control-toggle`, and a hidden overlay/dialog containing:

- heading `GPU diagnostics`;
- close and copy buttons;
- a definition-list host for rows;
- scenario buttons for `1`, `6`, `12`, and `24`;
- cancel button;
- progress element with `role="status"` and `aria-live="polite"`;
- error element with `role="alert"`.

The initial HTML must not expose enabled stress controls before runtime authorization.

- [ ] **Step 5: Add compositor-safe styles**

The overlay fades with `opacity`; the right-side drawer moves only with `transform: translateX(...)`. Use `.is-transitioning` for `will-change`. Do not animate width, height, inset, left, right, top, bottom, margin, or padding. Add a visible warning treatment for software fallback without changing global theme tokens.

- [ ] **Step 6: Wire thin `main.js` adapters**

Initialize one performance collector and one panel controller after the existing Tauri/runtime guards. Adapt existing operations:

- terminals: call `createThread()` with launch metadata that uses `diagnostics_spawn_fixture`;
- editor: open a generated in-memory document through the existing editor surface;
- browser: create/focus the existing local browser pane on the app’s local diagnostics URL;
- focus: call `focusThread()`;
- resize: mutate the existing pane layout through current layout helpers and render once;
- visibility: call each terminal controller’s `setVisibility()`;
- window cycle: call `currentWindow.minimize()`, wait for restoration, then call `currentWindow.unminimize()` or `show()` according to available Tauri API;
- context loss: request `WEBGL_lose_context` only from a current xterm WebGL context when exposed, otherwise return `false`;
- cleanup: call existing close functions and restore the prior layout/focus.

Immediately before each deterministic stress focus or resize operation, call `recordInteractionStart`. On the next animation frame after the operation lands, call `recordInteractionPaint`. This is the only source for the verification matrix’s focus/resize input-to-next-paint values.

Do not place scenario timing, fixture selection, metrics calculations, or JSON formatting in `main.js`.

- [ ] **Step 7: Add CSP/capability and transition assertions**

Update tests to assert:

```ts
expect(indexHtml).toContain('id="gpu-diagnostics-toggle"');
expect(mainJs).toContain('createDiagnosticsPanelController');
expect(stylesCss).toMatch(/\.gpu-diagnostics-drawer[\s\S]*transform:/);
expect(stylesCss).not.toMatch(/\.gpu-diagnostics-drawer[\s\S]*transition:[^;]*(width|height|left|right)/);
```

Assert `tauri.conf.json` CSP is byte-for-byte unchanged and `.4.5` adds no capability or permission entry.

- [ ] **Step 8: Build, run the full desktop surface set, review, and commit**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriGpuDiagnosticsPanel.test.ts \
  __tests__/tauriGraphicsDiagnostics.test.ts \
  __tests__/tauriPerformanceMetrics.test.ts \
  __tests__/tauriStressHarness.test.ts \
  __tests__/tauriCompositorCss.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
pnpm typecheck
```

After independent specification and quality reviews approve:

```bash
bd close psyche-z7c.4.5 --reason "Authorized diagnostics panel, deterministic copy, accessible progress, omission rules, CSP/capability checks, tests, and reviews passed."
git add native/desktop/psyche-build-tauri/web/runtime/diagnostics-panel.ts \
  native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/styles.css \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/runtime.bundle.js \
  __tests__/tauriGpuDiagnosticsPanel.test.ts \
  __tests__/tauriCompositorCss.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  .beads/interactions.jsonl
git commit -m "feat: expose developer GPU diagnostics"
```

Expected: `.4.5` is closed.

## Task 7: Document and Execute the Verification Matrix

**Files:**
- Create: `docs/GPU-VERIFICATION.md`
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: Write the evidence matrix**

Document rows for macOS, Windows, and Linux with columns:

```text
Platform | Machine/driver | Startup graphics JSON | 1 pane | 6 panes |
12 panes | 24 panes | Context loss | Minimize/restore | CI | Physical status
```

For each physical run require:

1. `pnpm dev:tauri:diagnostics`;
2. copied startup JSON;
3. all four stress result JSON objects;
4. six-pane `p95Ms <= 33.4`;
5. focus/resize input-to-next-paint `< 100`;
6. CPU/RSS, queue, IPC, throughput, frame, renderer, and fallback fields;
7. separate machine, GPU, driver, and virtualization metadata;
8. explicit `accelerated`, `software`, `unknown`, `unavailable`, or `proof gap`.

State that hosted CI never satisfies physical acceleration evidence.

- [ ] **Step 2: Link the workflow from smoke documentation**

Add a `GPU diagnostics and stress smoke` section to `docs/SMOKE.md` linking `docs/GPU-VERIFICATION.md`, the authorized launch command, and the rule that unsupported physical platforms remain open proof gaps.

- [ ] **Step 3: Run deterministic repository verification**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
git diff --check
```

Expected: every command exits `0`. Record exact test totals and elapsed times in `docs/GPU-VERIFICATION.md`.

- [ ] **Step 4: Audit security boundaries**

Run:

```bash
git diff origin/main...HEAD -- \
  native/desktop/psyche-build-tauri/src-tauri/capabilities \
  native/desktop/psyche-build-tauri/src-tauri/permissions \
  native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json
```

Expected: only the debug fixture command is added to the main-webview diagnostics capability; CSP is unchanged; browser webviews receive no diagnostics or stress permission.

- [ ] **Step 5: Capture available physical macOS evidence**

Launch:

```bash
pnpm dev:tauri:diagnostics
```

Use the panel to copy startup JSON and run 1/6/12/24 scenarios. Record actual results, context-loss support, minimize/restore behavior, machine model, macOS version, GPU model, and driver/runtime version. If the machine or environment cannot produce trustworthy non-virtualized evidence, record a macOS proof gap instead of an acceleration claim.

- [ ] **Step 6: Record Windows and Linux physical gaps honestly**

Use hosted CI only for build/test status. Unless non-virtualized hardware reports are supplied during this task, mark Windows and Linux physical rows `proof gap` and leave cross-platform physical acceleration evidence open.

- [ ] **Step 7: Request final cumulative reviews**

Request independent review against:

- the approved design;
- every child acceptance criterion;
- the full branch diff;
- CSP/capability isolation;
- deterministic cleanup and bounded retention;
- verification claims versus recorded evidence.

Fix all high-confidence findings, rerun the smallest affected suite, then rerun Step 3.

- [ ] **Step 8: Commit verification documentation and close `.4.6`**

```bash
bd close psyche-z7c.4.6 --reason "Repository gates, desktop CI plan, available physical evidence, security audit, final reviews, and explicit proof gaps are recorded."
git add docs/GPU-VERIFICATION.md docs/SMOKE.md \
  native/desktop/psyche-build-tauri/web/runtime.bundle.js \
  .beads/interactions.jsonl
git commit -m "docs: record GPU acceleration verification"
```

Expected: `.4.6` is closed.

## Task 8: Push, Open the PR, Drive CI, and Close the Parent

**Files:**
- Potentially modify files named by review or CI failures only.
- Update: `.beads/interactions.jsonl` through `bd`.

- [ ] **Step 1: Rebase or merge the current remote base without rewriting task commits**

Run:

```bash
git fetch origin
git merge --no-edit origin/main
```

Expected: merge succeeds without losing the graphics commits or unrelated current-main work. Resolve conflicts by preserving both current-main behavior and this slice’s evidence/authorization boundaries.

- [ ] **Step 2: Re-run the cumulative verification gate**

Repeat Task 7 Step 3 after the base integration.

Expected: every command exits `0`.

- [ ] **Step 3: Push the feature branch and open a PR**

Run:

```bash
git push -u origin feat/graphics-evidence-diagnostics
{
  printf '%s\n\n' \
    'Closes psyche-z7c.4' \
    'Completes graphics evidence classification, bounded runtime metrics, the debug-authorized fixed stress harness, the developer diagnostics panel, and the verification matrix.' \
    '## Commits'
  git log --format='- `%h` %s' origin/main..HEAD
  printf '%s\n' \
    '' \
    '## Verification' \
    'Exact local, Rust, CI, physical evidence, and proof-gap results are recorded in `docs/GPU-VERIFICATION.md`.' \
    '' \
    '## Security boundaries' \
    '- CSP is unchanged.' \
    '- Runtime and stress commands remain restricted to the main webview.' \
    '- Stress fixtures accept no arbitrary command or argument input.'
} > /tmp/psyche-z7c-4-pr.md
gh pr create \
  --base main \
  --head feat/graphics-evidence-diagnostics \
  --title "Complete GPU runtime diagnostics and stress mode" \
  --body-file /tmp/psyche-z7c-4-pr.md
rm /tmp/psyche-z7c-4-pr.md
```

The PR body must list child tasks, commit SHAs, exact verification commands/results, physical macOS metrics or proof gap, Windows/Linux proof gaps, and the no-CSP/no-browser-permission guarantees.

- [ ] **Step 4: Drive desktop CI to terminal success**

Watch:

```bash
gh pr checks --watch
```

Expected terminal success for `quality`, `desktop-web`, `rust-test`, and the macOS/Windows/Linux `desktop-check` matrix plus the aggregate required-check job. Fix real failures, commit, push, and rerun focused local checks before watching again.

- [ ] **Step 5: Resolve review feedback**

Fetch unresolved review threads, apply valid fixes, run affected tests, commit, push, and resolve each addressed thread. Do not dismiss failures or comments without evidence.

- [ ] **Step 6: Merge through the repository workflow**

When approvals and required checks are green:

```bash
gh pr merge --merge --delete-branch
```

Expected: the PR reports `MERGED`.

- [ ] **Step 7: Close the parent task with an evidence-rich reason**

Run:

```bash
bd close psyche-z7c.4 --reason "Children .4.1-.4.6 completed; PR merged with terminal desktop CI, independent reviews, bounded metrics, debug-authorized fixed stress fixtures, diagnostics UI, available physical evidence, and explicit unavailable-platform proof gaps."
bd show psyche-z7c.4
```

Expected: the parent reports `CLOSED`, and every child is closed.

- [ ] **Step 8: Produce the final completion report**

Report:

- merged PR URL and merge commit;
- child task closure states;
- implementation commit SHAs and changed-file groups;
- exact repository/Rust/CI results;
- 1/6/12/24 physical metrics actually captured;
- acceleration classification actually observed;
- CSP/capability audit result;
- unresolved physical proof gaps.
