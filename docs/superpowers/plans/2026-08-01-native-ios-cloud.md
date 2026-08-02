# Native iOS Cloud Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a Cloudflare-hosted, provider-isolated control plane that authenticates devices, coordinates encrypted host/client relay sessions, stores user metadata, and delivers privacy-preserving notifications without owning code or process state.

**Architecture:** Put HTTP APIs and authentication callbacks in a Worker, coordinate one host/session WebSocket room with Durable Objects, index durable metadata in D1, store only opt-in encrypted blobs in R2, and process push/audit/retention work through Queues. Depend on provider-neutral `RelayStore`, `MetadataStore`, `ArtifactStore`, and `NotificationSink` interfaces; the host’s `RelayConnector` and iOS `RelayTransport` speak only v3 and opaque IDs.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1, R2, Queues, Wrangler, Vitest, Miniflare/Workers test runtime, Web Crypto, APNs HTTP/2.

---

## File Structure

**Create**

- `cloud/psyche-control-plane/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`.
- `cloud/psyche-control-plane/src/index.ts` — HTTP router and WebSocket upgrade entry point.
- `cloud/psyche-control-plane/src/interfaces.ts` — portable store/sink contracts.
- `cloud/psyche-control-plane/src/auth/AuthService.ts`, `DeviceRegistry.ts`, `HostRegistry.ts`.
- `cloud/psyche-control-plane/src/relay/HostRelayDO.ts`, `RelayAuthorizer.ts`, `RelayCiphertext.ts`.
- `cloud/psyche-control-plane/src/stores/D1MetadataStore.ts`, `R2ArtifactStore.ts`, `QueueAuditSink.ts`, `APNSNotificationSink.ts`.
- `cloud/psyche-control-plane/migrations/0001_identity.sql`, `0002_metadata.sql`, `0003_audit.sql`.
- `cloud/psyche-control-plane/test/` suites below.
- `cloud/psyche-control-plane/docs/data-retention.md` and `docs/key-lifecycle.md`.

**Modify**

- `pnpm-workspace.yaml` — include `cloud/psyche-control-plane` without changing root package publishing.
- `src/services/relay/interfaces.ts` — share protocol-neutral relay messages with the host connector.
- `native/ios/PsycheCore/Sources/PsycheCore/Connection/RelayTransport.swift` — consume opaque relay endpoints/tokens only.
- `docs/PRODUCT-SPEC.md` and `README.md` — accurately describe opt-in cloud retention and host authority.

### Task 1: Establish Isolated Worker Package and Provider-Neutral Contracts

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `cloud/psyche-control-plane/package.json`
- Create: `cloud/psyche-control-plane/tsconfig.json`
- Create: `cloud/psyche-control-plane/vitest.config.ts`
- Create: `cloud/psyche-control-plane/wrangler.jsonc`
- Create: `cloud/psyche-control-plane/src/interfaces.ts`
- Create: `cloud/psyche-control-plane/test/interfaces.test.ts`

- [ ] **Step 1: Write a failing cloud-neutral contract test**

```ts
import { describe, expect, it } from 'vitest';
import type { MetadataStore, RelayStore } from '../src/interfaces.js';

describe('cloud interfaces', () => {
  it('uses opaque identifiers rather than provider resources in relay state', () => {
    const state: Parameters<RelayStore['putPresence']>[0] = {
      accountId: 'acct-1', hostId: 'host-1', connectionId: 'conn-1',
      capabilities: ['terminal.attach'], updatedAt: '2026-08-01T00:00:00.000Z',
    };
    expect(Object.keys(state)).not.toContain('durableObjectId');
  });
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/interfaces.test.ts
```

Expected: FAIL because the cloud workspace and interfaces do not exist.

- [ ] **Step 3: Create the isolated package**

Use this package shape:

```json
{
  "name": "@psyche/control-plane",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest --run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
```

Create `src/interfaces.ts`:

```ts
export interface RelayStore {
  putPresence(record: HostPresence): Promise<void>;
  getPresence(accountId: string, hostId: string): Promise<HostPresence | null>;
  appendCiphertext(room: RelayRoom, frame: Uint8Array): Promise<void>;
  replayCiphertext(room: RelayRoom, afterSequence: number): Promise<ReadonlyArray<RelayFrame>>;
}
export interface MetadataStore {
  upsertDevice(device: DeviceRecord): Promise<void>;
  saveDraft(draft: DraftRecord): Promise<void>;
  saveCursor(cursor: StreamCursor): Promise<void>;
  listProjects(accountId: string, hostId: string): Promise<ReadonlyArray<ProjectMetadata>>;
}
export interface ArtifactStore {
  putEncryptedArtifact(input: EncryptedArtifactInput): Promise<ArtifactManifest>;
  getEncryptedArtifact(accountId: string, artifactId: string): Promise<EncryptedArtifact>;
}
export interface NotificationSink {
  enqueue(notification: NotificationIntent): Promise<void>;
}
```

Declare `HostPresence`, `RelayRoom`, `RelayFrame`, `DeviceRecord`,
`DraftRecord`, `StreamCursor`, `ProjectMetadata`, `EncryptedArtifactInput`,
`ArtifactManifest`, `EncryptedArtifact`, and `NotificationIntent` in this file
with `accountId`, opaque IDs, ISO date strings, and ciphertext bytes only. Do
not add repository path, terminal content, Cloudflare binding, or provider ID
to the public contracts.

Configure `wrangler.jsonc` with Worker compatibility date selected during
implementation, a named `HostRelayDO` Durable Object binding, a D1 database
binding, an R2 bucket binding, and Queue producer/consumer bindings. Store
production binding IDs and secret values through Wrangler environment
configuration, not in the repository.

- [ ] **Step 4: Validate the package**

Run:

```sh
pnpm --dir cloud/psyche-control-plane run typecheck
pnpm --dir cloud/psyche-control-plane test
```

Expected: PASS; the standalone control-plane package typechecks and its
portable interfaces contain no Cloudflare identifiers.

- [ ] **Step 5: Commit isolated foundation**

```sh
git add pnpm-workspace.yaml cloud/psyche-control-plane/package.json cloud/psyche-control-plane/tsconfig.json cloud/psyche-control-plane/vitest.config.ts cloud/psyche-control-plane/wrangler.jsonc cloud/psyche-control-plane/src/interfaces.ts cloud/psyche-control-plane/test/interfaces.test.ts
git commit -m "feat: scaffold provider-isolated Psyche cloud plane" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add Account Authentication, Device Registry, and Host Credentials

**Files:**
- Create: `cloud/psyche-control-plane/src/auth/AuthService.ts`
- Create: `cloud/psyche-control-plane/src/auth/DeviceRegistry.ts`
- Create: `cloud/psyche-control-plane/src/auth/HostRegistry.ts`
- Create: `cloud/psyche-control-plane/migrations/0001_identity.sql`
- Create: `cloud/psyche-control-plane/test/auth.test.ts`
- Modify: `cloud/psyche-control-plane/src/index.ts`

- [ ] **Step 1: Write failing identity isolation tests**

```ts
it('issues a device-bound refresh session after verified Sign in with Apple identity', async () => {
  const session = await auth.completeAppleCallback(verifiedAppleToken);
  expect(session).toMatchObject({ accountId: 'acct-1', deviceId: 'device-1' });
  expect(session.accessToken).not.toContain('host-1');
});

it('rejects a device from a different account before host registration', async () => {
  await expect(hosts.register(otherAccountDevice, { hostId: 'host-1', publicKey: 'key-a' }))
    .rejects.toMatchObject({ code: 'account_device_mismatch' });
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/auth.test.ts
```

Expected: FAIL because authentication and registries do not exist.

- [ ] **Step 3: Implement account and device boundaries**

Create D1 migrations for `users`, `organizations`, `memberships`, `devices`,
`hosts`, `host_credentials`, and `notification_endpoints`. Use opaque primary
keys, account-scoped unique device public-key fingerprints, revoked timestamps,
and audit indexes. Never store host filesystem paths.

`AuthService` verifies Sign in with Apple authorization responses against the
provider’s published keys, exchanges only verified identities for short-lived
access tokens and rotating device-bound refresh sessions, and accepts GitHub
OAuth only when a configured repository feature requires it. Keep provider
claims inside `AuthService`; return product `AccountSession` objects elsewhere.

`DeviceRegistry` registers a device public key, lists/revokes it by account,
and publishes revocation to active relay rooms. `HostRegistry` requires an
authenticated, non-revoked device, records host public key and selected display
name, issues short-lived outbound host credentials, and requires credential
rotation on revocation. Hash all refresh and host credential secrets at rest.

- [ ] **Step 4: Pass identity and migration checks**

Run:

```sh
pnpm --dir cloud/psyche-control-plane run typecheck
pnpm --dir cloud/psyche-control-plane vitest --run test/auth.test.ts
pnpm --dir cloud/psyche-control-plane exec wrangler d1 migrations apply psyche-control --local
```

Expected: PASS; identity tests prove cross-account rejection and the local D1
migrations apply in order.

- [ ] **Step 5: Commit identity control plane**

```sh
git add cloud/psyche-control-plane/src/auth cloud/psyche-control-plane/src/index.ts cloud/psyche-control-plane/migrations/0001_identity.sql cloud/psyche-control-plane/test/auth.test.ts
git commit -m "feat: add cloud device and host registry" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Coordinate End-to-End Encrypted Outbound Relay Sessions

**Files:**
- Create: `cloud/psyche-control-plane/src/relay/HostRelayDO.ts`
- Create: `cloud/psyche-control-plane/src/relay/RelayAuthorizer.ts`
- Create: `cloud/psyche-control-plane/src/relay/RelayCiphertext.ts`
- Create: `cloud/psyche-control-plane/test/relay.test.ts`
- Modify: `cloud/psyche-control-plane/src/index.ts`
- Modify: `src/services/relay/interfaces.ts`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/RelayTransport.swift`

- [ ] **Step 1: Write failing relay tests**

```ts
it('routes ciphertext only between the authenticated device and its outbound host', async () => {
  const room = await fixture.connectHostAndDevice({ accountId: 'acct-1', hostId: 'host-1' });
  await room.device.send(encryptedFrame('device-1', 'host-1'));
  expect(room.host.received).toEqual([encryptedFrame('device-1', 'host-1')]);
  expect(room.relayLog).not.toContain('terminal plaintext');
});

it('rejects replayed nonce and a frame for another project before forwarding', async () => {
  await expect(fixture.sendReplay()).rejects.toMatchObject({ code: 'replayed_frame' });
  await expect(fixture.sendCrossProject()).rejects.toMatchObject({ code: 'project_not_authorized' });
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/relay.test.ts
```

Expected: FAIL because the relay room, authorizer, and ciphertext validator do not exist.

- [ ] **Step 3: Implement a bounded relay room**

Use one `HostRelayDO` instance per opaque account/host pair. Its WebSocket
upgrade validates short-lived account/device/host credentials, records
presence, orders envelope sequence, keeps a bounded ciphertext-only replay
window, and routes a frame only after `RelayAuthorizer` validates account,
organization membership, device, host, project subscription, expiry, nonce,
and v3 capability. The Durable Object must not decrypt terminal/file/prompt/
artifact payloads, derive a content key, or persist plaintext.

`RelayCiphertext` validates the client/host E2EE envelope shape:

```ts
export interface EncryptedEnvelope {
  version: 3;
  keyId: string;
  nonce: string;
  ciphertext: string;
  associatedData: { accountId: string; hostId: string; projectId: string; messageId: string; expiresAt: string };
}
```

It validates expiry, message-ID and nonce replay caches, associated-data
identity binding, and maximum ciphertext size; key agreement and decryption
occur only on the host and iOS device using their pinned device/host keys.

Update both transports to send generic v3 ciphertext envelopes. Neither file
may import Durable Objects, D1, R2, Queues, or a provider URL type.

- [ ] **Step 4: Pass relay fault tests**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/relay.test.ts
pnpm vitest --run __tests__/relay/RelayConnector.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/ConnectionManagerTests
```

Expected: PASS; host sleep/disconnect is visible as absent presence, frames
remain ciphertext, replays fail, and host/iOS transports retain provider
independence.

- [ ] **Step 5: Commit encrypted relay**

```sh
git add cloud/psyche-control-plane/src/relay cloud/psyche-control-plane/src/index.ts cloud/psyche-control-plane/test/relay.test.ts src/services/relay/interfaces.ts native/ios/PsycheCore/Sources/PsycheCore/Connection/RelayTransport.swift
git commit -m "feat: add encrypted outbound Psyche relay" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Persist Metadata, Drafts, Cursors, Preferences, and Optional Encrypted Artifacts

**Files:**
- Create: `cloud/psyche-control-plane/src/stores/D1MetadataStore.ts`
- Create: `cloud/psyche-control-plane/src/stores/R2ArtifactStore.ts`
- Create: `cloud/psyche-control-plane/migrations/0002_metadata.sql`
- Create: `cloud/psyche-control-plane/test/metadata.test.ts`
- Create: `cloud/psyche-control-plane/docs/data-retention.md`
- Create: `cloud/psyche-control-plane/docs/key-lifecycle.md`

- [ ] **Step 1: Write failing retention and authority tests**

```ts
it('stores a draft and cursor but never accepts repository content as metadata', async () => {
  await metadata.saveDraft({ accountId: 'acct-1', projectId: 'project-1', body: 'Run tests', updatedAt: now });
  await expect(metadata.saveProject({ accountId: 'acct-1', hostPath: '/Users/me/repo' }))
    .rejects.toMatchObject({ code: 'host_path_forbidden' });
});

it('stores optional artifact ciphertext without a decryptable content key', async () => {
  const manifest = await artifacts.putEncryptedArtifact(encryptedArtifact);
  expect(manifest).toMatchObject({ encrypted: true });
  expect(await rawR2.get(manifest.storageKey)).not.toContain('diff --git');
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/metadata.test.ts
```

Expected: FAIL because metadata and artifact stores do not exist.

- [ ] **Step 3: Implement scoped durable state**

Migration `0002_metadata.sql` creates `projects`, `sessions`, `panes`,
`subscriptions`, `stream_cursors`, `drafts`, `preferences`,
`notification_endpoints`, and `artifact_manifests`, all keyed to an account and
opaque host/project/session identifiers. Enforce account and organization
filters on every D1 query.

`D1MetadataStore` persists display names, status, last activity, draft body,
preferences, cursors, and lifecycle metadata. It rejects fields named
`root`, `cwd`, `worktreePath`, `hostPath`, `fileContent`, or `terminalOutput`.
Host live state wins over cloud summaries; stale state carries `updatedAt`.

`R2ArtifactStore` accepts only explicit opt-in encrypted chunks with an
envelope manifest, checksum, retention expiry, and no key material. Presign
uploads through the Worker after account/host authorization. Document default
no-archive behavior, user deletion, retention expiry, revocation effect, and
the device/host E2EE key lifecycle.

- [ ] **Step 4: Pass data authority tests**

Run:

```sh
pnpm --dir cloud/psyche-control-plane run typecheck
pnpm --dir cloud/psyche-control-plane vitest --run test/metadata.test.ts
pnpm --dir cloud/psyche-control-plane exec wrangler d1 migrations apply psyche-control --local
```

Expected: PASS; cloud durable state is account-scoped and contains no default
source/transcript content or decryptable artifact keys.

- [ ] **Step 5: Commit metadata stores**

```sh
git add cloud/psyche-control-plane/src/stores cloud/psyche-control-plane/migrations/0002_metadata.sql cloud/psyche-control-plane/test/metadata.test.ts cloud/psyche-control-plane/docs
git commit -m "feat: persist Psyche metadata and encrypted artifacts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Add Queue-Driven APNs, Audit, Cleanup, and Deployment Checks

**Files:**
- Create: `cloud/psyche-control-plane/src/stores/QueueAuditSink.ts`
- Create: `cloud/psyche-control-plane/src/stores/APNSNotificationSink.ts`
- Create: `cloud/psyche-control-plane/migrations/0003_audit.sql`
- Create: `cloud/psyche-control-plane/test/notifications.test.ts`
- Modify: `cloud/psyche-control-plane/src/index.ts`
- Modify: `cloud/psyche-control-plane/wrangler.jsonc`

- [ ] **Step 1: Write failing notification and duplicate delivery tests**

```ts
it('sends a generic lock-screen push once for a duplicated attention event', async () => {
  await sink.enqueue({ id: 'event-1', accountId: 'acct-1', kind: 'attention', detail: 'Agent needs review' });
  await sink.enqueue({ id: 'event-1', accountId: 'acct-1', kind: 'attention', detail: 'Agent needs review' });
  expect(apns.messages).toEqual([{ title: 'Psyche activity', body: 'Open Psyche to review.' }]);
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm --dir cloud/psyche-control-plane vitest --run test/notifications.test.ts
```

Expected: FAIL because queue sinks and notification processing do not exist.

- [ ] **Step 3: Implement asynchronous sinks**

`QueueAuditSink` writes append-only event IDs, actor IDs, action class,
outcome, timestamps, and redacted error code to a Queue; its consumer inserts
deduplicated `audit_events` rows. `APNSNotificationSink` queues attention and
completion hints, checks account preferences and device revocation, deduplicates
by event ID, and sends generic notification text unless the user has enabled
detail preview. Push payloads never include terminal/file/diff/prompt content.

Add a scheduled cleanup handler that deletes expired relay replay records,
drafts/artifacts selected for expiry, revoked credential records permitted by
audit policy, and notification retry records. Queue retries must be
idempotent. Expose only redacted metrics and correlation IDs in observability.

- [ ] **Step 4: Run cloud integration checks**

Run:

```sh
pnpm --dir cloud/psyche-control-plane test
pnpm --dir cloud/psyche-control-plane run typecheck
pnpm --dir cloud/psyche-control-plane exec wrangler dev --test-scheduled
```

Expected: PASS; unit tests cover duplicate push, authorization isolation,
retention cleanup, and audit redaction; the local Worker starts with scheduled
handlers enabled.

- [ ] **Step 5: Commit asynchronous services**

```sh
git add cloud/psyche-control-plane/src/stores/QueueAuditSink.ts cloud/psyche-control-plane/src/stores/APNSNotificationSink.ts cloud/psyche-control-plane/src/index.ts cloud/psyche-control-plane/wrangler.jsonc cloud/psyche-control-plane/migrations/0003_audit.sql cloud/psyche-control-plane/test/notifications.test.ts
git commit -m "feat: add Psyche cloud notifications and audit queues" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Acceptance Gates

- [ ] Each Worker route, Durable Object room, D1 query, R2 operation, Queue handler, and APNs call is accessed through a provider-neutral interface.
- [ ] Tests prove tenant, organization, device, host, and project isolation; revoked devices lose relay access immediately.
- [ ] The relay carries encrypted payloads and minimal routing metadata only; log assertions prove no plaintext terminal/file/prompt/artifact content.
- [ ] Default persistence contains metadata/drafts/cursors/preferences only. Artifact storage is explicit, encrypted, retention-bounded, and deletable.
- [ ] Host relay connection is outbound-only; no Cloudflare type or resource identifier appears in the v3 protocol or iOS transport.
- [ ] Only exact task paths are staged; unrelated dirty test files remain untouched.
