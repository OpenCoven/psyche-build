# GPU ADE Slice 2: Bounded PTY Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-read PTY IPC with ordered, bounded, acknowledged batches and per-pane backpressure.

**Architecture:** Put a pure state machine and byte-budget queue in a focused Rust module, then connect each portable-pty reader to its own output pump. Permit two in-flight batches per pane and advance only after xterm's write callback acknowledges the exact sequence.

**Tech Stack:** Rust, parking_lot, Tauri events/commands, TypeScript runtime bundle, xterm.js, Vitest.

---

Prerequisite: Slice 1 is green and the desktop root is `native/desktop/psyche-build-tauri`.

## File map

- Create `src-tauri/src/pty_transport.rs` — bounded byte queue, batching state machine, metrics, events, visibility, acknowledgements, and tests.
- Modify `src-tauri/src/lib.rs` — session ownership, reader/exit integration, Tauri commands, event registration.
- Create `web/runtime/pty-client.ts` — sequence validation, per-pane write/ack path, visibility calls.
- Create `web/runtime/runtime-entry.ts` and generated `web/runtime.bundle.js` — typed runtime global.
- Modify desktop `package.json` and `web/index.html` — build/load the runtime bundle.
- Modify `web/main.js` — route terminal creation and PTY events through the typed client.
- Create `__tests__/tauriPtyTransport.test.ts` — frontend and source-contract coverage.

### Task 1: Build the bounded native queue and batch state machine

**Files:**
- Create: `native/desktop/psyche-build-tauri/src-tauri/src/pty_transport.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing Rust tests for bounds, order, and cadence**

Create module tests using these public constants and state API:

```rust
#[test]
fn batches_in_order_at_the_size_boundary() {
    let mut state = PumpState::new(PumpLimits::default());
    state.push(vec![1; MAX_BATCH_BYTES - 1]).unwrap();
    state.push(vec![2; 2]).unwrap();
    let first = state.next_batch(Duration::from_millis(16)).unwrap();
    assert_eq!(first.sequence, 1);
    assert_eq!(first.bytes.len(), MAX_BATCH_BYTES);
    assert_eq!(first.bytes[MAX_BATCH_BYTES - 1], 2);
    state.acknowledge(1).unwrap();
    assert_eq!(state.next_batch(Duration::ZERO).unwrap().bytes, vec![2]);
}

#[test]
fn never_exceeds_two_in_flight_batches() {
    let mut state = PumpState::new(PumpLimits::default());
    state.push(vec![7; MAX_BATCH_BYTES * 3]).unwrap();
    assert!(state.next_batch(Duration::from_millis(16)).is_some());
    assert!(state.next_batch(Duration::from_millis(16)).is_some());
    assert!(state.next_batch(Duration::from_millis(16)).is_none());
}

#[test]
fn byte_and_fragment_budgets_are_enforced() {
    let mut state = PumpState::new(PumpLimits::default());
    for _ in 0..MAX_PENDING_FRAGMENTS {
        state.push(vec![1]).unwrap();
    }
    assert_eq!(state.push(vec![2]), Err(PushError::WouldBlock));
    assert!(state.queued_bytes() <= MAX_PENDING_BYTES);
}

#[test]
fn acknowledgements_are_exact_and_idempotent() {
    let mut state = PumpState::new(PumpLimits::default());
    state.push(b"abc".to_vec()).unwrap();
    state.next_batch(Duration::from_millis(16)).unwrap();
    assert_eq!(state.acknowledge(1), Ok(AckOutcome::Advanced));
    assert_eq!(state.acknowledge(1), Ok(AckOutcome::Duplicate));
    assert!(matches!(state.acknowledge(3), Err(AckError::FutureSequence { .. })));
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml pty_transport --locked`

Expected: compile failure because the module and types do not exist.

- [ ] **Step 3: Implement the pure transport state**

Define exact bounds:

```rust
pub const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PENDING_FRAGMENTS: usize = 128;
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_IN_FLIGHT: usize = 2;
pub const VISIBLE_CADENCE: Duration = Duration::from_millis(16);
pub const HIDDEN_CADENCE: Duration = Duration::from_millis(100);
pub const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
```

Use `VecDeque<Vec<u8>>` plus explicit byte accounting. `next_batch` drains at most 64 KiB without changing byte order and retains the emitted bytes in an in-flight map until exact acknowledgement. `push` returns `WouldBlock` before either budget is exceeded. Metrics record read/emitted bytes, batches, high-water marks, blocked duration, and ack latency.

- [ ] **Step 4: Verify GREEN**

Run the focused Rust test command again. Expected: all `pty_transport` tests PASS.

- [ ] **Step 5: Commit the pure transport**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/pty_transport.rs \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "Add bounded PTY batch state"
```

### Task 2: Connect PTY readers to independent output pumps

**Files:**
- Modify: `src-tauri/src/pty_transport.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust module tests

- [ ] **Step 1: Add failing integration-state tests**

Cover producer blocking/unblocking with a condition variable, visible-to-hidden cadence changes, independent pane budgets, retry after emit failure, and exit drain ordering. Use a fake emitter closure so tests do not need a Tauri runtime.

```rust
#[test]
fn slow_pane_does_not_consume_another_panes_window() {
    let a = OutputPump::for_test("a");
    let b = OutputPump::for_test("b");
    a.enqueue(vec![1; MAX_PENDING_BYTES]).unwrap();
    b.enqueue(b"ready".to_vec()).unwrap();
    assert_eq!(b.emit_ready(|_| Ok(())).unwrap(), 1);
    assert_eq!(b.snapshot().queued_bytes, 0);
}
```

- [ ] **Step 2: Run and verify RED**

Expected: compile failure because `OutputPump` is absent.

- [ ] **Step 3: Implement `OutputPump`**

Wrap state in `Arc<(Mutex<PumpState>, Condvar)>`. The reader's `enqueue` waits while either budget is full and records blocked time. A dedicated worker emits `PtyDataBatchEvent` no faster than the effective cadence and never beyond the in-flight window. Store the pump in `PtySession`; do not hold the global `SESSIONS` lock while waiting, emitting, acknowledging, or writing.

Define the event exactly:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataBatchEvent {
    pub thread_id: String,
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub byte_count: usize,
    pub enqueued_at_micros: u64,
    pub emitted_at_micros: u64,
    pub queued_bytes: usize,
    pub queue_depth: usize,
}
```

- [ ] **Step 4: Replace per-read emission**

The reader thread calls `pump.enqueue(buf[..n].to_vec())`; only the pump emits `pty:data-batch`. The exit watcher joins the reader, requests a drain, waits at most two seconds, emits any timeout metric, then emits `pty:exit`. Remove `PtyDataEvent` and `emit("pty:data", ...)`.

- [ ] **Step 5: Verify Rust integration GREEN**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml pty_transport --locked
```

Expected: PASS, including byte-for-byte randomized ordering tests.

- [ ] **Step 6: Commit native pump integration**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src
git commit -m "Batch PTY output before IPC"
```

### Task 3: Keep PTY operations off the Tauri main thread

**Files:**
- Create: `__tests__/tauriPtyTransport.test.ts`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write a failing non-blocking command contract**

Read `lib.rs` and assert `pty_start`, `pty_write`, and `pty_resize` are async commands whose blocking portable-pty work runs inside `tauri::async_runtime::spawn_blocking`. Also assert reader draining remains on its dedicated worker and no global session lock is held across a blocking write.

```ts
for (const command of ['pty_start', 'pty_write', 'pty_resize']) {
  const source = commandSource(tauriLib, command);
  expect(source).toMatch(/async fn/);
  expect(source).toMatch(/tauri::async_runtime::spawn_blocking/);
}
expect(commandSource(tauriLib, 'pty_write')).toMatch(
  /Arc::clone\(&session\.writer\)[\s\S]*drop\(guard\)[\s\S]*spawn_blocking/,
);
```

Implement `commandSource` by locating `#[tauri::command]` plus the named function and slicing through the next `#[tauri::command]`; do not use a regex that can accidentally inspect a different command.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriPtyTransport.test.ts`

Expected: FAIL because the three commands are synchronous and directly perform portable-pty work.

- [ ] **Step 3: Move blocking work to Tauri's blocking pool**

Change the command signatures to `async fn`. Validate/copy command inputs first, then call `tauri::async_runtime::spawn_blocking(move || { ... }).await`. Store both writer and master as pane-owned `Arc<Mutex<...>>` handles. For writes and resize, clone the relevant handle while briefly holding `SESSIONS`, drop the guard, and only then enter blocking work. PTY reader loops remain dedicated OS threads because they are long-lived streams, not async tasks.

- [ ] **Step 4: Verify GREEN**

```bash
pnpm vitest --run __tests__/tauriPtyTransport.test.ts
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

- [ ] **Step 5: Commit the non-blocking command boundary**

```bash
git add __tests__/tauriPtyTransport.test.ts native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "Keep PTY commands off the Tauri main thread"
```

### Task 4: Add acknowledgement, visibility, and metrics commands

**Files:**
- Modify: `src-tauri/src/pty_transport.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `__tests__/tauriPtyTransport.test.ts`

- [ ] **Step 1: Write failing command/source contracts**

Assert `lib.rs` registers `pty_ack`, `pty_set_visibility`, and `pty_transport_metrics`, emits only `pty:data-batch`, and no longer emits `pty:data`.

```ts
expect(tauriLib).toMatch(/pty_ack,\s*pty_set_visibility,\s*pty_transport_metrics,/s);
expect(tauriLib).toContain('"pty:data-batch"');
expect(tauriLib).not.toMatch(/emit\("pty:data"/);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriPtyTransport.test.ts`

Expected: FAIL because the commands are not registered.

- [ ] **Step 3: Implement validated commands**

```rust
#[tauri::command]
fn pty_ack(thread_id: String, sequence: u64) -> Result<AckOutcome, String>;

#[tauri::command]
fn pty_set_visibility(thread_id: String, visible: bool) -> Result<(), String>;

#[tauri::command]
fn pty_transport_metrics(thread_id: Option<String>) -> Vec<PtyTransportSnapshot>;
```

Look up and clone the pane pump while holding `SESSIONS`, then drop the global lock before calling it. Unknown pane IDs return an error. Visibility changes update cadence only on actual transitions. Metrics snapshots contain no process output bytes.

- [ ] **Step 4: Verify GREEN**

Run the focused TypeScript contract test and all Rust `pty_transport` tests.

- [ ] **Step 5: Commit the command surface**

```bash
git add __tests__/tauriPtyTransport.test.ts native/desktop/psyche-build-tauri/src-tauri/src
git commit -m "Expose PTY flow control commands"
```

### Task 5: Add the typed frontend PTY consumer

**Files:**
- Create: `web/runtime/pty-client.ts`, `web/runtime/runtime-entry.ts`
- Generate: `web/runtime.bundle.js`
- Modify: desktop `package.json`, `web/index.html`, `web/main.js`
- Test: `__tests__/tauriPtyTransport.test.ts`, `__tests__/tauriWebBundles.test.ts`

- [ ] **Step 1: Write failing behavioral tests with fake xterm/invoke**

Test these behaviors directly from `pty-client.ts`: exact sequence acceptance, one write at a time, acknowledgement only in the xterm callback, no acknowledgement on write throw, and visibility calls only on change.

```ts
it('acknowledges only after xterm accepts the ordered batch', async () => {
  const calls: unknown[][] = [];
  let complete!: () => void;
  const client = createPtyClient({
    threadId: 'pane-1',
    write: (_bytes, callback) => { complete = callback; },
    invoke: async (...args) => { calls.push(args); },
  });
  client.receive({ threadId: 'pane-1', sequence: 1, bytes: [65], byteCount: 1 });
  expect(calls).toEqual([]);
  complete();
  await Promise.resolve();
  expect(calls[0]).toEqual(['pty_ack', { threadId: 'pane-1', thread_id: 'pane-1', sequence: 1 }]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriPtyTransport.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the client and runtime bundle**

Export this transport type plus `createPtyClient`, `routePtyBatch`, and `disposePtyClient`:

```ts
export interface PtyDataBatch {
  threadId: string;
  sequence: number;
  bytes: number[];
  byteCount: number;
  enqueuedAtMicros?: number;
  emittedAtMicros?: number;
  queuedBytes?: number;
  queueDepth?: number;
}
```

Keep one client per pane in a map. Reject sequence gaps and duplicates without advancing. Use xterm's `write(Uint8Array, callback)` and call `pty_ack` from the callback. Do not copy batches into an unbounded frontend history.

Add this esbuild step:

```json
"esbuild web/runtime/runtime-entry.ts --bundle --minify --format=iife --global-name=PsycheRuntime --outfile=web/runtime.bundle.js"
```

Load `runtime.bundle.js` before `main.js` in `index.html`.

- [ ] **Step 4: Replace direct frontend writes**

In `main.js`, listen to `pty:data-batch` and route it to `PsycheRuntime.routePtyBatch`. When mounting a terminal, register its `term.write` adapter; when closing, dispose the client. Remove `pendingDataBuffers` and the old `pty:data` listener.

- [ ] **Step 5: Build and verify GREEN**

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run __tests__/tauriPtyTransport.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriDesktopTabs.test.ts
```

Expected: all PASS and bundle freshness is exact.

- [ ] **Step 6: Commit frontend flow control**

```bash
git add native/desktop/psyche-build-tauri/web native/desktop/psyche-build-tauri/package.json \
  __tests__/tauriPtyTransport.test.ts __tests__/tauriWebBundles.test.ts
git commit -m "Acknowledge bounded PTY batches in xterm"
```

### Task 6: Verify Slice 2 under sustained output

- [ ] **Step 1: Run deterministic native and frontend suites**

```bash
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
pnpm vitest --run __tests__/tauriPtyTransport.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriPhysicalPanes.test.ts
```

- [ ] **Step 2: Run a local six-pane stream smoke**

Launch `pnpm dev:tauri`, start six panes with sequence-numbered output, hide three, and inspect `pty_transport_metrics` through the debug console. Verify:

- no sequence gap or duplicate;
- no pane exceeds 2 MiB queued, 128 fragments, or two in-flight batches;
- hidden panes emit no faster than 100 ms;
- visible panes produce materially fewer IPC events than native reads;
- restoring a hidden pane shows correct terminal state.

- [ ] **Step 3: Commit any test-only corrections after rerunning both gates**

Use `git diff --check`, rerun the commands above, and commit only if corrections were necessary.
