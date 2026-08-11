# GPU-Accelerated Multiplatform ADE Design

## Problem

Psyche Build's desktop ADE currently runs from a macOS-named Tauri application. Its terminal panes already attempt to load xterm's WebGL addon, but PTY reads emit one Tauri event per native read, frontend writes happen immediately per event, context loss only disposes the addon, and acceleration failure is silent. The desktop crate also assumes macOS in its window configuration, default shell, packaging, CI, and source layout.

Under multiple continuously streaming panes, this architecture can turn PTY read frequency into IPC and render frequency. It provides no bounded end-to-end flow control and no reliable evidence about the WebView engine, graphics backend, GPU adapter, software fallback, frame timing, or resource pressure.

Psyche needs a genuinely runnable macOS, Windows, and Linux desktop target that keeps the platform WebView compositor, makes terminal delivery bounded and frame-aware, recovers safely from WebGL loss, suspends expensive work outside visible panes, and reports acceleration from runtime evidence rather than assumption.

## Goals

- Build and run the desktop ADE locally on macOS, Windows, and Linux.
- Prefer WKWebView, WebView2, and WebKitGTK hardware compositing without adding a custom renderer.
- Report acceleration, WebView engine/version, graphics backend, GPU adapter, and software fallback only when runtime evidence supports each value.
- Batch and bound PTY output from the native reader through xterm consumption without discarding or reordering process bytes.
- Limit pane resize, fit, bounds, and visible output work to one scheduled operation per animation frame.
- Give every terminal pane an independent terminal, renderer, visibility, queue, and disposal lifecycle.
- Recover a lost WebGL context once, then remain stable on xterm's supported fallback renderer.
- Suspend fitting and painting for hidden, collapsed, off-screen, backgrounded, and minimized panes.
- Virtualize large terminal histories and long application collections.
- Provide a developer diagnostics mode for 1, 6, 12, and 24 active streaming terminals and mixed editor/browser workloads.
- Preserve the current CSP, Tauri capability boundary, and local-only security posture.

## Non-Goals

- Building a custom terminal or application renderer.
- Replacing xterm, CodeMirror, or the platform WebView.
- Producing signed or distributable Windows and Linux release artifacts.
- Expanding the existing signed/notarized macOS release workflow to other platforms.
- Guaranteeing that virtual machines, remote desktops, CI runners, or unsupported drivers provide hardware acceleration.
- Persisting full terminal transcripts or introducing an unbounded replay buffer.
- Weakening CSP, enabling remote debugging in production, or adding broad Tauri permissions.
- Implementing a Windows transport for Coven's Unix-socket-only local session discovery. That integration reports unavailable on unsupported transports while the ADE, PTYs, files, Git, editor, and browser remain functional.

## Delivery Slices

The work is delivered as four independently testable slices. Each slice must pass its focused tests and leave the application runnable before the next begins.

1. Cross-platform Tauri runtime.
2. Bounded PTY batching and backpressure.
3. Per-pane xterm/WebGL lifecycle and frame scheduling.
4. Runtime acceleration diagnostics and the 1/6/12/24-pane stress mode.

## Slice 1: Cross-Platform Tauri Runtime

### Desktop source layout

Move `native/macos/psyche-build-tauri` to `native/desktop/psyche-build-tauri`. Update root scripts, source-contract tests, CI, macOS release paths, and documentation as one mechanical migration. The iOS tree and the legacy `native/macos/comux-tauri` prototype are unaffected.

Use a portable base `tauri.conf.json` with opaque, decorated window defaults. Platform configuration overlays restore only supported presentation details:

- macOS uses WKWebView, overlay title-bar presentation, transparent background, and optional vibrancy.
- Windows uses WebView2 with a normal opaque decorated window.
- Linux uses WebKitGTK with a normal opaque decorated window.

Generate Windows and Linux development icons from the existing source icon. Do not add signing, installer publication, or release upload jobs.

### Rust platform boundary

Add a small `platform` module with a shared interface for:

- platform and architecture identity;
- default interactive shell and arguments;
- PATH augmentation;
- stable working-directory preparation;
- optional window effects;
- WebView engine identity/version when the native runtime exposes them reliably;
- process CPU and memory sampling used by diagnostics.

Implement the interface with `cfg(target_os)` modules. Unix file-descriptor validation remains in the macOS/Linux implementation. Windows canonicalizes the project root and requested working directory immediately before spawn, rejects paths outside the project or verified worktree boundary, and passes the canonical path to ConPTY through `portable-pty`.

Shell defaults are platform-native:

- macOS: `$SHELL`, then `/bin/zsh`.
- Linux: `$SHELL`, then `/bin/sh`.
- Windows: `PSModulePath`-compatible PowerShell when available, then `COMSPEC`.

Environment construction uses `std::env::split_paths` and `join_paths`; it must not hard-code Unix separators on Windows. Finder/Dock PATH augmentation remains macOS-specific. Windows and Linux inherit their normal process environments with only verified platform additions.

The `window-vibrancy` dependency and `macos-private-api` feature are target-specific. Window setup must treat unavailable effects as a visual degradation, not a startup failure.

### Cross-platform functionality

PTYs use `portable-pty` on all three desktop targets. Filesystem, Git, editor, and browser commands retain their current interfaces and gain platform-neutral path tests. Commands that rely on Unix-only sockets or metadata return a typed `unsupported`/`unavailable` result on Windows rather than failing application startup.

The CI workflow gains a desktop matrix for `macos-15`, `windows-2025`, and `ubuntu-24.04`. Each entry installs its documented Tauri system prerequisites and runs:

- web bundle construction;
- Rust formatting checks;
- Rust unit tests;
- `cargo check --locked`;
- platform-neutral TypeScript/source-contract tests.

The existing full package, macOS, and iOS gates remain separate. CI compilation proves platform compatibility; it does not assert that a hosted runner has a physical accelerated GPU.

New performance-critical frontend units are TypeScript source bundled by the existing esbuild step. The terminal controller, frame scheduler, graphics probe, virtual list, metrics collector, and stress harness expose narrow globals to the existing shell until a separately justified shell migration exists. This avoids a risky whole-file rewrite of `main.js` while ensuring the new rendering and diagnostics contracts are typed.

## Slice 2: Bounded PTY Batching and Backpressure

### Native data path

Replace per-read `pty:data` emission with a per-session `PtyOutputPump`:

```text
portable-pty reader
  -> bounded byte-budget queue
  -> cadence/size batcher
  -> acknowledged in-flight window
  -> Tauri pty:data-batch event
  -> per-pane frontend consumer
  -> xterm write callback
  -> pty_ack command
```

Each session has independent flow control. A slow pane cannot consume another pane's byte budget or acknowledgement window.

The initial bounds are explicit constants and developer diagnostics reports them:

- native pending budget: 2 MiB per pane;
- native fragment limit: 128 fragments per pane;
- emitted batch limit: 64 KiB;
- maximum unacknowledged batches: two per pane;
- visible flush cadence: at most once per animation interval, nominally 16 ms;
- hidden/background cadence: no faster than 100 ms;
- exit drain timeout: 2 seconds, after which the timeout is reported explicitly.

The native reader may block when the byte budget is full. This propagates normal PTY/OS backpressure to the child instead of dropping bytes or allocating without limit. Bytes remain ordered and unchanged. The design does not promise an unlimited transcript: xterm's configured scrollback remains bounded, while every byte accepted from the PTY is processed in order by the terminal parser.

### Batch protocol

`pty:data-batch` contains:

- thread ID;
- monotonically increasing sequence;
- bytes;
- byte count;
- enqueue and emission monotonic timestamps;
- native queue depth and queued byte count.

The frontend acknowledges a sequence only from xterm's write-completion callback. Duplicate acknowledgements are idempotent. Unknown, skipped, or future acknowledgements are rejected without advancing the window. PTY exit waits for already-read data to drain before the exit event, with a bounded shutdown timeout that is surfaced in diagnostics.

### Visibility control

The frontend sends `pty_set_visibility` only when a pane's effective visibility changes. Effective visibility combines:

- document visibility;
- window minimized/focused state where available;
- active project/worktree/focus set;
- collapsed or explicitly hidden state;
- intersection with the terminal viewport.

Hidden panes receive fewer, larger batches. Their xterm parsers continue to consume ordered output so terminal state remains correct, but fitting and painting are disabled. When browsers suspend animation frames for a backgrounded document, a low-frequency hidden-pane drain handles already-delivered batches without initiating fits or visual updates. The two-batch acknowledgement window still bounds cross-boundary data.

### Metrics

Each pump tracks bytes read, bytes emitted, batch count, batch size, emit frequency, queue depth high-water mark, blocked-reader duration, acknowledgement latency, and drain timeout. Superseded resize/focus/bounds requests increment `coalesced_visual_updates`; PTY bytes never contribute to a discarded-update counter.

## Slice 3: Per-Pane Rendering Lifecycle

### Terminal controller

Extract terminal behavior from the monolithic shell into one `TerminalPaneController` per terminal. It owns:

- the xterm instance and bounded scrollback;
- fit and WebGL addons;
- current renderer state;
- output batch queue and write-in-progress state;
- `ResizeObserver` and `IntersectionObserver` state;
- effective visibility;
- scheduled fit/output frame handles;
- context-loss retry state;
- input, bell, link, resize, and disposal registrations.

Creating, hiding, showing, moving, and closing one pane must not recreate or rerender unrelated terminal instances. Closing a pane cancels frames, disconnects observers, disposes addons and xterm, releases queued acknowledgements safely, and then stops the PTY.

### Renderer selection and recovery

After xterm opens, attempt to load `@xterm/addon-webgl`. Record `webgl` only after addon initialization succeeds.

On WebGL context loss:

1. mark the pane renderer `recovering` and record the loss;
2. dispose the failed addon without disposing xterm;
3. wait for a visible, stable layout frame;
4. create and load one fresh WebGL addon;
5. record recovery if successful;
6. otherwise remain on xterm's supported default renderer and record the fallback reason.

A second context loss inside a 30-second cooldown does not loop. It disposes WebGL and remains on the fallback renderer until an explicit developer retry or pane recreation. Renderer failure never crashes the terminal or PTY.

### Frame scheduler

Add a shared scheduler with per-pane keys for:

- terminal output flush;
- terminal fit and PTY resize;
- pane-tree geometry application;
- embedded-browser bounds;
- transient focus/transition presentation.

Scheduling the same key twice before the next frame replaces the pending value and increments the coalescing metric. Visible terminal output is passed to xterm at most once per animation frame. xterm's write callback controls the next batch and native acknowledgement. A pane fit occurs only when visible, connected, and measurably sized. The resulting PTY resize is sent once per changed row/column pair.

Pointer-driven split and sidebar resizing calculate their latest geometry during pointer events but mutate layout only in the next scheduled frame. Resizing necessarily changes dimensions; it is not implemented as a CSS width/height animation.

### Visibility and virtualization

Pane DOM remains independently addressable. Off-screen, inactive-project, collapsed, hidden-set, minimized, and backgrounded panes receive a suspended presentation state. Suspended panes do not call `fit`, update browser bounds, or request xterm refreshes. When restored, they fit once before normal output scheduling resumes.

Use xterm's viewport/scrollback virtualization for terminal history with `scrollback: 10_000`. Add a reusable fixed/estimated-row virtual list for sessions/processes, file trees, logs, and other long collections, with eight rows of keyboard-safe overscan and stable item keys. Collections up to 200 items may render fully; crossing 200 switches to windowing without changing selection state.

### Compositor-safe CSS

Audit every transition and keyframe in the desktop stylesheet. Animated properties are limited to `transform` and `opacity`. Replace background-position shimmer, dimension, inset, and layout animations with compositor-safe pseudo-elements or static states. Resize interactions remain direct scheduled layout changes rather than CSS animations.

Blur, backdrop filters, large shadows, transparent stacked layers, and nested glass effects are removed or reduced on terminal-heavy surfaces. `will-change` is never global or persistent: an active-transition class adds it immediately before a known transition and removes it on `transitionend`, `animationend`, cancellation, or timeout.

## Slice 4: Runtime Acceleration Diagnostics and Stress Mode

### Evidence model

Expose one merged startup/runtime report. Rust supplies platform/native WebView facts and process metrics. The frontend supplies standards-based graphics probe results and renderer lifecycle facts.

The report uses omission instead of guessed placeholder values. Its acceleration status is one of:

- `accelerated`: a context created with `failIfMajorPerformanceCaveat`, or a WebGPU adapter, plus available renderer evidence that does not identify software rendering;
- `software`: renderer/adapter evidence identifies a known software implementation;
- `unknown`: the engine masks the necessary evidence, a probe is unsupported, or evidence conflicts;
- `unavailable`: neither WebGL nor WebGPU can create a usable context.

Known software markers include SwiftShader, llvmpipe, softpipe, software rasterizer, and Microsoft Basic Render Driver. The list is tested and versioned. A successful ordinary WebGL context alone is not enough to claim acceleration.

### Reported fields

Report these fields only when reliably obtained:

- operating system and architecture;
- WebView engine: WKWebView/WebKit, WebView2/Chromium, or WebKitGTK;
- engine version from a native runtime API or an unambiguous runtime token;
- acceleration status and supporting probe;
- graphics backend when a renderer string clearly identifies Metal, Direct3D, Vulkan, or OpenGL;
- GPU adapter from WebGPU adapter information or unmasked WebGL renderer data;
- active terminal renderer per pane;
- software/unavailable fallback reason;
- probe warnings and masked/unsupported field names.

Do not infer a GPU model from operating system, CPU architecture, browser family, or vendor ID alone. User-agent strings may identify an engine but do not prove acceleration.

Startup logs emit one concise structured summary after the frontend probe completes. Developer diagnostics display the same report in-app and can copy/export deterministic JSON. The acceleration record is compatible with the separately designed native diagnostics journal but does not depend on that unimplemented feature.

### Developer stress mode

Enable stress mode only in debug builds when `PSYCHE_RENDER_DIAGNOSTICS=1` is present at native startup. The native environment command exposes a boolean capability to the local shell; the frontend does not trust a query parameter to authorize process spawning. Production builds compile the controls out and reject stress commands even if the environment variable is present.

The harness runs separate 1, 6, 12, and 24-terminal scenarios. Each terminal executes a platform-native deterministic output generator with sequence-numbered text, ANSI color, line rewrites, and bursts. Scenarios also exercise:

- continuous output from every terminal;
- repeated split and sidebar resizing;
- rapid deterministic focus switching;
- an editor pane with a large generated document;
- an embedded browser pane loading a local diagnostic page;
- window minimize, background, restore, and refocus;
- forced WebGL loss through `WEBGL_lose_context` when supported;
- successful recreation or stable fallback;
- hidden and off-screen pane suspension.

The harness never opens arbitrary external URLs and needs no CSP or permission expansion.

### Measurements

The frontend records requestAnimationFrame deltas and supported PerformanceObserver entries. The native side samples the Psyche process at a controlled cadence. Each scenario reports:

- average, p95, and maximum frame time;
- frames over 16.7, 33.4, and 50 ms;
- long frames and estimated dropped frames;
- bytes read/rendered per second;
- IPC batch count, average/p95/max size, and frequency;
- native/frontend queue depth and high-water marks;
- coalesced visual updates;
- PTY backpressure time;
- renderer losses, recoveries, and fallbacks;
- process CPU and resident memory.

Machine-dependent performance values are evidence, not universal CI assertions. Deterministic tests enforce batching, bounds, ordering, acknowledgement flow, hidden-pane suspension, once-per-frame resizing, and context-loss behavior.

For the six-pane acceptance run on supported non-virtualized hardware, the responsiveness target is p95 frame time at or below 33.4 ms and measured focus/resize input-to-next-paint latency below 100 ms. Results outside that target remain visible evidence and block the responsiveness acceptance claim; they do not make unrelated cross-platform compile tests flaky.

## Error Handling

- Graphics probe failure produces `unknown` or `unavailable`; it never blocks startup.
- Missing adapter/backend/version data is omitted and accompanied by an unsupported-field list in developer output.
- PTY queue saturation applies backpressure and records duration; it does not discard bytes.
- A failed batch emit remains pending and retries within the bounded window unless the pane closes.
- Sequence gaps stop acknowledgement advancement and surface a protocol error.
- A hidden pane that becomes visible receives one fit before painting resumes.
- A WebGL initialization or recovery error falls back per pane without affecting other panes.
- Metrics collection failure omits that metric and records a collector warning.
- Platform-only integrations return typed unsupported results and do not prevent the desktop shell from starting.

## Security

This work does not add remote origins, unsafe script directives, devtools in production, shell command passthrough from web content, or broad filesystem/window permissions. Stress commands are fixed native development fixtures, not user-supplied command strings. Graphics renderer strings and process metrics remain local unless the user explicitly copies a report.

The existing CSP remains at least as strict as before. Embedded diagnostic browser content is local and self-contained. Tauri commands validate pane IDs, sequence numbers, byte/count bounds, and development-mode authorization.

## Testing Strategy

Follow test-driven development within each slice.

### Rust tests

- platform shell/environment selection and path-boundary behavior;
- cross-platform configuration contracts;
- byte-budget queue bounds and producer blocking;
- 16 ms/64 KiB batching boundaries;
- two-batch acknowledgement window;
- sequence ordering, duplicate/invalid acknowledgement behavior, and exit draining;
- visibility cadence changes without byte loss;
- metrics/high-water accounting;
- acceleration evidence classification and software-marker detection;
- unsupported native fields are omitted;
- process metrics collector degradation.

### Frontend tests

- one output flush and one resize/fit per pane per animation frame;
- independent pane controller creation and disposal;
- hidden/off-screen/background panes never fit or repaint;
- ordered xterm writes and acknowledgement after write completion;
- context-loss recreation, retry cooldown, and fallback;
- renderer failure isolation between panes;
- virtual-list windowing, keyboard selection, overscan, and stable keys;
- CSS keyframes/transitions animate only transform and opacity;
- temporary `will-change` cleanup;
- acceleration report omission and conflict behavior;
- frame and throughput percentile calculations;
- deterministic stress scenario transitions.

### Integration verification

- Build and run the desktop target on macOS, Windows, and Linux.
- Capture one startup graphics report on non-virtualized hardware for each platform. Hardware acceleration is confirmed only when that report says `accelerated`; otherwise record the actual software/unknown result as a proof gap.
- Run all four stress sizes on each platform and retain exported JSON as verification evidence.
- Confirm six continuously streaming terminals meet p95 frame time at or below 33.4 ms and focus/resize input-to-next-paint below 100 ms.
- Force WebGL context loss and verify either recovery or stable fallback without PTY termination.
- Minimize/background/restore and verify queue bounds, correct terminal state, and one restore fit.
- Inspect CSP and capabilities diffs to prove no security weakening.

The implementation is not considered fully cross-platform verified from a macOS-only development machine. CI build/test results plus real runtime reports from all three engines are required for the final acceptance claim.

## Acceptance Mapping

- Hardware acceleration is verified by strict runtime evidence, never platform assumption.
- Six active streaming terminals remain responsive during the stress resize/focus scenario.
- Native read chunks are aggregated into bounded acknowledged batches before IPC.
- Hidden panes stop fit, bounds, refresh, and paint work while ordered parsing continues at reduced cadence.
- Resize and output scheduling are keyed and coalesced to at most once per animation frame.
- WebGL loss recreates once or falls back per pane without crashing.
- Native byte budgets, fragment counts, in-flight IPC, frontend work, xterm scrollback, and metrics retention are bounded.
- Software renderers are named in startup and developer reports when evidence reveals them.
- CSP and Tauri capabilities remain equally or more restrictive.

## Rollout

Land the four slices in order. Keep acceleration diagnostics enabled by default because they are local and cheap; keep the stress harness development-only. Do not remove xterm's fallback renderer or require WebGL for startup. Do not add release artifacts for Windows or Linux in this project.

If profiling after these changes still identifies a platform compositor or renderer bottleneck, capture a trace and design the smallest targeted follow-up. A custom renderer requires a separate approved design backed by that evidence.
