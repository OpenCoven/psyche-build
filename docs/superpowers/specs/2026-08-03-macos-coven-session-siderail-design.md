# macOS Project-Scoped Coven Session Siderail Design

## Goal

Extend the existing macOS sessions siderail so each open project shows both
Psyche-owned terminal sessions and matching sessions managed by the local Coven
daemon. A Coven row opens or focuses a normal terminal surface attached to that
session, while Psyche remains fully usable when Coven is absent or unhealthy.

## Current state and scope

`origin/main` already has the persistent left sessions rail in the Tauri desktop
app. It renders `state.threads`, grouped by `state.projects`, and the search field
filters those local rows. This work extends that existing information
architecture; it does not add a second rail or replace the desktop session
model.

The root Node daemon already has a direct Coven adapter, but the packaged Tauri
app cannot assume the repository's Node runtime is installed. The desktop app
therefore needs a small native adapter at its Rust command boundary rather than
calling root TypeScript or treating `coven sessions --json` as the primary data
source.

This slice owns:

- read-only discovery of Coven sessions from the stable local daemon API;
- exact project scoping and presentation in the existing left rail;
- attaching a selected Coven session in the existing PTY surface; and
- non-disruptive loading, unavailable, empty, and failure states.

It does not own Coven session creation, kill/archive/input APIs, event timelines,
a broad desktop session-protocol rewrite, or release infrastructure. Before
implementation, the branch must be rebased onto current `main`. If the separate
session-centric work has landed by then, this work extends its canonical model
and tests instead of introducing parallel state.

## User experience

The rail retains its current project grouping. Within each project group it
renders two compact subsections:

```text
PROJECT NAME
  Psyche
    shell                         ●
    tests                         ●
  Coven
    Fix failing release checks    ● running
    Audit packaging               ● waiting
```

The `Psyche` subsection contains the project's existing local thread rows and
keeps their current focus, rename, and close behavior. The `Coven` subsection
contains only daemon sessions whose canonical project root exactly matches that
project. Cross-project sessions and sessions without a verifiable project root
are not rendered.

The existing search box covers project name, Psyche title, Coven title, harness,
status, and session id. A matching project name includes both of that project's
subsections. Empty subsections are omitted in the normal ready state so the rail
stays compact.

Clicking a Coven row first activates its project, then:

1. focuses an existing local attachment carrying the same Coven session id; or
2. creates a normal desktop thread whose command is `coven` and whose arguments
   are `attach`, `<session-id>`.

The attachment uses the existing `createThread`/`pty_start` path, so terminal
focus, resize, output, exit, and close behavior remain owned by the current PTY
implementation. The local thread records the Coven session id as metadata so a
second click does not create a duplicate attachment.

## Native daemon adapter

Add a focused Tauri command such as
`coven_sessions(project_roots: Vec<String>) -> CovenSessionsResponse`. Its Rust
implementation uses the same endpoint precedence and stable contract as the
root adapter:

1. `COVEN_SOCKET` when set;
2. `$COVEN_HOME/coven.sock` when `COVEN_HOME` is set and no network endpoint is
   configured;
3. the explicitly configured `COVEN_URL`/`COVEN_PORT` loopback HTTP endpoint;
   or
4. `~/.coven/coven.sock` by default.

The adapter checks `GET /api/v1/health` and accepts only
`apiVersion: "coven.daemon.v1"`, then requests `GET /api/v1/sessions`. Unix
socket HTTP is the primary packaged-app path. Explicit loopback HTTP remains
available for local development and parity with the root adapter. The legacy
`coven sessions --json` path is not an automatic fallback because the published
CLI does not reliably expose that contract.

The native response is structured rather than throwing transport strings into
the webview:

```text
{
  status: "ready" | "unavailable" | "incompatible" | "error",
  sessions: CovenSessionSummary[],
  message?: string
}
```

`CovenSessionSummary` exposes normalized `id`, `projectRoot`, `cwd`, `harness`,
`title`, `status`, `createdAt`, `updatedAt`, and `archivedAt` fields. The parser
accepts the documented list and `{ sessions: [...] }` envelopes plus camelCase
and snake_case project/timestamp keys. Only `id` and `projectRoot` are required;
invalid entries are dropped without invalidating otherwise valid results.

The command canonicalizes every requested open-project root using the desktop
app's existing filesystem rules. Each returned session root must canonicalize
successfully and equal one requested root as a filesystem path, not as a string
prefix. If `cwd` is shown or used, it must canonicalize to the project root or a
descendant. The webview receives only already-scoped sessions.

## Webview state and refresh

The webview keeps one small Coven discovery state separate from
`state.threads`:

```text
{
  phase: "idle" | "loading" | "ready" | "unavailable" | "incompatible" | "error",
  sessionsByProject: Map<canonicalProjectRoot, CovenSessionSummary[]>,
  message: string | null,
  requestId: number,
  refreshedAt: number | null
}
```

Keeping remote discovery separate prevents a daemon outage from mutating or
removing local terminal state. The rail renderer joins the two models only for
display.

Discovery runs immediately after projects are restored or changed and then on
a modest five-second interval while the window is visible. It pauses while the
document is hidden and refreshes immediately when visibility returns. Every
request carries a monotonically increasing id; a late response is ignored when
its id is no longer current. Project removal also invalidates in-flight data so
stale sessions cannot reappear under another project.

The renderer maps Coven status without changing the daemon value:

- `starting`: amber/pulsing;
- `running`: green;
- `waiting`: amber;
- `completed` and `archived`: muted;
- `failed`, `killed`, and `orphaned`: red; and
- unknown values: neutral with the raw normalized label in secondary text.

Within a project, live sessions sort before non-live sessions, then by
`updatedAt` descending with id as a stable final tie-breaker. Psyche row order is
unchanged.

## Inline states and errors

Daemon discovery never blocks project restore, local PTY startup, or local rail
interaction.

- During the first request, projects with local rows render those rows normally
  plus one muted `Coven — loading…` line.
- A healthy empty result omits the Coven subsection. If a search specifically
  matches no row, the existing global no-results message remains authoritative.
- Missing socket, connection refusal, or timeout renders one compact
  `Coven unavailable` line with a tooltip or secondary hint to run
  `coven daemon start`.
- An unsupported health version renders `Coven update required`.
- Malformed payloads or non-success responses render `Coven could not load` and
  retain no stale remote rows.
- Later refresh failures replace remote rows with the inline state; local rows
  remain untouched. A subsequent successful poll recovers automatically.
- If `coven` cannot be spawned for attach, the created terminal shows the
  existing PTY start error and the rail remains interactive.

Only one availability/error line appears per project group, even though the
native adapter performs one batched request for all open roots.

## Security and reliability constraints

- Set a two-second connect/read timeout and a one-MiB response limit before JSON
  parsing; reject incomplete HTTP bodies and non-2xx status codes.
- Accept only the documented stable health version and normalized session
  fields. Do not expose arbitrary daemon payloads to the webview.
- Use canonical filesystem equality for project scoping. Do not use substring
  or lexical-prefix checks.
- Validate session ids against the existing safe character set
  `[A-Za-z0-9._:-]+` before attach and reject ids longer than 128 characters.
- Pass `coven`, `attach`, and the validated id as `CommandBuilder` command and
  argument values. Never interpolate a session id into a shell string.
- Restrict explicit HTTP configuration to loopback hosts; the desktop discovery
  adapter must not turn environment configuration into arbitrary network access.
- Avoid logging session prompts, terminal contents, credentials, or full daemon
  bodies. Error logs may include the endpoint kind, status code, and structured
  error category.

## Verification

Implementation is complete only with all of the following evidence:

### Rust unit and adapter tests

- endpoint precedence for default, `COVEN_SOCKET`, `COVEN_HOME`, and explicit
  loopback HTTP configuration;
- HTTP status/header/body parsing, size limits, timeouts, malformed JSON, and
  stable health-version enforcement;
- list and `{ sessions }` envelopes plus camelCase/snake_case normalization;
- canonical project equality, missing/unreadable roots, and prefix-collision
  rejection such as `/repo/app` versus `/repo/application`;
- safe and unsafe session ids; and
- a fake Unix-domain socket round trip for health plus sessions, with loopback
  HTTP covered when that endpoint is enabled.

### Webview model and rendering tests

- project grouping with Psyche and Coven subsections;
- search across both sources and project-name matches;
- stable status mapping and sort order;
- loading, empty, unavailable, incompatible, malformed, and recovery states;
- stale-response suppression after project changes;
- click-to-focus for an existing attachment and click-to-create for a new one;
  and
- preservation of all existing Psyche focus, rename, close, and empty-state
  behavior.

Pure normalization/filter/sort helpers should live in the canonical desktop
session model module so they can be exercised without a webview. If that module
does not yet exist on current `main`, introduce one small module and make the
existing renderer consume it; do not duplicate helpers in tests.

### End-to-end gates

- focused Vitest tests for the desktop session model and contract surface;
- `cargo fmt --check`, `cargo test --locked`, and `cargo check --locked` for the
  Tauri crate;
- root `pnpm test`, `pnpm typecheck`, and `pnpm build`;
- native `pnpm build:web` and an unsigned DMG build; and
- packaged-app smoke with Coven stopped, a fake/real compatible daemon running,
  project filtering visible, and one session successfully attached.

No feature commit or release candidate may proceed until those gates pass and
the packaged behavior has been inspected in the built app rather than only in
a development webview.
