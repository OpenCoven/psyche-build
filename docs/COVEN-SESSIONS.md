# Coven session visibility

comux treats Coven as an optional local runtime. comux stays useful on its own, and when a local Coven daemon is available it can show, launch, and attach Coven-managed sessions beside normal comux panes.

## Demo loop

See [DEMO-LOOP.md](./DEMO-LOOP.md) for the full developer walkthrough.

## Demo loop

See [DEMO-LOOP.md](./DEMO-LOOP.md) for the full developer walkthrough.

## Adapter boundary

The preferred bridge path is the local daemon API:

```text
GET  /api/v1/health
GET  /api/v1/sessions
POST /api/v1/sessions
GET  /api/v1/sessions/:id
GET  /api/v1/events?sessionId=...
POST /api/v1/sessions/:id/input
```

comux first checks `GET /api/v1/health` and accepts the current stable `apiVersion: "coven.daemon.v1"` contract. Event polling accepts the current paginated envelope and stores `nextCursor.afterSeq`-style sequence progress by reading event `seq` values.

### Optional agentic capability routing

After Coven creates a session, an orchestration caller may route a capability
against that authoritative session through the authenticated comux daemon
message `coven.capabilities.execute`:

```json
{
  "sessionId": "session-123",
  "prompt": "Fix the failing tests",
  "capability": "planning",
  "provider": "psyche",
  "taskId": "task-123",
  "traceId": "trace-123",
  "attempt": 1,
  "idempotencyKey": "task-123:planning"
}
```

The bridge fetches the session from Coven, verifies its project root and cwd,
then routes the phase through `AgenticCapabilityRouter`. `coven-native` is the default provider; `psyche` is an optional
strategy registration point, not a built-in Psyche implementation. Provider
output cannot replace the authoritative session harness, project root, cwd, or
session id.

Only `starting`, `running`, and `waiting` sessions accept capability work.
Created/detached, completed, failed, killed, orphaned, and archived sessions
fail closed before provider execution. Embedded daemon callers can register a
future Psyche strategy through `runDaemon({ capabilityStrategies: [...] })`;
without that registration, explicit Psyche requests return a structured
provider-unavailable error.

The returned trace reports the task, provider, tool calls, deltas, and
evaluation outcomes for orchestration-ledger persistence. The v1 daemon still
receives the existing `{ harness, prompt, title, projectRoot, cwd }` launch shape, so
there is no session-store migration and older clients remain compatible.
Explicit unsupported or unavailable routes return structured errors rather
than silently falling back.

The legacy visibility-only CLI fallback is still supported for tests and older local builds when explicitly configured:

```bash
coven sessions --json
```

If the daemon or command is missing, unsupported, invalid JSON, or too slow, comux keeps running and shows a compact unavailable state. No unpublished Coven APIs are imported.

## Proposed JSON contract

Either top-level shape is accepted:

```json
{
  "sessions": [
    {
      "id": "session-123",
      "projectRoot": "/path/to/repo",
      "cwd": "/path/to/repo/packages/app",
      "harness": "codex",
      "title": "Fix failing tests",
      "status": "running",
      "createdAt": "2026-04-28T12:00:00.000Z",
      "updatedAt": "2026-04-28T12:03:00.000Z",
      "archivedAt": null
    }
  ]
}
```

or:

```json
[
  {
    "id": "session-123",
    "project_root": "/path/to/repo",
    "harness": "codex",
    "title": "Fix failing tests",
    "status": "running",
    "created_at": "2026-04-28T12:00:00.000Z",
    "updated_at": "2026-04-28T12:03:00.000Z",
    "archived_at": null
  }
]
```

Required fields for comux visibility are `id` and `projectRoot`/`project_root`. Everything else is optional and rendered opportunistically.

## Current UI behavior

- Sessions are filtered to the active comux project roots before rendering.
- Sessions whose project roots cannot be verified are hidden.
- The side panel renders a small `☾ Coven sessions` section under each project with matching running, completed, and archived sessions.
- The active project shows `[o]pen`; pressing `o` opens the latest matching session as a comux shell pane with `coven attach <session-id>`.
- Empty and unavailable states are non-fatal and stay inside the side panel.
- Desktop-use panes launch through the daemon API and attach with `coven attach <session-id>`.
- Socket/daemon failures are reported as action-oriented messages, such as starting Coven with `coven daemon start`.

## Known gaps

- Verified on 2026-05-14: the locally installed Coven binary at `~/.cargo/bin/coven` supports `coven sessions --all`, `--manage`, and `--plain`, but does not currently support `coven sessions --json` or `coven sessions --json --all`. comux therefore treats this CLI shape as unavailable until Coven restores or publishes the JSON contract above.
- The same local binary does not expose `coven --version`; use `coven --help` to confirm command availability for now.

## Known gaps

- Verified on 2026-05-14: the locally installed Coven binary at `~/.cargo/bin/coven` supports `coven sessions --all`, `--manage`, and `--plain`, but does not currently support `coven sessions --json` or `coven sessions --json --all`. comux therefore treats this CLI shape as unavailable until Coven restores or publishes the JSON contract above.
- The same local binary does not expose `coven --version`; use `coven --help` to confirm command availability for now.

Future slices can add per-session selection, summon/archive controls, and live event timelines without changing this adapter boundary.
See [comux + Coven demo loop](COVEN-DEMO-LOOP.md) for the end-to-end demo path and the [OpenCoven public roadmap](https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md) for the upstream milestone.
