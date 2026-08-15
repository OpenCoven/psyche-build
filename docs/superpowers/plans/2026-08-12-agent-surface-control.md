# Agent Control of Psyche Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents lease-scoped, typed, auditable control over Psyche-managed terminal panes and embedded browser tabs without granting access to the wider desktop.

**Architecture:** Extend the canonical `ControlRuntime` with a live surface registry, task capability leases, approval transactions, and generic per-resource queues. Route MCP through the project control owner, connect the Tauri desktop as an authenticated browser effect provider, and execute browser operations through a bounded semantic runtime injected into the existing serialized child-webview lifecycle.

**Tech Stack:** TypeScript 7 ESM, Node.js local Unix sockets/named pipes, tmux control mode, MCP JSON-RPC, Tauri 2, Rust 1.77, WebKit/WKWebView on macOS, plain browser JavaScript, Vitest, Cargo tests, esbuild.

**Design:** `docs/superpowers/specs/2026-08-12-agent-surface-control-design.md`

---

## Scope and delivery rule

This is one dependency-ordered plan with four independently shippable slices:

1. control authority and typed pane control;
2. authenticated browser provider and read-only inspection;
3. semantic browser mutations and operator approvals;
4. the separately leased, per-invocation-approved script escape hatch.

Do not start a later slice until the preceding slice's focused tests and full
TypeScript validation are green. Every commit step below comes after its task's
verification step. Preserve existing v0 daemon and MCP tool names during the
migration, but do not allow them to bypass leases or the canonical runtime.

## Current-state constraints

- `psyche daemon` is currently the only composition root that creates
  `ControlRuntime` and mounts `ControlServer`.
- `psyche mcp` currently imports pane effects directly from `src/daemon/`; it
  must become a `ControlClient` adapter.
- The native app invokes Rust/Tauri commands directly and has no control-socket
  connection. Browser control therefore needs a provider bridge, not another
  policy engine in `web/main.js`.
- Browser lifecycle serialization already lives in
  `native/desktop/psyche-build-tauri/web/main.js`; automation must join it.
- Generated web bundles are committed. Every source-bundle change must run
  `pnpm --filter psyche-build-tauri build:web` and the bundle freshness test.
- The control protocol envelope remains version 1. New command kinds and
  provider frames are additive; checked-in v1 fixtures must remain decodable.

## Fixed limits

Use these constants in the first implementation. Tests must pin them.

```ts
export const AGENT_CONTROL_LIMITS = Object.freeze({
  leaseTtlMs: 30 * 60_000,
  approvalTtlMs: 5 * 60_000,
  paneOutputBytes: 64 * 1024,
  paneOutputChunks: 512,
  semanticNodes: 2_000,
  semanticDepth: 32,
  accessibleNameBytes: 512,
  snapshotTtlMs: 30_000,
  screenshotBytes: 4 * 1024 * 1024,
  scriptSourceBytes: 64 * 1024,
  scriptResultBytes: 256 * 1024,
  actionTimeoutMs: 15_000,
  scriptTimeoutMs: 5_000,
});
```

## File map

### Canonical control domain

- Create `src/control/limits.ts` — fixed bounded-control constants.
- Create `src/control/surfaces.ts` — pane/browser resource identities and live
  generation registry.
- Create `src/control/capabilityLeases.ts` — task-scoped capability grants,
  revisions, expiry, release, and revocation.
- Create `src/control/approvals.ts` — redacted intents, payload digests,
  single-use decisions, and expiry.
- Create `src/control/policy.ts` — capability and high-risk classification.
- Create `src/control/browserProviderBroker.ts` — one authenticated desktop
  provider per project and correlated effect dispatch.
- Create `src/control/hostProcess.ts` — connect-or-start behavior for CLI/MCP
  clients.
- Modify `src/control/types.ts` — new commands, snapshots, receipts, and stable
  error vocabulary.
- Modify `src/control/protocol.ts` — additive provider request/push frames.
- Modify `src/control/runtime.ts` — generic resource queues, lease/approval
  enforcement, status lookup, and restart fail-closed behavior.
- Modify `src/control/server.ts` — operator-only grant/approval and provider
  connection mode.
- Modify `src/control/client.ts` — lease, resource, and action helpers.
- Modify `src/control/host.ts` — compose the shared surface registry and browser
  provider broker.

### Pane and MCP adapters

- Create `src/control/resources/paneObservation.ts` — bounded sequenced output
  ring per pane.
- Modify `src/control/resources/panes.ts` — pane registry projection and typed
  action effect boundary.
- Modify `src/daemon/controlHandlers.ts` — pane observe/action and browser
  provider handlers.
- Modify `src/daemon/index.ts` — broker/server composition and output feed.
- Modify `src/mcp/server.ts` — control-client-backed tools and legacy aliases.
- Modify `README.md` — new tools, lease flow, migration behavior, and safety
  boundary.

### Native provider and browser runtime

- Create `native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs`
  — authenticated NDJSON control-socket provider and Tauri command surface.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs` — register
  provider state/commands and native screenshot support.
- Modify `native/desktop/psyche-build-tauri/src-tauri/Cargo.toml` — SHA-256 and
  base64 dependencies used by endpoint derivation and screenshots.
- Create `native/desktop/psyche-build-tauri/web/control/control-entry.js` —
  bundle exports.
- Create `native/desktop/psyche-build-tauri/web/control/browser-automation.mjs`
  — self-contained semantic snapshot/action runtime.
- Create `native/desktop/psyche-build-tauri/web/control/agent-control-model.mjs`
  — pure lease, approval, badge, and receipt view model.
- Create `native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs`
  — focused DOM renderer and keyboard behavior.
- Modify `native/desktop/psyche-build-tauri/package.json` — build
  `control.bundle.js` as `PsycheControl`.
- Modify `native/desktop/psyche-build-tauri/web/index.html` — load the bundle
  and add the Agent control drawer shell.
- Modify `native/desktop/psyche-build-tauri/web/styles.css` — lease badges,
  approval cards, focus, and drawer layout.
- Modify `native/desktop/psyche-build-tauri/web/main.js` — resource publication,
  provider effect routing, lifecycle joining, and UI projection only.
- Generate `native/desktop/psyche-build-tauri/web/control.bundle.js`.

### Tests

- Create `__tests__/controlSurfaces.test.ts`.
- Create `__tests__/controlCapabilityLeases.test.ts`.
- Create `__tests__/controlApprovals.test.ts`.
- Create `__tests__/controlPolicy.test.ts`.
- Create `__tests__/controlBrowserProviderBroker.test.ts`.
- Create `__tests__/controlHostProcess.test.ts`.
- Create `__tests__/controlPaneObservation.test.ts`.
- Create `__tests__/mcpAgentControl.test.ts`.
- Create `__tests__/tauriBrowserAutomation.test.ts`.
- Create `__tests__/tauriBrowserProvider.test.ts`.
- Create `__tests__/tauriAgentControlUi.test.ts`.
- Extend `__tests__/controlProtocol.test.ts`.
- Extend `__tests__/controlRuntime.test.ts`.
- Extend `__tests__/controlClient.test.ts`.
- Extend `__tests__/daemon/controlHandlers.test.ts`.
- Extend `__tests__/mcpServer.test.ts`.
- Extend `__tests__/tauriBrowserLifecycle.test.ts`.
- Extend `__tests__/tauriWebBundles.test.ts`.

## Task 1: Define surface identities, capabilities, and fixed bounds

**Files:**
- Create: `src/control/limits.ts`
- Create: `src/control/surfaces.ts`
- Create: `src/control/capabilityLeases.ts`
- Modify: `src/control/types.ts`
- Test: `__tests__/controlSurfaces.test.ts`
- Test: `__tests__/controlCapabilityLeases.test.ts`

- [ ] **Step 1: Add failing surface-generation tests**

Create `__tests__/controlSurfaces.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest';
import { SurfaceRegistry } from '../src/control/surfaces.js';

describe('SurfaceRegistry', () => {
  it('keeps generation for an unchanged native binding', () => {
    const registry = new SurfaceRegistry();
    const first = registry.upsertPane({
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo/wt',
      title: 'agent', writable: true, outputSequence: 0,
    });
    const second = registry.upsertPane({ ...first, title: 'renamed' });
    expect(second.generation).toBe(first.generation);
  });

  it('increments generation when the native binding changes', () => {
    const registry = new SurfaceRegistry();
    const first = registry.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    });
    const second = registry.upsertBrowserTab({ ...first, webviewLabel: 'browser-b' });
    expect(second.generation).toBe(first.generation + 1);
    expect(() => registry.require('tab-1', first.generation)).toThrowError(
      expect.objectContaining({ code: 'resource_replaced' }),
    );
  });
});
```

- [ ] **Step 2: Run the surface test and verify the missing-module failure**

Run: `pnpm exec vitest --run __tests__/controlSurfaces.test.ts`

Expected: FAIL because `src/control/surfaces.ts` does not exist.

- [ ] **Step 3: Add the bounded constants and surface contracts**

Create `src/control/limits.ts` with the exact `AGENT_CONTROL_LIMITS` object from
the Fixed limits section. Create `src/control/surfaces.ts` around these public
types:

```ts
export type SurfaceKind = 'pane' | 'browser_tab';

export interface SurfaceBase<K extends SurfaceKind> {
  id: string;
  kind: K;
  generation: number;
  projectRoot: string;
  worktreeRoot: string;
}

export interface PaneSurface extends SurfaceBase<'pane'> {
  tmuxPaneId: string;
  title?: string;
  agent?: string;
  writable: boolean;
  outputSequence: number;
}

export interface BrowserTabSurface extends SurfaceBase<'browser_tab'> {
  providerId: string;
  webviewLabel: string;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
}

export type SurfaceResource = PaneSurface | BrowserTabSurface;
```

`SurfaceRegistry.upsertPane()` compares `tmuxPaneId`; `upsertBrowserTab()`
compares both `providerId` and `webviewLabel`. Metadata-only updates preserve
generation. Binding changes increment it. `require(id, generation)` throws
`resource_missing` or `resource_replaced`. `removeByProvider(providerId)`
removes all matching browser tabs and returns their prior records.

- [ ] **Step 4: Add failing capability-lease tests**

Create `__tests__/controlCapabilityLeases.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';

describe('CapabilityLeaseStore', () => {
  it('binds an agent task to exact resource generations and capabilities', () => {
    const store = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00Z'), 7);
    const lease = store.grant({
      requestId: 'lease-request-1', actorId: 'agent-1', taskId: 'task-1',
      grantedBy: 'operator', ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 2 },
        capabilities: ['pane.observe', 'pane.input'] }],
    });
    expect(store.assert({ leaseId: lease.id, revision: lease.revision,
      actorId: 'agent-1', taskId: 'task-1', ownerEpoch: 7,
      target: { kind: 'pane', id: 'pane-1', generation: 2 },
      capability: 'pane.input' }).id).toBe(lease.id);
  });

  it('rejects future generations and clears all authority on restart', () => {
    const store = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00Z'), 7);
    const lease = store.grant({
      requestId: 'r', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        capabilities: ['browser.inspect'] }],
    });
    expect(() => store.assert({ leaseId: lease.id, revision: lease.revision,
      actorId: 'agent-1', taskId: 'task-1', ownerEpoch: 7,
      target: { kind: 'browser_tab', id: 'tab-1', generation: 2 },
      capability: 'browser.inspect' })).toThrowError(expect.objectContaining({ code: 'capability_denied' }));
    expect(new CapabilityLeaseStore(() => new Date(), 8).snapshot()).toEqual([]);
  });
});
```

- [ ] **Step 5: Implement capability leases without replacing legacy lane leases**

Create `src/control/capabilityLeases.ts`. Keep `LaneLeaseStore` intact for v0
takeover compatibility. Export these exact types:

```ts
export type SurfaceCapability =
  | 'pane.observe' | 'pane.input' | 'pane.interrupt' | 'pane.focus'
  | 'pane.resize' | 'pane.create' | 'pane.close'
  | 'browser.inspect' | 'browser.screenshot' | 'browser.navigate'
  | 'browser.interact' | 'browser.history' | 'browser.close' | 'browser.script';

export type LeaseTarget =
  | { kind: 'project'; id: string }
  | { kind: 'pane' | 'browser_tab'; id: string; generation: number };

export interface CapabilityLease {
  id: string;
  requestId: string;
  revision: number;
  ownerEpoch: number;
  actorId: string;
  taskId: string;
  grantedBy: string;
  grants: readonly { target: LeaseTarget; capabilities: readonly SurfaceCapability[] }[];
  createdAt: string;
  expiresAt: string;
}
```

`grant` clamps TTL to `AGENT_CONTROL_LIMITS.leaseTtlMs`, freezes the returned
lease, and increments the lease revision on renewal. `assert` checks owner
epoch, ID/revision, actor, task, expiry, exact target, and capability. `release`,
`revoke`, `revokeTarget`, and `revokeAll` return the invalidated leases for
journaling.

- [ ] **Step 6: Add command payload types without removing existing commands**

Extend `src/control/types.ts` with `LeaseGrant`, `PaneAction`,
`BrowserSemanticAction`, `SemanticSnapshot`, and `ActionReceipt`. Add command
kinds for `lease.request`, `lease.grant`, `lease.release`, `lease.revoke`,
`pane.observe`, `pane.action`, `browser.inspect`, `browser.action`,
`browser.script`, `approval.resolve`, and `provider.resource.upsert/remove`.
Every agent action payload carries `taskId`, `leaseId`, `leaseRevision`, target
ID, and expected generation. Do not add optional authorization fields.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlSurfaces.test.ts \
  __tests__/controlCapabilityLeases.test.ts \
  __tests__/controlLeases.test.ts \
  __tests__/controlProtocol.test.ts
pnpm typecheck
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 8: Commit the verified contracts**

```bash
git add src/control/limits.ts src/control/surfaces.ts \
  src/control/capabilityLeases.ts src/control/types.ts \
  __tests__/controlSurfaces.test.ts __tests__/controlCapabilityLeases.test.ts
git commit -m "feat: define agent surface control contracts"
```

## Task 2: Add single-use approvals and policy classification

**Files:**
- Create: `src/control/approvals.ts`
- Create: `src/control/policy.ts`
- Test: `__tests__/controlApprovals.test.ts`
- Test: `__tests__/controlPolicy.test.ts`

- [ ] **Step 1: Write failing approval digest and consumption tests**

Create `__tests__/controlApprovals.test.ts` with fixed-clock cases proving:

```ts
const pending = store.request({
  actionId: 'action-1', ownerEpoch: 7, leaseId: 'lease-1', leaseRevision: 2,
  resource: { kind: 'browser_tab', id: 'tab-1', generation: 3 },
  capability: 'browser.interact', effect: { kind: 'submit', target: 'Create issue' },
});
expect(pending.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
expect(store.approve(pending.id, 'operator', pending.payloadDigest).status).toBe('approved');
expect(() => store.consume(pending.id, pending.payloadDigest)).not.toThrow();
expect(() => store.consume(pending.id, pending.payloadDigest)).toThrowError(
  expect.objectContaining({ code: 'approval_denied' }),
);
```

Also prove changed payload digest, owner epoch, lease revision, resource
generation, denial, and five-minute expiry fail closed.

- [ ] **Step 2: Run the approval test and verify it fails**

Run: `pnpm exec vitest --run __tests__/controlApprovals.test.ts`

Expected: FAIL because `src/control/approvals.ts` does not exist.

- [ ] **Step 3: Implement deterministic redacted approval intents**

Create `src/control/approvals.ts`. Compute SHA-256 over a stable-key JSON value
containing action ID, owner epoch, lease identity, resource identity,
capability, and the already-redacted effect. Store no typed value, script,
terminal output, page text, cookie, header, or file path. Expose `request`,
`approve`, `deny`, `consume`, `expire`, `revokeForLease`, `revokeAll`, and
`snapshot`. Only `pending` approvals may transition; consumption is single-use.

- [ ] **Step 4: Write the risk-policy matrix test**

Create `__tests__/controlPolicy.test.ts` and pin this matrix:

```ts
expect(classifyBrowserAction({ kind: 'click', semantic: { role: 'button', submit: false } }))
  .toEqual({ decision: 'allow', capability: 'browser.interact' });
expect(classifyBrowserAction({ kind: 'type', semantic: { secret: true } }))
  .toMatchObject({ decision: 'approval', capability: 'browser.interact' });
for (const kind of ['submit', 'upload', 'download', 'permission_response', 'close'] as const) {
  expect(classifyBrowserAction({ kind })).toMatchObject({ decision: 'approval' });
}
expect(classifyBrowserScript()).toEqual({ decision: 'approval', capability: 'browser.script' });
expect(classifyPaneAction({ kind: 'close' })).toEqual({ decision: 'approval', capability: 'pane.close' });
```

- [ ] **Step 5: Implement policy as a pure exhaustive switch**

Create `src/control/policy.ts`. Every typed action maps to exactly one
capability and either `allow` or `approval`. Unknown action kinds return
`capability_denied`. `click` is allowed unless semantic metadata identifies a
submit control. `type` requires approval when `secret` is true. Upload,
download, permission response, form submission, close, and script always
require approval.

- [ ] **Step 6: Run policy, approval, and redaction tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlApprovals.test.ts \
  __tests__/controlPolicy.test.ts \
  __tests__/controlJournal.test.ts
pnpm typecheck
```

Expected: PASS; no approval fixture contains `password`, script source, page
text, or absolute upload path.

- [ ] **Step 7: Commit the verified policy layer**

```bash
git add src/control/approvals.ts src/control/policy.ts \
  __tests__/controlApprovals.test.ts __tests__/controlPolicy.test.ts
git commit -m "feat: add resumable agent action approvals"
```

## Task 3: Integrate leases, approvals, and generic resource queues into ControlRuntime

**Files:**
- Modify: `src/control/runtime.ts`
- Modify: `src/control/server.ts`
- Modify: `src/control/protocol.ts`
- Modify: `src/control/client.ts`
- Modify: `src/control/host.ts`
- Test: `__tests__/controlRuntime.test.ts`
- Test: `__tests__/controlProtocol.test.ts`
- Test: `__tests__/controlClient.test.ts`

- [ ] **Step 1: Add failing runtime authorization tests**

Extend `__tests__/controlRuntime.test.ts` to prove:

- an agent cannot grant, renew, revoke, or approve;
- an operator can grant only an existing exact-generation target, except the
  canonical project target for `pane.create`;
- an allowed action reaches its handler once;
- a high-risk action returns `approval_required` without invoking its handler;
- approval does not hold the resource queue;
- resumption revalidates owner epoch, lease revision, expiry, resource
  generation, snapshot, element reference, and payload digest;
- takeover, provider removal, and owner restart revoke matching authority;
- an ambiguous backend result becomes `effect_unknown` and is not retried.

Use an action fixture shaped as:

```ts
{
  id: 'cmd-click', idempotencyKey: 'idem-click', kind: 'browser.action',
  projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' },
  ownerEpoch: 7, createdAt: '2026-08-12T12:00:00.000Z',
  payload: {
    taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
    tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
    action: { kind: 'click', elementRef: 'e17',
      semantic: { role: 'button', name: 'Refresh', submit: false } },
  },
}
```

- [ ] **Step 2: Run the runtime tests and verify authorization failures**

Run: `pnpm exec vitest --run __tests__/controlRuntime.test.ts`

Expected: FAIL because the runtime has no surface leases, approvals, browser
handlers, or generic resource queues.

- [ ] **Step 3: Extend the handler boundary**

Add these methods to `ControlHandlers`:

```ts
observePane(payload: Payload<'pane.observe'>): Promise<unknown>;
actOnPane(payload: Payload<'pane.action'>): Promise<unknown>;
inspectBrowser(payload: Payload<'browser.inspect'>): Promise<unknown>;
actOnBrowser(payload: Payload<'browser.action'>): Promise<unknown>;
runBrowserScript(payload: Payload<'browser.script'>): Promise<unknown>;
```

Pass a shared `SurfaceRegistry`, `CapabilityLeaseStore`, and `ApprovalStore` to
`ControlRuntime.create`. Rename internal pane queues to resource queues keyed by
`kind:id:generation`; retain `blockPaneQueue()` as a test compatibility alias.

- [ ] **Step 4: Implement the canonical action transaction**

For each new action command, `ControlRuntime` must execute this order:

1. append `command.requested` with redacted metadata;
2. validate owner epoch and resource generation;
3. assert exact task capability lease;
4. classify policy;
5. return a succeeded receipt with state `approval_required` and journal only
   the redacted intent when approval is needed;
6. otherwise enqueue by resource key;
7. immediately before the effect, repeat epoch, generation, lease, and payload
   validation;
8. call exactly one handler;
9. append one terminal event with a redacted receipt.

`approval.resolve` is operator-only. Approval moves the original immutable
command back into validation and the resource queue. It never constructs a new
payload from UI fields.

- [ ] **Step 5: Extend snapshots and status lookup**

Add `resources`, `capabilityLeases`, `leaseRequests`, `approvals`, and bounded
recent `receipts` to `ControlSnapshot`. Do not include pane output, semantic
trees, screenshots, typed values, script source/results, or browser page text.
Action status is derived from the command/approval maps and journal terminal
events.

- [ ] **Step 6: Extend server authorization and additive protocol decoding**

In `src/control/server.ts`, make `lease.grant`, `lease.revoke`, and
`approval.resolve` operator-only regardless of stored capability strings.
Agents may submit `lease.request` and `lease.release`. Compatibility principals
cannot use new agent-control commands. Add all new command kinds to
`KNOWN_COMMAND_KINDS`.

In `src/control/protocol.ts`, validate the common authorization fields and
reject missing generations before runtime dispatch. Keep protocol version 1
and existing fixtures unchanged.

- [ ] **Step 7: Add typed client helpers**

Add `ControlClient.submit`, `getState`, `readEvents`, `requestLease`,
`releaseLease`, `resolveApproval`, and `actionStatus`. Helpers construct only
transport envelopes; the server continues stamping actor and owner epoch.

- [ ] **Step 8: Run focused control tests and typecheck**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlRuntime.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts \
  __tests__/controlLeases.test.ts
pnpm typecheck
```

Expected: PASS with existing v0 lane takeover tests unchanged.

- [ ] **Step 9: Commit the verified runtime integration**

```bash
git add src/control/runtime.ts src/control/server.ts src/control/protocol.ts \
  src/control/client.ts src/control/host.ts src/control/types.ts \
  __tests__/controlRuntime.test.ts __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts
git commit -m "feat: enforce surface leases in the control runtime"
```

## Task 4: Implement sequenced pane observation and typed pane actions

**Files:**
- Create: `src/control/resources/paneObservation.ts`
- Modify: `src/control/resources/panes.ts`
- Modify: `src/daemon/controlHandlers.ts`
- Modify: `src/daemon/index.ts`
- Test: `__tests__/controlPaneObservation.test.ts`
- Test: `__tests__/daemon/controlHandlers.test.ts`

- [ ] **Step 1: Write failing bounded-output tests**

Create `__tests__/controlPaneObservation.test.ts` to append chunks beyond both
the 512-chunk and 64-KiB caps, then assert:

```ts
expect(store.read('%3', { afterSequence: 4 })).toMatchObject({
  paneId: '%3', fromSequence: 5, nextSequence: 7, truncated: false,
});
expect(store.read('%3', { afterSequence: 0 }).bytes)
  .toBeLessThanOrEqual(AGENT_CONTROL_LIMITS.paneOutputBytes);
expect(store.read('%3', { afterSequence: 0 }).truncated).toBe(true);
```

Also prove UTF-8 chunk boundaries do not produce replacement characters and
the store never writes output into a journal fixture.

- [ ] **Step 2: Implement PaneObservationStore**

Create `src/control/resources/paneObservation.ts` with one monotonic sequence
per stable pane resource. Store raw `Buffer` chunks in memory, evict oldest
chunks at either cap, and decode only when reading. Return `fromSequence`,
`nextSequence`, `text`, `bytes`, and `truncated`.

- [ ] **Step 3: Feed the store from the one tmux control connection**

In `src/daemon/index.ts`, subscribe once to `TmuxControl` output and resolve the
tmux pane ID through `SurfaceRegistry`. On pane list/creation refresh, upsert
stable Psyche pane IDs with their tmux binding. On pane exit/rebind, remove or
replace the binding so generations change before further commands execute.

- [ ] **Step 4: Add typed pane effect tests**

Extend `__tests__/daemon/controlHandlers.test.ts` with injected `TmuxControl`
spies proving:

- `send_text` calls `sendKeysHex` with exact UTF-8 bytes;
- `send_keys` accepts only `Enter`, `Tab`, `Escape`, `Backspace`, arrow keys,
  `C-c`, and `C-d`;
- `interrupt`, `focus`, and `resize` call one acknowledged tmux operation;
- `create` delegates to `spawnBridgePane` with a canonical project scope;
- `close` calls `killPane` only after runtime approval;
- raw tmux syntax and newline-containing pane IDs are rejected.

- [ ] **Step 5: Implement pane observation and action handlers**

`observePane` reads `PaneObservationStore`. `actOnPane` uses an exhaustive
switch and the existing injected spawn/tmux capabilities. After focus/resize,
query tmux state and include the observed postcondition in the receipt. Throw
an error with `{ ambiguous: true }` if the control connection drops after
dispatch but before acknowledgement.

- [ ] **Step 6: Run the pane slice**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlPaneObservation.test.ts \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/services/tmuxControl.test.ts \
  __tests__/controlRuntime.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the verified pane backend**

```bash
git add src/control/resources/paneObservation.ts \
  src/control/resources/panes.ts src/daemon/controlHandlers.ts \
  src/daemon/index.ts __tests__/controlPaneObservation.test.ts \
  __tests__/daemon/controlHandlers.test.ts
git commit -m "feat: add leased typed pane control"
```

## Task 5: Make MCP a canonical control client and bootstrap the owner

**Files:**
- Create: `src/control/hostProcess.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `__tests__/controlHostProcess.test.ts`
- Test: `__tests__/mcpAgentControl.test.ts`
- Modify: `__tests__/mcpServer.test.ts`

- [ ] **Step 1: Write the connect-or-start test**

Create `__tests__/controlHostProcess.test.ts` with injected `connect`, `spawn`,
and clock functions. Prove it first tries the project-derived control socket,
spawns exactly:

```ts
[process.execPath, [entryPath, 'daemon', '--port', '0', '--project-root', canonicalRoot]]
```

with `{ detached: true, stdio: 'ignore' }`, calls `unref()`, waits up to five
seconds for authenticated control health, and treats concurrent `already owned`
startup as success once the socket answers. Timeout must throw
`control_owner_unavailable`.

- [ ] **Step 2: Implement `ensureHostControlPlane`**

Create `src/control/hostProcess.ts`:

```ts
export interface EnsureHostOptions {
  projectRoot: string;
  token: string;
  clientName: string;
  entryPath: string;
}

export async function ensureHostControlPlane(
  options: EnsureHostOptions,
): Promise<ControlClient>;
```

Canonicalize once, try `ControlClient.connect`, spawn the detached daemon only
for `ENOENT`/connection-refused, then poll with exponential delays capped at
250 ms. Never retry a mutation; only the initial health connection is retried.

- [ ] **Step 3: Write MCP registry and delegation tests**

Create `__tests__/mcpAgentControl.test.ts` and extend
`__tests__/mcpServer.test.ts`. Pin the eight new tool names from the design,
their required fields, and these behaviors:

- tools obtain the per-project agent token and call
  `ensureHostControlPlane`;
- `psyche_control_lease` cannot grant or approve;
- action tools return the canonical receipt unchanged;
- legacy create/kill tools remain listed but require `task_id`, `lease_id`, and
  `lease_revision` for mutation;
- no MCP handler imports or calls `spawnBridgePane`, `killBridgePane`,
  `TmuxControl`, or `execFileSync`.

- [ ] **Step 4: Replace direct MCP effects with ControlClient**

Change `McpDeps` to inject `controlClientForRoot` and read-only ritual/worktree
functions. Add:

- `psyche_control_list`
- `psyche_control_lease`
- `psyche_pane_observe`
- `psyche_pane_action`
- `psyche_browser_inspect`
- `psyche_browser_action`
- `psyche_browser_script`
- `psyche_control_action_status`

The approved design names eight tools; expose all eight. Update the README
table and exact-registry test together. Keep existing tools as aliases that
translate to canonical commands. An alias missing lease fields returns a
structured `lease_missing` response and performs no effect.

- [ ] **Step 5: Run MCP and host-process tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlHostProcess.test.ts \
  __tests__/mcpAgentControl.test.ts \
  __tests__/mcpServer.test.ts \
  __tests__/controlClient.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS; a source scan finds no pane mutation import in
`src/mcp/server.ts`.

- [ ] **Step 6: Commit slice 1**

```bash
git add src/control/hostProcess.ts src/mcp/server.ts src/index.ts README.md \
  __tests__/controlHostProcess.test.ts __tests__/mcpAgentControl.test.ts \
  __tests__/mcpServer.test.ts
git commit -m "feat: route MCP surface control through the owner"
```

## Task 6: Add the authenticated desktop browser provider transport

**Files:**
- Create: `src/control/browserProviderBroker.ts`
- Modify: `src/control/protocol.ts`
- Modify: `src/control/server.ts`
- Modify: `src/control/host.ts`
- Modify: `src/daemon/controlHandlers.ts`
- Modify: `src/daemon/index.ts`
- Create: `native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/Cargo.toml`
- Test: `__tests__/controlBrowserProviderBroker.test.ts`
- Test: `__tests__/tauriBrowserProvider.test.ts`

- [ ] **Step 1: Write failing broker correlation tests**

Create `__tests__/controlBrowserProviderBroker.test.ts`. Use a fake provider
connection and prove register, resource upsert/remove, one in-flight effect per
tab, correlated completion, timeout, disconnect, and ambiguous dispatch:

```ts
const pending = broker.dispatch({
  actionId: 'action-1', tabId: 'tab-1', generation: 2,
  operation: { kind: 'inspect' }, timeoutMs: 15_000,
});
expect(sent[0]).toMatchObject({ type: 'provider.effect.request', actionId: 'action-1' });
broker.complete('desktop-1', { actionId: 'action-1', status: 'succeeded', value: {} });
await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
```

If the provider disconnects before send, reject `provider_unavailable`; after
send, reject with `{ code: 'effect_unknown', ambiguous: true }`.

- [ ] **Step 2: Implement the broker and provider frames**

Add protocol frames:

```ts
type ProviderRequest =
  | { version: 1; type: 'provider.register'; requestId: string; providerId: string }
  | { version: 1; type: 'provider.resource.upsert'; requestId: string; resource: BrowserTabResource }
  | { version: 1; type: 'provider.resource.remove'; requestId: string; id: string; generation: number }
  | { version: 1; type: 'provider.effect.result'; requestId: string; result: ProviderEffectResult };

type ProviderPush = {
  version: 1;
  type: 'provider.effect.request';
  requestId: string;
  actionId: string;
  tabId: string;
  generation: number;
  operation: BrowserProviderOperation;
};
```

`ControlServer` accepts provider registration only from an operator principal,
then locks that connection into provider mode: provider frames are allowed and
ordinary control commands are rejected on that socket. The broker owns pending
effect correlation; the runtime remains the mutation authority.

- [ ] **Step 3: Compose the broker once in daemon startup**

Create one `BrowserProviderBroker` in `runDaemon`, pass it to
`createDaemonControlHandlers` and `ControlServer.start`, and use it for
`inspectBrowser`, `actOnBrowser`, and `runBrowserScript`. Provider resource
events update `SurfaceRegistry`; disconnect removes provider resources and
revokes matching leases/approvals before new commands are accepted.

- [ ] **Step 4: Write source-contract tests for the Rust provider**

Create `__tests__/tauriBrowserProvider.test.ts` to assert that:

- `control_provider.rs` derives the socket path from SHA-256 of the canonical
  project root using the same first 20 hex characters as TypeScript;
- it reads only the operator token from the 0600 project credentials file;
- it sends `hello` then `provider.register` before resource frames;
- server pushes are emitted to the main webview as
  `control:provider-effect-request`;
- Tauri commands accept typed resource/result structs, not arbitrary raw
  control frames;
- provider stop/reconnect clears pending effects.

- [ ] **Step 5: Implement the Rust provider manager**

Create `control_provider.rs` with a managed map keyed by canonical project root.
Each connection owns a Tokio task, newline-delimited reader, and mpsc writer.
Expose Tauri commands:

```rust
control_provider_start(app, state, project_root) -> Result<ProviderStatus, String>
control_provider_stop(state, project_root) -> Result<(), String>
control_provider_upsert(state, project_root, resource) -> Result<(), String>
control_provider_remove(state, project_root, tab_id, generation) -> Result<(), String>
control_provider_complete(state, project_root, result) -> Result<(), String>
control_operator_submit(state, project_root, command) -> Result<serde_json::Value, String>
control_state(state, project_root) -> Result<serde_json::Value, String>
```

`control_operator_submit` accepts only lease grant/revoke and approval resolve
variants represented by a tagged Rust enum. It cannot forward arbitrary agent
commands. Add `sha2 = "0.10"` and `base64 = "0.22"` to Cargo dependencies.

- [ ] **Step 6: Run provider tests in both languages**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlBrowserProviderBroker.test.ts \
  __tests__/tauriBrowserProvider.test.ts \
  __tests__/controlProtocol.test.ts
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml control_provider
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the provider transport**

```bash
git add src/control/browserProviderBroker.ts src/control/protocol.ts \
  src/control/server.ts src/control/host.ts src/daemon/controlHandlers.ts \
  src/daemon/index.ts \
  native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  __tests__/controlBrowserProviderBroker.test.ts \
  __tests__/tauriBrowserProvider.test.ts
git commit -m "feat: connect the desktop browser provider"
```

## Task 7: Build bounded semantic browser inspection

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/control/browser-automation.mjs`
- Create: `native/desktop/psyche-build-tauri/web/control/control-entry.js`
- Modify: `native/desktop/psyche-build-tauri/package.json`
- Modify: `native/desktop/psyche-build-tauri/web/index.html`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Test: `__tests__/tauriBrowserAutomation.test.ts`
- Modify: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `__tests__/tauriWebBundles.test.ts`

- [ ] **Step 1: Write semantic fixture tests**

Create `__tests__/tauriBrowserAutomation.test.ts` with a minimal DOM fixture
covering button, link, checkbox, select, textarea, password input, hidden node,
disabled node, nested labels, viewport clipping, and an inaccessible frame.
Assert schema `psyche.browser.snapshot/v1`, preorder references `e1`, `e2`,
bounded roles/names/state/bounds, password value omission, opaque frame marker,
and caps at 2,000 nodes/32 depth/512 accessible-name bytes.

Also assert that a second snapshot, navigation marker, document replacement,
or 30-second clock advance makes the first reference map throw
`snapshot_stale`.

- [ ] **Step 2: Implement the self-contained automation runtime**

`browser-automation.mjs` exports:

```js
export function installBrowserAutomation(globalObject, options = {})
export function browserAutomationSource()
export function dispatchBrowserAutomation(globalObject, request)
```

The installed object is `window.__PSYCHE_AUTOMATION__`. It owns one current
snapshot and reference map, computes accessible names from `aria-label`,
`aria-labelledby`, associated labels, `alt`, `title`, and bounded visible text,
and records only visible or interactive semantic nodes. Secret inputs expose
`{ secret: true, valuePresent: boolean }`, never their value.

- [ ] **Step 3: Add read-only dispatch and lifecycle joining**

Build `PsycheControl` as a committed bundle. On each finished
`browser:page-load`, `main.js` injects `browserAutomationSource()` through the
existing `browser_eval` lifecycle queue. On provider `inspect`, enqueue after
pending navigation, dispatch into the exact tab generation, and correlate the
emitted result. Any navigation or destroy invalidates snapshots before native
dispatch.

- [ ] **Step 4: Add native screenshot with an explicit unsupported result**

Add `browser_snapshot` in `lib.rs`. On macOS, use the child WKWebView's native
snapshot API and return bounded PNG base64 plus width/height. Abort before
returning if PNG bytes exceed 4 MiB. On platforms where a native child-webview
snapshot is unavailable, return the stable `backend_unavailable` error; do not
capture the desktop or use coordinate APIs.

- [ ] **Step 5: Publish browser resources**

When a project browser tab is created, navigated, restored, focused, or
destroyed, call the typed provider upsert/remove command with stable tab ID,
native label, worktree root, URL/title/loading state, and viewport. Never use
the active tab as an implicit fallback for an agent command.

- [ ] **Step 6: Build bundles and run the read-only browser slice**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
pnpm exec vitest --run \
  __tests__/tauriBrowserAutomation.test.ts \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriBrowserProvider.test.ts \
  __tests__/tauriWebBundles.test.ts
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml browser_
pnpm typecheck
```

Expected: PASS and generated `control.bundle.js` matches source.

- [ ] **Step 7: Commit slice 2**

```bash
git add native/desktop/psyche-build-tauri/web/control \
  native/desktop/psyche-build-tauri/web/control.bundle.js \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/package.json \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriBrowserAutomation.test.ts \
  __tests__/tauriBrowserLifecycle.test.ts __tests__/tauriWebBundles.test.ts
git commit -m "feat: expose semantic browser inspection"
```

## Task 8: Add semantic browser mutations and pre-dispatch risk gates

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/control/browser-automation.mjs`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `src/control/policy.ts`
- Modify: `src/control/runtime.ts`
- Modify: `src/daemon/controlHandlers.ts`
- Test: `__tests__/tauriBrowserAutomation.test.ts`
- Test: `__tests__/tauriBrowserLifecycle.test.ts`
- Test: `__tests__/controlPolicy.test.ts`

- [ ] **Step 1: Add action semantics tests**

Extend `tauriBrowserAutomation.test.ts` with exact tests for `click`, `type`,
`select`, `scroll`, `focus`, `submit`, `upload`, `download`, and
`permission_response`. Prove:

- every element operation needs current snapshot ID and element reference;
- actions dispatch real input/change/click events in browser order;
- `type` replaces by default and supports explicit append;
- disabled, hidden, detached, or replaced elements fail before effect;
- submit metadata is identified before click/submit dispatch;
- a secret value never appears in the result;
- upload paths are never passed into page JavaScript;
- unsupported native interception fails `backend_unavailable` before effect.

- [ ] **Step 2: Implement semantic actions against the snapshot map**

Use only stored element objects. Do not accept selectors, XPath, HTML, or
coordinates from the agent. Return bounded postconditions: focused state,
selected option values with secret redaction, scroll offsets, or resulting
URL/title. Mark the snapshot stale after any action that can navigate or replace
the document.

- [ ] **Step 3: Join native navigation and history actions**

Route `navigate`, `reload`, `back`, `forward`, and `close` through the existing
browser lifecycle serializer in `main.js`. `close` enters the canonical
approval path before `browser_destroy`. Never invoke lifecycle functions from
the provider event handler without the queue.

- [ ] **Step 4: Enforce native file and permission boundaries**

For upload, canonicalize the requested path in Rust and require containment in
the project root or a registered worktree before showing approval. For
downloads, require a project-contained destination and disable the webview's
default destination for agent-initiated downloads. For permission responses,
bind approval to permission kind, requesting origin, tab generation, and
single native prompt instance. If the platform cannot preflight/intercept any
of these operations, return `backend_unavailable` before dispatch.

- [ ] **Step 5: Prove generic-click limitations are explicit**

Add a test that a generic non-submit button is authorized by
`browser.interact`, while a semantic submit control requires approval. Pin the
MCP tool description and drawer copy to state that application-defined effects
behind a generic click cannot be perfectly predicted.

- [ ] **Step 6: Run semantic mutation tests**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
pnpm exec vitest --run \
  __tests__/tauriBrowserAutomation.test.ts \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/controlPolicy.test.ts \
  __tests__/controlRuntime.test.ts
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml browser_
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit semantic browser control**

```bash
git add native/desktop/psyche-build-tauri/web/control/browser-automation.mjs \
  native/desktop/psyche-build-tauri/web/control.bundle.js \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  src/control/policy.ts src/control/runtime.ts src/daemon/controlHandlers.ts \
  __tests__/tauriBrowserAutomation.test.ts \
  __tests__/tauriBrowserLifecycle.test.ts __tests__/controlPolicy.test.ts
git commit -m "feat: add approved semantic browser actions"
```

## Task 9: Build the operator lease and approval UI

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/control/agent-control-model.mjs`
- Create: `native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs`
- Modify: `native/desktop/psyche-build-tauri/web/control/control-entry.js`
- Modify: `native/desktop/psyche-build-tauri/web/index.html`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Test: `__tests__/tauriAgentControlUi.test.ts`

- [ ] **Step 1: Write pure view-model tests**

Create `__tests__/tauriAgentControlUi.test.ts` to prove the model:

- groups requested, active, expired, and revoked leases;
- shows agent, task, exact resources, capabilities, and expiry;
- renders redacted effect details only;
- exposes approve once, deny, and revoke lease only for operator state;
- maps resource badges to exact lease ID/revision;
- drops badges immediately when state owner epoch changes;
- preserves focus after a failed operator command.

- [ ] **Step 2: Implement the pure model and focused renderer**

`agent-control-model.mjs` contains normalization and selectors only.
`agent-control-drawer.mjs` owns DOM creation, keyboard focus, and callbacks only.
The renderer receives `onGrant`, `onDeny`, `onApprove`, and `onRevoke`; it does
not call Tauri or mutate control state directly.

- [ ] **Step 3: Add the drawer shell and resource badges**

Add a persistent titlebar **Agent control** button with pending count, a modal
drawer using existing dialog/focus conventions, and one compact badge in pane
and browser headers. Badge accessible names include agent, task, and expiry.
Every leased resource has an immediate revoke button in the drawer.

- [ ] **Step 4: Wire operator commands through Rust**

`main.js` polls/subscribes to `control_state`, projects it through the model,
and invokes only the typed `control_operator_submit` variants. Approval uses
the server-provided approval ID and payload digest; the UI never rebuilds the
original action. Failed commands retain the card, focus, and visible error.

- [ ] **Step 5: Build and run UI contracts**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
pnpm exec vitest --run \
  __tests__/tauriAgentControlUi.test.ts \
  __tests__/tauriBrowserProvider.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWebBundles.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit slice 3**

```bash
git add native/desktop/psyche-build-tauri/web/control \
  native/desktop/psyche-build-tauri/web/control.bundle.js \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/styles.css \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriAgentControlUi.test.ts
git commit -m "feat: add operator controls for agent leases"
```

## Task 10: Add the separately approved script escape hatch

**Files:**
- Modify: `src/control/types.ts`
- Modify: `src/control/policy.ts`
- Modify: `src/control/runtime.ts`
- Modify: `native/desktop/psyche-build-tauri/web/control/browser-automation.mjs`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Test: `__tests__/controlRuntime.test.ts`
- Test: `__tests__/tauriBrowserAutomation.test.ts`
- Test: `__tests__/mcpAgentControl.test.ts`

- [ ] **Step 1: Add script safety tests**

Prove all of the following:

- `browser.script` capability alone still returns `approval_required`;
- approval binds SHA-256 of script source but journal/receipt never stores it;
- every invocation requires a new approval;
- source over 64 KiB is rejected before approval;
- execution over five seconds returns `action_timeout`;
- non-JSON results, cycles, functions, DOM nodes, and native handles return
  `result_too_large` or a stable serialization error;
- JSON over 256 KiB is rejected;
- navigation or tab replacement during evaluation returns `effect_unknown` and
  is not retried.

- [ ] **Step 2: Implement bounded script dispatch**

After approval consumption, evaluate inside a Promise race with the fixed
timeout. Serialize by `JSON.stringify` then parse back to a plain value before
returning. The effect result contains only the parsed value, byte count, and
duration. The durable receipt contains only source digest, byte counts,
duration, and outcome.

- [ ] **Step 3: Rebuild and run script tests**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
pnpm exec vitest --run \
  __tests__/controlRuntime.test.ts \
  __tests__/controlPolicy.test.ts \
  __tests__/tauriBrowserAutomation.test.ts \
  __tests__/mcpAgentControl.test.ts \
  __tests__/tauriWebBundles.test.ts
pnpm typecheck
```

Expected: PASS and source scans find no script body in journal fixture output.

- [ ] **Step 4: Commit slice 4**

```bash
git add src/control/types.ts src/control/policy.ts src/control/runtime.ts \
  native/desktop/psyche-build-tauri/web/control/browser-automation.mjs \
  native/desktop/psyche-build-tauri/web/control.bundle.js \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/controlRuntime.test.ts __tests__/controlPolicy.test.ts \
  __tests__/tauriBrowserAutomation.test.ts __tests__/mcpAgentControl.test.ts
git commit -m "feat: add approved bounded browser scripts"
```

## Task 11: Harden redaction, restart, disconnect, and negative security paths

**Files:**
- Modify: `src/control/journal.ts`
- Modify: `src/control/runtime.ts`
- Modify: `src/control/browserProviderBroker.ts`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs`
- Create: `__tests__/agentSurfaceControlSecurity.test.ts`
- Modify: `__tests__/controlJournal.test.ts`
- Modify: `__tests__/controlBrowserProviderBroker.test.ts`

- [ ] **Step 1: Add adversarial fixtures**

Create `__tests__/agentSurfaceControlSecurity.test.ts` with attempts to:

- self-grant/self-approve;
- widen or renew a lease as an agent;
- target another project, undelegated tab, or replacement generation;
- reuse approval with changed text, upload path, permission, script, or target;
- inject newline tmux IDs, selectors, XPath, raw HTML, or raw tmux commands;
- recover password/page/script/output data through state, events, errors, or
  receipts;
- impersonate a provider with the agent token;
- fall back to accessibility, coordinates, or another provider.

Every attempt must fail with a stable code before the fake effect handler is
called.

- [ ] **Step 2: Add restart and disconnect recovery tests**

Persist journal events for active leases, pending approvals, and a dispatched
browser action. Create a new owner epoch and prove leases/approvals are empty,
the nonterminal action is `unknown`, provider resources are unavailable, and no
effect is replayed. Disconnect after dispatch must also remain unknown.

- [ ] **Step 3: Centralize redaction before journal append**

Add a journal payload builder for agent-control events that accepts only an
allowlisted metadata type. Do not recursively redact arbitrary effect payloads;
construct the permitted record explicitly. Unit tests must fail compilation if
callers try to pass transcript, page, screenshot, typed value, script, cookie,
header, or absolute path fields.

- [ ] **Step 4: Run the full security slice**

Run:

```bash
pnpm exec vitest --run \
  __tests__/agentSurfaceControlSecurity.test.ts \
  __tests__/controlJournal.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlBrowserProviderBroker.test.ts \
  __tests__/tauriBrowserProvider.test.ts
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml control_provider
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit hardening only after proof**

```bash
git add src/control/journal.ts src/control/runtime.ts \
  src/control/browserProviderBroker.ts \
  native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs \
  __tests__/agentSurfaceControlSecurity.test.ts \
  __tests__/controlJournal.test.ts \
  __tests__/controlBrowserProviderBroker.test.ts
git commit -m "test: harden agent surface control boundaries"
```

## Task 12: Document and verify the complete feature

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCT-SPEC.md`
- Modify: `docs/BRIDGE-SECURITY.md`
- Create: `docs/AGENT-SURFACE-CONTROL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the operator and agent guide**

Document:

- owner startup and project scoping;
- all eight MCP tools with exact required arguments;
- lease request/grant/revoke lifecycle;
- resource generations and stale snapshot recovery;
- approval-required operations and approve-once semantics;
- generic-click limitation;
- restart/provider disconnect behavior;
- explicit absence of whole-desktop fallback;
- redaction and non-persistence guarantees;
- troubleshooting for `control_owner_unavailable`, `provider_unavailable`,
  `resource_replaced`, `snapshot_stale`, and `effect_unknown`.

- [ ] **Step 2: Run source and generated-artifact guards**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
git diff --exit-code -- native/desktop/psyche-build-tauri/web/*.bundle.js
! rg -n "spawnBridgePane|killBridgePane|TmuxControl|execFileSync" src/mcp/server.ts
! rg -n "AXUIElement|CGEvent|cliclick|coordinate" src/control native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs native/desktop/psyche-build-tauri/web/control
git diff --check
```

Expected: all regenerated bundle diffs are empty; both negated forbidden source
scans exit 0 because they find no matches; `git diff --check` exits 0.

- [ ] **Step 3: Run the complete TypeScript verification surface**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
```

Expected: every command exits 0. Record exact test/pass counts in the PR body.

- [ ] **Step 4: Run the complete native verification surface**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --all-targets
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml
```

Expected: every command exits 0.

- [ ] **Step 5: Perform the end-to-end acceptance scenario**

Using an isolated test project and development app:

1. start `psyche mcp` and confirm one project owner;
2. request a narrow lease for one pane and one browser tab;
3. grant it in Agent control and verify badges/expiry;
4. inspect the tab and safely click/type/select using snapshot references;
5. submit a form and verify only that action pauses;
6. approve once and verify the original action resumes exactly once;
7. observe pane output incrementally, send text, resize, and interrupt;
8. revoke the lease and verify the next pane/browser action fails;
9. restart the owner and verify old lease, approval, snapshot, and generation
   credentials fail closed;
10. disconnect the provider after dispatch and verify `effect_unknown` with no
    automatic retry.

Capture receipts and UI screenshots for the PR without including page content,
terminal transcripts, secrets, or scripts.

- [ ] **Step 6: Commit final docs only after all gates pass**

```bash
git add README.md docs/PRODUCT-SPEC.md docs/BRIDGE-SECURITY.md \
  docs/AGENT-SURFACE-CONTROL.md CHANGELOG.md
git commit -m "docs: explain agent control of Psyche surfaces"
```

## Plan self-review matrix

- Managed-surface-only boundary: Tasks 6-8 and 11.
- Stable IDs and generation fencing: Tasks 1, 3, 4, and 7.
- Per-task capability leases: Tasks 1, 3, 5, and 9.
- High-risk resumable approvals: Tasks 2, 3, 8, and 9.
- Typed terminal control: Tasks 4 and 5.
- Semantic browser inspection: Tasks 6 and 7.
- Typed browser actions: Task 8.
- Script escape hatch: Task 10.
- Restart/provider fail-closed behavior: Tasks 3, 6, and 11.
- Redacted bounded evidence: Tasks 2, 4, 7, 10, and 11.
- Operator visibility and revocation: Task 9.
- Existing MCP compatibility without authority bypass: Task 5.
- Full repository and native verification: Task 12.
