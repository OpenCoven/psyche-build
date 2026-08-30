import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS,
  WORKSPACE_CACHE_MAX_DRAFTS,
  WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS,
  WORKSPACE_CACHE_MAX_ID_CODE_UNITS,
  WORKSPACE_CACHE_MAX_PANES,
  WORKSPACE_CACHE_MAX_PROJECTS,
  WORKSPACE_CACHE_MAX_RECORD_BYTES,
  WORKSPACE_CACHE_RECORD_VERSION,
  WorkspaceCacheError,
  createMemoryWorkspaceCacheStorage,
  createWorkspaceCacheStore,
  deriveHostKey,
  discardWorkspaceCache,
  restoreWorkspaceCache,
  saveWorkspaceCache,
  validateCachedWorkspaceState,
  workspaceCacheStorageKey,
  type CachedWorkspaceState,
  type WorkspaceCacheProblem,
  type WorkspaceCacheProblemCode,
  type WorkspaceCacheStateInput,
  type WorkspaceCacheStorageAdapter,
  type WorkspaceHostIdentity,
} from '../src/mobile/workspaceCache.js';

const HOST_A: WorkspaceHostIdentity = {
  platform: 'ios',
  installScopeId: '01234567-89ab-4cde-8f01-23456789abcd',
};
const HOST_B: WorkspaceHostIdentity = {
  platform: 'macos',
  installScopeId: 'fedcba98-7654-4321-8fed-cba987654321',
};

function stateInput(overrides: Partial<WorkspaceCacheStateInput> = {}): WorkspaceCacheStateInput {
  return {
    workspaceId: 'workspace-1',
    lastConfirmedSequence: 42,
    projects: [
      { projectId: 'project-alpha', name: 'Alpha' },
      { projectId: 'project-beta', name: 'Beta' },
    ],
    panes: [
      { paneId: 'pane-1', projectId: 'project-alpha', title: 'Agent' },
      { paneId: 'pane-2', projectId: 'project-beta', title: 'Shell' },
    ],
    selection: { projectId: 'project-alpha', paneId: 'pane-1' },
    drafts: [
      { paneId: 'pane-1', text: 'fix the flaky test\nsecond line' },
      { paneId: 'pane-2', text: '' },
    ],
    ...overrides,
  };
}

function minimalStored(): Record<string, unknown> {
  return {
    version: WORKSPACE_CACHE_RECORD_VERSION,
    hostKey: deriveHostKey(HOST_A),
    workspaceId: 'workspace-1',
    lastConfirmedSequence: 0,
    projects: [],
    panes: [],
    selection: null,
    drafts: [],
  };
}

function expectError(code: string, run: () => unknown): WorkspaceCacheError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceCacheError);
    const cacheError = error as WorkspaceCacheError;
    expect(cacheError.code, `expected error code ${code}`).toBe(code);
    return cacheError;
  }
  throw new Error(`expected a WorkspaceCacheError with code ${code}, but nothing was thrown`);
}

function problemCodes(problems: readonly WorkspaceCacheProblem[]): WorkspaceCacheProblemCode[] {
  return problems.map((problem) => problem.code);
}

function problemPaths(problems: readonly WorkspaceCacheProblem[]): string[] {
  return problems.map((problem) => problem.path ?? '');
}

/**
 * Storage wrapper over the memory reference adapter that records call order
 * and can simulate promote/temp-write failures.
 */
function instrumentedStorage(
  options: { failPromote?: boolean; failTempWrite?: boolean } = {},
): {
  adapter: WorkspaceCacheStorageAdapter;
  calls: string[];
  discardedHandles: string[];
  flags: { failPromote: boolean; failTempWrite: boolean };
  promoteCallCount: number;
  read(key: string): Uint8Array | null;
  writeRaw(key: string, bytes: Uint8Array): void;
} {
  const inner = createMemoryWorkspaceCacheStorage();
  const calls: string[] = [];
  const discardedHandles: string[] = [];
  const flags = { failPromote: options.failPromote === true, failTempWrite: options.failTempWrite === true };
  let promoteCallCount = 0;
  const adapter: WorkspaceCacheStorageAdapter = {
    read: (key) => inner.read(key),
    writeTemp: (key, bytes) => {
      calls.push('writeTemp');
      if (flags.failTempWrite) {
        throw new Error('simulated temp write failure');
      }
      return inner.writeTemp(key, bytes);
    },
    promote: (key, temp) => {
      calls.push('promote');
      if (flags.failPromote) {
        throw new Error('simulated promote failure');
      }
      promoteCallCount += 1;
      inner.promote(key, temp);
    },
    discardTemp: (temp) => {
      calls.push('discardTemp');
      discardedHandles.push(temp);
      inner.discardTemp(temp);
    },
    remove: (key) => {
      calls.push('remove');
      inner.remove(key);
    },
  };
  return {
    adapter,
    calls,
    discardedHandles,
    flags,
    get promoteCallCount() {
      return promoteCallCount;
    },
    read: (key) => inner.read(key),
    writeRaw: (key, bytes) => inner.promote(key, inner.writeTemp(key, bytes)),
  };
}

describe('host identity keying', () => {
  it.each([
    ['ios', '01234567-89ab-4cde-8f01-23456789abcd', 'ios:01234567-89ab-4cde-8f01-23456789abcd'],
    ['ipados', 'ipad-scope-0001', 'ipados:ipad-scope-0001'],
    ['macos', 'desktop.scope_0002:a', 'macos:desktop.scope_0002:a'],
  ])('derives a deterministic key from a %s identity', (platform, installScopeId, expected) => {
    const host: WorkspaceHostIdentity = {
      platform: platform as WorkspaceHostIdentity['platform'],
      installScopeId,
    };
    expect(deriveHostKey(host)).toBe(expected);
    expect(deriveHostKey(host)).toBe(deriveHostKey(host));
  });

  it('keeps platforms in separate key spaces', () => {
    const sameId = '01234567-89ab-4cde-8f01-23456789abcd';
    const keys = (['ios', 'ipados', 'macos'] as const).map((platform) =>
      deriveHostKey({ platform, installScopeId: sameId }),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ['non-object', null],
    ['missing fields', {}],
    ['unknown platform', { platform: 'android', installScopeId: '0123456789abcdef' }],
    ['short installScopeId', { platform: 'ios', installScopeId: 'short' }],
    ['overlong installScopeId', { platform: 'ios', installScopeId: 'a'.repeat(129) }],
    ['bad charset', { platform: 'ios', installScopeId: '../../etc/passwd' }],
    ['whitespace id', { platform: 'ios', installScopeId: '                        ' }],
    ['non-string id', { platform: 'ios', installScopeId: 42 }],
  ])('rejects an invalid host identity (%s) with a typed error', (_label, host) => {
    expectError(
      'invalid-host-identity',
      () => deriveHostKey(host as unknown as WorkspaceHostIdentity),
    );
  });

  it('namespaces the storage key by host and schema version', () => {
    const key = workspaceCacheStorageKey(deriveHostKey(HOST_A));
    expect(key).toBe(
      'psyche/mobile/workspace-cache/v1/ios:01234567-89ab-4cde-8f01-23456789abcd.json',
    );
    expect(workspaceCacheStorageKey(deriveHostKey(HOST_A))).toBe(key);
    expect(key).toContain(deriveHostKey(HOST_A));
    expect(key).not.toBe(workspaceCacheStorageKey(deriveHostKey(HOST_B)));
  });

  it('rejects non-derived keys as storage keys', () => {
    expectError('invalid-host-identity', () => workspaceCacheStorageKey('not-a-derived-key'));
  });
});

describe('saveWorkspaceCache happy path', () => {
  it('saves under the derived key and stamps version and hostKey', () => {
    const storage = instrumentedStorage();
    const result = saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    expect(result.hostKey).toBe(deriveHostKey(HOST_A));
    expect(result.storageKey).toBe(workspaceCacheStorageKey(deriveHostKey(HOST_A)));
    const stored = storage.read(result.storageKey);
    expect(stored).not.toBeNull();
    expect(result.byteLength).toBe(stored!.byteLength);
    const record = JSON.parse(new TextDecoder().decode(stored!)) as CachedWorkspaceState;
    expect(record.version).toBe(WORKSPACE_CACHE_RECORD_VERSION);
    expect(record.hostKey).toBe(deriveHostKey(HOST_A));
    expect(record.workspaceId).toBe('workspace-1');
    expect(storage.calls).toEqual(['writeTemp', 'promote']);
  });

  it('is byte-deterministic for the same input', () => {
    const storage = instrumentedStorage();
    const first = saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    const second = saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    expect(second.byteLength).toBe(first.byteLength);
    expect(storage.read(first.storageKey)).toEqual(storage.read(second.storageKey));
  });

  it('round-trips a restored record back through save (stamped fields validated, not trusted)', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    expect(restored.status).toBe('restored');
    if (restored.status !== 'restored') {
      return;
    }
    const again = saveWorkspaceCache({
      storage,
      host: HOST_A,
      state: restored.state.record,
      auth: { authAccepted: true },
    });
    expect(again.record).toEqual(restored.state.record);
  });

  it('requires the authenticated-session attestation', () => {
    const storage = instrumentedStorage();
    expectError('auth-required', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: stateInput(),
        auth: { authAccepted: false } as unknown as { authAccepted: true },
      }),
    );
    expect(storage.read(workspaceCacheStorageKey(deriveHostKey(HOST_A)))).toBeNull();
  });
});

describe('same-host restore (acceptance: workspace, sequence, selection, drafts restore)', () => {
  it('restores the full bounded payload on the same host', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    const saved = saveWorkspaceCache({
      storage,
      host: HOST_A,
      state: stateInput({ lastConfirmedSequence: 42, lastConfirmedAtMs: 1_700_000_000_000 }),
      auth: { authAccepted: true },
    });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    expect(restored.status).toBe('restored');
    if (restored.status !== 'restored') {
      return;
    }
    expect(restored.state.record).toEqual(saved.record);
    expect(restored.state.record.lastConfirmedSequence).toBe(42);
    expect(restored.state.record.lastConfirmedAtMs).toBe(1_700_000_000_000);
    expect(restored.state.record.selection).toEqual({ projectId: 'project-alpha', paneId: 'pane-1' });
    expect(restored.state.record.drafts).toEqual([
      { paneId: 'pane-1', text: 'fix the flaky test\nsecond line' },
      { paneId: 'pane-2', text: '' },
    ]);
    expect(restored.state.record.projects).toHaveLength(2);
    expect(restored.state.record.panes).toHaveLength(2);
  });

  it('restores an empty-selection, no-draft workspace', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({
      storage,
      host: HOST_A,
      state: stateInput({ selection: null, drafts: [] }),
      auth: { authAccepted: true },
    });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    expect(restored.status).toBe('restored');
    if (restored.status !== 'restored') {
      return;
    }
    expect(restored.state.record.selection).toBeNull();
    expect(restored.state.record.drafts).toEqual([]);
  });

  it('returns empty when nothing was ever cached', () => {
    const result = restoreWorkspaceCache({
      storage: createMemoryWorkspaceCacheStorage(),
      host: HOST_A,
      auth: { authAccepted: false },
    });
    expect(result).toEqual({ status: 'empty' });
  });
});

describe('complete-until-first-auth protection (acceptance: inert until authAccepted)', () => {
  it('restores as protected-inert before the first-auth assertion', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: false } });
    expect(restored.status).toBe('restored');
    if (restored.status !== 'restored') {
      return;
    }
    expect(restored.state.protection).toBe('protected-inert');
    expect(restored.state.reconciliationAllowed).toBe(false);
  });

  it('restores as stale-pending-reconciliation after the first-auth assertion', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    expect(restored.status).toBe('restored');
    if (restored.status !== 'restored') {
      return;
    }
    expect(restored.state.protection).toBe('stale-pending-reconciliation');
    expect(restored.state.reconciliationAllowed).toBe(true);
  });

  it('never marks restored cache as live, input-enabled, or mutable — in either mode', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    for (const authAccepted of [false, true]) {
      const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted } });
      expect(restored.status).toBe('restored');
      if (restored.status !== 'restored') {
        continue;
      }
      expect(restored.state.presentableAsLive).toBe(false);
      expect(restored.state.inputEnabled).toBe(false);
      expect(restored.state.mutationsAllowed).toBe(false);
    }
  });

  it('carries the never-live guarantee at the type level', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    if (restored.status !== 'restored') {
      throw new Error('expected restored');
    }
    // Compile-time proof: the literal type of each flag is `false`, so no
    // caller can present restored cache as a live surface through this module.
    const neverLive: false = restored.state.presentableAsLive;
    const noInput: false = restored.state.inputEnabled;
    const noMutations: false = restored.state.mutationsAllowed;
    expect(neverLive).toBe(false);
    expect(noInput).toBe(false);
    expect(noMutations).toBe(false);
  });
});

describe('other-host state never restores (acceptance)', () => {
  it('does not see another host record through key namespacing', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const restored = restoreWorkspaceCache({ storage, host: HOST_B, auth: { authAccepted: true } });
    expect(restored).toEqual({ status: 'empty' });
  });

  it('refuses foreign-host bytes even when they sit under this host key', () => {
    const storage = instrumentedStorage();
    saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    const foreignBytes = storage.read(workspaceCacheStorageKey(deriveHostKey(HOST_A)))!;
    // Simulate a container/backup restore that leaves host A's record under
    // host B's key: the in-record host key must still refuse it.
    storage.writeRaw(workspaceCacheStorageKey(deriveHostKey(HOST_B)), foreignBytes);
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_B,
      auth: { authAccepted: true },
    });
    expect(restored).toEqual({ status: 'refused-other-host' });
    expect(Object.keys(restored)).not.toContain('state');
  });

  it('refuses records whose stored hostKey is malformed', () => {
    const storage = instrumentedStorage();
    const malformed = new TextEncoder().encode(
      JSON.stringify({ ...stateInput(), hostKey: 'garbage-key', version: WORKSPACE_CACHE_RECORD_VERSION }),
    );
    storage.writeRaw(workspaceCacheStorageKey(deriveHostKey(HOST_A)), malformed);
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      auth: { authAccepted: false },
    });
    expect(restored).toEqual({ status: 'refused-other-host' });
  });

  it('refuses before validation, so a foreign payload is never described back', () => {
    const storage = instrumentedStorage();
    const foreign = JSON.stringify({
      version: WORKSPACE_CACHE_RECORD_VERSION,
      hostKey: deriveHostKey(HOST_B),
      workspaceId: 'workspace-foreign',
      lastConfirmedSequence: 1,
      projects: [],
      panes: [],
      selection: null,
      drafts: [{ paneId: 'pane-unknown', text: 'some other host draft text' }],
    });
    storage.writeRaw(
      workspaceCacheStorageKey(deriveHostKey(HOST_A)),
      new TextEncoder().encode(foreign),
    );
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      auth: { authAccepted: true },
    });
    expect(restored.status).toBe('refused-other-host');
    if (restored.status === 'unusable') {
      throw new Error('foreign-host record must be refused, not validated-and-described');
    }
  });
});

describe('fail-closed restore of unusable stored records', () => {
  const key = workspaceCacheStorageKey(deriveHostKey(HOST_A));

  const unusableCases: {
    readonly name: string;
    readonly bytes?: Uint8Array;
    readonly json?: string;
    readonly expected: WorkspaceCacheProblemCode;
  }[] = [
    {
      name: 'corrupt JSON',
      bytes: new TextEncoder().encode('{"version":1,"hostKey":'),
      expected: 'invalid-record',
    },
    {
      name: 'invalid UTF-8 bytes',
      bytes: new Uint8Array([0x7b, 0x80, 0x7d]),
      expected: 'invalid-record',
    },
    {
      name: 'non-object root (array)',
      json: JSON.stringify([]),
      expected: 'invalid-record',
    },
    {
      name: 'wrong version',
      json: JSON.stringify({ ...minimalStored(), version: 2 }),
      expected: 'unsupported-version',
    },
    {
      name: 'unknown root field',
      json: JSON.stringify({ ...minimalStored(), transcript: ['lots of output'] }),
      expected: 'unknown-field',
    },
    {
      name: 'missing hostKey in a stored record',
      json: JSON.stringify({ ...minimalStored(), hostKey: undefined }),
      expected: 'missing-field',
    },
    {
      name: 'oversize stored record',
      bytes: new Uint8Array(WORKSPACE_CACHE_MAX_RECORD_BYTES + 1),
      expected: 'oversize-record',
    },
  ];

  it.each(unusableCases)('returns unusable without exposing the payload: $name', ({ bytes, json, expected }) => {
    const storage = instrumentedStorage();
    const stored = bytes ?? new TextEncoder().encode(json ?? JSON.stringify(minimalStored()));
    storage.writeRaw(key, stored);
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      auth: { authAccepted: true },
    });
    expect(restored.status).toBe('unusable');
    if (restored.status !== 'unusable') {
      return;
    }
    expect(problemCodes(restored.problems)).toContain(expected);
    expect(Object.keys(restored)).not.toContain('state');
  });

  it('does not implicitly remove an unusable record', () => {
    const storage = instrumentedStorage();
    storage.writeRaw(key, new TextEncoder().encode('{not json'));
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      auth: { authAccepted: false },
    });
    expect(restored.status).toBe('unusable');
    expect(storage.read(key)).not.toBeNull();
  });
});

describe('bounds are explicit: oversize fails, nothing truncates (acceptance)', () => {
  const boundsCases: {
    readonly name: string;
    readonly code: WorkspaceCacheProblemCode;
    readonly state: WorkspaceCacheStateInput;
    readonly path: string;
  }[] = [
    {
      name: 'too many projects',
      code: 'too-many-items',
      state: stateInput({
        projects: Array.from({ length: WORKSPACE_CACHE_MAX_PROJECTS + 1 }, (_, i) => ({
          projectId: `project-${i}`,
          name: `Project ${i}`,
        })),
      }),
      path: 'projects',
    },
    {
      name: 'too many panes',
      code: 'too-many-items',
      state: stateInput({
        panes: Array.from({ length: WORKSPACE_CACHE_MAX_PANES + 1 }, (_, i) => ({
          paneId: `pane-${i}`,
          projectId: 'project-alpha',
          title: `Pane ${i}`,
        })),
      }),
      path: 'panes',
    },
    {
      name: 'too many drafts',
      code: 'too-many-items',
      state: stateInput({
        panes: Array.from({ length: WORKSPACE_CACHE_MAX_DRAFTS + 1 }, (_, i) => ({
          paneId: `pane-${i}`,
          projectId: 'project-alpha',
          title: `Pane ${i}`,
        })),
        drafts: Array.from({ length: WORKSPACE_CACHE_MAX_DRAFTS + 1 }, (_, i) => ({
          paneId: `pane-${i}`,
          text: 'd',
        })),
      }),
      path: 'drafts',
    },
    {
      name: 'oversize draft text',
      code: 'oversize-field',
      state: stateInput({
        drafts: [{ paneId: 'pane-1', text: 'a'.repeat(WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS + 1) }],
      }),
      path: 'drafts[0].text',
    },
    {
      name: 'oversize project name',
      code: 'oversize-field',
      state: stateInput({
        projects: [
          {
            projectId: 'project-alpha',
            name: 'a'.repeat(WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS + 1),
          },
        ],
      }),
      path: 'projects[0].name',
    },
    {
      name: 'oversize identifier',
      code: 'invalid-field',
      state: stateInput({ workspaceId: 'a'.repeat(WORKSPACE_CACHE_MAX_ID_CODE_UNITS + 1) }),
      path: 'workspaceId',
    },
  ];

  it.each(boundsCases)('rejects $name explicitly with a typed error', ({ state, code, path }) => {
    const storage = instrumentedStorage();
    const key = workspaceCacheStorageKey(deriveHostKey(HOST_A));
    const error = expectError(code, () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state,
        auth: { authAccepted: true },
      }),
    );
    expect(problemPaths(error.problems ?? [])).toContain(path);
    // Nothing written, nothing truncated: the storage stays untouched.
    expect(storage.read(key)).toBeNull();
    expect(storage.calls).toEqual([]);
  });

  it('rejects a record whose legal-per-field content exceeds the total byte budget with oversize-record', () => {
    const storage = instrumentedStorage();
    // 24 drafts of 2048 three-byte characters each: every field is within its
    // own cap, but the serialized record exceeds the byte budget.
    const state = stateInput({
      panes: Array.from({ length: WORKSPACE_CACHE_MAX_DRAFTS }, (_, i) => ({
        paneId: `pane-${i}`,
        projectId: 'project-alpha',
        title: `Pane ${i}`,
      })),
      drafts: Array.from({ length: WORKSPACE_CACHE_MAX_DRAFTS }, (_, i) => ({
        paneId: `pane-${i}`,
        text: '水'.repeat(WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS),
      })),
    });
    const error = expectError('oversize-record', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state,
        auth: { authAccepted: true },
      }),
    );
    expect(error.message).toMatch(/exceeds/);
    expect(storage.calls).toEqual([]);
  });

  it('accepts inputs exactly at the per-field bounds', () => {
    const storage = instrumentedStorage();
    const panes = Array.from({ length: WORKSPACE_CACHE_MAX_PANES }, (_, i) => ({
      paneId: `pane-${i}`,
      projectId: 'project-alpha',
      title: `t${i}`,
    }));
    const drafts = panes.slice(0, WORKSPACE_CACHE_MAX_DRAFTS).map((pane) => ({
      paneId: pane.paneId,
      text: 'a'.repeat(WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS),
    }));
    const result = saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput({ panes, drafts }),
      auth: { authAccepted: true },
    });
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.byteLength).toBeLessThanOrEqual(WORKSPACE_CACHE_MAX_RECORD_BYTES);
  });

  it('refuses a hostile oversize record on the read path without parsing it', () => {
    const storage = instrumentedStorage();
    storage.writeRaw(
      workspaceCacheStorageKey(deriveHostKey(HOST_A)),
      new Uint8Array(WORKSPACE_CACHE_MAX_RECORD_BYTES + 1),
    );
    const restored = restoreWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      auth: { authAccepted: true },
    });
    expect(restored.status).toBe('unusable');
    if (restored.status === 'unusable') {
      expect(problemCodes(restored.problems)).toEqual(['oversize-record']);
    }
  });
});

describe('atomic write semantics (acceptance: failed write leaves prior state intact)', () => {
  const key = workspaceCacheStorageKey(deriveHostKey(HOST_A));

  it('uses the write-temp-then-promote model and never removes during save', () => {
    const storage = instrumentedStorage();
    saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    expect(storage.calls).toEqual(['writeTemp', 'promote']);
  });

  it('leaves the prior record byte-identical when promote fails', () => {
    const storage = instrumentedStorage();
    saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput({ lastConfirmedSequence: 1 }),
      auth: { authAccepted: true },
    });
    const priorBytes = storage.read(key)!;
    storage.flags.failPromote = true;
    expectError('promote-failed', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: stateInput({ lastConfirmedSequence: 2 }),
        auth: { authAccepted: true },
      }),
    );
    expect(storage.read(key)).toEqual(priorBytes);
    // The failed temp handle was discarded, not leaked.
    expect(storage.discardedHandles).toHaveLength(1);
  });

  it('leaves the prior record untouched and never promotes when the temp write fails', () => {
    const storage = instrumentedStorage();
    saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput({ lastConfirmedSequence: 7 }),
      auth: { authAccepted: true },
    });
    const priorBytes = storage.read(key)!;
    storage.flags.failTempWrite = true;
    expectError('temp-write-failed', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: stateInput({ lastConfirmedSequence: 8 }),
        auth: { authAccepted: true },
      }),
    );
    expect(storage.read(key)).toEqual(priorBytes);
    expect(storage.promoteCallCount).toBe(1);
  });

  it('never touches storage when validation fails before any write', () => {
    const storage = instrumentedStorage();
    expectError('invalid-field', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: stateInput({ lastConfirmedSequence: -1 }),
        auth: { authAccepted: true },
      }),
    );
    expect(storage.calls).toEqual([]);
    expect(storage.read(key)).toBeNull();
  });

  it('recovers: a good save after a promote failure succeeds', () => {
    const storage = instrumentedStorage({ failPromote: true });
    expectError('promote-failed', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: stateInput(),
        auth: { authAccepted: true },
      }),
    );
    storage.flags.failPromote = false;
    const result = saveWorkspaceCache({
      storage: storage.adapter,
      host: HOST_A,
      state: stateInput({ lastConfirmedSequence: 9 }),
      auth: { authAccepted: true },
    });
    expect(result.byteLength).toBeGreaterThan(0);
    expect(storage.read(result.storageKey)).not.toBeNull();
  });
});

describe('closed schema: unknown fields and exclusions (acceptance)', () => {
  const unknownFieldCases: {
    readonly name: string;
    readonly input: Record<string, unknown>;
  }[] = [
    {
      name: 'root-level unknown field',
      input: { ...stateInput(), terminalOutput: ['everything the pane ever printed'] },
    },
    { name: 'credential-shaped unknown field', input: { ...stateInput(), apiToken: 'secret-value' } },
    {
      name: 'unknown project field',
      input: {
        ...stateInput(),
        projects: [{ projectId: 'project-alpha', name: 'Alpha', sourceTree: '...' }],
      },
    },
    {
      name: 'unknown pane field',
      input: {
        ...stateInput(),
        panes: [{ paneId: 'pane-1', projectId: 'project-alpha', title: 'Agent', transcript: '...' }],
      },
    },
    {
      name: 'unknown draft field',
      input: { ...stateInput(), drafts: [{ paneId: 'pane-1', text: 'd', attachment: 'x' }] },
    },
    {
      name: 'unknown selection field',
      input: { ...stateInput(), selection: { projectId: 'project-alpha', token: 'x' } },
    },
  ];

  it.each(unknownFieldCases)('rejects $name with unknown-field problems', ({ input }) => {
    const problems = validateCachedWorkspaceState(input, { mode: 'input' });
    expect(problemCodes(problems)).toContain('unknown-field');
    const storage = instrumentedStorage();
    const error = expectError('unknown-field', () =>
      saveWorkspaceCache({
        storage: storage.adapter,
        host: HOST_A,
        state: input as WorkspaceCacheStateInput,
        auth: { authAccepted: true },
      }),
    );
    expect(problemCodes(error.problems ?? [])).toContain('unknown-field');
    expect(storage.calls).toEqual([]);
  });

  it.each([
    ['bearer token in a draft', 'draft', 'run: Authorization: Bearer abcdef123456'],
    ['password assignment in a draft', 'draft', 'password: hunter2'],
    ['api key in a draft', 'draft', 'sk-abcdefghijklmnop1234'],
    ['private key armor in a pane title', 'title', '-----BEGIN RSA PRIVATE KEY-----'],
    ['credential assignment in a project name', 'name', 'client_secret = "abc"'],
  ])('fails closed on %s', (_label, placement, content) => {
    const input: WorkspaceCacheStateInput = (() => {
      if (placement === 'draft') {
        return stateInput({ drafts: [{ paneId: 'pane-1', text: content }] });
      }
      if (placement === 'title') {
        return stateInput({
          panes: [{ paneId: 'pane-1', projectId: 'project-alpha', title: content }],
        });
      }
      return stateInput({ projects: [{ projectId: 'project-alpha', name: content }] });
    })();
    const problems = validateCachedWorkspaceState(input, { mode: 'input' });
    expect(problemCodes(problems)).toContain('forbidden-content');
  });

  it('keeps benign text that merely mentions security vocabulary', () => {
    const problems = validateCachedWorkspaceState(
      stateInput({
        drafts: [
          {
            paneId: 'pane-1',
            text: 'the secret sauce is that the token count stays low and the api rate limit holds',
          },
        ],
      }),
      { mode: 'input' },
    );
    expect(problems).toEqual([]);
  });
});

describe('referential integrity and text hygiene', () => {
  const integrityCases: {
    readonly name: string;
    readonly state: unknown;
    readonly path: string;
  }[] = [
    {
      name: 'draft for an uncached pane',
      state: stateInput({ drafts: [{ paneId: 'pane-unknown', text: 'd' }] }),
      path: 'drafts[0].paneId',
    },
    {
      name: 'pane for an uncached project',
      state: stateInput({
        panes: [...stateInput().panes, { paneId: 'pane-9', projectId: 'project-gamma', title: 'X' }],
      }),
      path: 'panes[2].projectId',
    },
    {
      name: 'selection of an uncached project',
      state: stateInput({ selection: { projectId: 'project-gamma' } }),
      path: 'selection.projectId',
    },
    {
      name: 'selection pane of another project',
      state: stateInput({ selection: { projectId: 'project-beta', paneId: 'pane-1' } }),
      path: 'selection.paneId',
    },
    {
      name: 'duplicate draft for one pane',
      state: stateInput({
        drafts: [
          { paneId: 'pane-1', text: 'a' },
          { paneId: 'pane-1', text: 'b' },
        ],
      }),
      path: 'drafts[1].paneId',
    },
    {
      name: 'carriage return in a draft',
      state: stateInput({ drafts: [{ paneId: 'pane-1', text: 'line one\r\nline two' }] }),
      path: 'drafts[0].text',
    },
    {
      name: 'newline in a pane title',
      state: stateInput({
        panes: [{ paneId: 'pane-1', projectId: 'project-alpha', title: 'two\nlines' }],
      }),
      path: 'panes[0].title',
    },
    {
      name: 'undefined selection (null is the legal empty value)',
      state: { ...stateInput(), selection: undefined },
      path: 'selection',
    },
  ];

  it.each(integrityCases)('rejects $name', ({ state, path }) => {
    const problems = validateCachedWorkspaceState(state, { mode: 'input' });
    expect(problems.length).toBeGreaterThan(0);
    expect(problemPaths(problems)).toContain(path);
    // The typed save error mirrors the first problem's code 1:1.
    expectError(problems[0]!.code, () =>
      saveWorkspaceCache({
        storage: createMemoryWorkspaceCacheStorage(),
        host: HOST_A,
        state: state as WorkspaceCacheStateInput,
        auth: { authAccepted: true },
      }),
    );
  });
});

describe('determinism: no clock or randomness in core logic', () => {
  it('module source contains no clock or random calls', () => {
    const source = readFileSync(join(process.cwd(), 'src/mobile/workspaceCache.ts'), 'utf8');
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new Date\s*\(/);
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).not.toMatch(/performance\.now\s*\(/);
  });

  it('save → restore → save is record-stable', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    const first = saveWorkspaceCache({
      storage,
      host: HOST_A,
      state: stateInput(),
      auth: { authAccepted: true },
    });
    const restored = restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } });
    if (restored.status !== 'restored') {
      throw new Error('expected restored');
    }
    const second = saveWorkspaceCache({
      storage,
      host: HOST_A,
      state: restored.state.record,
      auth: { authAccepted: true },
    });
    expect(second.byteLength).toBe(first.byteLength);
    expect(first.record).toEqual(second.record);
  });
});

describe('discard', () => {
  it('removes the record explicitly and reports what happened', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    expect(discardWorkspaceCache({ storage, host: HOST_A })).toEqual({ removed: true });
    expect(restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } })).toEqual({
      status: 'empty',
    });
    expect(discardWorkspaceCache({ storage, host: HOST_A })).toEqual({ removed: false });
  });

  it('does not touch another host record', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    discardWorkspaceCache({ storage, host: HOST_B });
    expect(restoreWorkspaceCache({ storage, host: HOST_A, auth: { authAccepted: true } }).status).toBe(
      'restored',
    );
  });
});

describe('memory reference adapter semantics', () => {
  it('returns copies so callers cannot mutate promoted state', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    saveWorkspaceCache({ storage, host: HOST_A, state: stateInput(), auth: { authAccepted: true } });
    const key = workspaceCacheStorageKey(deriveHostKey(HOST_A));
    const bytes = storage.read(key)!;
    bytes[0] = 0x00;
    expect(storage.read(key)![0]).not.toBe(0x00);
  });

  it('rejects promote of an unknown temp handle', () => {
    const storage = createMemoryWorkspaceCacheStorage();
    expect(() => storage.promote('any', 'temp-unknown')).toThrow(/unknown temp handle/);
  });
});

describe('store facade', () => {
  it('binds host, key, save, restore, and discard consistently', () => {
    const store = createWorkspaceCacheStore({
      storage: createMemoryWorkspaceCacheStorage(),
      host: HOST_A,
    });
    expect(store.hostKey).toBe(deriveHostKey(HOST_A));
    expect(store.storageKey).toBe(workspaceCacheStorageKey(store.hostKey));
    const saved = store.save(stateInput(), { authAccepted: true });
    expect(saved.storageKey).toBe(store.storageKey);
    const restored = store.restore({ authAccepted: false });
    expect(restored.status).toBe('restored');
    if (restored.status === 'restored') {
      expect(restored.state.protection).toBe('protected-inert');
    }
    expect(store.discard()).toEqual({ removed: true });
  });

  it('rejects a store built on an invalid identity before any storage call', () => {
    expectError('invalid-host-identity', () =>
      createWorkspaceCacheStore({
        storage: createMemoryWorkspaceCacheStorage(),
        host: { platform: 'ios', installScopeId: 'bad id with spaces' } as WorkspaceHostIdentity,
      }),
    );
  });
});
