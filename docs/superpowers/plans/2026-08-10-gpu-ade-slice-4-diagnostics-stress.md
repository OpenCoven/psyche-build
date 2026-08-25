# GPU ADE Slice 4: Acceleration Diagnostics and Stress Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report hardware acceleration from reliable runtime evidence and provide repeatable 1, 6, 12, and 24-pane performance and fallback verification.

**Architecture:** Merge a native platform/WebView/process snapshot with a typed browser graphics probe, terminal renderer snapshots, PTY metrics, and frame metrics. Keep the always-on startup probe cheap and local; compile the process-spawning stress harness behind a debug-build plus environment authorization gate.

**Tech Stack:** Rust/Tauri, `tauri::webview_version`, sysinfo, TypeScript, WebGL/WebGPU APIs, PerformanceObserver, requestAnimationFrame, xterm.js, Vitest.

---

Prerequisite: Slices 1–3 are green.

## File map

- Create `src-tauri/src/runtime_diagnostics.rs` — native engine/platform/process data, authorization, metrics snapshot, commands, tests.
- Modify `Cargo.toml` and `lib.rs` — sysinfo dependency and command registration.
- Create `web/runtime/graphics-diagnostics.ts` — strict probe and evidence classifier.
- Create `web/runtime/performance-metrics.ts` — frame percentiles, long frames, throughput, IPC, queue, CPU/memory merge.
- Create `web/runtime/stress-harness.ts` — deterministic four-size scenarios and fixed native fixtures.
- Create `scripts/dev-tauri-diagnostics.mjs` — cross-platform environment launcher.
- Modify `runtime-entry.ts`, generated bundle, `main.js`, `index.html`, and `styles.css` — startup log and developer diagnostics panel.
- Create `__tests__/tauriGraphicsDiagnostics.test.ts`, `tauriPerformanceMetrics.test.ts`, and `tauriStressHarness.test.ts`.
- Create `docs/GPU-VERIFICATION.md` — exact three-platform evidence procedure and acceptance table.

### Task 1: Add native runtime and process diagnostics

**Files:**
- Create: `src-tauri/src/runtime_diagnostics.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

- [x] **Step 1: Write failing native diagnostics tests**

```rust
#[test]
fn omits_unavailable_engine_version_and_metrics() {
    let report = NativeRuntimeReport::from_parts(
        "linux", "x86_64", "WebKitGTK", None, None, false,
    );
    let json = serde_json::to_value(report).unwrap();
    assert!(json.get("webviewVersion").is_none());
    assert!(json.get("process").is_none());
}

#[test]
fn production_never_authorizes_the_stress_harness() {
    assert!(!stress_authorized_for(false, Some("1")));
    assert!(stress_authorized_for(true, Some("1")));
    assert!(!stress_authorized_for(true, Some("0")));
}
```

Also test bounded CPU/memory sampling, no environment-map serialization, and stable camelCase JSON.

- [x] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml runtime_diagnostics --locked`

Expected: compile failure because the module is absent.

- [x] **Step 3: Implement the native report**

Use `tauri::webview_version().ok()` and the Slice 1 platform engine identity. Add target-neutral `sysinfo` with only the current process refreshed at a controlled cadence. Serialize optional fields with `skip_serializing_if`.

```rust
#[tauri::command]
fn runtime_diagnostics(state: State<RuntimeDiagnosticsState>) -> NativeRuntimeReport;

#[tauri::command]
fn runtime_process_metrics(state: State<RuntimeDiagnosticsState>) -> Option<ProcessMetrics>;
```

The report contains OS, architecture, engine, optional version, debug-build flag, stress authorization, and optional CPU/RSS. It never claims graphics acceleration; that requires the frontend probe.

- [x] **Step 4: Verify GREEN and commit**

Run Rust fmt/test/check, then commit as `Add native runtime diagnostics`.

### Task 2: Classify graphics evidence without guessing

**Files:**
- Create: `web/runtime/graphics-diagnostics.ts`
- Create: `__tests__/tauriGraphicsDiagnostics.test.ts`
- Modify: `web/runtime/runtime-entry.ts`

- [ ] **Step 1: Write failing classifier tests**

Cover hardware ANGLE/D3D, Metal, Vulkan, OpenGL, SwiftShader, llvmpipe, Microsoft Basic Render Driver, masked renderer, failed strict context, conflicting evidence, and missing engine version.

```ts
expect(classifyGraphicsEvidence({ strictWebgl: true, renderer: 'ANGLE (Apple, Apple M3, Metal)' }))
  .toMatchObject({ acceleration: 'accelerated', backend: 'Metal', adapter: 'Apple M3' });
expect(classifyGraphicsEvidence({ strictWebgl: true, renderer: 'ANGLE (Google, Vulkan 1.3 SwiftShader)' }))
  .toMatchObject({ acceleration: 'software', backend: 'Vulkan' });
expect(classifyGraphicsEvidence({ strictWebgl: true }))
  .toMatchObject({ acceleration: 'unknown' });
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriGraphicsDiagnostics.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement strict probing and classification**

Attempt WebGPU first when available and request adapter information only through supported APIs. Create WebGL2 then WebGL with `{ failIfMajorPerformanceCaveat: true, powerPreference: 'high-performance' }`. Request `WEBGL_debug_renderer_info`; if masked, omit adapter/backend and report the field in `unsupportedFields`.

Use a versioned, case-insensitive software-marker list. `accelerated` requires a strict context or WebGPU adapter plus non-software renderer evidence. An ordinary context alone is `unknown`. If neither usable API exists, return `unavailable`. Never derive adapter/backend from OS or user agent.

- [ ] **Step 4: Merge native and frontend reports**

Expose:

```ts
export interface RuntimeGraphicsReport {
  os: string;
  arch: string;
  engine: string;
  engineVersion?: string;
  acceleration: 'accelerated' | 'software' | 'unknown' | 'unavailable';
  backend?: 'Metal' | 'Direct3D' | 'Vulkan' | 'OpenGL';
  adapter?: string;
  supportingProbe?: string;
  fallbackReason?: string;
  unsupportedFields: string[];
}
```

Log one structured `[psyche:graphics]` summary after startup probing. Keep unsupported fields absent from the primary field set.

- [ ] **Step 5: Verify GREEN and commit**

Run focused graphics tests, build the runtime bundle, run bundle freshness, and commit as `Report runtime graphics acceleration`.

### Task 3: Add frame, throughput, IPC, and resource metrics

**Files:**
- Create: `web/runtime/performance-metrics.ts`
- Create: `__tests__/tauriPerformanceMetrics.test.ts`
- Modify: `web/runtime/runtime-entry.ts`, `terminal-pane-controller.ts`, `frame-scheduler.ts`

- [ ] **Step 1: Write failing deterministic statistics tests**

```ts
expect(summarizeFrames([10, 20, 30, 40, 60])).toEqual({
  averageMs: 32,
  p95Ms: 60,
  maxMs: 60,
  over16_7: 4,
  over33_4: 2,
  over50: 1,
  estimatedDroppedFrames: 5,
});
```

Also test empty samples, nearest-rank p95, IPC batch sizes/frequency, bytes per second, queue high-water, coalesced visual updates, ack latency, CPU/RSS omission, and bounded sample retention.

- [ ] **Step 2: Run and verify RED**

Expected: module-not-found failure.

- [ ] **Step 3: Implement bounded collectors**

Sample rAF deltas into a fixed 20,000-entry ring and report average, p95, and maximum frame time. Use `PerformanceObserver` for `longtask` only when supported. Count estimated dropped frames as `max(0, round(delta / 16.7) - 1)`. Merge PTY/native snapshots, including process CPU and resident memory, at one-second cadence; do not poll per frame. Renderer/controller/scheduler metrics enter through counters, not terminal contents.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and commit as `Collect bounded ADE rendering metrics`.

### Task 4: Add the debug-authorized stress harness

**Files:**
- Create: `web/runtime/stress-harness.ts`
- Create: `__tests__/tauriStressHarness.test.ts`
- Create: `scripts/dev-tauri-diagnostics.mjs`
- Modify: root `package.json`
- Modify: `src-tauri/src/runtime_diagnostics.rs`, `lib.rs`, desktop `package.json`

- [ ] **Step 1: Write failing scenario-state tests**

Assert scenario order `[1, 6, 12, 24]`, deterministic focus/resize steps, editor/browser adjacency, minimize/restore, hidden panes, context loss, cancellation cleanup, and rejection when authorization is false.

```ts
expect(buildStressPlan().map((scenario) => scenario.paneCount)).toEqual([1, 6, 12, 24]);
await expect(runStressPlan({ authorized: false } as HarnessDependencies))
  .rejects.toThrow('render diagnostics are not authorized');
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriStressHarness.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement fixed native stress fixtures**

Add a debug-only `diagnostics_spawn_fixture(thread_id, fixture)` command. Accept only the enum `steady`, `burst`, or `rewrite`; never accept a command string. Select a platform-native executable/arguments in Rust. Each fixture emits sequence numbers and ANSI patterns until stopped. Reject the command unless both `cfg!(debug_assertions)` and startup `PSYCHE_RENDER_DIAGNOSTICS=1` are true.

- [ ] **Step 4: Implement the four scenarios**

Each scenario has a 10-second warmup, 30-second measured interval, and 5-second restore/context-loss interval. It creates the requested terminals, a generated large editor document, and a local diagnostic browser page; cycles focus every 250 ms; schedules deterministic split/sidebar geometry every frame; hides half the panes; minimizes/restores through a validated native debug command; triggers `WEBGL_lose_context` when supported; then disposes everything.

Create `scripts/dev-tauri-diagnostics.mjs` with Node's `spawn` and an explicit environment so the launcher works on every desktop OS:

```js
import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['dev:tauri'], {
  env: { ...process.env, PSYCHE_RENDER_DIAGNOSTICS: '1' },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
```

Expose it from the root package:

```json
"dev:tauri:diagnostics": "node scripts/dev-tauri-diagnostics.mjs"
```

- [ ] **Step 5: Verify GREEN and commit**

Run stress-harness tests, a launcher test that asserts the child environment and exit propagation, Rust authorization tests, build the bundle, and commit as `Add GPU rendering stress harness`.

### Task 5: Add the in-app developer diagnostics surface

**Files:**
- Modify: `web/index.html`, `web/styles.css`, `web/main.js`
- Test: `__tests__/tauriGraphicsDiagnostics.test.ts`, `tauriStressHarness.test.ts`

- [ ] **Step 1: Add failing markup/wiring tests**

Assert the panel is absent/hidden without authorization, reports acceleration/engine/backend/adapter/fallback with omitted unsupported rows, exposes scenario controls only when authorized, supports copy JSON, and has accessible progress/status text.

- [ ] **Step 2: Run and verify RED**

Expected: missing diagnostics surface assertions fail.

- [ ] **Step 3: Implement the surface**

Add a development-only titlebar action and right-side diagnostics panel. Render rows from present object keys rather than placeholder text. Show software fallback prominently. Include frame/throughput/IPC/queue/CPU/RSS summaries, scenario progress, cancellation, and copy deterministic JSON. Keep graphics startup logging active even when the panel is unavailable.

Use only transform/opacity transitions and the Slice 3 transition helper. Do not change CSP or capabilities.

- [ ] **Step 4: Verify GREEN and commit**

Run graphics, performance, stress, compositor CSS, CSP, and bundle tests. Commit as `Expose developer GPU diagnostics`.

### Task 6: Document and execute the three-platform verification matrix

**Files:**
- Create: `docs/GPU-VERIFICATION.md`
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: Write the exact evidence procedure**

Document for each OS:

1. build and launch the debug desktop app with `PSYCHE_RENDER_DIAGNOSTICS=1`;
2. copy the startup graphics JSON;
3. require `acceleration: "accelerated"` for the hardware-acceleration claim;
4. run 1/6/12/24 scenarios;
5. force context loss;
6. minimize/background/restore;
7. copy final JSON and record machine/driver metadata separately;
8. verify CSP/capabilities diff is not weaker.

The six-pane acceptance row requires p95 frame time ≤33.4 ms and focus/resize input-to-next-paint <100 ms on supported non-virtualized hardware.

- [ ] **Step 2: Run deterministic repository verification**

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

- [ ] **Step 3: Run platform CI**

Require terminal success from macOS, Windows, and Linux desktop matrix jobs. CI proves build/tests and correct fallback reporting; it does not substitute for physical GPU evidence.

- [ ] **Step 4: Capture real runtime reports**

Run the documented matrix on non-virtualized macOS, Windows, and Linux machines. Record actual `accelerated`, `software`, `unknown`, or `unavailable` results. Do not call hardware acceleration confirmed for an OS until its report says `accelerated`.

- [ ] **Step 5: Final acceptance audit**

Check every acceptance criterion against deterministic test output plus the three runtime reports. If Windows/Linux hardware is unavailable, report those rows as explicit proof gaps and leave the cross-platform acceleration acceptance open rather than guessing.

- [ ] **Step 6: Commit verification documentation and any generated bundle changes**

```bash
git add docs/GPU-VERIFICATION.md docs/SMOKE.md native/desktop/psyche-build-tauri/web/runtime.bundle.js
git commit -m "Document GPU acceleration verification"
```
