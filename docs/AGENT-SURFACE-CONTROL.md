# Agent surface control

Psyche Build exposes project-scoped terminal panes and embedded browser tabs to
agents through one authenticated control owner. It does not grant agents tmux,
WebView, accessibility, coordinate, or whole-desktop authority directly.

## Owner and project scope

`psyche mcp` connects to the canonical project root's local control socket. If
the owner is absent it starts `psyche daemon --port 0 --project-root <root>`,
then waits for authenticated health. A project has one owner epoch. A restart
invalidates every prior lease, approval, semantic snapshot, resource generation,
and nonterminal effect.

For task-scoped agent use, start `psyche mcp` with a trusted task binding:

- `psyche mcp --task-id <task-id>` plus `PSYCHE_CONTROL_TASK_TOKEN=<task-token>`, or
- `PSYCHE_CONTROL_TASK_ID=<task-id>` plus `PSYCHE_CONTROL_TASK_TOKEN=<task-token>`

The credential store binds each task token to exactly one task subject. The
control server authenticates that token, includes the trusted
`taskBinding.taskId` and `taskBinding.subjectId` in its welcome frame, and the
client rejects a mismatched welcome. Non-operator task scope comes only from
that authenticated binding, never from a caller-supplied `task_id`. Task-bound
MCP also pins `project_root` reads and commands to the canonical launch
project, accepting only that root or one of its symlink aliases. The
default model is one active subject per task: rotating a token invalidates the
prior token immediately, the server revalidates already-open task-bound
connections before every read and command, and the replacement subject does
not inherit the revoked subject's leases, pending requests, approvals, or
receipts. Pending approvals keep durable task/actor/subject plus
lease/action ownership, and lease expiry/prune or subject revocation rewrites
`approval_required` into one terminal `action_invalidated` receipt without
depending on a live lease map. Capability leases and `approval.resolve`
re-check the active subject before use so revoked authority fails closed on
the next request. Embedded
launchers mint and revoke those credentials through the public ESM subpath:

```ts
import {
  issueControlTaskCredential,
  issueControlTaskToken,
  issueControlTaskTokenForCanonicalRoot,
  revokeControlTaskCredential,
} from 'psyche-build/control-task-tokens';
```

These trusted-launcher helpers require operator/agent root secret material and
must not be exposed to untrusted agents. By default, control credential state
lives outside the repository under
`~/.config/psyche/control/projects/<sha256(canonicalProjectRoot)>/`, with
`control-credentials.json`, `task-credentials/<sha256(taskId)>.json`, and
`task-credential-locks/<sha256(taskId)>.lock/` stored as `0700` directories
and `0600` files. Legacy in-project task credential and task-binding paths are
ignored rather than followed or migrated automatically.
`issueControlTaskCredential()` returns the replacement token plus
`{ taskId, subjectId, principalId }` metadata for the authenticated subject and
reports the replaced subject when one existed. `issueControlTaskToken*()` are
convenience wrappers that return only the replacement token for the common
one-active-token-per-task flow. `revokeControlTaskCredential()` removes the
active subject so the old token fails authentication on reconnect and on the
next read or mutation from an already-open socket. The legacy shared agent
token stays unbound, redacted, and unable to use task-sensitive commands.

The filesystem hardening here is aimed at malicious repository contents and
sibling project paths that can precreate, symlink, hardlink, FIFO, or rename
project-local paths. It does not try to hide credentials from already-arbitrary
same-user code execution, which can read process memory or the per-user state
directory directly.

The desktop registers as an operator-authenticated browser provider. Provider
connections are provider-only after registration; an agent token cannot
register or impersonate one. Native browser commands accept calls only from the
trusted `main` webview.

## MCP tools

All mutation and observation tools use the canonical project root returned by
the owner. All task-scoped MCP reads and mutations first resolve task identity
against the authenticated client. When the client is task-bound, omitted
`task_id` resolves to that binding, exact matches are accepted, and conflicting
values fail `task_binding_mismatch` before any control read or command. An
unbound non-operator cannot create authority by supplying `task_id`; task-scoped
reads and task-sensitive mutations fail `task_binding_required`. Pane and
browser operations additionally require the current resource `generation`.

| Tool | Required arguments |
|---|---|
| `psyche_control_list` | `project_root` optional; `task_id` optional for compatibility |
| `psyche_control_lease` | `operation`; `task_id` optional when task-bound; status also requires `request_id`; requests also require `ttl_ms`, `grants`; release requires `lease_id`, `lease_revision` |
| `psyche_pane_observe` | `lease_id`, `lease_revision`, `pane_id`, `generation`; `task_id` optional when task-bound |
| `psyche_pane_action` | `lease_id`, `lease_revision`, `action`; `task_id` optional when task-bound; existing-pane actions require `pane_id`, `generation`; creation requires `project_id` |
| `psyche_browser_inspect` | `lease_id`, `lease_revision`, `tab_id`, `generation`; `task_id` optional when task-bound |
| `psyche_browser_action` | `lease_id`, `lease_revision`, `tab_id`, `generation`, `action`; `task_id` optional when task-bound; element actions additionally require `snapshot_id` and `action.elementRef` |
| `psyche_browser_script` | `lease_id`, `lease_revision`, `tab_id`, `generation`, `source`; `task_id` optional when task-bound |
| `psyche_control_action_status` | `action_id`; `task_id` optional for compatibility; replay results keep `resource.idDigest` instead of a live `resource.id` |
| `psyche_list_panes` | `project_root` optional; `task_id` optional for compatibility |
| `psyche_execute_task` | `prompt`, `lanes`, `lease_id`, `lease_revision`; `task_id` optional when task-bound |
| `psyche_create_pane` | `prompt`, `agent`, `lease_id`, `lease_revision`; `task_id` optional when task-bound |
| `psyche_kill_pane` | `pane_id`, `generation`, `lease_id`, `lease_revision`; `task_id` optional when task-bound |
| `psyche_get_pane_output` | `pane_id`, `generation`, `lease_id`, `lease_revision`; `task_id` optional when task-bound |

Compatibility aliases route through the same owner and task-resolution helper.
Create, execute-task, kill, and pane-output operations require lease fields;
missing authority returns `lease_missing` before an effect.

If `psyche mcp` starts without a task binding, non-operator task-scoped MCP
tools such as `psyche_control_list`, `psyche_control_lease status`,
`psyche_list_panes`, and `psyche_control_action_status` fail closed with
`task_binding_required` instead of returning a redacted view. Task-sensitive
commands such as lease request/release, pane operations, browser operations,
and orchestration fail closed with `task_binding_required`.
Replayed `psyche_control_action_status` receipts preserve the journal's
redacted resource digest instead of reconstructing a live resource id.
Task-bound validation failures keep exact task/actor ownership even when the
runtime must fail before a trustworthy lease tuple exists, and include
lease id/revision whenever the owner can still prove them.

## Lease lifecycle

1. An agent requests narrow grants with `psyche_control_lease`.
2. The Agent control drawer shows the agent, task, exact resources,
   capabilities, and expiry.
3. An operator grants the request. Agents cannot self-grant, widen, renew, or
   approve authority.
4. Every operation revalidates actor, task, lease ID/revision, owner epoch,
   target ID/generation, and capability immediately before dispatch.
5. The operator or agent can revoke/release the lease. Provider disconnect,
   resource replacement, pane takeover, expiry, and owner restart also revoke
   it.

Resource IDs are stable; generations fence replacement instances. Refresh state
after `resource_replaced`. Browser element references belong to a single
30-second semantic snapshot; inspect again after `snapshot_stale` or
`element_missing`.

## Approve-once operations

Pane close, browser close, form submission, submit-capable generic clicks,
secret input, upload/download, permission responses, and scripts pause only the
originating action. The operator approves the server-provided approval ID and
payload digest. Approval revalidates the immutable original action and is
consumed once; changed text, path, permission, script, target, lease, or
generation cannot reuse it.

A generic click is classified using captured semantics, but page JavaScript can
still make consequences impossible to predict perfectly. Form method and
destination are captured and rechecked immediately before a submit-capable
click or explicit submit.

Scripts always need a fresh approval. Source is limited to 64 KiB, execution to
five seconds, and JSON results to 256 KiB. Functions, cycles, DOM/native objects,
and other non-JSON results fail closed. Script bodies are represented durably by
SHA-256 and byte counts, never source.

Approved source receives `args` and a bounded `page` API. `page.snapshot` and
`page.get(nodeId)` are immutable. Mutations are declarative, validated as one
plan, and applied synchronously only after the one-shot script worker has been
terminated:

```js
const button = page.get("n17");
if (!button) return { changed: false };

page.setText(button.id, "Ready");
page.setAttribute(button.id, "aria-label", "Ready");
page.focus(button.id);

return { changed: true };
```

Live `window`/`document`, timers, network, listeners, observers, imports,
nested workers, navigation, HTML sinks, executable URLs, and external resource
creation are unavailable. Node IDs expire after the invocation. Disallowed
mutation plans return `mutation_not_allowed`; rejected source syntax or other
unsupported Worker behavior returns `automation_failed`. Approved source also
rejects executable slash tokens, including division and regular-expression
literals, so import preflight can fail closed without lexical ambiguity.

## Evidence and failure semantics

Durable journal events and journaled receipts contain allowlisted metadata only.
They do not persist terminal output, semantic/page contents, screenshots,
typed/secret values, scripts, cookies, headers, absolute/full paths or
unredacted path components, or backend error details. A redacted basename may
be retained only for approval context, and a redacted target description may
identify the requested effect. Live in-memory control state may retain exact
operational resource IDs until owner restart. Pane reads, semantic trees,
screenshots, and script return values are bounded response data, not journal
payloads.
Task-scoped reads may expose only resources named by persisted capability-lease
grants or pending lease requests for the authenticated subject, active
approvals whose durable task/actor ownership matches that subject (with a
lease id/revision fallback for legacy approvals), and receipts that carry a
durable task/actor/lease ownership tuple stamped by the owner. Legacy receipts
without that ownership proof stay operator-only, so unrelated or unattributed
action IDs resolve to `unknown` for agent-scoped status checks. At the MCP boundary, conflicting read-time `task_id` values fail
`task_binding_mismatch` before a read is sent; once authorized, scope stays
pinned to the authenticated binding. Without a task binding, task-scoped MCP
reads fail closed with `task_binding_required` instead of returning a redacted
view.

Psyche Build never retries a mutation whose delivery may have occurred. A
timeout, provider disconnect after dispatch, navigation during script
evaluation, or owner recovery reports `effect_unknown`; inspect state before
deciding what to do next.

There is deliberately no accessibility, coordinate, screenshot-click, shell,
raw tmux command, XPath, selector, or whole-desktop fallback.

## Troubleshooting

- `control_owner_unavailable`: verify the canonical project is accessible and
  run `psyche daemon --port 0 --project-root <root>` once to inspect startup.
- `provider_unavailable`: open the desktop project/browser surface and wait for
  its authenticated provider registration; do not fall back to desktop input.
- `resource_replaced`: refresh `psyche_control_list`, request/grant authority for
  the new generation, and do not reuse the old lease.
- `snapshot_stale` or `element_missing`: call `psyche_browser_inspect` again and
  use references from that response only.
- `effect_unknown`: do not retry automatically. Inspect the resource and query
  `psyche_control_action_status`; ask the operator if the effect cannot be
  established safely.
