# macOS Project-Scoped Coven Session Siderail Implementation Plan

> **Execution:** Work only in the `docs/macos-coven-session-siderail` worktree. Use strict TDD: add each focused test, prove it fails for the expected reason, make the smallest implementation change, then rerun the focused test before committing. Do not touch the dirty canonical checkout or the separate session-centric worktree.

**Goal:** Extend the existing macOS Tauri sessions rail with read-only, project-scoped Coven daemon sessions that attach through the existing PTY path without affecting local Psyche sessions when Coven is absent or unhealthy.

**Architecture:** Add a small Rust Tauri adapter that discovers the supported local Coven endpoint, validates the stable daemon API, normalizes and scopes sessions, and returns structured states to the webview. Keep remote discovery separate from `state.threads`; expose pure webview helpers through a small IIFE bundle, then join local and remote rows only while rendering the existing rail.

**Technology:** Rust 2021, Tauri 2, `serde`/`serde_json`, standard-library Unix/TCP streams, vanilla JavaScript, esbuild, Vitest, pnpm.

---

## Task 1: Add the native response model, endpoint resolution, and session normalization

**Files:**

- Create: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`

### Step 1: Write failing unit tests for endpoint precedence and safe identifiers

Create `coven_sessions.rs` with a `#[cfg(test)] mod tests` that constructs environment maps directly, never mutating the process environment. Cover these exact cases:

```rust
#[test]
fn endpoint_precedence_is_socket_home_network_default() {
    let home = Path::new("/Users/val");

    let endpoint = resolve_endpoint(
        &env(&[
            ("COVEN_SOCKET", "/tmp/direct.sock"),
            ("COVEN_HOME", "/tmp/coven-home"),
            ("COVEN_URL", "http://127.0.0.1:9777"),
        ]),
        home,
    )
    .unwrap();
    assert_eq!(endpoint, CovenEndpoint::Unix(PathBuf::from("/tmp/direct.sock")));

    let endpoint = resolve_endpoint(&env(&[("COVEN_HOME", "/tmp/coven-home")]), home).unwrap();
    assert_eq!(endpoint, CovenEndpoint::Unix(PathBuf::from("/tmp/coven-home/coven.sock")));

    let endpoint = resolve_endpoint(&env(&[("COVEN_PORT", "9777")]), home).unwrap();
    assert_eq!(endpoint, CovenEndpoint::Http(SocketAddr::from(([127, 0, 0, 1], 9777))));

    let endpoint = resolve_endpoint(&HashMap::new(), home).unwrap();
    assert_eq!(endpoint, CovenEndpoint::Unix(PathBuf::from("/Users/val/.coven/coven.sock")));
}

#[test]
fn explicit_http_must_be_loopback() {
    assert!(resolve_endpoint(
        &env(&[("COVEN_URL", "https://example.com:7777")]),
        Path::new("/Users/val"),
    )
    .is_err());
    assert!(resolve_endpoint(
        &env(&[("COVEN_URL", "http://192.0.2.1:7777")]),
        Path::new("/Users/val"),
    )
    .is_err());
}

#[test]
fn attach_ids_use_the_documented_safe_set() {
    assert!(is_safe_session_id("release:fix_01.a-b"));
    assert!(!is_safe_session_id(""));
    assert!(!is_safe_session_id("id with spaces"));
    assert!(!is_safe_session_id("$(touch /tmp/nope)"));
    assert!(!is_safe_session_id(&"a".repeat(129)));
}
```

Run:

```bash
cd native/macos/psyche-build-tauri/src-tauri
cargo test --locked coven_sessions::tests::endpoint_precedence_is_socket_home_network_default
```

Expected: FAIL because the module and resolver do not exist.

### Step 2: Implement the response types and resolver

Implement these types and constants in `coven_sessions.rs`:

```rust
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const STABLE_API_VERSION: &str = "coven.daemon.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
enum CovenEndpoint {
    Unix(PathBuf),
    Http(SocketAddr),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CovenSessionSummary {
    id: String,
    project_root: String,
    cwd: Option<String>,
    harness: Option<String>,
    title: Option<String>,
    status: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CovenSessionsResponse {
    status: String,
    sessions: Vec<CovenSessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
```

`resolve_endpoint(env, home)` must apply this precedence exactly:

1. non-empty `COVEN_SOCKET`;
2. `$COVEN_HOME/coven.sock` only when neither `COVEN_URL` nor `COVEN_PORT` is set;
3. `COVEN_URL` or `COVEN_PORT`, restricted to `http` and loopback hosts (`127.0.0.1`, `localhost`, or `::1`);
4. `$HOME/.coven/coven.sock`.

Parse `COVEN_URL` with `tauri::Url`; reject credentials, query, fragment, a non-root path, a missing port, or any non-loopback resolved address. Parse `COVEN_PORT` as a non-zero `u16`. Keep `is_safe_session_id` private and enforce `1..=128` ASCII characters from `[A-Za-z0-9._:-]`.

Add `mod coven_sessions;` near the imports in `lib.rs`; registration comes in Task 3.

Run:

```bash
cargo fmt --check
cargo test --locked coven_sessions::tests::endpoint_precedence_is_socket_home_network_default
cargo test --locked coven_sessions::tests::explicit_http_must_be_loopback
cargo test --locked coven_sessions::tests::attach_ids_use_the_documented_safe_set
```

Expected: PASS.

### Step 3: Add failing normalization and project-scoping tests

Use `tempfile`-free temporary directories under `std::env::temp_dir()` with a unique process-id/counter suffix and remove only those exact directories in a drop guard. Add tests that prove:

```rust
#[test]
fn normalizes_envelopes_and_scopes_by_canonical_root() {
    let fixture = ProjectFixture::new("normalize");
    let app = fixture.mkdir("app");
    let application = fixture.mkdir("application");
    let payload = json!({
        "sessions": [
            {
                "id": "one",
                "project_root": app,
                "cwd": fixture.path("app/src"),
                "harness": "codex",
                "title": "Fix release",
                "status": "running",
                "updated_at": "2026-08-03T12:00:00Z"
            },
            { "id": "prefix-collision", "projectRoot": application },
            { "id": "missing-root" },
            { "id": "bad id", "projectRoot": app }
        ]
    });

    let sessions = normalize_sessions(payload, &[app.to_string_lossy().to_string()]).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "one");
    assert_eq!(sessions[0].project_root, app.to_string_lossy());
}
```

Also cover a top-level list, camelCase timestamps, an unreadable/missing session root, a `cwd` outside the project, an invalid item beside a valid item, and duplicate requested roots that canonicalize to one directory.

Run:

```bash
cargo test --locked coven_sessions::tests::normalizes_envelopes_and_scopes_by_canonical_root
```

Expected: FAIL because normalization is not implemented.

### Step 4: Implement normalization

Parse the payload through `serde_json::Value`. Accept only a list or an object with a list-valued `sessions`. For each record:

- read `id`, `projectRoot`/`project_root`, `cwd`, `harness`, `title`, `status`, and both timestamp spellings;
- require a safe id and a canonicalizable directory project root;
- compare the canonical `PathBuf` for exact equality with a canonical requested root;
- canonicalize `cwd` when present and drop it unless it is the matched root or `starts_with` that root path;
- return the original requested project-root spelling in `projectRoot`, so the webview can key the result to its existing project without a second canonicalization command;
- trim optional strings and map empty strings to `None`;
- drop invalid items while preserving valid siblings.

Malformed envelopes return an adapter error; malformed individual items are dropped.

Run:

```bash
cargo fmt --check
cargo test --locked coven_sessions::tests
```

Expected: PASS.

### Step 5: Commit the native model slice

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "feat: model project-scoped Coven sessions"
```

---

## Task 2: Add bounded Unix/TCP HTTP transport and structured adapter states

**Files:**

- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`

### Step 1: Write failing parser tests

Add table-driven tests for:

- 2xx plus `Content-Length`;
- 2xx plus `Transfer-Encoding: chunked`;
- incomplete declared bodies;
- invalid chunk sizes/terminators;
- non-2xx statuses;
- missing header terminator;
- response bytes over `MAX_RESPONSE_BYTES`.

The core assertions are:

```rust
assert_eq!(
    parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").unwrap(),
    br#"{"ok":true}"#
);
assert!(parse_http_response(
    b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{\"ok\":true}"
).is_err());
assert!(parse_http_response(
    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"
).is_err());
```

Run:

```bash
cargo test --locked coven_sessions::tests::http_parser
```

Expected: FAIL because the parser does not exist.

### Step 2: Implement the bounded HTTP parser

Implement `parse_http_response` without converting the full response to UTF-8:

- locate the first `\r\n\r\n` within the one-MiB cap;
- parse an ASCII status line and require `200..=299`;
- parse case-insensitive ASCII headers;
- decode `Transfer-Encoding: chunked`, including the zero chunk and trailer terminator;
- otherwise honor `Content-Length` exactly;
- when neither is present, accept the bytes after the header only because EOF from `Connection: close` proves completion;
- reject conflicting lengths, unsupported transfer encodings, extra/incomplete chunk bytes, and decoded bodies over the cap.

Return an owned `Vec<u8>` for JSON parsing.

Run:

```bash
cargo fmt --check
cargo test --locked coven_sessions::tests::http_parser
```

Expected: PASS.

### Step 3: Write failing transport and state-mapping tests

Add fake-server helpers that accept two sequential requests and return health then sessions. Cover both `UnixListener` (macOS/Linux) and `TcpListener` on `127.0.0.1:0`:

```rust
let response = load_coven_sessions(
    CovenEndpoint::Unix(server.socket_path().to_path_buf()),
    vec![project.to_string_lossy().to_string()],
);
assert_eq!(response.status, "ready");
assert_eq!(response.sessions[0].id, "release-fix");
assert_eq!(server.paths(), vec!["/api/v1/health", "/api/v1/sessions"]);
```

Add separate cases for:

- missing socket, refused connection, and read timeout -> `unavailable`;
- health `apiVersion` other than exactly `coven.daemon.v1` -> `incompatible`;
- malformed health/session JSON, malformed HTTP, and non-2xx -> `error`;
- a later successful call after a failure -> `ready` with no retained stale data.

Run:

```bash
cargo test --locked coven_sessions::tests::unix_round_trip
cargo test --locked coven_sessions::tests::tcp_round_trip
cargo test --locked coven_sessions::tests::maps_transport_and_contract_failures
```

Expected: FAIL because transport and state mapping do not exist.

### Step 4: Implement transport and adapter orchestration

Implement one request builder:

```rust
fn request_bytes(path: &str) -> Vec<u8> {
    format!(
        "GET {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}
```

For Unix sockets, set read and write timeouts immediately after connect. For TCP, use `TcpStream::connect_timeout`, require the resolved address to remain loopback, then set read and write timeouts. Read through `Read::take((MAX_RESPONSE_BYTES + 1) as u64)` and reject the extra byte before parsing.

`load_coven_sessions` must perform exactly:

1. `GET /api/v1/health`;
2. parse JSON and require `apiVersion == "coven.daemon.v1"`;
3. `GET /api/v1/sessions`;
4. normalize/scope sessions;
5. return `ready`.

Use an internal categorized error enum so only missing/refused/timed-out transport maps to `unavailable`, version mismatch maps to `incompatible`, and all contract/parser errors map to `error`. Public messages are fixed, non-sensitive strings:

```text
unavailable  -> Coven daemon is not running; run `coven daemon start`
incompatible -> Coven daemon API update required
error        -> Coven sessions could not be loaded
```

Do not log response bodies or session content.

Run:

```bash
cargo fmt --check
cargo test --locked coven_sessions::tests
```

Expected: PASS.

### Step 5: Commit transport

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs
git commit -m "feat: query the local Coven daemon safely"
```

---

## Task 3: Register the non-blocking Tauri command

**Files:**

- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Create: `__tests__/tauriCovenSessionNativeContract.test.ts`

### Step 1: Add a failing command-contract test

Read both Rust files as text and assert that:

```ts
expect(moduleSource).toContain('#[tauri::command]');
expect(moduleSource).toMatch(/pub\(crate\) async fn coven_sessions\(project_roots: Vec<String>\)/);
expect(moduleSource).toContain('spawn_blocking');
expect(libSource).toContain('coven_sessions::coven_sessions');
expect(libSource).toMatch(/generate_handler!\[[\s\S]*coven_sessions,/);
```

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionNativeContract.test.ts
```

Expected: FAIL because the command is not registered.

### Step 2: Implement and register the command

Expose an async command that moves environment collection and blocking socket/file-system work off the Tauri command future:

```rust
#[tauri::command]
pub(crate) async fn coven_sessions(project_roots: Vec<String>) -> CovenSessionsResponse {
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));

    tauri::async_runtime::spawn_blocking(move || discover(&env, &home, project_roots))
        .await
        .unwrap_or_else(|_| CovenSessionsResponse::error())
}
```

Import it in `lib.rs` and add `coven_sessions` to `tauri::generate_handler!` immediately after `app_environment`.

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionNativeContract.test.ts
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked
cargo check --locked
```

Expected: PASS.

### Step 3: Commit command registration

```bash
git add __tests__/tauriCovenSessionNativeContract.test.ts native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "feat: expose Coven discovery to the desktop"
```

---

## Task 4: Add the pure webview session model and bundle

**Files:**

- Create: `native/macos/psyche-build-tauri/web/sessions/session-model.mjs`
- Create: `native/macos/psyche-build-tauri/web/sessions/session-entry.js`
- Create: `__tests__/tauriSessionModel.test.ts`
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

### Step 1: Write failing model tests

Import `session-model.mjs` directly from Vitest. Cover:

```ts
expect(isSafeCovenSessionId('release:fix_01.a-b')).toBe(true);
expect(isSafeCovenSessionId('bad id')).toBe(false);

expect(sortCovenSessions([
  { id: 'done', status: 'completed', updatedAt: '2026-08-03T13:00:00Z' },
  { id: 'waiting', status: 'waiting', updatedAt: '2026-08-03T11:00:00Z' },
  { id: 'running', status: 'running', updatedAt: '2026-08-03T12:00:00Z' },
]).map((session) => session.id)).toEqual(['running', 'waiting', 'done']);

expect(statusPresentation('orphaned')).toEqual({ tone: 'danger', label: 'orphaned', live: false });
expect(statusPresentation('custom')).toEqual({ tone: 'neutral', label: 'custom', live: false });
```

Also test:

- grouping by exact `projectRoot`;
- filtering local titles plus Coven title/harness/status/id;
- a project-name hit including all rows;
- response phases `ready`, `unavailable`, `incompatible`, and `error` clearing stale remote rows;
- request generation ignoring stale responses after invalidation.

Run:

```bash
pnpm test -- __tests__/tauriSessionModel.test.ts
```

Expected: FAIL because the module does not exist.

### Step 2: Implement pure helpers

Export `isSafeCovenSessionId`, `statusPresentation`, `sortCovenSessions`,
`groupCovenSessions`, `filterProjectSessions`, `createCovenDiscoveryState`,
`beginCovenRequest`, `applyCovenResponse`, and `invalidateCovenRequests` from
`session-model.mjs`, then re-export the same named functions from
`session-entry.js`.

`isSafeCovenSessionId` enforces the exact 1..128 ASCII contract.
`statusPresentation` returns the stable `{ tone, label, live }` mapping.
`sortCovenSessions` sorts a cloned array by live state, `updatedAt`, then id.
`groupCovenSessions` returns a new `Map` keyed by exact `projectRoot`.
`filterProjectSessions` returns the matched local/remote arrays plus whether the
project name matched. The four state functions return new discovery objects;
they never mutate the caller's state or map.

Do not mutate input arrays or maps. Normalize search with `trim().toLowerCase()`. Treat `starting`, `running`, and `waiting` as live; preserve the raw normalized status label for unknown values.

### Step 3: Bundle the model for the static webview

Update `build:web` to build both bundles in sequence:

```json
"build:web": "esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js"
```

Add `<script src="./sessions.bundle.js" defer></script>` between `editor.bundle.js` and `main.js`. Update the existing package-contract assertion in `tauriWorkspacePanels.test.ts` to require both commands and both script tags.

Run:

```bash
pnpm test -- __tests__/tauriSessionModel.test.ts __tests__/tauriWorkspacePanels.test.ts
pnpm --dir native/macos/psyche-build-tauri build:web
test -s native/macos/psyche-build-tauri/web/sessions.bundle.js
```

Expected: PASS.

### Step 4: Commit the model bundle

```bash
git add __tests__/tauriSessionModel.test.ts __tests__/tauriWorkspacePanels.test.ts native/macos/psyche-build-tauri/package.json native/macos/psyche-build-tauri/web/index.html native/macos/psyche-build-tauri/web/sessions native/macos/psyche-build-tauri/web/sessions.bundle.js
git commit -m "feat: add desktop session discovery model"
```

---

## Task 5: Add discovery lifecycle and safe attach behavior

**Files:**

- Create: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

### Step 1: Write failing lifecycle/attach tests

Follow the existing `extractFunctionSource` pattern from `tauriWorkspaceEditorIntegration.test.ts`. Assert and execute the isolated functions with stubs to prove:

- `refreshCovenSessions` invokes `coven_sessions` once with every open `project.root`;
- a stale response is ignored after a newer request or project removal;
- the five-second poll starts only while visible, stops while hidden, and refreshes immediately on visibility restore;
- adding/removing/restoring projects refreshes discovery;
- clicking an already attached id focuses the existing non-exited thread;
- clicking an unattached safe id calls `createThread` with discrete values;
- unsafe ids never call `createThread`.

The key attach expectation is:

```ts
expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
  project,
  kind: 'coven',
  command: 'coven',
  args: ['attach', 'release-fix'],
  projectRoot: project.root,
  covenSessionId: 'release-fix',
}));
```

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: FAIL because discovery and attach helpers do not exist.

### Step 2: Integrate remote discovery without touching local thread state

After the main `state` declaration, add:

```js
var covenDiscovery = PsycheSessions.createCovenDiscoveryState();
var covenPollTimer = null;
var COVEN_POLL_MS = 5000;
```

Implement:

```js
async function refreshCovenSessions() {
  var started = PsycheSessions.beginCovenRequest(covenDiscovery);
  covenDiscovery = started.state;
  renderSessionList();
  try {
    var response = await invoke("coven_sessions", {
      projectRoots: state.projects.map(function (project) { return project.root; }),
    });
    covenDiscovery = PsycheSessions.applyCovenResponse(covenDiscovery, started.requestId, response);
  } catch (_err) {
    covenDiscovery = PsycheSessions.applyCovenResponse(covenDiscovery, started.requestId, {
      status: "error",
      sessions: [],
      message: "Coven sessions could not be loaded",
    });
  }
  renderSessionList();
}
```

`startCovenPolling` clears any prior timer, does nothing while hidden, refreshes immediately, then installs a five-second interval. `stopCovenPolling` clears and nulls the timer. Extend the existing `visibilitychange` listener: hidden saves and stops; visible starts.

Call an immediate refresh after workspace restore, successful `addProject`, and `removeProject`. Before removing a project, assign `covenDiscovery = PsycheSessions.invalidateCovenRequests(covenDiscovery)` so a late result cannot repopulate it. Never copy remote rows into `state.threads`.

### Step 3: Persist attachment metadata and reuse the PTY path

Extend the thread object created by `createThread` with:

```js
covenSessionId: opts.covenSessionId || null,
```

Implement `openCovenSession(project, session)`:

1. reject unless `PsycheSessions.isSafeCovenSessionId(session.id)`;
2. activate the row's project with `setActiveProject(project.id)`;
3. find a non-exited local thread with the same `projectId` and `covenSessionId` and focus it;
4. otherwise call `createThread` with `command: "coven"`, `args: ["attach", session.id]`, and the metadata shown in the test.

Do not construct a shell command or quote/interpolate the id.

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionLifecycle.test.ts
pnpm test -- __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: PASS, including existing project removal and visibility behavior.

### Step 4: Commit lifecycle and attach

```bash
git add __tests__/tauriCovenSessionLifecycle.test.ts native/macos/psyche-build-tauri/web/main.js
git commit -m "feat: refresh and attach Coven desktop sessions"
```

---

## Task 6: Render the two project subsections and inline states

**Files:**

- Create: `__tests__/tauriCovenSessionSiderail.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`

### Step 1: Write failing renderer contract tests

Exercise `renderSessionList` with the repository's existing lightweight DOM
stubs and function-extraction harness, using project, local-thread, and remote
discovery fixtures. Do not add a browser-emulation dependency. Verify:

- one project group contains `Psyche` and `Coven` labels when both have rows;
- empty ready subsections are omitted;
- project-name search includes both sources;
- row search matches local title and Coven title/harness/status/id;
- remote rows sort live first, then `updatedAt`, then id;
- loading/unavailable/incompatible/error render exactly one inline line per project;
- a later ready response removes the inline error and restores remote rows;
- clicking a remote row calls `openCovenSession` and does not trigger rename/close behavior;
- existing local focus, rename, close, active, and no-results assertions remain unchanged.

Add static CSS assertions for subsection labels, inline state, remote metadata, and every required status tone.

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: FAIL because the renderer still emits only local rows.

### Step 2: Refactor `renderSessionList` around the pure model

For each project:

1. get local rows without changing their existing order;
2. get Coven rows from `covenDiscovery.sessionsByProject.get(project.root) || []`;
3. call `PsycheSessions.filterProjectSessions` with the current query;
4. omit the project only when neither source nor an applicable inline discovery state matches;
5. render `Psyche` before local rows and `Coven` before remote rows;
6. render one discovery line under the Coven label for `loading`, `unavailable`, `incompatible`, or `error`;
7. retain the existing global no-results row when a non-empty search matches nothing.

Build all text with `textContent`. Remote rows use buttons with `data-coven-session-id`, accessible labels containing the title/id and status, a primary title fallback of id, and secondary harness/status/id text. A row is active when a non-exited local attachment with the same id is active.

Map inline copy exactly:

```text
loading      Coven — loading…
unavailable  Coven unavailable
incompatible Coven update required
error        Coven could not load
```

Use the native message only as a `title` attribute; do not render raw error strings in the rail.

### Step 3: Add compact styles

Extend the existing session design tokens instead of creating a new rail. Add:

- `.session-subsection-label` with compact uppercase muted typography;
- `.session-coven-meta` with ellipsis and muted secondary text;
- `.session-inline-state` matching row indentation without hover chrome;
- status classes for `starting`, `running`, `waiting`, `completed`, `archived`, `failed`, `killed`, `orphaned`, and neutral;
- the existing pulse animation for `starting` only.

Keep row height, active marker, keyboard focus, and close-button layout unchanged for Psyche rows.

Run:

```bash
pnpm test -- __tests__/tauriCovenSessionSiderail.test.ts __tests__/tauriSessionModel.test.ts
pnpm test -- __tests__/tauriWorkspaceEditorIntegration.test.ts __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

### Step 4: Commit the renderer

```bash
git add __tests__/tauriCovenSessionSiderail.test.ts native/macos/psyche-build-tauri/web/main.js native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat: show Coven sessions in the project rail"
```

---

## Task 7: Run full gates and inspect the packaged app

**Files:**

- Modify only if a verification failure proves a defect in the files above.

### Step 1: Run focused desktop gates

```bash
pnpm test -- \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
pnpm --dir native/macos/psyche-build-tauri build:web
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked
cargo check --locked
```

Expected: all pass.

### Step 2: Run repository gates

From the worktree root:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
```

Expected: all pass. Record the exact test/pass counts for handoff.

### Step 3: Build the unsigned desktop artifact

```bash
pnpm --dir native/macos/psyche-build-tauri build
```

Expected: Tauri produces the unsigned app/DMG successfully. Record exact artifact paths and SHA-256 checksums:

```bash
find native/macos/psyche-build-tauri/src-tauri/target/release/bundle -type f \( -name '*.dmg' -o -name '*.app.tar.gz' \) -print
shasum -a 256 native/macos/psyche-build-tauri/src-tauri/target/release/bundle/dmg/*.dmg
```

### Step 4: Perform packaged behavior smoke

Launch the built `.app` from `target/release/bundle/macos`. Inspect all of these in the packaged webview:

1. With Coven stopped: local Psyche rows remain interactive and each project shows one `Coven unavailable` line.
2. With a fake or real stable daemon: only exact-root sessions appear; a prefix-collision project does not leak rows.
3. Search matches project, local title, remote title, harness, status, and id.
4. Clicking a Coven row opens `coven attach <id>` in the existing terminal surface.
5. Clicking the same row again focuses the existing attachment instead of spawning a duplicate.
6. Stop/restart the daemon and confirm the five-second poll replaces rows with the inline state and then recovers.
7. Hide/show the window and confirm polling pauses and refreshes immediately on return.

Capture a screenshot showing one project with both subsections and retain the fake-daemon fixture command/output used for the smoke.

### Step 5: Final verification commit, only if generated bundle output changed

```bash
git status --short
git diff --check
```

If `sessions.bundle.js` changed after the final build, commit only that verified generated output:

```bash
git add native/macos/psyche-build-tauri/web/sessions.bundle.js
git commit -m "build: refresh desktop session bundle"
```

Do not create an empty commit. Confirm the worktree is clean before publishing.

### Step 6: Prepare maintainer handoff

Report:

- commit list and exact changed files;
- focused and full test counts;
- Rust gate results;
- packaged artifact paths/checksums;
- packaged smoke evidence, including daemon absent/recovery and attach reuse;
- any proof gap that remains.

Do not merge or tag from this worktree. Release integration remains a separate reviewed workflow.
