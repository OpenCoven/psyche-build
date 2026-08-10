# Minimal Footer Status Bar Design

## Problem

Psyche Build exposes pane state in the session rail and focused-process state in the titlebar, but it has no quiet workspace-wide view of runtime health. Operators must inspect individual panes or external system tools to notice failed work, resource pressure, degraded frame delivery, abnormal terminal throughput, or backend trouble.

The desktop app needs a slim diagnostic footer that remains unobtrusive during normal work and expands into focused detail without becoming a dashboard or covering the workspace.

## Goals

- Add a 26px bottommost status bar beneath the existing command composer.
- Show high-signal workspace metrics with stable widths and muted presentation.
- Make every visible metric open a lightweight detail panel directly above the bar.
- Collect real native and frontend metrics wherever a structured source exists.
- Support workspace and focused-pane scopes.
- Adapt refresh frequency to activity and visibility.
- Preserve the user's visible metrics, responsive priority, and order.
- Keep warnings and failures noticeable without coloring routine healthy values.
- Remain useful at narrow window widths through priority-based overflow.

## Non-Goals

- Building a general monitoring dashboard or profiler.
- Guessing models, token usage, tool calls, tasks, or GPU load from terminal text.
- Persisting long-term telemetry or uploading metrics.
- Recording prompts, terminal transcripts, file contents, browser contents, or diffs.
- Implementing the separate research-grade diagnostic journal.
- Adding charts larger than compact recent-history sparklines.

## Approved Layout

Wrap the existing composer, optional metric detail panel, and status bar in one footer stack:

1. command composer;
2. expanded metric panel when open;
3. 26px status bar at the bottom window edge.

The collapsed state adds only 26px to the current interface. Opening a metric inserts a bounded panel between the composer and status bar and reduces the workbench height; it does not overlay the entire workspace. The panel should target 156-220px, cap itself against the available window height, and remain scrollable when content exceeds that bound.

The footer uses the existing opaque deep surfaces, borders, semantic colors, and monospace font. It must not add glass effects, large icons, cards with heavy elevation, or decorative charts.

## Collapsed Status Bar

The default workspace order is:

1. Connection
2. Active agents
3. Running shells
4. Tasks
5. CPU and memory
6. FPS
7. Terminal output rate
8. Scope control
9. More

Example:

```text
● Connected | 4 Agents | 6 Shells | 3 Run  1 Wait | CPU 18%  MEM 640 MB | 60 FPS | 240 lines/s | Workspace⌄ | More
```

Each metric is a button with a tooltip and stable minimum width. Numerals use `font-variant-numeric: tabular-nums`. Values update in place without rebuilding the footer or changing label widths.

Routine values use muted text. Semantic emphasis is reserved for:

- red: failed work or disconnected native service;
- amber: waiting work, sustained CPU or memory pressure, low FPS, high render latency, exceptional output throughput, or degraded optional services;
- normal connection green dot only, without a green pill or broad success fill.

## Expanded Panels

The footer has six detail panels.

### Agents

Show normalized local and Coven-backed agent rows:

- name;
- harness and model when structured data supplies them;
- status;
- current task when supplied;
- runtime;
- token usage when supplied.

Local agent panes include Coven chat/attach and other recognized agent harness panes. Discovered Coven sessions are de-duplicated against attached local panes by structured session identity when available. Unsupported optional fields are omitted from the row.

### Shells

Show each live local PTY:

- executable/process name;
- PID;
- pane name;
- status;
- CPU;
- memory;
- terminal output rate.

CPU and memory aggregate the PTY root process and its descendant process tree. A web pane is not presented as a shell and receives focused-pane process metrics only if the native layer can identify a reliable process owner.

### Tasks

Treat all process-backed pane work as tasks, as approved. Normalize status as follows:

- `starting` and active work -> running;
- local attention or daemon `waiting` -> waiting for input;
- daemon `blocked` -> blocked;
- startup failure or nonzero process exit -> failed;
- clean process exit or daemon `completed` -> completed.

The collapsed footer shows running, waiting, and failed counts. The panel shows all five groups. A category with no entries may remain as a compact zero-count group, but unavailable task metadata fields are omitted.

Local thread records gain `startedAt`, `finishedAt`, and `exitCode` fields so runtime and completion state come from lifecycle events rather than inference.

### Performance

CPU, memory, FPS, render latency, and dropped-frame footer buttons all open this panel with the triggering metric emphasized.

Show:

- current and observed peak workspace CPU;
- current and observed peak workspace memory;
- GPU only when a reliable native collector is available;
- current FPS;
- rolling render latency;
- dropped frames over the recent window.

Workspace CPU and memory include the Tauri application plus tracked PTY process trees without double-counting descendants. Focused-pane scope includes only the focused pane's tracked process tree. Peaks are session-observed peaks, reset when the application restarts.

### Activity

Show:

- terminal bytes and normalized line throughput;
- Psyche native operation count and rate, labeled `Ops`;
- native operation errors;
- agent tool calls only when a structured Coven event source becomes available;
- recent threshold-crossing spikes.

PTY data events update byte counters before writing to xterm. Line throughput counts newline boundaries in decoded output and maintains incomplete-line carry per thread. Binary byte rate remains available even when line rate cannot be meaningfully derived.

### Connection

Show:

- Tauri/native bridge health and snapshot round-trip latency;
- Coven service phase and request latency;
- reconnect count for unhealthy-to-ready transitions during the app session;
- last successful refresh;
- per-service health.

The footer reports the native bridge as connected when native snapshots succeed. An unavailable optional Coven daemon is listed in detail but does not falsely mark the standalone app disconnected.

Use explicit native health states: one failed refresh keeps the last sample without changing the connection label; two consecutive failures or a sample older than 10 seconds marks the bridge degraded; five consecutive failures or a sample older than 30 seconds marks it disconnected. A successful refresh resets the failure count and increments the reconnect count when recovering from degraded or disconnected.

## Interaction

- Clicking a metric opens its panel.
- Clicking the active metric again collapses the panel.
- `Esc` closes the panel and restores focus to the triggering metric.
- The panel is non-modal and does not trap focus.
- Workspace/focused-pane scope uses a compact segmented control.
- Focused-pane scope is disabled when the selected pane has no reliable metric source.
- Clicking `Pin metric` raises that metric's responsive priority and persists the choice.
- `Copy diagnostics` copies a bounded live metric snapshot and recent trend summary. It excludes prompts and terminal content.
- The More menu exposes hidden metrics, visibility toggles, and keyboard-accessible reordering.
- Warning and failure metrics override user hiding and ordering while the condition is active.

## Responsive Behavior

Footer metrics have a persisted user order plus a default priority. When width is insufficient:

1. remove healthy, unpinned metrics from the rightmost lowest priority;
2. preserve active warnings and failures;
3. preserve Connection, scope, and More;
4. expose overflowed metrics in More with their current value and severity.

Pinned metrics outrank unpinned healthy metrics but do not outrank active failures. The bar must not horizontally scroll or wrap to a second line.

## Architecture

### Native metrics module

Add a focused Rust module under the Tauri application. It owns:

- tracked PTY process identity;
- process-tree discovery;
- system and process CPU/memory refresh;
- workspace and focused-pane aggregation;
- native collector health;
- serializable snapshot types.

Use a maintained system-information crate rather than shelling out to `ps`. Capture the PTY child PID from the portable-pty child before moving it into the exit waiter. Store PID and process metadata with the PTY session, and remove them on stop or exit.

Keep the system-information collector as managed Tauri state so CPU deltas are calculated across refreshes instead of rebuilding a stateless process table for every command.

Expose one command:

```text
workspace_metrics(scope?: { threadId?: string }) -> MetricsSnapshot
```

The snapshot returns a timestamp, collector status, system totals, tracked process rows, aggregate values, and explicit unavailable fields through omission rather than zero-shaped defaults.

GPU collection is capability-based. If the supported macOS APIs or selected dependency cannot provide reliable GPU utilization without privileged commands or private unsupported behavior, omit GPU.

### Frontend status module

Add a bundled frontend module following the existing sessions, panes, diffs, and editor bundle pattern. It owns:

- normalized metric state;
- aggregation of native snapshots with existing thread/session state;
- FPS, render latency, and dropped-frame sampling;
- PTY throughput counters;
- Psyche operation counters;
- short trend buffers and observed peaks;
- threshold evaluation;
- adaptive polling;
- persistence and responsive ordering;
- footer and panel rendering helpers.

`main.js` supplies a narrow adapter for current threads, active pane, Coven discovery state, and metric DOM hosts. It must not duplicate aggregation logic.

### Operation instrumentation

Introduce a small wrapper around metric-relevant Tauri invocations. It records operation name, duration, success, and failure for the Activity and Connection panels, then preserves the original return or rejection behavior. Do not broadly catch or convert failures into successful empty values.

Existing direct calls may migrate incrementally within this feature, but every operation counted as `Ops` must use the wrapper so the metric remains truthful.

## Metric Sources

| Metric | Source |
|---|---|
| Active agents | Local thread kinds plus structured Coven session summaries |
| Running shells | Live local PTY sessions |
| Task state | Normalized local thread and Coven session lifecycle |
| Process PID/name | Portable-pty child PID plus native process table |
| CPU/memory | Native system/process collector |
| FPS/render latency/dropped frames | Frontend `requestAnimationFrame` sampler |
| Terminal throughput | PTY data event byte/newline counters |
| Psyche Ops/errors | Instrumented Tauri invocation wrapper |
| Agent tools | Structured Coven events only, when available |
| Native latency | Timed metrics invocation |
| Coven latency/health | Existing discovery request timing and phase transitions |
| Model/task/tokens | Structured session fields only, when available |
| GPU | Reliable native capability only |

## Sampling and Trends

- Active sampling: every 1 second.
- Idle sampling: every 5 seconds after 30 seconds without pointer, keyboard, pane, or PTY activity.
- Hidden window: pause native and animation sampling.
- Visibility or focus return: request an immediate fresh snapshot.
- Coven discovery keeps its existing lifecycle, with timing added around the request.
- Store at most 60 samples per trend.
- Sparklines use small inline SVG paths with no axes or hover dashboard.
- Respect `prefers-reduced-motion`; numeric changes do not animate spatially.

## Thresholds

Initial semantic thresholds:

- CPU: amber at 80% or greater for five consecutive samples.
- Memory: amber when workspace or system memory pressure reaches 85%.
- FPS: amber below 45 for five consecutive active samples.
- Render latency: amber above 32ms over the recent window.
- Output: amber after three consecutive samples at or above 1,000 lines/s and four times the median of the preceding 30 samples.
- Waiting: amber attention state.
- Failed or disconnected: red immediately.

Threshold functions belong in the pure frontend metric model and must be independently tested. They should use hysteresis so a value near a boundary does not flicker between states.

## Persistence

Store one versioned local-storage record containing:

- visible metric IDs;
- metric order;
- pinned metric IDs;
- last selected scope.

Validate IDs against the current metric registry and fall back to defaults for invalid or obsolete entries. Runtime samples, peaks, process rows, and connection errors are not persisted.

The application always starts with the detail panel collapsed, preserving the quiet default state.

## Failure Semantics

- A failed native snapshot retains the last good values as stale rather than replacing them with zeros.
- Metrics with no valid source are hidden.
- Stale age appears in the Connection panel.
- Repeated failures promote Connection severity.
- One unavailable collector must not prevent unrelated metrics from updating.
- Clipboard failure leaves the panel open and shows an actionable error.
- Persistence parse/write failure falls back to in-memory defaults and remains non-fatal.
- Process disappearance during a snapshot is treated as a normal race and omitted from that sample.

## Accessibility

- Every status item is a real button with a concise accessible name.
- Tooltips explain technical metrics and thresholds.
- Footer and panel use logical DOM order matching visual order.
- Scope, More, customization, pin, copy, and close controls are keyboard reachable.
- Panel status changes use a polite live region; failures use an assertive message only when action is required.
- Semantic state is conveyed through text and shape as well as color.
- Focus rings follow the existing theme.

## Testing

Follow test-driven development.

### Rust

- PTY PID capture and cleanup on exit/stop;
- descendant process-tree aggregation and de-duplication;
- workspace versus focused-pane scopes;
- CPU and memory snapshot serialization;
- process disappearance races;
- unavailable collector omission;
- collector error propagation without fabricated values.

### Frontend model

- agent, shell, and task normalization and de-duplication;
- byte and line throughput;
- FPS, render latency, and dropped-frame windows;
- observed peaks and bounded trend buffers;
- thresholds and hysteresis;
- native/Coven reconnect counting;
- stale-sample handling;
- persisted visibility, order, pins, and schema migration;
- responsive priority and warning overrides;
- adaptive refresh cadence.

### UI contracts

- footer placement beneath the composer;
- required metric buttons and tooltip text;
- click-to-open, active-click collapse, and Escape behavior;
- workspace/focused-pane switching;
- More overflow and customization;
- pin and copy states;
- unavailable metrics omitted;
- no wrapping or horizontal scrolling at narrow widths.

Run the focused Vitest tests, Rust formatting/check/tests, repository typecheck, Tauri web build, and the smallest existing build or smoke surface that covers the changed startup and desktop behavior.

## Rollout

Ship the footer enabled by default. The native collector remains local and does not create persistent telemetry. Capability-dependent fields appear automatically when their structured sources exist. Any future long-term metric storage, remote telemetry, agent-event streaming, or privileged GPU profiling requires a separate design.
