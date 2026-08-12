# Session-list Close Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every visible native macOS session row an always-visible, guarded stop-and-close control that removes the row only after its local or Coven lifecycle operation succeeds.

**Architecture:** Keep row presentation and confirmation in `web/main.js`, reusing `closeThread` for local panes and adding one deduplicated async adapter for Coven rows. Extend the Rust Coven adapter with a validated `coven_session_kill` Tauri command that performs the existing health/version handshake and then sends a bounded `POST /api/v1/sessions/:id/kill` request over the configured Unix socket or loopback HTTP endpoint.

**Tech Stack:** Vanilla JavaScript DOM UI, CSS, Tauri 2, Rust standard-library socket I/O, Vitest source-contract/renderer tests, Rust unit tests.

---

## File map

- `native/macos/psyche-build-tauri/web/main.js` — shared close control, confirmation callback, local close wiring, Coven close orchestration, and error status.
- `native/macos/psyche-build-tauri/web/styles.css` — always-visible trailing close slot and existing hover/focus treatments.
- `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs` — validated kill command, health handshake, HTTP method-aware bounded request transport, and error mapping.
- `native/macos/psyche-build-tauri/src-tauri/src/lib.rs` — import and register the new Tauri command.
- `__tests__/tauriCovenSessionSiderail.test.ts` — real renderer interaction coverage for local and Coven rows.
- `__tests__/tauriWorkspaceRail.test.ts` — stable CSS, tree, shortcut, and source contract assertions.
- `__tests__/tauriCovenSessionNativeContract.test.ts` — command registration and blocking-boundary contract.

### Task 1: Add the native Coven kill boundary

**Files:**
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs:20-390`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs:1238-1260`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs:1568-1580`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs:2250-2310`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:27-29`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:2280-2310`
- Test: `__tests__/tauriCovenSessionNativeContract.test.ts`

- [ ] **Step 1: Write failing Rust transport and validation tests**

Add a method-aware request helper in the test module and tests that describe the required wire contract:

```rust
fn expected_method_request(method: &str, path: &str) -> Vec<u8> {
    format!(
        "{method} {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

#[test]
fn kills_session_over_loopback_tcp_after_compatible_health_check() {
    let (endpoint, server) = spawn_tcp_server(vec![
        http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
        http_json(br#"{}"#),
    ]);

    assert_eq!(try_kill_coven_session(&endpoint, "release:fix_01.a-b"), Ok(()));
    assert_eq!(
        server.recv_request(),
        expected_method_request("GET", "/api/v1/health"),
    );
    assert_eq!(
        server.recv_request(),
        expected_method_request(
            "POST",
            "/api/v1/sessions/release:fix_01.a-b/kill",
        ),
    );
    server.finish();
}

#[cfg(unix)]
#[test]
fn kills_session_over_unix_socket() {
    let tree = TempTree::new("kill-unix");
    let socket = tree.root.join("coven.sock");
    let server = spawn_unix_server(&socket, vec![
        http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
        http_json(br#"{}"#),
    ]);
    let endpoint = CovenEndpoint::Unix(socket);

    assert_eq!(try_kill_coven_session(&endpoint, "session-1"), Ok(()));
    assert_eq!(server.recv_request(), expected_method_request("GET", "/api/v1/health"));
    assert_eq!(
        server.recv_request(),
        expected_method_request("POST", "/api/v1/sessions/session-1/kill"),
    );
    server.finish();
}

#[test]
fn rejects_unsafe_session_id_before_connecting() {
    let endpoint = CovenEndpoint::Http("127.0.0.1:9".parse().unwrap());
    assert_eq!(
        try_kill_coven_session(&endpoint, "../foreign"),
        Err(CovenAdapterError::Failed),
    );
}
```

- [ ] **Step 2: Write the failing Tauri registration contract**

Extend `tauriCovenSessionNativeContract.test.ts`:

```ts
test('registers a validated non-blocking Coven session kill command', async () => {
  const [source, libSource] = await Promise.all([
    readFile(covenSessionsSourcePath, 'utf8'),
    readFile(libSourcePath, 'utf8'),
  ]);
  const command = functionBody(source, 'coven_session_kill');
  const closure = blockingClosureBody(command);

  expect(command).toMatch(/session_id\s*:\s*String/);
  expect(command).toMatch(/Result\s*<\s*\(\)\s*,\s*String\s*>/);
  expect(command).toMatch(/tauri::async_runtime::spawn_blocking/);
  expect(closure).toContain('is_safe_session_id(&session_id)');
  expect(closure).toContain('try_kill_coven_session(&endpoint, &session_id)');
  expect(libSource).toMatch(/use\s+coven_sessions::\{coven_session_kill,\s*coven_sessions\}\s*;/);
  expect(libSource).toMatch(
    /tauri::generate_handler!\s*\[[\s\S]*?coven_sessions\s*,\s*coven_session_kill\s*,/,
  );
});
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml coven_sessions::tests::kills_session
pnpm vitest --run __tests__/tauriCovenSessionNativeContract.test.ts
```

Expected: Rust fails because `try_kill_coven_session` and method-aware requests do not exist; Vitest fails because `coven_session_kill` is absent from the module and handler.

- [ ] **Step 4: Implement method-aware bounded requests and the kill command**

In `coven_sessions.rs`, add a private method enum, update the request exchange, and keep current GET callers explicit:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

fn request_endpoint(
    endpoint: &CovenEndpoint,
    method: HttpMethod,
    path: &str,
    deadline: Instant,
) -> Result<Vec<u8>, CovenAdapterError> {
    let allowed = matches!(
        (method, path),
        (HttpMethod::Get, "/api/v1/health" | "/api/v1/sessions")
    ) || (method == HttpMethod::Post
        && path.starts_with("/api/v1/sessions/")
        && path.ends_with("/kill"));
    if !allowed {
        return Err(CovenAdapterError::Failed);
    }
    match endpoint {
        #[cfg(unix)]
        CovenEndpoint::Unix(socket) => {
            let mut stream = connect_unix_before(socket, deadline)
                .map_err(|error| categorize_io_error(&error, true))?;
            exchange_http(&mut stream, method, path, deadline)
        }
        #[cfg(not(unix))]
        CovenEndpoint::Unix(_) => Err(CovenAdapterError::Failed),
        CovenEndpoint::Http(address) => {
            if !address.ip().is_loopback() {
                return Err(CovenAdapterError::Failed);
            }
            let timeout = remaining_before(deadline)
                .map_err(|error| categorize_io_error(&error, false))?;
            let mut stream = TcpStream::connect_timeout(address, timeout)
                .map_err(|error| categorize_io_error(&error, false))?;
            stream.set_nonblocking(true)
                .map_err(|error| categorize_io_error(&error, false))?;
            exchange_http(&mut stream, method, path, deadline)
        }
    }
}

fn exchange_http<S: LocalHttpStream>(
    stream: &mut S,
    method: HttpMethod,
    path: &str,
    deadline: Instant,
) -> Result<Vec<u8>, CovenAdapterError> {
    let request = format!(
        "{} {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        method.as_str(),
    );
    write_all_before(stream, request.as_bytes(), deadline)
        .map_err(|error| categorize_io_error(&error, false))?;
    flush_before(stream, deadline).map_err(|error| categorize_io_error(&error, false))?;
    remaining_before(deadline).map_err(|error| categorize_io_error(&error, false))?;
    stream
        .shutdown_write()
        .map_err(|error| categorize_io_error(&error, false))?;
    let response = read_to_end_before(stream, deadline)
        .map_err(|error| categorize_io_error(&error, false))?;
    parse_http_response(&response).map_err(|_| CovenAdapterError::Failed)
}
```

Replace both discovery calls with these exact method-aware calls, then add the kill functions below:

```rust
let health_body = request_endpoint(
    endpoint,
    HttpMethod::Get,
    "/api/v1/health",
    deadline,
)?;
let sessions_body = request_endpoint(
    endpoint,
    HttpMethod::Get,
    "/api/v1/sessions",
    deadline,
)?;
```

```rust
fn try_kill_coven_session(
    endpoint: &CovenEndpoint,
    session_id: &str,
) -> Result<(), CovenAdapterError> {
    if !is_safe_session_id(session_id) {
        return Err(CovenAdapterError::Failed);
    }
    let deadline = Instant::now() + EXCHANGE_TIMEOUT;
    let health_body = request_endpoint(
        endpoint,
        HttpMethod::Get,
        "/api/v1/health",
        deadline,
    )?;
    let health: CovenHealthResponse = serde_json::from_slice(&health_body)
        .map_err(|_| CovenAdapterError::Failed)?;
    if health.api_version != STABLE_API_VERSION {
        return Err(CovenAdapterError::Incompatible);
    }
    let path = format!("/api/v1/sessions/{session_id}/kill");
    request_endpoint(endpoint, HttpMethod::Post, &path, deadline)?;
    Ok(())
}

fn adapter_error_message(error: CovenAdapterError) -> &'static str {
    match error {
        CovenAdapterError::Unavailable => UNAVAILABLE_MESSAGE,
        CovenAdapterError::Incompatible => INCOMPATIBLE_MESSAGE,
        CovenAdapterError::Failed => "Coven session could not be stopped",
    }
}

#[tauri::command]
pub(crate) async fn coven_session_kill(session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_session_id(&session_id) {
            return Err("Invalid Coven session".to_string());
        }
        let env = coven_environment([
            ("COVEN_SOCKET", std::env::var_os("COVEN_SOCKET")),
            ("COVEN_HOME", std::env::var_os("COVEN_HOME")),
            ("COVEN_URL", std::env::var_os("COVEN_URL")),
            ("COVEN_PORT", std::env::var_os("COVEN_PORT")),
        ]).map_err(|_| "Coven session could not be stopped".to_string())?;
        let home = home_path(std::env::var_os("HOME"));
        let endpoint = resolve_endpoint(&env, &home)
            .map_err(|_| "Coven session could not be stopped".to_string())?;
        try_kill_coven_session(&endpoint, &session_id)
            .map_err(|error| adapter_error_message(error).to_string())
    })
    .await
    .map_err(|_| "Coven session could not be stopped".to_string())?
}
```

In `lib.rs`, replace the single import with the first line below and insert the command immediately after `coven_sessions,` in `tauri::generate_handler!`:

```rust
use coven_sessions::{coven_session_kill, coven_sessions};

coven_sessions,
coven_session_kill,
```

- [ ] **Step 5: Run focused native tests and verify GREEN**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml coven_sessions::tests
pnpm vitest --run __tests__/tauriCovenSessionNativeContract.test.ts
```

Expected: all selected Rust and Vitest tests pass with exact GET/POST request bytes and registered command evidence.

- [ ] **Step 6: Commit the native boundary**

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriCovenSessionNativeContract.test.ts
git diff --cached --check
git commit -m "feat(macos): add Coven session kill command"
```

### Task 2: Make local session close visible and destructive only after confirmation

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:4755-4795`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5640-5750`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:649-675`
- Test: `__tests__/tauriCovenSessionSiderail.test.ts`
- Test: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Write failing local-row interaction and CSS tests**

First update the harness's returned helper signature:

```ts
armSessionClose: (
  wrapper: FakeElement,
  close: FakeElement,
  label: string,
  onConfirm: () => unknown,
) => void;
```

In the existing `timed close confirm` helper, replace the direct arm call with:

```ts
renderer.armSessionClose(row, close, 'Local', () => {
  renderer.closeThread('local');
});
```

Then add renderer assertions that use the existing fake DOM event helpers:

```ts
it('shows a guarded stop-and-close action on local rows', () => {
  const renderer = createRenderer({
    threads: [{
      id: 'local', projectId: 'alpha', worktreePath: '/alpha',
      name: 'Local', kind: 'shell', status: 'running',
    }],
  });
  renderer.render();

  const row = renderer.sessionListEl.querySelector('.session-row');
  const close = row?.querySelector('.session-close');
  expect(close?.title).toBe('Stop and close Local');
  expect(close?.getAttribute('aria-label')).toBe('Stop and close Local');

  close?.click();
  expect(renderer.closeThread).not.toHaveBeenCalled();
  const confirm = row?.querySelector('.session-close-confirm');
  expect(confirm?.textContent).toBe('Close · 3');

  confirm?.click();
  expect(renderer.closeThread).toHaveBeenCalledTimes(1);
  expect(renderer.closeThread).toHaveBeenCalledWith('local');
});

it('arms rather than immediately closes from the Delete shortcut', async () => {
  const renderer = createRenderer({
    threads: [{
      id: 'local', projectId: 'alpha', worktreePath: '/alpha',
      name: 'Local', kind: 'shell', status: 'running',
    }],
  });
  renderer.render();
  const row = renderer.sessionListEl.querySelector('.session-row');
  row?.focus();
  await row?.emit('keydown', { key: 'Delete' });

  expect(renderer.closeThread).not.toHaveBeenCalled();
  expect(row?.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
});
```

In `tauriWorkspaceRail.test.ts`, replace the hover-only expectation with:

```ts
expect(styles).toMatch(/\.session-close\s*\{[^}]*opacity:\s*1;/);
expect(styles).not.toMatch(
  /\.session-row-wrap:hover \.session-close[^}]*\{[^}]*opacity\s*:/,
);
expect(mainJs).toContain('row.setAttribute("aria-keyshortcuts", "Delete")');
expect(mainJs).toContain('armSessionClose(row, close, thread.name');
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts __tests__/tauriWorkspaceRail.test.ts
```

Expected: the button still advertises Hide, immediately calls `hideThread`, and CSS hides it at rest.

- [ ] **Step 3: Generalize the confirmation helper and wire local close**

Change `armSessionClose` to accept a label and callback:

```js
function armSessionClose(host, close, label, onConfirm) {
  disarmSessionClose();
  var left = SESSION_CLOSE_SECONDS;
  var confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "session-close-confirm";
  confirm.title = "Click to confirm — auto-cancels when the timer runs out";
  function paint() {
    confirm.textContent = "Close · " + left;
    confirm.setAttribute("aria-label", "Confirm closing " + label);
  }
  paint();
  confirm.addEventListener("click", function (event) {
    event.stopPropagation();
    disarmSessionClose();
    onConfirm();
  });
  close.hidden = true;
  host.appendChild(confirm);
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) { disarmSessionClose(); return; }
    paint();
  }, 1000);
  armedSessionClose = { timer: timer, confirm: confirm, close: close };
  confirm.focus();
}
```

For local rows, preserve `Hide` only in the context menu and make the visible action guarded:

```js
close.title = "Stop and close " + thread.name;
close.setAttribute("aria-label", close.title);
close.setAttribute("tabindex", "-1");
close.textContent = "×";
function armLocalClose() {
  armSessionClose(row, close, thread.name, function () {
    closeThread(thread.id);
  });
}
close.addEventListener("click", function (event) {
  event.stopPropagation();
  armLocalClose();
});
```

Use `armLocalClose()` for the local row's `Delete` handler and context-menu `Stop and close` item. Delete the old `dismissLocalRow` helper, but retain `{ label: "Hide", run: function () { hideThread(thread.id); } }`.

- [ ] **Step 4: Make the action visible at rest**

Change only the close opacity and obsolete reveal selector:

```css
.session-close {
  /* keep position, dimensions, colors, and transitions */
  opacity: 1;
}
.session-close:focus-visible {
  outline: 1px solid var(--accent-line);
  outline-offset: 1px;
}
.session-close:hover { background: var(--surface-3); color: var(--text); }
```

Keep `.session-row-wrap .session-row { padding-right: 32px; }`; remove the hover/focus rule whose only job was changing opacity.

- [ ] **Step 5: Run focused UI tests and verify GREEN**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts __tests__/tauriWorkspaceRail.test.ts
```

Expected: both files pass; the first click arms and the confirmation click calls `closeThread` once.

- [ ] **Step 6: Commit the local row behavior**

```bash
git add native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git diff --cached --check
git commit -m "fix(macos): expose guarded session close controls"
```

### Task 3: Wire daemon-backed Coven rows to native stop-and-close

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:395-470`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5560-5630`
- Test: `__tests__/tauriCovenSessionSiderail.test.ts`

- [ ] **Step 1: Extend the renderer harness and write failing Coven tests**

Add these option fields:

```ts
invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
refreshCovenSessions?: () => Promise<unknown>;
```

Create the dependencies beside `setStatus`:

```ts
const invoke = options.invoke ?? vi.fn(async () => undefined);
const refreshCovenSessions = options.refreshCovenSessions ?? vi.fn(async () => undefined);
```

Add the close state and function to `sources` before `renderSessionList`:

```ts
'var covenSessionCloseFlights = new Set();',
extractFunctionSource(mainJs, 'closeCovenSession'),
```

Add `'invoke', 'refreshCovenSessions'` to the generated `Function` argument
names, pass the two local functions in the corresponding invocation positions,
and insert these properties in the existing returned object immediately after
`...harness,`:

```ts
invoke,
refreshCovenSessions,
```

Then add these interaction tests:

```ts
it('stops a Coven row once and refreshes only after success', async () => {
  const invoke = vi.fn(async () => undefined);
  const refreshCovenSessions = vi.fn(async () => undefined);
  const renderer = createRenderer({
    invoke,
    refreshCovenSessions,
    sessions: [{
      id: 'coven-1', projectRoot: '/alpha', cwd: '/alpha',
      title: 'Agent Coven', harness: 'codex', status: 'running',
      labels: ['source:psyche-build'],
    }],
  });
  renderer.render();

  const row = covenRows(renderer.sessionListEl)[0];
  const close = row?.querySelector('.session-close');
  close?.click();
  row?.querySelector('.session-close-confirm')?.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('coven_session_kill', {
    sessionId: 'coven-1',
    session_id: 'coven-1',
  });
  expect(refreshCovenSessions).toHaveBeenCalledTimes(1);
  expect(renderer.openCovenSession).not.toHaveBeenCalled();
});

it('retains a Coven row and reports a failed stop', async () => {
  const invoke = vi.fn(async () => { throw new Error('daemon refused'); });
  const refreshCovenSessions = vi.fn();
  const renderer = createRenderer({
    invoke,
    refreshCovenSessions,
    sessions: [{
      id: 'coven-1', projectRoot: '/alpha', cwd: '/alpha',
      title: 'Agent Coven', status: 'waiting', labels: ['source:psyche-build'],
    }],
  });
  renderer.render();
  const row = covenRows(renderer.sessionListEl)[0];
  row?.querySelector('.session-close')?.click();
  row?.querySelector('.session-close-confirm')?.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(refreshCovenSessions).not.toHaveBeenCalled();
  expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
  expect(renderer.setStatus).toHaveBeenCalledWith(
    'Stop and close failed: Error: daemon refused',
    'error',
  );
});

it('deduplicates Coven stop requests while one is in flight', async () => {
  let resolveInvoke: () => void = () => {};
  const pending = new Promise<void>((resolve) => { resolveInvoke = resolve; });
  const invoke = vi.fn(() => pending.promise);
  const renderer = createRenderer({
    invoke,
    sessions: [{
      id: 'coven-1', projectRoot: '/alpha', cwd: '/alpha',
      title: 'Agent Coven', status: 'running', labels: ['source:psyche-build'],
    }],
  });
  renderer.render();
  const row = covenRows(renderer.sessionListEl)[0];
  row?.querySelector('.session-close')?.click();
  row?.querySelector('.session-close-confirm')?.click();
  row?.querySelector('.session-close')?.click();
  row?.querySelector('.session-close-confirm')?.click();
  expect(invoke).toHaveBeenCalledTimes(1);
  resolveInvoke();
  await pending.promise;
});
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: Coven rows have no `.session-close`, and `closeCovenSession` is absent.

- [ ] **Step 3: Add deduplicated Coven close orchestration**

Near discovery state, add:

```js
var covenSessionCloseFlights = new Set();

async function closeCovenSession(session) {
  if (!session || !session.id || covenSessionCloseFlights.has(session.id)) return false;
  covenSessionCloseFlights.add(session.id);
  try {
    await invoke("coven_session_kill", {
      sessionId: session.id,
      session_id: session.id,
    });
    await refreshCovenSessions();
    return true;
  } catch (error) {
    setStatus("Stop and close failed: " + String(error), "error");
    return false;
  } finally {
    covenSessionCloseFlights.delete(session.id);
  }
}
```

In the Coven-row branch of `renderSessionList`, add the same trailing control before appending the wrapper:

```js
var close = document.createElement("button");
close.type = "button";
close.className = "session-close";
close.title = "Stop and close " + rowModel.title;
close.setAttribute("aria-label", close.title);
close.setAttribute("tabindex", "-1");
close.textContent = "×";
function armCovenClose() {
  armSessionClose(row, close, rowModel.title, function () {
    closeCovenSession(rowModel.value);
  });
}
close.addEventListener("click", function (event) {
  event.stopPropagation();
  armCovenClose();
});
row.addEventListener("keydown", function (event) {
  if (event.target !== row || document.activeElement !== row) return;
  if (event.key !== "Delete") return;
  event.preventDefault();
  armCovenClose();
});
row.setAttribute("aria-keyshortcuts", "Delete");
row.appendChild(close);
row.addEventListener("contextmenu", function (event) {
  openSessionContextMenu(event, [
    {
      label: attached ? "Focus attachment" : "Attach",
      run: activateCovenRow,
    },
    {
      label: "Stop and close",
      danger: true,
      run: armCovenClose,
    },
  ]);
});
```

Place the close click listener before `row.appendChild(close)`. Its
`event.stopPropagation()` prevents the existing row activation listener from
observing close clicks; the context menu's first item delegates to the existing
`activateCovenRow` function.

- [ ] **Step 4: Run focused renderer and contract tests and verify GREEN**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: all selected tests pass; success invokes once then refreshes, failure retains the row and does not refresh.

- [ ] **Step 5: Commit Coven row wiring**

```bash
git add native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts
git diff --cached --check
git commit -m "feat(macos): close Coven sessions from the rail"
```

### Task 4: Verify the complete slice

**Files:**
- Verify: all files changed in Tasks 1-3

- [ ] **Step 1: Run formatting and static checks**

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
pnpm typecheck
git diff --check HEAD~3
```

Expected: all commands exit 0 with no TypeScript errors, Rust formatting drift, or whitespace errors.

- [ ] **Step 2: Run native and UI regression suites**

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
pnpm vitest --run \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriCovenLaunch.test.ts
pnpm --filter psyche-build-tauri run build:web
pnpm build
```

Expected: Rust, focused Vitest, native web bundle, and root build all pass.

- [ ] **Step 3: Perform packaged manual acceptance**

Launch the dev app with `pnpm dev:tauri`, then verify:

1. A local live pane row and an eligible `source:psyche-build` Coven row each show an `×` without hover.
2. The first click shows `Close · 3`; allowing it to expire leaves the session running.
3. Confirming a local close stops its PTY and removes the row.
4. Confirming a Coven close stops the daemon session and removes the row after discovery refresh.
5. Right-click `Hide` leaves a local process alive, while `Stop and close` uses the same confirmation.
6. Keyboard focus remains on tree rows; `Delete` arms rather than immediately closes.
7. Disconnecting the Coven daemon before confirmation leaves the Coven row visible and shows an error.

Expected: all seven behaviors match the committed design with no row reflow or duplicate kill request.

- [ ] **Step 4: Record final evidence without creating an extra commit**

```bash
git status --short --branch
git log -4 --oneline --show-signature
```

Expected: only the intended commits are present, every implementation commit has a good signature, and the worktree is clean. If verification required a correction, add a focused regression test first and amend the owning task in a new signed fix commit rather than hiding the change in documentation.
