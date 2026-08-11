# Mount the canonical control socket on the daemon

Date: 2026-08-08
Status: Approved (design)
Author: cody

## Summary

Make the canonical `ControlServer` live. Today the entire control-socket layer
(`src/control/server.ts`, `client.ts`, `credentials.ts`, `endpoint.ts`) is built
and unit-tested but has **no production caller** — `ControlServer.start()` and
`createControlCredentialStore()` are never invoked by the running daemon. All
runtime traffic still arrives over the legacy v0 WebSocket, whose
`Connection.dispatch` translates into `host.runtime` (the single mutation
authority established by PRs 1–3c).

This PR mounts `ControlServer` inside `runDaemon`, bound to the project-derived
endpoint and backed by the same `host.runtime` and owner epoch the WebSocket
already uses. After this change, an external operator/agent `ControlClient` can
connect over the canonical Unix socket and drive **every** daemon mutation
(panes + coven sessions) through the single authority, receiving the rich typed
results the handlers already return.

This is the capstone of the PR 1→3c sequence: the authority is built, the
handlers are wired, the socket layer is written — this PR opens the door.

## Goals

- Start `ControlServer` in `runDaemon`, alongside the existing v0 WebSocket,
  against the already-created `host.runtime` / `host.epoch`.
- Self-provision operator/agent credentials via the existing
  `createControlCredentialStore` (auto-mints tokens to
  `.psyche/runtime/control-credentials.json`, 0700 dir / 0600 file). No new
  secret-handling story.
- Close the control socket cleanly on daemon shutdown, alongside `host.close()`.
- Prove end-to-end reachability: a real `ControlClient` authenticating with the
  store's token can drive a pane mutation and a coven-session mutation through
  the mounted server and receive typed results.

## Non-Goals (YAGNI)

- **No `ControlClient` convenience wrappers** (typed `launchCovenSession()` etc.).
  Defer until a real in-tree consumer exists — `submit()` is sufficient for the
  e2e proof.
- **No new CLI verb** to print/rotate tokens. The credential file is the
  contract; a `psyche control token` verb can come in a later PR when a human
  workflow needs it.
- **No change to the v0 WebSocket path.** Legacy clients keep flowing through
  `Connection.dispatch` → `host.runtime` unchanged; they never touch the new
  socket. The daemon adapter keeps minting its in-process
  `compatibilityPrincipal`.
- **No `panes.meta` cutover** (still blocked by the `updatePaneMeta` circular
  import; out of scope).
- **No authz policy change.** `authorizeCommand` already gates operator-only
  takeover/delegate; agent tokens get read+mutate.

## Architecture

### Single insertion point in `runDaemon`

In `src/daemon/index.ts`, immediately after `host` is created
(`createHostControlPlane(canonicalProjectRoot, { handlers })`, ~line 120) and
before accepting connections:

```ts
const controlCredentials = await createControlCredentialStore({
  projectRoot: canonicalProjectRoot,
});
const controlEndpoint = controlEndpointForProject(canonicalProjectRoot);
const controlServer = await ControlServer.start({
  projectRoot: canonicalProjectRoot,
  endpoint: controlEndpoint,
  runtime: host.runtime,
  ownerEpoch: host.epoch,
  credentials: controlCredentials,
});
console.log(`psyche control socket listening on ${controlEndpoint}`);
```

The v0 `WebSocketServer` construction and connection handling are unchanged.
Both servers share one `host.runtime`, so all mutations — from either door —
pass through the same journaled, lease-revalidating authority.

### Shutdown

The existing `shutdown(signal)` handler (~lines 167–175) currently does
`wss.close()` then `await host.close()`. Extend it to also
`await controlServer.close()` before (or concurrently with) `host.close()`.
`ControlServer.close()` destroys live sockets, stops listening, and unlinks the
socket file. Order: close the transports (`wss`, `controlServer`) first, then
release the owner fence (`host.close()`), then `process.exit(0)`.

### Data flow (new door)

```
ControlClient.connect({ projectRoot, token })
  → hello → auth(token) → root-match → welcome{ ownerEpoch, principal }
  → submit(command: pane.* | coven.session.launch|open | coven.desktop.action
           | coven.capability.execute)
    → ControlAuthority.submitAs(principal, input)
       → authorizeCommand(principal, kind)         // operator-only gates
       → stamp { projectRoot, actor, ownerEpoch }  // server-side identity
       → host.runtime.submit(command)
          → createDaemonControlHandlers (already wired into host)
    ← CommandOutcome { status, value?, code?, message? }
```

Rich results already returned by the handlers (`CovenSessionSummary`,
`{ id, pane, session }`, capability `execution`) surface via `outcome.value`.

## Error Handling

- **Bind failure is fatal to daemon startup.** `ControlServer.start` does
  `rm -f` on the stale endpoint then `listen`. Because `host` (the owner fence)
  has already been acquired successfully at this point, a bind failure is a real
  conflict, not a benign race — so it should propagate and abort daemon startup,
  consistent with how other startup errors are surfaced. We do **not**
  log-and-continue-degraded; a daemon that owns the project but silently lacks
  its canonical socket would be a confusing half-state.
- If `ControlServer.start` throws after `host` is created, `host.close()` must
  still run so the owner lock is released. Wrap the start in a `try` that
  releases `host` on failure before rethrowing (mirrors `createHostControlPlane`'s
  own lock-release-on-failure pattern).
- Per-connection errors (bad auth, unknown command kind, oversized frame) are
  already handled inside `ControlServer`/`ControlAuthority` from PR 3a hardening
  and are unchanged here.

## Testing

One new integration test (`__tests__/daemon/controlSocketMount.test.ts` or
extend an existing control e2e suite) that exercises the **real** stack over a
temp endpoint — no daemon process spawn required, just the same wiring
`runDaemon` uses:

1. Build a real `host` via `createHostControlPlane` with a memory journal and
   `createDaemonControlHandlers` over a `RecordingTmux` + injected coven deps
   (reuse the harness from `daemonConnection.test.ts` / `controlAdapter.test.ts`).
2. Create a credential store pointed at a temp file; start `ControlServer` on a
   temp endpoint against `host.runtime` / `host.epoch`.
3. Connect a real `ControlClient` with the store's operator token.
4. **Assert pane path:** `submit(pane.input …)` succeeds and the keystrokes reach
   the RecordingTmux (`sendKeysHex`).
5. **Assert coven path:** `submit(coven.session.launch …)` succeeds and returns a
   typed `CovenSessionSummary` from `outcome.value`.
6. **Assert auth rejection:** a `ControlClient` connecting with a bogus token is
   refused at the auth step.
7. Clean up: `client.close()`, `controlServer.close()`, `host.close()`, temp
   dir removal.

This test is the behavioral contract that the mount is live and both mutation
families are reachable through the canonical door.

### Gate (standard psyche checklist)

- `pnpm typecheck` → 0 errors; `git checkout -- src/utils/generated-agents-doc.ts`
  before commit (typecheck regenerates the gitignored file).
- Focused: the new integration suite + `controlClient` + `controlCredentials` +
  `controlAdapter` suites.
- `pnpm test` → full suite green except the 2 known macOS `releaseWorkflow`
  `stat '%Lp'` failures (pre-existing, not regressions).
- `pnpm smoke` (real tmux + owner fence) → pass. Confirms the daemon actually
  binds the control socket at startup without lock collision.

## Rollout / Risk

- **Additive at the transport layer.** No existing client changes behavior; the
  new socket is a second, independent entry into the same authority. Risk is
  concentrated in daemon startup/shutdown ordering, covered by `smoke` + the new
  integration test.
- **Security surface:** one new Unix-domain socket, 0600, at a project-scoped
  hashed endpoint, backed by constant-time token auth and server-side principal
  stamping — all pre-existing, hardened machinery from PR 3a. This PR adds no new
  policy, only turns the machinery on.

## Files (expected)

- `src/daemon/index.ts` — mount `ControlServer` + credential store in
  `runDaemon`; extend `shutdown` to close it; release `host` if start fails;
  startup log line. New imports from `../control/server.js`,
  `../control/credentials.js`, `../control/endpoint.js`.
- `__tests__/daemon/controlSocketMount.test.ts` — NEW e2e reachability test
  (pane + coven mutation + auth rejection).
- (Possibly) small export/harness tweaks if the test needs to reuse the
  `daemonConnection` handler-building helper.
