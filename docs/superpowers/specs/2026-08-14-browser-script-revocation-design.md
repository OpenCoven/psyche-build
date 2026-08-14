# Browser Script Authority Revocation — Design

Date: 2026-08-14
Status: Approved for implementation

## Goal

Ensure one approved browser script cannot retain authority after its invocation
completes. Approved scripts may inspect a bounded page snapshot and request
synchronous DOM mutations, but they must not keep timers, listeners, observers,
network activity, navigation authority, executable page-realm code, or any
other callback alive after success.

## Decisions

- Replace direct approved-source execution in a live `WKContentWorld` with a
  one-shot Worker that has no live `window` or `document`.
- Give the Worker only bounded JSON input: script arguments and a compact DOM
  snapshot with invocation-scoped node references.
- Let approved source return ordinary JSON data and a declarative mutation
  plan. It does not receive live DOM objects.
- Terminate the Worker before applying mutations or reporting success.
- Apply mutations through trusted native/page code only after validating the
  document token, node references, operation allowlist, value limits, and
  executable-content restrictions.
- Permit synchronous text, safe attribute, property, and form-control changes.
- Reject navigation, event-handler attributes, executable URLs, HTML/script
  injection, external resource creation, and stale targets.
- Quarantine outcomes when execution or mutation application may have started
  but cannot be classified safely.

## Non-goals

- General Playwright, WebDriver, or page-realm JavaScript compatibility.
- Persistent automation callbacks, background polling, or subscriptions.
- Arbitrary HTML replacement or script/style injection.
- Network access from approved scripts.
- Navigation, downloads, uploads, permission prompts, or window creation.
- Preserving the existing API behavior for scripts that depend on live DOM
  globals. Those scripts must migrate to snapshot queries and mutation plans.

## Architecture

```text
approved browser.script command
              |
              v
native target + document validation
              |
              v
bounded DOM snapshot and invocation input
              |
              v
one-shot Worker
  - no window/document
  - no timers/network/importScripts
  - query snapshot
  - build mutation plan
              |
        terminate Worker
              |
              v
trusted mutation validator
              |
              v
document token recheck
              |
              v
synchronous mutation apply
              |
              v
document token recheck + bounded result
```

### One-shot Worker

Each invocation creates a fresh Worker from a fixed trusted runtime. The
runtime captures and freezes its required intrinsics before approved source
runs. It removes or shadows ambient authority including:

- timers and animation scheduling;
- event listener APIs;
- fetch, WebSocket, EventSource, and other network clients;
- `importScripts`, dynamic module loading, and nested workers;
- browser storage and navigation globals;
- live DOM and page objects.

Approved source receives:

- canonical JSON arguments;
- the bounded snapshot;
- pure snapshot query helpers;
- a mutation-plan builder.

The Worker has a strict wall-clock timeout and result-size limit. The native
caller terminates it on success, rejection, timeout, malformed output, or
provider cancellation. Termination occurs before any mutation is applied and
before success is reported.

### DOM snapshot

Trusted page code captures a compact snapshot for the selected document. Each
entry includes an invocation-scoped node ID and only the fields required for
approved inspection:

- node type and normalized tag name;
- bounded text and accessible label;
- allowlisted attributes and form state;
- parent/child relationships within configured node and depth limits.

The snapshot excludes executable content, event handlers, JavaScript URLs,
raw object identities, page prototypes, and unbounded HTML.

Node IDs are valid only for the document token and invocation that produced
them. They are never persisted or reused.

## Script result contract

The Worker returns canonical JSON:

```json
{
  "value": {},
  "mutations": [
    {
      "kind": "set_text",
      "node_id": "n17",
      "value": "Updated"
    }
  ]
}
```

Allowed mutation kinds:

- `set_text`: replace text content with bounded plain text.
- `set_attribute`: set an allowlisted non-executable attribute.
- `remove_attribute`: remove an allowlisted attribute.
- `set_property`: set an allowlisted scalar property.
- `set_form_value`: update supported input, textarea, or select state.
- `set_checked`: update supported checkbox or radio state.
- `focus`: synchronously focus an existing snapshot node.

The initial implementation does not create, remove, reorder, or clone nodes.
This keeps mutation identity and rollback classification tractable.

## Mutation validation

Trusted code validates the complete plan before applying any operation:

- exact invocation and document token match;
- bounded operation count and aggregate encoded size;
- unique, existing invocation-scoped node references;
- operation allowed for the target node type;
- bounded strings and finite scalar values;
- attribute/property allowlists;
- rejection of `on*` attributes, `srcdoc`, executable URLs, HTML sinks,
  script/style creation, navigation targets, and external-resource changes;
- no operation that can register callbacks or evaluate code.

Validation failure applies nothing and returns a stable error.

## Apply and completion flow

1. Validate the trusted caller, lease, approval, target generation, URL, and
   document token.
2. Capture the bounded snapshot.
3. Run approved source in a fresh Worker.
4. Terminate the Worker.
5. Parse and validate the complete result and mutation plan.
6. Recheck target generation, URL, and document token.
7. Resolve all node IDs and preflight every operation.
8. Apply the plan synchronously in order.
9. Recheck the document token and encode the bounded result.
10. Report success only after all checks complete.

No approved-source callback exists when step 7 begins.

## Error handling

Stable errors remain sanitized and allowlisted:

- `backend_unavailable`
- `effect_unknown`
- `result_too_large`
- `serialization_failed`
- `script_source_too_large`
- `target_unavailable`
- `automation_failed`
- `snapshot_too_large`
- `mutation_plan_invalid`
- `mutation_target_stale`
- `mutation_not_allowed`

Failures before mutation application are fail-closed and apply nothing.
Timeouts, target replacement, navigation, provider loss, or callback loss
after dispatch return `effect_unknown` and quarantine the browser resource
until authoritative state is re-established.

## Limits

Use existing script source, argument, result, and timeout limits. Add:

- maximum snapshot nodes and depth;
- maximum text per node and aggregate snapshot bytes;
- maximum mutation count;
- maximum encoded mutation-plan bytes;
- maximum value length per mutation.

All limits are enforced before allocation or application where possible.

## Testing

### Worker authority

- `window` and `document` are unavailable.
- timers, listeners, observers, nested workers, imports, and network APIs are
  unavailable or rejected.
- a script cannot retain a callback after its result resolves.
- the Worker is terminated on success, error, timeout, and cancellation.

### Snapshot and result bounds

- oversized, deep, cyclic, accessor-bearing, or non-canonical values fail
  deterministically.
- snapshot node, depth, text, and aggregate byte limits are enforced.
- invocation-scoped node IDs cannot be reused.

### Mutation validation

- valid text, safe attribute, scalar property, form value, checked state, and
  focus operations succeed.
- event handlers, HTML sinks, JavaScript URLs, script/style injection,
  navigation, external resource mutation, stale nodes, and wrong node types
  fail before application.
- one invalid operation rejects the entire plan.

### Lifecycle and ambiguity

- document replacement before or after Worker execution rejects the result.
- navigation or provider loss during apply returns `effect_unknown`.
- no success receipt is emitted before Worker termination and final document
  validation.

## Migration

Keep the public approved-script command and lease/approval flow. Change the
approved source environment from live DOM globals to explicit snapshot/query
and mutation-plan helpers. Document the supported helper contract and return
stable `mutation_not_allowed` errors for unsupported live-DOM behavior.

