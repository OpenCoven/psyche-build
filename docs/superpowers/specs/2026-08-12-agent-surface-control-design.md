# Agent Control of Psyche Surfaces — Design

Date: 2026-08-12
Status: Approved for implementation

## Goal

Let agents reliably observe and control only the terminal panes and embedded
browser tabs that Psyche manages. Control must be structured, task-scoped,
revocable, auditable, generation-safe, and unable to silently escape to the
wider macOS desktop.

The canonical control plane remains the sole mutation authority. MCP is an
adapter over that authority, tmux and the native desktop are effect providers,
and the operator remains the only principal that can grant leases or approve
sensitive actions.

## Decisions

- Scope v1 to Psyche-managed terminal panes and embedded browser tabs. Do not
  add whole-desktop accessibility or coordinate control.
- Offer semantic browser actions plus an explicitly gated JavaScript escape
  hatch.
- Grant control through per-task capability leases over named resources.
- Require action-specific approval for detectable high-risk actions: secret
  fields, uploads, downloads, permission prompts, external form submissions,
  arbitrary scripts, and closing or killing a surface.
- Pause only the action awaiting approval. Other leased work may continue.
- Give terminal agents bounded observation plus typed input, interrupt, focus,
  resize, create, and close operations. Do not expose raw tmux commands.
- Represent browser pages as compact accessibility-oriented snapshots with
  snapshot-scoped element references, not raw HTML or coordinates.
- Revoke all active leases and pending approvals when the control owner
  restarts.

## Non-goals

- Controlling other applications, windows, the macOS desktop, or arbitrary
  system accessibility elements.
- General WebDriver, Chrome DevTools Protocol, or Playwright compatibility.
- Long-lived selectors or element references that survive page changes.
- Persisting screenshots, browser content, typed values, or terminal
  transcripts in the control journal.
- Automatically approving an action because the requesting agent explains why
  it is safe.
- Perfectly predicting application-defined side effects behind a generic web
  button. The security boundary is the granted click capability plus the
  detectable high-risk gates described below.

## Architecture

```text
agent
  |
  v
MCP adapter -----> canonical ControlRuntime -----> policy and lease gate
                             |                              |
                             v                              v
                    journal and receipts          per-resource queue
                                                            |
                                      +---------------------+------------------+
                                      |                                        |
                                      v                                        v
                              tmux pane backend                    desktop browser provider
                                                                       |
                                                                       v
                                                              Tauri child webviews
```

### Canonical authority

`src/control/` owns authentication, owner epochs, resource scope, leases,
approval transactions, command idempotency, queueing, receipts, and journal
events. No MCP handler, tmux adapter, browser script, or desktop UI may bypass
`ControlRuntime` for an agent-requested mutation.

MCP translates tool arguments into canonical commands and translates command
outcomes into tool responses. It contains no parallel authorization policy.
Future clients may use the same protocol without creating a second mutation
authority.

### Resource registry and identity

The runtime adds a live resource registry with two resource kinds:

- `pane`: stable Psyche pane ID, current tmux pane ID, generation, project and
  worktree identity, agent, title, status, writability, and output sequence.
- `browser_tab`: stable Psyche tab ID, provider connection ID, native webview
  label, generation, project/worktree identity, URL, title, loading state, and
  viewport.

Commands address the stable resource ID and expected generation. A recreated
pane, tab, or webview increments its generation. Commands carrying an older
generation fail with `resource_replaced`; they are never redirected to the new
surface.

Leases enumerate existing resource IDs. They do not implicitly include future
panes, tabs, or replacement generations. Pane creation is the one collection
operation: its lease entry targets the canonical project ID with only
`pane.create`. A successfully created pane still requires a separate lease
grant before the agent can control it.

### Desktop browser provider

The Node control owner cannot directly call Tauri commands. The running desktop
app therefore registers as the browser effect provider over the existing local
daemon transport, authenticated with an operator-owned local credential rather
than an agent token.

The provider publishes browser resource lifecycle and state changes, receives
already-authorized browser commands, executes them through the existing native
browser lifecycle queue, and returns correlated outcomes. Provider disconnect:

- marks its browser resources unavailable;
- invalidates their generations;
- revokes leases containing those resources;
- terminalizes commands not known to have started as `backend_unavailable`;
- terminalizes dispatched commands without a confirmed outcome as
  `effect_unknown`.

The runtime never reroutes browser commands to desktop accessibility or another
browser provider.

## Capability leases

A lease binds:

- lease ID and monotonic revision;
- requesting agent principal and task ID;
- owner epoch;
- explicit surface resource IDs and generations, or the canonical project ID
  for `pane.create` only;
- explicit capability set;
- grant time and expiry;
- operator principal that granted it.

Representative capabilities:

- Pane: `pane.observe`, `pane.input`, `pane.interrupt`, `pane.focus`,
  `pane.resize`, `pane.create`, `pane.close`.
- Browser: `browser.inspect`, `browser.screenshot`, `browser.navigate`,
  `browser.interact`, `browser.history`, `browser.close`, `browser.script`.

An agent can request, inspect, or release a lease. Only an operator can grant,
expand, renew, or revoke it. Expiry, explicit revocation, operator takeover,
resource replacement, provider loss, or owner restart invalidates the lease.
An invalidated lease cannot authorize a queued command that has not started.

Leases and pending approvals are intentionally in-memory authority. The journal
records their redacted history, but an owner restart does not restore them.

## External tool surface

The initial MCP surface is deliberately small and typed.

### `psyche_control_list`

Lists controllable panes and browser tabs for the project. Each resource includes
its stable ID, generation, type, bounded state, lease status, and capabilities
that can be requested.

### `psyche_control_lease`

Supports `request`, `status`, and `release`. A request names the task, exact
resource generations, capabilities, and desired TTL. It returns either the
granted lease or a request ID awaiting operator action. It cannot approve or
expand a lease.

### `psyche_pane_observe`

Returns bounded terminal output, cursor/status metadata, attention state,
current output sequence, and truncation metadata. `after_sequence` supports
incremental reads. The runtime does not persist returned transcript content.

### `psyche_pane_action`

Typed actions:

- `send_text`
- `send_keys` using an explicit named-key allowlist
- `interrupt`
- `focus`
- `resize`
- `create`
- `close`

`close` always requires action-specific approval. Pane creation requires an
explicit project scope and produces a new resource that is not automatically
added to the caller's lease; the creation receipt may include a follow-up lease
request ID.

### `psyche_browser_inspect`

Returns a versioned semantic snapshot containing:

- snapshot ID, tab ID and generation;
- URL, title, loading state, viewport, and capture time;
- a bounded accessibility-oriented tree;
- for each relevant node: snapshot-scoped reference, role, accessible name,
  state, value metadata, bounds, and interaction affordances;
- truncation and opaque-frame metadata;
- an optional screenshot as an ephemeral artifact.

It does not return raw HTML. Secret values are never included. Cross-origin
frames appear as opaque nodes in v1.

### `psyche_browser_action`

Typed actions:

- `navigate`
- `click`
- `type`
- `select`
- `submit`
- `upload`
- `download`
- `permission_response`
- `scroll`
- `focus`
- `reload`
- `back`
- `forward`
- `screenshot`
- `close`

Element actions require tab generation, snapshot ID, and element reference.
Psyche never substitutes an agent-provided selector or guesses after a stale
reference. Upload sources must resolve inside the canonical project or a
registered worktree. Download destinations must resolve inside the same scope;
the browser provider must prevent an unapproved native fallback destination.
All five explicit high-risk actions (`submit`, `upload`, `download`,
`permission_response`, and `close`) require action-specific approval. Typing
into a secret-classified field is classified as high-risk even though `type` is
normally allowed by `browser.interact`.

### `psyche_browser_script`

Evaluates JavaScript only when the lease includes `browser.script` and the
operator approves that exact invocation. It has a strict timeout and accepts
and returns size-bounded JSON-compatible values. It cannot return native object
handles. Each invocation requires approval; prior approval does not establish a
trusted script session.

### `psyche_control_action_status`

Returns a transaction by action ID as `queued`, `running`,
`approval_required`, `succeeded`, `failed`, `denied`, `expired`, or `unknown`,
including a redacted structured receipt when terminal. Browser snapshots use
the schema tag `psyche.browser.snapshot/v1`; action receipts use
`psyche.control.receipt/v1`.

Existing pane MCP tools remain compatible during migration. They should route
through the canonical command path and may later be documented as convenience
aliases; removal is outside this design.

## Browser semantic bridge

Each Psyche browser webview receives one namespaced runtime after page load:
`window.__PSYCHE_AUTOMATION__`.

The runtime:

- builds bounded semantic snapshots from visible DOM, accessible names, roles,
  form semantics, state, and layout bounds;
- stores element references in a snapshot-local map;
- executes typed actions only against that map;
- emits correlated results containing action ID, tab generation, snapshot ID,
  and bounded payload;
- clears all references on navigation, reload, document replacement, timeout,
  or creation of a newer snapshot.

The injected runtime is an effect implementation, not an authority. It receives
only commands already accepted by `ControlRuntime`. The desktop provider
validates correlation and generation again before returning an outcome.

The native browser lifecycle queue remains authoritative for create, navigate,
reload, history, bounds, hide, and destroy ordering. Automation dispatch joins
that queue rather than maintaining a parallel lifecycle lock.

## Risk classification and approvals

The following detectable actions require an exact, single-use approval:

- typing into password or secret-classified fields;
- choosing or uploading a file;
- initiating a detected download;
- responding to a browser or system permission prompt;
- activating a semantic form submission control or submitting a form;
- evaluating arbitrary JavaScript;
- closing or killing a pane, tab, or browser pane.

Approval binds the action ID, payload digest, lease ID and revision, resource ID
and generation, and owner epoch. Any mismatch invalidates it.

The approval card shows the requesting agent and task, exact resource, current
URL or worktree, capability, redacted target context, and intended effect. The
operator can approve once, deny, or revoke the entire lease. The agent cannot
approve its own action.

Generic page controls can implement application-defined network side effects
that cannot be proven from DOM semantics. In v1, a granted `browser.interact`
capability authorizes generic clicks; Psyche guarantees additional approval for
the detectable categories above, not perfect semantic prediction of arbitrary
site code. The UI and tool description must state this boundary plainly.

If the native webview cannot intercept an upload, download, permission prompt,
or submission before its effect, that operation is unsupported for agent
control on that platform. It must fail before dispatch rather than execute and
report approval afterward.

An action awaiting approval does not hold the resource execution queue. On
approval it revalidates owner epoch, lease revision and expiry, resource
generation, snapshot, element reference, and payload digest before re-entering
the queue. If any precondition changed, it fails closed and requires a new
action.

## Execution flow

1. The adapter authenticates the principal and submits a canonical command with
   action ID, idempotency key, owner epoch, lease ID/revision, resource
   ID/generation, and snapshot identity where applicable.
2. The runtime validates project scope, identity, lease, capability, expiry,
   resource generation, and payload limits.
3. Policy either rejects the action, records `approval_required`, or admits it
   to the resource queue.
4. One mutation executes at a time per resource. Read-only observation may run
   concurrently against a defined sequence or snapshot boundary.
5. The backend returns postcondition evidence such as output sequence, focus or
   size, resulting URL/title, or semantic action outcome.
6. The runtime appends a redacted terminal event and returns a structured
   receipt.

Idempotency keys return the original outcome. If dispatch may have occurred but
the effect cannot be confirmed, the outcome is `unknown`; the runtime does not
retry automatically.

## Operator experience

The desktop app adds a compact **Agent control** drawer and resource-level
status affordances:

- pane/tab header badge with leased agent, task, capability summary, and expiry;
- active and requested lease list;
- pending approval cards with approve-once, deny, and revoke-lease actions;
- immediate revoke action on every leased surface;
- recent redacted receipts linked to the visible resource.

Approval and lease controls use the operator credential and canonical control
commands. UI state is a projection of runtime state and events, not an
independent source of authority.

## Limits and redaction

All observation and action responses have explicit byte, node, depth, and time
limits. The implementation plan must choose tested constants rather than leave
them configurable without bounds.

The durable journal may contain IDs, capability names, timestamps, resource
metadata, redacted target descriptions, outcome codes, durations, truncation
counts, and payload digests. It must not persist:

- terminal output or transcripts;
- browser page text or semantic trees;
- screenshots;
- typed field values;
- script source or script results;
- file contents or upload paths beyond a redacted basename when needed for an
  approval card;
- cookies, storage, authorization headers, or environment secrets.

## Error contract

Stable error codes include:

- `lease_missing`, `lease_expired`, `lease_revision_mismatch`
- `capability_denied`, `operator_required`
- `owner_restarted`, `resource_missing`, `resource_replaced`
- `provider_unavailable`, `backend_unavailable`
- `snapshot_stale`, `element_missing`, `page_navigated`
- `approval_required`, `approval_denied`, `approval_expired`
- `payload_too_large`, `result_too_large`, `output_truncated`
- `action_timeout`, `effect_unknown`

Errors are structured and safe to expose to agents. Backend exception strings
are normalized and redacted before entering receipts or the journal.

## Delivery slices

### 1. Control foundation and panes

- Generalize resource identity and leases without weakening current lane
  takeover behavior.
- Add pane observation and typed pane actions to the canonical runtime.
- Route pane MCP mutations through the runtime.
- Add lease request/grant/revoke UI and resource badges.

### 2. Read-only browser control

- Register the desktop browser provider and browser-tab resources.
- Add semantic inspection and ephemeral screenshots.
- Prove redaction, bounds, opaque-frame behavior, and provider disconnect.

### 3. Semantic browser mutations

- Add typed navigation and element actions.
- Add risk classification, approval cards, resumable transactions, and effect
  receipts.
- Join the existing native browser lifecycle serialization.

### 4. Script escape hatch

- Add separately leased, per-invocation-approved evaluation.
- Enforce time, input, output, serialization, redaction, and audit limits.

Each slice must be independently reviewable and leave unsupported commands
explicitly rejected rather than silently accepted.

## Verification

### Unit and contract tests

- Capability matching, lease revision and expiry, explicit resource scope,
  restart revocation, operator-only grant/approval, and takeover behavior.
- Approval payload digests, single-use approval, expiry, revalidation, and queue
  re-entry.
- Idempotency, per-resource ordering, lifecycle barriers, and ambiguous effects.
- MCP schemas and proof that handlers translate to canonical commands rather
  than call effects directly.
- Stable error codes and redaction rules.

### Pane integration tests

Use an isolated tmux server to verify incremental output sequence, bounded
capture, named keys, interrupt, focus, resize, creation, close approval,
generation replacement, and ambiguous control-mode disconnects.

### Browser tests

- DOM fixtures for accessible names, roles, state, forms, hidden nodes, bounds,
  secret fields, truncation, and opaque cross-origin frames.
- Snapshot invalidation after navigation, reload, DOM replacement, timeout, and
  newer inspection.
- Native lifecycle tests proving automation cannot race navigation, restoration,
  or destruction.
- Provider authentication, reconnect, disconnect, resource invalidation, and
  unknown-effect behavior.
- Script timeout, JSON serialization, size caps, and per-invocation approval.

### Security tests

Prove that an agent cannot:

- grant, expand, renew, or approve its own lease;
- target an undelegated or replacement resource;
- reuse an approval with changed arguments;
- recover secret values through inspect, receipts, errors, or the journal;
- access raw tmux commands or agent-supplied selectors;
- bypass sensitive-action approval through the script tool;
- fall back to whole-desktop control.

### End-to-end acceptance

An agent receives a narrow lease, inspects a browser tab, performs safe semantic
interactions, pauses at a detected external form submission, resumes the exact
action after operator approval, observes and controls a leased pane, then loses
access immediately when the lease is revoked and when the owner restarts.

Before any implementation commit, run the focused tests for the changed slice,
`pnpm typecheck`, the full test suite, `pnpm build`, `pnpm smoke`,
`pnpm smoke:pack`, and the relevant native Rust formatting, checks, and tests.

## Acceptance criteria

- Every agent mutation of a Psyche pane or browser tab passes through
  `ControlRuntime` with a valid task lease.
- Resource generation prevents stale commands from reaching recreated panes or
  tabs.
- High-risk detectable actions pause as resumable, single-use approvals.
- Operators can inspect and revoke all active agent authority from the desktop
  app.
- Browser control uses semantic snapshots and typed actions; raw script remains
  a separately leased and approved escape hatch.
- Restart, provider loss, ambiguous dispatch, and lifecycle races fail closed
  with structured outcomes and no automatic replay.
- Durable evidence is useful for attribution without retaining transcripts,
  browser contents, screenshots, secrets, or scripts.
- No command can fall back to controlling the wider macOS desktop.
