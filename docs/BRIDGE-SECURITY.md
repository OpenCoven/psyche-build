# Bridge and daemon security model

Psyche Build has two WebSocket transports and a separate canonical local
control IPC surface. Pane input can reach shells, so network reachability,
authentication, project scoping, and operation authorization must be evaluated
separately. A local socket or a successful handshake does not itself authorize
protected operations.

This document states what each surface trusts and refuses. It describes the
implementation's boundaries and known gaps, not blanket security certification.
Read it before adding a message type to any of these protocols.

## The three surfaces

| | LAN bridge | Legacy loopback daemon | Canonical control IPC |
|---|---|---|---|
| Code | `src/services/bridge/` | `src/daemon/` | `src/control/server.ts` |
| Transport | TLS WebSocket on `0.0.0.0`, ephemeral port | Plaintext WebSocket on `127.0.0.1:47123` by default | Unix socket or Windows named pipe |
| Discovery | Bonjour `_psyche._tcp` | none | canonical project-root endpoint |
| Auth | device token from bounded pairing, or invite profile only where wired | 256-bit token in `~/.config/psyche/token` | project-scoped control credentials and authenticated task bindings |
| Clients | companion apps | legacy local tooling | `psyche mcp` and control clients |
| Availability boundary | published workspace and negotiated protocol | each daemon instance enforces its project root | production operator commands and provider registration refuse pending trusted native brokers |

The LAN bridge is reachable from other machines and runs inside the TUI, so a
bridge crash can take down that session. Loopback and IPC reduce network
exposure, but do not isolate the application from arbitrary same-user code.

## What is trusted

The host operating-system user, intended credential store, tmux session and git
executable are part of the trusted computing base. Repository contents, paths,
configuration values and every client frame remain untrusted input, including
frames from authenticated clients. The wire decoder checks the envelope;
per-field validation and authorization belong at the consuming boundary.

Authentication is not authorization. Each legacy daemon instance limits pane
operations to its configured project root, but its token is a **per-user, operator-equivalent** credential, not a distinct project credential. Possession
of the same token can authenticate to other daemon instances using that token.
Project lookup checks do not create protection against arbitrary same-user
processes that can read the credential or start another daemon.

The separate [Agent surface control](./AGENT-SURFACE-CONTROL.md) contract uses
canonical project roots and authenticated task subjects. Agent credentials
cannot self-grant, widen, renew, approve, or register browser providers.
In production, `operatorCommandPolicy` defaults to `disabled`: operator
`command.submit` returns `operator_authority_unavailable`, and
`provider.register` returns `provider_authority_unavailable`. The
`trusted-test-only` policy is not a production workaround. Native user-presence
and identity brokers remain prerequisites for these operations; a token or
visible approval drawer does not supply them.

Provider-only connections, exact capability leases and child-WebView automation
have implementation/test contracts, but those are not proof of a functioning
production grant/approval/provider-registration path. Native lifecycle and
automation commands continue to reject callers other than the trusted main
WebView. The broader support-claim reconciliation is tracked separately in #504;
this security-document correction does not enable authority or qualify a release.

## First-pair trust

The companion's initial self-signed certificate fingerprint is learned from
Bonjour discovery: this is **trust on first use (TOFU)**, not independently
authenticated host identity. Later certificate pinning protects continuity with
the chosen pin; the pairing code does not cryptographically bind the discovered
host identity or certificate to an independently trusted one. A malicious first
pairing/discovery path therefore remains a separate risk from guessing a code.
Pair only through a trusted local network and independently check the intended
host; do not describe the six-digit code as protection against every first-pair
impersonation. The #280 invite protocol slice is not evidence that production
pairing and revocation have been integrated or accepted.

## Rules

### 1. A pane id is command text. Validate its shape, do not just quote it

The pane transports drive tmux through control mode (`tmux -C attach-session`), which
is **line-oriented**: one command per line on the subprocess's stdin. Quoting an
argument protects the *argument* boundary. Only rejecting control characters
protects the *command* boundary — a newline inside single quotes still ends the
line, and everything after it is parsed as a new tmux command. tmux ships
`run-shell`, so that is arbitrary code execution as the user.

`src/utils/tmuxTarget.ts` is the single guard for this:

- `assertTmuxPaneId` — a pane id must match `%<digits>`, the exact format
  `#{pane_id}` produces and the only format psyche ever stores.
- `quoteTmuxArgument` — rejects `\x00-\x1f` and `\x7f` before quoting, so any
  other interpolated value (a session name derived from a directory name, say)
  cannot break the line either.
- `assertSingleTmuxCommandLine` — a final check on the assembled command, so a
  future call site that skips the guards above still cannot cross the boundary.

Anything reaching `TmuxControl` goes through all three. That class lives in
`src/services/tmuxControl.ts` and is shared by both transports — it was
duplicated per transport until the copies drifted. Note that
`bridge.ts` reaches tmux a different way — `execFileSync` with an argument
array — which is not affected by any of this; do not "helpfully" convert those
call sites to shell strings.

### 2. Pane operations stay inside the daemon's project

The loopback daemon is scoped to a single project root. Every pane request
resolves through `resolveConfiguredPaneId`, which looks the id up in that
project's `.psyche/psyche.config.json` and fails with `pane_not_found`
otherwise. That covers `panes.capture`, `panes.status`, `panes.attach`,
`panes.focus`, `panes.kill` and `panes.meta`.

`panes.input` and `panes.resize` address a pane indirectly, by `streamId` from
a prior `panes.attach` — so they inherit the check that attach already did.
**A new handler that takes a pane id directly must call
`Connection.resolveScopedPaneId`.** Skipping it lets a client authorized for
one project read output from, and type into, any tmux pane on the machine.

### 3. Guessing a secret must be bounded

The LAN pairing code is six digits — 10^6 values — inside a five-minute window,
on a listener that advertises itself over Bonjour. Unbounded guessing is a
feasible attack from any device on the network, and a successful pair issues a
durable device token with pane-input rights.

`PairingFlow` therefore closes the window after `PAIR_MAX_ATTEMPTS` (5) wrong
codes, with close reason `exhausted`; the client sees `pairRejected` with reason
`too_many_attempts`, and the host must consciously run `:pair` again. Pairing-code
comparison uses `timingSafeEqual` behind a length guard. The legacy loopback
daemon token also uses a guarded timing-safe comparison. In contrast, LAN
`TokenStore.validate` uses ordinary JavaScript string equality to search device
records; no constant-time device-token lookup is claimed. This is a documented
implementation gap, not a change to token issuance or authentication.

`PairingFlow.attempt` returns the outcome — `accepted`, `invalid_code`,
`too_many_attempts`, `expired`, `no_window_open` — and the daemon forwards it
verbatim. **Do not reconstruct the reason from `isOpen()` before and after.**
An exhausted window and an already-expired one both end closed, so that
inference tells a user who merely idled that someone is guessing at their code.
`consume()` remains as a boolean view of `attempt()`.

Any future short-secret challenge needs an explicit attempt budget. A random
256-bit daemon token has a different guessing risk from a six-digit code, but
its entropy does not bound connection/resource exhaustion. Do not generalize a
timing-safe primitive at one call site to a whole transport or token store.

### 4. Decoded payloads must be validated, not just typed

`Buffer.from(str, 'base64')` never throws: it skips characters outside the
alphabet and tolerates wrong padding. `Buffer.from('!!!!', 'base64')` is an
empty buffer and `Buffer.from('zz z', 'base64')` is two arbitrary bytes — both
silently, which makes a `try`/`catch` around the decode dead code.

These payloads carry *keystrokes*. Silently mangling a byte sequence and typing
the remains into a terminal is worse than refusing it: a truncated multi-byte
sequence can leave stray control characters in the user's shell, and the client
never learns its frame was malformed. Use `decodeBase64Payload` from
`src/utils/base64.ts`, which validates canonical RFC 4648 base64 first and
returns `null` rather than a mangled buffer.

### 5. A single frame must never be able to stop the server

Three distinct crash routes, all of which were reachable:

- **Unhandled `'error'` events.** `ws` emits `'error'` on abrupt peer resets,
  and Node's `EventEmitter` *rethrows* an `'error'` with no listener. Every
  socket, every `WebSocketServer`, and the `https.Server` after `listen`
  needs a listener. On the LAN bridge these route to
  `WSSListenerEvents.onServerError`.
- **Unhandled promise rejections.** The daemon's message handler is `async`.
  An escaping rejection terminates the process on modern Node, so the
  `'message'` listener catches and replies `internal_error` instead.
- **Handler throws on malformed input.** A missing or non-string field must
  produce an error frame, not an exception. `panes.attach` with no `id` used to
  be a one-frame denial of service.

### 6. Resources a client controls are bounded

- The LAN bridge `maxPayload` is 1 MiB
  (`MAX_CLIENT_FRAME_BYTES = 1024 * 1024`; `ws` defaults to 100 MB, which an
  unauthenticated peer can send repeatedly to exhaust the heap).
- The legacy loopback daemon closes a connection that has not authenticated
  within `AUTH_DEADLINE_MS` (10 s). This is not a LAN bridge guarantee.
- The LAN `WSSListener` has no application-level idle authentication deadline
  and no pre-authentication connection cap. Its per-frame limit does not bound
  the number of waiting connections or the total queued work; do not describe
  it as complete pre-authentication denial-of-service protection.
- Canonical control IPC bounds each frame to 4 MiB and queued input to 128 frames / 8 MiB.
  These limits belong to `src/control/server.ts`, not to the LAN WebSocket.
- A connection may hold at most `MAX_STREAMS_PER_CONNECTION` (64) attached
  streams.
- A connection registers **one** `output` listener on the shared `TmuxControl`
  emitter and fans out internally, rather than one per attached stream.
- A v3 mobile bridge connection may hold at most
  `MAX_CONTROL_STREAMS_PER_CONNECTION` (4) terminal streams.
- Each LAN bridge pane output ring is bounded to 256 KiB
  (`PaneOutputBuffer` default capacity). The iOS terminal registry attaches at
  most two visible panes and retains at most 64 KiB of output per pane.
- Mobile control requests time out on the client after 15 seconds
  (`ControlRequestClient.defaultTimeout`). A timeout is not proof the host did
  not act.
- Mobile pane-spawn idempotency remembers 128 hot keys. Pending remote action
  sessions are capped at 64 and expire after five minutes.
- Mobile file preview reads are capped at 200,000 bytes and browser/diff git
  output is capped at 16 MiB.
- The encoded workspace-cache file is capped at 256 KiB total, across its
  host-keyed records. Draft count is capped at 24 per cached state, and each
  draft is capped at 4,096 characters.
- Invite authentication, where used, is profile `bridge.v3` only: 10-minute
  lifetime, 32-byte secret, 16-byte invite ID, five wrong presentations,
  16 retained records, 2,048-byte payload cap, and 60-second clock-skew
  tolerance.

### 7. Destructive git operations are not remotely reachable

`killBridgePane` deliberately leaves the worktree and branch on disk and
returns them, so a remote client cannot destroy uncommitted work as a side
effect of closing a pane. Deletion stays an explicit act in the TUI. Keep it
that way.

## Config integrity

`.psyche/psyche.config.json` is the pane registry — the only record mapping a
pane to its worktree and branch. Losing it loses the map back to the user's
in-progress work, so it gets treated as data, not as a cache:

- **Reads distinguish "absent" from "unreadable".** Only `ENOENT` yields an
  empty project. A read or parse failure raises `config_unreadable` /
  `config_corrupt` rather than falling back to `{ panes: [] }` — that fallback,
  followed by a write, silently erased every pane record.
- **Writes are atomic** (`atomicWriteJson`, write-then-rename). A truncating
  write leaves a torn registry if the process dies mid-write.
- **Every read-modify-write goes through `mutateBridgeConfig`**, which
  serializes them. Concurrent lanes otherwise read the same snapshot and the
  last write wins, dropping panes. `mutateBridgeConfig` also skips the write
  entirely if the mutation throws.

Adding a new config mutation means using `mutateBridgeConfig`. Doing the
read-parse-write inline is the bug, every time.

## Mobile protocol boundary

The LAN bridge supports wire protocol versions 2 and 3. Version 2 is the legacy
pane/project/ritual message set. Version 3 keeps those messages and adds the
top-level `control` and `workspaceChanged` envelopes. A client must negotiate a
supported version in `hello`; `control` requests on non-v3 sessions fail with
`protocol_mismatch`.

The v3 gateway is a bridge adapter, not durable OpenCoven protocol ownership.
It validates every target against the host-published workspace snapshot:
terminal streams require a tmux-backed published pane; pane creation requires a
published project root or worktree; inspection requires an available worktree
for the pane and rejects absolute or escaping paths; action replies must belong
to an owner-scoped pending action session. Unsupported, missing, or unwired
executors return correlated errors such as `command_not_supported` rather than
fixture-shaped success.

The legacy v2 `subscribePane` and `sendInput` messages apply the same
published-pane check on every frame, because tmux pane ids are server-global
and a well-formed id outside the workspace still names a real shell. Without a
workspace snapshot the scope is the legacy pane list that `listPanes` returns.
An unpublished pane, or a scope that cannot be read, is refused with the v3
`unknown_pane` error and nothing reaches tmux. So that each keystroke does not
rebuild the snapshot, the published pane set from the latest workspace read is
reused until a workspace-change notification arrives or
`LEGACY_PANE_SCOPE_TTL_MS` passes. A notification that lands during a scope
read forces one re-read, and a second one refuses the request. A session that
is revoked, closed, or in its closing handshake when the check returns is
dropped before anything is subscribed or typed. Scope-read failures are logged
as an error class name only, never the provider's message or stack.

Ritual metadata publication is wired and bounded, but production mobile ritual
execution is still a gap until #242 completes. Fixture roots, `DemoStore`,
`-uiFixture`, and fixture-only debug controls are test scaffolding and must not
be used as evidence for production bridge behavior.

## Tests

The rules above are pinned by:

| Test | Covers |
|---|---|
| `__tests__/utils/tmuxTarget.test.ts` | the shared pane-id and quoting guard |
| `__tests__/utils/base64.test.ts` | strict base64 validation of wire payloads |
| `__tests__/services/tmuxControl.test.ts` | no tmux command is built from an injecting pane id |
| `__tests__/bridge/PairingFlow.test.ts` | the pairing attempt budget |
| `__tests__/bridge/bridgeDaemonHardening.test.ts` | pairing, input validation, v2 pane scope (races, cache), socket errors, frame cap — over a real TLS WebSocket |
| `__tests__/bridge/legacyPaneScope.test.ts` | every pane v2 `listPanes` advertises passes the v2 pane scope |
| `__tests__/daemon/daemonConnection.test.ts` | auth, project scoping, crash resistance, stream limits |
| `__tests__/daemon/bridgeConfigIntegrity.test.ts` | config reads, atomic writes, concurrent mutation |
| `__tests__/securityDocsContract.test.ts` | documentation claim guards; not runtime security or end-to-end acceptance |

## Reporting

Follow [SECURITY.md](../SECURITY.md) and submit a private vulnerability report at
<https://github.com/OpenCoven/psyche-build/security/advisories/new>.
Do not post vulnerabilities, tokens, private prompts, exploitable details or
sensitive logs in public issues, pull requests or discussions. If the private
form is unavailable, use the established private maintainer channel described
in SECURITY.md and verify the recipient before sharing sensitive material.
Ordinary non-sensitive support belongs in the channels named by SUPPORT.md.
