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

The desktop registers as an operator-authenticated browser provider. Provider
connections are provider-only after registration; an agent token cannot
register or impersonate one. Native browser commands accept calls only from the
trusted `main` webview.

## MCP tools

All mutation and observation tools use the canonical project root returned by
the owner. `task_id`, `lease_id`, and `lease_revision` identify one exact grant.
Pane and browser operations additionally require the current resource
`generation`.

| Tool | Required arguments |
|---|---|
| `psyche_control_list` | none (`project_root` optional) |
| `psyche_control_lease` | `operation`, `task_id`; requests also require `ttl_ms`, `grants`; release requires `lease_id`, `lease_revision` |
| `psyche_pane_observe` | `task_id`, `lease_id`, `lease_revision`, `pane_id`, `generation` |
| `psyche_pane_action` | `task_id`, `lease_id`, `lease_revision`, `action`; existing-pane actions require `pane_id`, `generation`, creation requires `project_id` |
| `psyche_browser_inspect` | `task_id`, `lease_id`, `lease_revision`, `tab_id`, `generation` |
| `psyche_browser_action` | `task_id`, `lease_id`, `lease_revision`, `tab_id`, `generation`, `action`; element actions additionally require `snapshot_id` and `action.elementRef` |
| `psyche_browser_script` | `task_id`, `lease_id`, `lease_revision`, `tab_id`, `generation`, `source` |
| `psyche_control_action_status` | `action_id` |

Compatibility aliases route through the same owner. Create, execute-task, kill,
and pane-output operations require lease fields; missing authority returns
`lease_missing` before an effect.

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

## Evidence and failure semantics

State, events, and stored receipts contain allowlisted metadata only. They do
not persist terminal output, semantic/page contents, screenshots, typed/secret
values, scripts, cookies, headers, full paths, directory names, or backend error
details. A redacted basename may be retained only for approval context, and a
redacted target description may identify the requested effect. Pane reads,
semantic trees, screenshots, and script return values are bounded response data,
not journal payloads.

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
