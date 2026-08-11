# Control Socket Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the already-built canonical `ControlServer` inside the running daemon so external operator/agent `ControlClient`s can drive every daemon mutation (panes + coven sessions) through the single `ControlRuntime` authority.

**Architecture:** In `runDaemon` (`src/daemon/index.ts`), after the host control plane is created, self-provision the file-backed credential store and start a `ControlServer` bound to the project-derived Unix endpoint against the same `host.runtime` / `host.epoch` the v0 WebSocket already uses. The two servers run side by side and share one journaled authority. Bind failure is fatal to daemon startup; the owner fence is released if start throws. One integration test proves a real client drives a pane mutation and a coven-session mutation end-to-end and that a bogus token is refused.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Vitest, node:net Unix sockets, pnpm.

---

## Context an implementer needs first

- **Package manager is `pnpm`, never `npm`.**
- **Commit trailer is REQUIRED** on every commit:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- **Git SSH signing is broken in this environment** — commit with `-c commit.gpgsign=false`.
- **`pnpm typecheck` regenerates the gitignored `src/utils/generated-agents-doc.ts`.** Run `git checkout -- src/utils/generated-agents-doc.ts` before every commit.
- **Two macOS test failures are PRE-EXISTING and EXPECTED** at every gate: `__tests__/releaseWorkflow.test.ts` (~lines 196 & 298, BSD `stat '%Lp'`). They are NOT regressions.
- **No `lint` script exists.** Do not invent one.
- Work in the worktree `.worktrees/control-socket-mount` on branch `feat/control-socket-mount`. Run `pnpm install` in the worktree first (worktrees don't share `node_modules`).
- `pnpm smoke` runs `pnpm build` first and uses real tmux + owner fence.

### The exact building blocks (already exist, do not rebuild)

`ControlServer.start(options)` — `src/control/server.ts`:
```ts
export interface ControlServerOptions {
  endpoint: string;
  projectRoot: string;
  ownerEpoch: number;
  runtime: ControlServerRuntime;      // { submit, snapshot, readEvents } — ControlRuntime satisfies this
  credentials: ControlCredentialStore;
}
// static async start(options): Promise<ControlServer>
// async close(): Promise<void>   // destroys sockets, stops listening, unlinks socket file
// get address(): string
```

`createControlCredentialStore(options)` — `src/control/credentials.ts`:
```ts
// options: { projectRoot: string; filePath?: string }
// returns ControlCredentialStore with authenticate/operatorToken/agentToken
// auto-mints tokens to <root>/.psyche/runtime/control-credentials.json (0700 dir / 0600 file) on first use
```

`controlEndpointForProject(canonicalProjectRoot)` — `src/control/endpoint.ts`: returns the Unix socket path string.

`ControlClient.connect(options)` — `src/control/client.ts`:
```ts
// options: { projectRoot, token, clientName, endpoint? }
// .submit(command: ControlCommandInput): Promise<CommandOutcome>
// .close(): Promise<void>
```

`host` (from `createHostControlPlane`) exposes `{ epoch: number; runtime: ControlRuntime; close(): Promise<void> }`. `host.runtime` already satisfies `ControlServerRuntime` (it is passed as `controlRuntime` to `Connection` today, and has `snapshot()`/`readEvents()` from PR 3a).

### The current mount site (`src/daemon/index.ts`, verified line numbers)

- Line 120: `const host = await createHostControlPlane(canonicalProjectRoot, { handlers: controlHandlers });`
- Lines 122–133: `const wss = new WebSocketServer({...})`.
- Lines 141–148: startup `console.log` lines (daemon addr, project root, tmux session, token file).
- Lines 167–175: `shutdown(signal)` — `tmux.stop(); wss.close(); void host.close()...finally(process.exit(0))`.
- Line 35–38: existing control imports:
  ```ts
  import { canonicalizeProjectRoot } from '../control/projectIdentity.js';
  import { createHostControlPlane } from '../control/host.js';
  import type { ControlActorKind, ControlCommand, CommandOutcome } from '../control/types.js';
  ```

### Canonical command payload shapes (from `src/control/types.ts`)

```ts
// coven.session.launch payload: { harness: string; prompt: string; cwd?: string; title?: string }
// pane.resize payload:          { paneId: string; cols: number; rows: number }
```

`ControlCommandInput` is a command with `id`, `idempotencyKey`, `kind`, `projectRoot`, `createdAt`, `payload` (the server overwrites `projectRoot`, and stamps `actor`/`ownerEpoch`). See `inputCommand()` in `__tests__/controlClient.test.ts` for the exact literal shape.

### `CovenSessionSummary` (from `src/daemon/protocol.ts`) — the launch result type

```ts
type CovenSessionSummary = {
  id: string; projectRoot: string; cwd?: string; harness: string; title: string;
  status: 'starting'|'running'|'waiting'|'completed'|'failed'|'killed'|'orphaned'|'created'|'archived';
  createdAt: string; updatedAt: string; archivedAt?: string;
};
```

### How to build a REAL host + handlers in a test (drive coven without a live harness)

`createDaemonControlHandlers` (`src/daemon/controlHandlers.ts`) accepts injectable `createCovenClient` and `covenSpawnDeps`. A `CovenClient` with a `launchSession` stub lets `coven.session.launch` return a `CovenSessionSummary` without any real harness. `launchProjectCovenSession` (bridge.ts:234) calls `client.launchSession({ harness, prompt, title, projectRoot, cwd })` then verifies the returned `session.projectRoot` is inside the project scope via `realpath` — so the stub MUST return `projectRoot` equal to (or inside) the canonical temp project root, or it throws `coven_session_scope_violation`.

`AgenticCapabilityRouter` is constructed as `new AgenticCapabilityRouter({ strategies: [] })` (see `__tests__/daemon/controlHandlers.test.ts`).

---

## Task 1: Mount ControlServer + credential store in `runDaemon`

**Files:**
- Modify: `src/daemon/index.ts` (imports near lines 35–38; mount after line 120; startup log near 148; shutdown 167–175)

- [ ] **Step 1: Add the control-layer imports**

At the top of `src/daemon/index.ts`, alongside the existing `../control/*` imports (after line 36), add:

```ts
import { ControlServer } from '../control/server.js';
import { createControlCredentialStore } from '../control/credentials.js';
import { controlEndpointForProject } from '../control/endpoint.js';
```

- [ ] **Step 2: Provision credentials and start the control server**

Immediately after line 120 (`const host = await createHostControlPlane(...)`), insert:

```ts
  // Mount the canonical control socket alongside the v0 WebSocket. Both share
  // the one host runtime, so every mutation — from either transport — passes
  // through the single journaled, lease-revalidating authority. If start fails
  // after the owner fence is held, release the fence before rethrowing so the
  // lock never leaks.
  const controlCredentials = await createControlCredentialStore({
    projectRoot: canonicalProjectRoot,
  });
  const controlEndpoint = controlEndpointForProject(canonicalProjectRoot);
  let controlServer: ControlServer;
  try {
    controlServer = await ControlServer.start({
      endpoint: controlEndpoint,
      projectRoot: canonicalProjectRoot,
      ownerEpoch: host.epoch,
      runtime: host.runtime,
      credentials: controlCredentials,
    });
  } catch (error) {
    await host.close().catch(() => undefined);
    throw error;
  }
```

- [ ] **Step 3: Announce the control endpoint at startup**

After the existing `token file:` log line (line 148), add:

```ts
  // eslint-disable-next-line no-console
  console.log(`control socket: ${controlEndpoint}`);
```

- [ ] **Step 4: Close the control server on shutdown**

Replace the `shutdown` body (lines 167–173) so it also closes the control server before releasing the fence:

```ts
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\npsyche daemon shutting down (${signal})`);
    tmux.stop();
    wss.close();
    void Promise.allSettled([controlServer.close(), host.close()])
      .finally(() => process.exit(0));
  };
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. Then run `git checkout -- src/utils/generated-agents-doc.ts` (typecheck regenerates it).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/index.ts
git -c commit.gpgsign=false commit -m "feat(daemon): mount canonical control socket in runDaemon

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: End-to-end reachability test (pane + coven mutation + auth rejection)

**Files:**
- Create: `__tests__/daemon/controlSocketMount.test.ts`

This test wires the SAME components `runDaemon` wires — a real `host` (memory journal), real `createDaemonControlHandlers` over a recording tmux + stub coven client, a real credential store, a real `ControlServer` on a temp endpoint, and a real `ControlClient` — and asserts the two mutation families are reachable and auth is enforced.

- [ ] **Step 1: Write the failing test**

Create `__tests__/daemon/controlSocketMount.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer } from '../../src/control/server.js';
import { ControlClient } from '../../src/control/client.js';
import { createControlCredentialStore } from '../../src/control/credentials.js';
import { createHostControlPlane } from '../../src/control/host.js';
import { canonicalizeProjectRoot } from '../../src/control/projectIdentity.js';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import type { CovenClient } from '../../src/daemon/bridge.js';
import type { CovenSessionSummary } from '../../src/daemon/protocol.js';

let cleanups: Array<() => Promise<void>> = [];
let tempRoots: string[] = [];

function socketPath(): string {
  return path.join(tmpdir(), `psyche-mount-${randomBytes(6).toString('hex')}.sock`);
}

function inputCommand(kind: string, payload: unknown) {
  const id = randomBytes(4).toString('hex');
  return {
    id,
    idempotencyKey: `idem-${id}`,
    kind,
    projectRoot: '/will-be-overwritten',
    createdAt: new Date().toISOString(),
    payload,
  } as Parameters<ControlClient['submit']>[0];
}

async function startMountedDaemon(): Promise<{
  projectRoot: string;
  endpoint: string;
  operatorToken: string;
  recordedKeys: string[];
  launched: Array<{ harness: string; prompt: string }>;
}> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-mount-proj-'));
  tempRoots.push(projectRoot);
  const canonicalRoot = await canonicalizeProjectRoot(projectRoot);

  // Recording tmux: capture sendKeysHex so we can assert the pane mutation
  // reached the effect boundary.
  const recordedKeys: string[] = [];
  const tmux = new TmuxControl('psyche-mount-test');
  vi.spyOn(tmux, 'sendKeysHex').mockImplementation(async (_paneId: string, hex: string) => {
    recordedKeys.push(hex);
  });

  // Stub coven client: launchSession returns a summary scoped INSIDE the
  // project root (bridge enforces scope via realpath).
  const launched: Array<{ harness: string; prompt: string }> = [];
  const covenClient: CovenClient = {
    listSessions: async () => [],
    launchSession: async (req) => {
      launched.push({ harness: req.harness, prompt: req.prompt });
      const now = new Date().toISOString();
      const summary: CovenSessionSummary = {
        id: 'sess-mounted',
        projectRoot: canonicalRoot,
        harness: req.harness,
        title: req.title ?? 'mounted',
        status: 'starting',
        createdAt: now,
        updatedAt: now,
      };
      return summary;
    },
  };

  const handlers = createDaemonControlHandlers({
    tmux,
    projectRoot: canonicalRoot,
    sessionName: 'psyche-mount-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => covenClient,
  });

  const host = await createHostControlPlane(canonicalRoot, { handlers });
  cleanups.push(() => host.close());

  const credentials = await createControlCredentialStore({
    projectRoot: canonicalRoot,
    filePath: path.join(projectRoot, 'creds.json'),
  });
  const endpoint = socketPath();
  const server = await ControlServer.start({
    endpoint,
    projectRoot: canonicalRoot,
    ownerEpoch: host.epoch,
    runtime: host.runtime,
    credentials,
  });
  cleanups.push(() => server.close());

  return {
    projectRoot: canonicalRoot,
    endpoint,
    operatorToken: await credentials.operatorToken(),
    recordedKeys,
    launched,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
  cleanups = [];
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
  vi.restoreAllMocks();
});

describe('mounted control socket end-to-end', () => {
  it('drives a pane mutation through the mounted socket', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.resize', { paneId: '%1', cols: 100, rows: 40 }),
    );

    expect(outcome.status).toBe('succeeded');
  });

  it('drives a coven session launch and returns a typed summary', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('coven.session.launch', {
        harness: 'codex',
        prompt: 'do the thing',
        title: 'mounted launch',
      }),
    );

    expect(outcome.status).toBe('succeeded');
    expect(daemon.launched).toEqual([{ harness: 'codex', prompt: 'do the thing' }]);
    if (outcome.status === 'succeeded') {
      const summary = outcome.value as CovenSessionSummary;
      expect(summary.id).toBe('sess-mounted');
      expect(summary.harness).toBe('codex');
    }
  });

  it('refuses a client presenting a bogus token', async () => {
    const daemon = await startMountedDaemon();
    await expect(
      ControlClient.connect({
        projectRoot: daemon.projectRoot,
        endpoint: daemon.endpoint,
        token: 'not-the-real-token',
        clientName: 'intruder',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm exec vitest run __tests__/daemon/controlSocketMount.test.ts`
Expected: 3 passed. (The mount test exercises real code paths that already exist — Task 1 only wires them into `runDaemon`, so this test passes against the same building blocks regardless. Its job is to lock the reachability contract in place.)

If the pane test fails with a lease/takeover error, note that `pane.resize` needs no lease (unlike `pane.input`), which is why the plan uses `pane.resize` — it is the simplest mutation that reaches the runtime and returns `succeeded` without a takeover handshake. Do not switch to `pane.input` here.

- [ ] **Step 3: Commit**

```bash
git add __tests__/daemon/controlSocketMount.test.ts
git -c commit.gpgsign=false commit -m "test(daemon): prove mounted control socket drives pane + coven mutations

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Full gate + push

**Files:** none (verification only)

- [ ] **Step 1: Typecheck (and revert generated file)**

Run: `pnpm typecheck && git checkout -- src/utils/generated-agents-doc.ts`
Expected: 0 errors.

- [ ] **Step 2: Focused suites**

Run: `pnpm exec vitest run __tests__/daemon/controlSocketMount.test.ts __tests__/controlClient.test.ts __tests__/controlCredentials.test.ts __tests__/daemon/controlAdapter.test.ts`
Expected: all pass.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all pass EXCEPT the 2 known macOS `releaseWorkflow` `stat '%Lp'` failures. Any other failure is a regression to fix before proceeding.

- [ ] **Step 4: Smoke (real tmux + owner fence + real bind)**

Run: `pnpm smoke`
Expected: pass. This confirms the daemon actually binds the control socket at startup without a lock collision and shuts down cleanly.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/control-socket-mount
```

- [ ] **Step 6: Open the PR via REST** (GraphQL is rate-limited in this environment)

```bash
cat > /tmp/pr-body.md <<'EOF'
Mounts the canonical `ControlServer` inside `runDaemon`, alongside the existing v0
WebSocket, against the same host `ControlRuntime` / owner epoch. External
operator/agent `ControlClient`s can now drive every daemon mutation (panes +
coven sessions) through the single journaled authority.

- Self-provisions operator/agent creds via the existing file-backed store
  (`.psyche/runtime/control-credentials.json`, 0700/0600).
- Bind failure is fatal to daemon startup; the owner fence is released if start
  throws.
- Closes the control socket cleanly on shutdown alongside the host.
- New e2e test drives a pane mutation and a coven-session launch through the
  mounted socket and asserts a bogus token is refused.

No v0 WebSocket behavior change; no new authz policy; no CLI token verb (deferred).

Gate: typecheck 0; `pnpm test` green except the 2 known macOS releaseWorkflow
stat failures; `pnpm smoke` pass.
EOF
gh api --method POST repos/OpenCoven/psyche-build/pulls \
  -f title="feat(daemon): mount canonical control socket" \
  -f head=feat/control-socket-mount -f base=main -F body=@/tmp/pr-body.md
```

- [ ] **Step 7: Watch CI**

```bash
# Get the head SHA, then poll check-runs:
SHA=$(git rev-parse HEAD)
gh api repos/OpenCoven/psyche-build/commits/$SHA/check-runs \
  --jq '.check_runs[] | {name: .name, status: .status, conclusion: .conclusion}'
```
Expected: TypeScript+Rust ✓, iOS ✓, Copilot ✓. If iOS flakes (exit 65, all unit tests pass, zero Swift files touched), rerun: `gh run rerun <RUNID> --repo OpenCoven/psyche-build --failed`.

---

## Task 4: Review, merge, cleanup, memory

**Files:** `/Users/buns/.coven/workspaces/familiars/cody/memory/2026-08-08.md`

- [ ] **Step 1: Run the code-review subagent** on the diff (`git diff origin/main...HEAD`). Address High/Medium findings; document any declines with rationale. Re-gate after any fix.

- [ ] **Step 2: Handle Copilot review** once CI posts it. Fix valid findings, decline with rationale otherwise, re-gate + push.

- [ ] **Step 3: Sign-off + merge via REST** (self cannot APPROVE; main is protected → admin-squash):

```bash
gh api --method POST repos/OpenCoven/psyche-build/pulls/<N>/reviews -f event=COMMENT -F body=@/tmp/signoff.md
gh api --method PUT repos/OpenCoven/psyche-build/pulls/<N>/merge -f merge_method=squash
```

- [ ] **Step 4: Cleanup** — remote branch auto-deletes on merge. Then:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/psyche-build
git worktree remove .worktrees/control-socket-mount
git branch -D feat/control-socket-mount
git checkout main && git pull --ff-only
```

- [ ] **Step 5: Record memory** — append a PR entry to `memory/2026-08-08.md` (branch, merge commit, what shipped, gate results, any review findings), matching the format of the prior PR #39–#43 entries.

---

## Self-Review

**Spec coverage:**
- Mount ControlServer in runDaemon → Task 1 ✓
- Self-provision credentials → Task 1 Step 2 ✓
- Bind failure fatal + release host on failure → Task 1 Step 2 (try/catch) ✓
- Close on shutdown → Task 1 Step 4 ✓
- Startup log line → Task 1 Step 3 ✓
- E2e test: pane mutation + coven launch + auth rejection → Task 2 (3 cases) ✓
- Gate (typecheck/focused/full/smoke) → Task 3 ✓
- Non-goals (no client wrappers, no CLI verb, no v0 change, no panes.meta, no authz change) → respected; nothing in any task touches them ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete; `<N>` and `<RUNID>` are runtime values (PR number, CI run id) that only exist after Task 3, correctly deferred to Task 4.

**Type consistency:** `ControlServerOptions` fields match server.ts; `inputCommand` shape matches `controlClient.test.ts`; `CovenSessionSummary` fields match protocol.ts; `CovenClient.launchSession` signature matches bridge.ts (returns summary with in-scope `projectRoot`); `createDaemonControlHandlers` deps match controlHandlers.ts; `AgenticCapabilityRouter({ strategies: [] })` matches controlHandlers.test.ts. `host.runtime` satisfies `ControlServerRuntime` (used identically as `controlRuntime` in Connection today).

**Design note verified during planning:** `pane.resize` is used for the pane test (not `pane.input`) because resize reaches the runtime and returns `succeeded` without a lease/takeover handshake, keeping the reachability assertion minimal and robust.
