# Bridge and daemon security model

Psyche Build runs two WebSocket servers. Both hand a remote client control over
tmux panes, and tmux panes are shells — so the boundary these servers enforce is
the boundary between "a device on your network" and "arbitrary commands as
you".

This document states what each server trusts, what it refuses, and why the
refusals are shaped the way they are. Read it before adding a message type to
either protocol.

## The two surfaces

| | LAN bridge | Loopback daemon |
|---|---|---|
| Code | `src/services/bridge/` | `src/daemon/` |
| Started by | the TUI, automatically (`src/index.ts`) | `psyche daemon`, explicitly |
| Binds | `0.0.0.0`, ephemeral port, TLS | `127.0.0.1:47123`, plaintext |
| Discovery | Bonjour `_psyche._tcp` | none |
| Auth | device token from a pairing code | 256-bit token in `~/.config/psyche/token` |
| Clients | the iOS / macOS companion apps | local tooling, MCP-adjacent callers |
| Runs inside | the psyche TUI process | its own process |

The LAN bridge is the higher-consequence surface on both axes: it is reachable
from other machines, and a crash there takes down the user's whole TUI session
rather than a background daemon.

## What is trusted

**Trusted:** the local filesystem, the tmux session psyche created, the git
binary, and any client that has completed authentication.

**Not trusted:** every byte of every client frame, including from an
authenticated client — pane ids, pane ids read back out of
`.psyche/psyche.config.json`, base64 payloads, and message shapes. The wire
decoder validates `type` and `payload` and nothing deeper, by design; per-field
validation belongs in the handler.

Authentication is not authorization. An authenticated client of the loopback
daemon is authorized for *one project root*, not for the machine.

The loopback daemon also owns the agent surface-control protocol described in
[Agent surface control](./AGENT-SURFACE-CONTROL.md). Agent tokens can request
and use exact capability leases, but cannot grant, widen, renew, approve, or
register a browser provider. Operator-provider sockets become provider-only
after registration. Browser authority is limited to registered child WebViews;
native lifecycle and automation commands reject every caller except the trusted
main WebView.

## Rules

### 1. A pane id is command text. Validate its shape, do not just quote it

Both servers drive tmux through control mode (`tmux -C attach-session`), which
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
`too_many_attempts`, and the host must consciously run `:pair` again. Code and
token comparisons use `timingSafeEqual` behind a length guard (it throws on
length mismatch).

`PairingFlow.attempt` returns the outcome — `accepted`, `invalid_code`,
`too_many_attempts`, `expired`, `no_window_open` — and the daemon forwards it
verbatim. **Do not reconstruct the reason from `isOpen()` before and after.**
An exhausted window and an already-expired one both end closed, so that
inference tells a user who merely idled that someone is guessing at their code.
`consume()` remains as a boolean view of `attempt()`.

Any future short-secret challenge needs the same treatment. A long random token
— the 256-bit daemon token — does not need an attempt cap, but still gets the
constant-time compare, because it is free.

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

- `maxPayload` is 1 MiB on both servers (`ws` defaults to 100 MB, which an
  unauthenticated peer can send repeatedly to exhaust the heap).
- The loopback daemon closes a connection that has not authenticated within
  `AUTH_DEADLINE_MS` (10 s).
- A connection may hold at most `MAX_STREAMS_PER_CONNECTION` (64) attached
  streams.
- A connection registers **one** `output` listener on the shared `TmuxControl`
  emitter and fans out internally, rather than one per attached stream.

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

## Tests

The rules above are pinned by:

| Test | Covers |
|---|---|
| `__tests__/utils/tmuxTarget.test.ts` | the shared pane-id and quoting guard |
| `__tests__/utils/base64.test.ts` | strict base64 validation of wire payloads |
| `__tests__/services/tmuxControl.test.ts` | no tmux command is built from an injecting pane id |
| `__tests__/bridge/PairingFlow.test.ts` | the pairing attempt budget |
| `__tests__/bridge/bridgeDaemonHardening.test.ts` | pairing, input validation, socket errors, frame cap — over a real TLS WebSocket |
| `__tests__/daemon/daemonConnection.test.ts` | auth, project scoping, crash resistance, stream limits |
| `__tests__/daemon/bridgeConfigIntegrity.test.ts` | config reads, atomic writes, concurrent mutation |

## Reporting

Security issues in this repository: <https://github.com/OpenCoven/psyche-build/issues>.
