import { describe, expect, it } from 'vitest';

import {
  DESTRUCTIVE_LIFECYCLE_ACTION_KINDS,
  isDestructiveLifecycleActionKind,
  LIFECYCLE_ACTION_CATALOG_SHAPE,
  LIFECYCLE_ACTION_KINDS,
  LIFECYCLE_DIALOG_KINDS,
  LIFECYCLE_FIXTURES_CONTRACT_ID,
  LIFECYCLE_FIXTURES_CONTRACT_VERSION,
  LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX,
  LIFECYCLE_SCENARIO_IDS,
  LIFECYCLE_SCENARIO_ROLES,
  MAX_LIFECYCLE_CONSEQUENCE_LENGTH,
  MAX_LIFECYCLE_FIELD_LENGTH,
  requestLifecycleFixture,
  requestLifecycleFixtureSet,
  validateFixtureSet,
  validateLifecycleFixture,
  type LifecycleActionKind,
  type LifecycleScenarioId,
} from '../src/mobile/lifecycleFixtures.js';

// ---------------------------------------------------------------------------
// Helpers (mutable copies for negative tests; canonical fixtures stay frozen)
// ---------------------------------------------------------------------------

const ALL_SCENARIO_IDS = [...LIFECYCLE_SCENARIO_IDS] as LifecycleScenarioId[];

/** Builds a mutable, structurally valid copy of a canonical fixture. */
function mutableFixture(scenarioId: LifecycleScenarioId): Record<string, unknown> {
  return JSON.parse(JSON.stringify(requestLifecycleFixture(scenarioId))) as Record<string, unknown>;
}

/** Builds a mutable copy of the canonical full set. */
function mutableSet(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(requestLifecycleFixtureSet())) as Record<string, unknown>;
}

function setField(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  let target: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1] as string] = value;
  return root;
}

function deleteField(
  root: Record<string, unknown>,
  path: readonly string[]
): Record<string, unknown> {
  let target: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  delete target[path[path.length - 1] as string];
  return root;
}

/** Fresh mutable fixture copy with one field set to `value`. */
function withPathValue(
  scenarioId: LifecycleScenarioId,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  return setField(mutableFixture(scenarioId), path, value);
}

/** Fresh mutable fixture copy with one field deleted. */
function withoutField(
  scenarioId: LifecycleScenarioId,
  path: readonly string[]
): Record<string, unknown> {
  return deleteField(mutableFixture(scenarioId), path);
}

function expectTypeError(fn: () => unknown, fragment: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain(fragment);
    return;
  }
  throw new Error('expected validation to throw a TypeError, but it resolved');
}

function expectRangeError(fn: () => unknown, fragment: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toContain(fragment);
    return;
  }
  throw new Error('expected a RangeError, but validation resolved');
}

// ---------------------------------------------------------------------------
// Contract identity
// ---------------------------------------------------------------------------

describe('lifecycleFixtures contract identity', () => {
  it('is v1 with a stable contract identifier and requester-id prefix', () => {
    expect(LIFECYCLE_FIXTURES_CONTRACT_VERSION).toBe(1);
    expect(LIFECYCLE_FIXTURES_CONTRACT_ID).toBe('psyche.mobile.lifecycle.fixtures.v1');
    expect(LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX).toBe('psyche.mobile.lifecycle.fixture');
  });

  it('pins the v1 action-catalog shape: every kind covers confirm, cancel, error, in-progress', () => {
    expect([...LIFECYCLE_ACTION_KINDS]).toEqual(['merge', 'pr-review', 'stop', 'close']);
    expect([...LIFECYCLE_SCENARIO_ROLES]).toEqual(['confirm', 'cancel', 'error', 'in-progress']);
    for (const kind of LIFECYCLE_ACTION_KINDS) {
      expect([...LIFECYCLE_ACTION_CATALOG_SHAPE[kind]]).toEqual([
        'confirm',
        'cancel',
        'error',
        'in-progress',
      ]);
    }
    const expectedIds = LIFECYCLE_ACTION_KINDS.flatMap((kind) =>
      LIFECYCLE_ACTION_CATALOG_SHAPE[kind].map((role) => `${kind}.${role}`)
    );
    expect([...LIFECYCLE_SCENARIO_IDS]).toEqual(expectedIds);
    expect(LIFECYCLE_SCENARIO_IDS).toHaveLength(16);
  });

  it('marks exactly merge, stop, and close as destructive', () => {
    expect([...DESTRUCTIVE_LIFECYCLE_ACTION_KINDS]).toEqual(['merge', 'stop', 'close']);
    expect(isDestructiveLifecycleActionKind('merge')).toBe(true);
    expect(isDestructiveLifecycleActionKind('pr-review')).toBe(false);
    expect(() => isDestructiveLifecycleActionKind('rename' as LifecycleActionKind)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Determinism (same requester id → deep-equal fixture on repeated calls)
// ---------------------------------------------------------------------------

describe('deterministic fixture requesters', () => {
  it.each(ALL_SCENARIO_IDS)(
    'returns a deep-equal fixture for %s on repeated calls',
    (scenarioId) => {
      const first = requestLifecycleFixture(scenarioId);
      const second = requestLifecycleFixture(scenarioId);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    }
  );

  it('returns a deep-equal full set on repeated calls', () => {
    const first = requestLifecycleFixtureSet();
    const second = requestLifecycleFixtureSet();
    expect(second).toEqual(first);
    expect(second.fixtures).toHaveLength(first.fixtures.length);
  });

  it('stamps every fixture with the fixed requester id derived from its scenario id', () => {
    expect.hasAssertions();
    for (const scenarioId of ALL_SCENARIO_IDS) {
      const fixture = requestLifecycleFixture(scenarioId);
      expect(fixture.requesterId).toBe(`${LIFECYCLE_FIXTURE_REQUESTER_ID_PREFIX}.${scenarioId}`);
    }
  });

  it('carries no timestamps, randomness, or volatile fields in serialized fixtures', () => {
    expect.hasAssertions();
    const volatilePattern = /timestamp|created_at|updated_at|nonce|uuid|\d{4}-\d{2}-\d{2}T/;
    for (const scenarioId of ALL_SCENARIO_IDS) {
      const serialized = JSON.stringify(requestLifecycleFixture(scenarioId));
      expect(serialized).not.toMatch(volatilePattern);
    }
  });

  it('returns deeply frozen fixtures and sets', () => {
    const fixture = requestLifecycleFixture('stop.confirm');
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.scope)).toBe(true);
    expect(Object.isFrozen(fixture.expected)).toBe(true);
    expect(Object.isFrozen(fixture.expected.options)).toBe(true);
    const set = requestLifecycleFixtureSet();
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.fixtures)).toBe(true);
    for (const entry of set.fixtures) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('fails closed on unknown scenario ids', () => {
    expect(() => requestLifecycleFixture('merge.restart' as LifecycleScenarioId)).toThrow(TypeError);
    expect(() => requestLifecycleFixture('MERGE.confirm' as LifecycleScenarioId)).toThrow(TypeError);
    expect(() => requestLifecycleFixture('' as LifecycleScenarioId)).toThrow(TypeError);
  });

  it('exposes a scenario-id index over the full set', () => {
    const set = requestLifecycleFixtureSet();
    expect(Object.keys(set.byScenarioId).sort()).toEqual([...ALL_SCENARIO_IDS].sort());
    for (const fixture of set.fixtures) {
      expect(set.byScenarioId[fixture.scenarioId]).toEqual(fixture);
    }
  });
});

// ---------------------------------------------------------------------------
// Completeness vs the action-catalog shape
// ---------------------------------------------------------------------------

describe('fixture set completeness vs the action-catalog shape', () => {
  const set = requestLifecycleFixtureSet();

  it('covers every kind.role pair in the catalog shape exactly once', () => {
    const ids = set.fixtures.map((fixture) => fixture.scenarioId);
    expect([...new Set(ids)]).toHaveLength(ids.length);
    expect([...ids].sort()).toEqual([...ALL_SCENARIO_IDS].sort());
  });

  it('keeps scenarioId, actionKind, and scenarioRole consistent on every fixture', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      expect(fixture.scenarioId).toBe(`${fixture.actionKind}.${fixture.scenarioRole}`);
      expect(LIFECYCLE_ACTION_KINDS).toContain(fixture.actionKind);
      expect(LIFECYCLE_SCENARIO_ROLES).toContain(fixture.scenarioRole);
      expect(LIFECYCLE_DIALOG_KINDS).toContain(fixture.expected.dialog);
    }
  });

  it('carries the documented destructive flag per action kind', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      expect(fixture.destructive).toBe(isDestructiveLifecycleActionKind(fixture.actionKind));
    }
  });

  it('every fixture passes the strict single-fixture validator unchanged', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      expect(validateLifecycleFixture(fixture)).toEqual(fixture);
    }
  });

  it('full set passes validateFixtureSet and round-trips through it', () => {
    const validated = validateFixtureSet(set);
    expect(validated).toEqual(set);
    expect(Object.isFrozen(validated)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Destructive flows: tested confirmation AND cancel paths
// ---------------------------------------------------------------------------

describe('destructive flows carry confirmation and cancel fixtures', () => {
  const set = requestLifecycleFixtureSet();
  const byScenarioId = new Map(set.fixtures.map((f) => [f.scenarioId, f] as const));

  it.each([...DESTRUCTIVE_LIFECYCLE_ACTION_KINDS])(
    '%s has both a confirmation and a cancel fixture',
    (kind) => {
      const confirmation = byScenarioId.get(`${kind}.confirm` as LifecycleScenarioId);
      const cancel = byScenarioId.get(`${kind}.cancel` as LifecycleScenarioId);
      expect(confirmation).toBeDefined();
      expect(cancel).toBeDefined();
      expect(confirmation?.destructive).toBe(true);
      expect(cancel?.destructive).toBe(true);
    }
  );

  it.each(['merge', 'stop'] as const)(
    '%s confirms through a guarded confirmation dialog',
    (kind) => {
      const confirmation = byScenarioId.get(`${kind}.confirm` as LifecycleScenarioId);
      expect(confirmation?.expected.dialog).toBe('confirmation');
      expect(confirmation?.expected.confirmLabel).toBeTruthy();
      expect(confirmation?.expected.cancelLabel).toBe('Cancel');
      expect(confirmation?.expected.actionEnabled).toBe(true);
      expect(confirmation?.expected.inProgress).toBe(false);
    }
  );

  it('close confirms through a cleanup choice with a default and destructive options', () => {
    const confirmation = byScenarioId.get('close.confirm');
    expect(confirmation?.expected.dialog).toBe('choice');
    expect(confirmation?.expected.confirmLabel).toBeNull();
    expect(confirmation?.expected.cancelLabel).toBe('Cancel');
    const options = confirmation?.expected.options ?? [];
    expect(options.map((option) => option.id)).toEqual([
      'kill_only',
      'kill_and_clean',
      'kill_clean_branch',
    ]);
    expect(options.filter((option) => option.default)).toHaveLength(1);
    expect(options.filter((option) => option.danger).map((option) => option.id)).toEqual([
      'kill_and_clean',
      'kill_clean_branch',
    ]);
    expect(options.find((option) => option.id === 'kill_and_clean')?.description).toContain(
      'keep branch'
    );
    expect(options.find((option) => option.id === 'kill_clean_branch')?.description).toContain(
      'delete branch'
    );
  });

  it('every cancel fixture asserts the no-op outcome: nothing happens, scope untouched', () => {
    expect.hasAssertions();
    for (const kind of LIFECYCLE_ACTION_KINDS) {
      const cancel = byScenarioId.get(`${kind}.cancel` as LifecycleScenarioId);
      expect(cancel).toBeDefined();
      expect(cancel?.expected.dialog).toBe('info');
      expect(cancel?.expected.confirmLabel).toBeNull();
      expect(cancel?.expected.cancelLabel).toBeNull();
      expect(cancel?.consequenceText).toMatch(/^This cancels/);
      // Scoped metadata: the cancel outcome names what stayed unchanged.
      expect(cancel?.consequenceText).toContain(cancel?.scope.paneTitle ?? '');
      expect(cancel?.consequenceText).toContain(cancel?.scope.hostName ?? '');
      expect(cancel?.survivalNote).toContain(cancel?.scope.worktreeName ?? '');
      expect(cancel?.survivalNote).toContain(cancel?.scope.branchName ?? '');
    }
  });

  it('every cancelable dialog declares that cancelling has no side effect', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      const { cancelLabel, cancelHasNoSideEffects } = fixture.expected;
      expect(cancelHasNoSideEffects).toBe(cancelLabel !== null);
    }
  });
});

// ---------------------------------------------------------------------------
// Scoped metadata and consequence assertions
// ---------------------------------------------------------------------------

describe('fixtures assert scoped metadata and consequences', () => {
  const set = requestLifecycleFixtureSet();

  it('names host, project, pane, branch, and (where applicable) target in consequence text', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      const { scope, consequenceText } = fixture;
      expect(consequenceText).toContain(scope.paneTitle);
      expect(consequenceText).toContain(scope.projectName);
      expect(consequenceText).toContain(scope.hostName);
      expect(consequenceText).toContain(scope.branchName);
      if (fixture.actionKind === 'merge' || fixture.actionKind === 'pr-review') {
        expect(scope.targetBranchName).toBe('main');
        expect(consequenceText).toContain(scope.targetBranchName);
      } else {
        expect(scope.targetBranchName).toBeNull();
      }
    }
  });

  it('uses distinct fixed scope identities per action kind', () => {
    const kinds = new Set<string>();
    const paneTitles = new Set<string>();
    for (const fixture of set.fixtures) {
      kinds.add(fixture.actionKind);
      paneTitles.add(fixture.scope.paneTitle);
    }
    expect(kinds.size).toBe(4);
    expect(paneTitles.size).toBe(4);
  });

  it('states immediacy on confirmations and survival of worktree and branch everywhere', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      if (fixture.scenarioRole === 'confirm') {
        expect(fixture.consequenceText).toContain('now');
        expect(fixture.consequenceText).toMatch(/^This /);
      }
      expect(fixture.survivalNote).toContain(fixture.scope.worktreeName);
      expect(fixture.survivalNote).toContain(fixture.scope.branchName);
    }
  });

  it('error fixtures name what stopped and what was preserved, with pane and host', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      if (fixture.scenarioRole !== 'error') {
        expect(fixture.expected.errorText).toBeNull();
        expect(fixture.expected.dialog).not.toBe('error');
        continue;
      }
      const errorText = fixture.expected.errorText;
      expect(typeof errorText).toBe('string');
      expect(errorText).toContain(fixture.scope.paneTitle);
      expect(errorText).toContain(fixture.scope.hostName);
      expect(fixture.expected.confirmLabel).toBeNull();
      expect(fixture.expected.cancelLabel).toBe('Dismiss');
      expect(fixture.expected.inProgress).toBe(false);
      expect(fixture.expected.actionEnabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// In-progress disabling
// ---------------------------------------------------------------------------

describe('in-progress disabling', () => {
  const set = requestLifecycleFixtureSet();

  it('disables every action entry point exactly while its action is in progress', () => {
    expect.hasAssertions();
    for (const fixture of set.fixtures) {
      const inProgressRole = fixture.scenarioRole === 'in-progress';
      expect(fixture.expected.inProgress).toBe(inProgressRole);
      expect(fixture.expected.actionEnabled).toBe(!inProgressRole);
      if (inProgressRole) {
        expect(fixture.expected.disabledReason).toBeTruthy();
        expect(fixture.expected.disabledReason).toContain('in progress');
        // Disabled entry point: no dialog is rendered at all.
        expect(fixture.expected.dialog).toBe('none');
        expect(fixture.expected.title).toBe('');
        expect(fixture.expected.message).toBe('');
        expect(fixture.expected.confirmLabel).toBeNull();
        expect(fixture.expected.cancelLabel).toBeNull();
        expect(fixture.expected.errorText).toBeNull();
      } else {
        expect(fixture.expected.disabledReason).toBeNull();
      }
    }
  });

  it.each([...LIFECYCLE_ACTION_KINDS])(
    '%s has an in-progress scenario with a stated reason',
    (kind) => {
      const fixture = requestLifecycleFixture(`${kind}.in-progress` as LifecycleScenarioId);
      expect(fixture.expected.actionEnabled).toBe(false);
      expect(fixture.expected.disabledReason).toContain('in progress');
      expect(fixture.expected.disabledReason).toContain(fixture.scope.paneTitle);
      expect(fixture.expected.disabledReason).toContain(fixture.scope.hostName);
    }
  );
});

// ---------------------------------------------------------------------------
// Strict validation: unknown fields rejected, invariants enforced
// ---------------------------------------------------------------------------

describe('validateLifecycleFixture rejects unknown and invalid fields', () => {
  it.each(ALL_SCENARIO_IDS)(
    'accepts the canonical fixture %s unchanged',
    (scenarioId) => {
      const fixture = requestLifecycleFixture(scenarioId);
      expect(validateLifecycleFixture(fixture)).toEqual(fixture);
    }
  );

  it('rejects unknown fixture-level fields', () => {
    const candidate = mutableFixture('merge.confirm');
    candidate.unknownField = true;
    expectTypeError(() => validateLifecycleFixture(candidate), '"unknownField"');
  });

  it('rejects missing required fixture-level fields', () => {
    const candidate = withoutField('merge.confirm', ['survivalNote']);
    expectTypeError(() => validateLifecycleFixture(candidate), '"survivalNote"');
  });

  it('rejects unknown fields nested in scope, expected state, and options', () => {
    expectTypeError(
      () => validateLifecycleFixture(withPathValue('stop.confirm', ['scope', 'hostNameExtra'], true)),
      '"hostNameExtra"'
    );
    expectTypeError(
      () => validateLifecycleFixture(withPathValue('stop.confirm', ['expected', 'dialogExtra'], true)),
      '"dialogExtra"'
    );
    const optionCandidate = mutableFixture('close.confirm');
    const options = (optionCandidate.expected as Record<string, unknown>).options as Array<
      Record<string, unknown>
    >;
    options[0] = { ...options[0], surprise: 1 };
    expectTypeError(() => validateLifecycleFixture(optionCandidate), '"surprise"');
  });

  it('rejects duplicate option ids and choice dialogs without exactly one default', () => {
    const duplicate = mutableFixture('close.confirm');
    const duplicateOptions = (duplicate.expected as Record<string, unknown>).options as Array<
      Record<string, unknown>
    >;
    duplicateOptions[2] = { ...duplicateOptions[2], id: duplicateOptions[0].id };
    expectRangeError(() => validateLifecycleFixture(duplicate), 'duplicate option id');

    const noDefault = mutableFixture('close.confirm');
    const noDefaultOptions = (noDefault.expected as Record<string, unknown>).options as Array<
      Record<string, unknown>
    >;
    noDefaultOptions[0] = { ...noDefaultOptions[0], default: false };
    expectRangeError(() => validateLifecycleFixture(noDefault), 'exactly one option');
  });

  it('rejects unknown enum values', () => {
    expectTypeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['actionKind'], 'rename')),
      'actionKind'
    );
    expectTypeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['scenarioRole'], 'restart')),
      'scenarioRole'
    );
    expectTypeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.confirm', ['expected', 'dialog'], 'wizard')),
      'dialog'
    );
  });

  it('rejects a scenarioId that does not equal actionKind.scenarioRole', () => {
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.confirm', ['scenarioId'], 'stop.confirm')),
      'must equal'
    );
  });

  it('rejects a requesterId that is not the fixed prefix plus scenario id', () => {
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.confirm', ['requesterId'], 'random-id')),
      'requesterId'
    );
  });

  it('rejects a destructive flag that contradicts the action kind', () => {
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('pr-review.confirm', ['destructive'], true)),
      'destructive'
    );
  });

  it('rejects empty, whitespace-padded, oversize, and non-string text fields', () => {
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['consequenceText'], '')),
      'must not be empty'
    );
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['consequenceText'], ' padded')),
      'whitespace'
    );
    const oversize = 'x'.repeat(MAX_LIFECYCLE_CONSEQUENCE_LENGTH + 1);
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['consequenceText'], oversize)),
      'exceeds maximum'
    );
    expectTypeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['consequenceText'], 42)),
      'must be a string'
    );
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue(
            'merge.confirm',
            ['scope', 'paneTitle'],
            'x'.repeat(MAX_LIFECYCLE_FIELD_LENGTH + 1)
          )
        ),
      'exceeds maximum'
    );
  });

  it('rejects consequence text that drops scoped metadata or consequence-first phrasing', () => {
    const withoutPane = 'This merges branch "feat/merge-demo" into "main" for project "psyche" on '
      + 'host "lan-host-1" now.';
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['consequenceText'], withoutPane)),
      'scoped metadata'
    );
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue(
            'merge.confirm',
            ['consequenceText'],
            'The merge happens for pane "agent-merge", project "psyche", host "lan-host-1", '
              + 'branch "feat/merge-demo", target "main".'
          )
        ),
      'consequence-first'
    );
  });

  it('rejects targetBranchName violations per action kind', () => {
    expectTypeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.confirm', ['scope', 'targetBranchName'], null)),
      'targetBranchName'
    );
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('stop.confirm', ['scope', 'targetBranchName'], 'main')
        ),
      'exactly null'
    );
  });

  it('rejects survival notes that do not name the worktree and branch', () => {
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('stop.confirm', ['survivalNote'], 'Only the session ends.')
        ),
      'worktree and the branch'
    );
  });

  it('rejects inconsistent expected states', () => {
    // Confirmation dialogs must offer both controls.
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['expected', 'cancelLabel'], null)),
      'confirm and a cancel label'
    );
    // Cancel controls must imply the no-side-effect flag (and vice versa).
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('stop.confirm', ['expected', 'cancelHasNoSideEffects'], false)
        ),
      'cancelHasNoSideEffects'
    );
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('merge.cancel', ['expected', 'cancelHasNoSideEffects'], true)
        ),
      'cancelHasNoSideEffects'
    );
    // Non-choice dialogs must not carry options.
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('merge.confirm', ['expected', 'options'], [
            { id: 'x', label: 'X', description: 'd', danger: false, default: true },
          ])
        ),
      'must not carry options'
    );
    // Choice dialogs must not carry a confirm label.
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('close.confirm', ['expected', 'confirmLabel'], 'Close')),
      'confirm label'
    );
    // Non-error scenarios must not carry errorText.
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('merge.confirm', ['expected', 'errorText'], 'boom on lan-host-1')
        ),
      'errorText'
    );
    // Error scenarios must carry errorText naming the pane and host.
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.error', ['expected', 'errorText'], null)),
      'errorText'
    );
    // Enabled entry points must not carry a disabledReason.
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('merge.confirm', ['expected', 'disabledReason'], 'busy')
        ),
      'exactly null'
    );
    // Disabled entry points must state the running work.
    expectRangeError(
      () =>
        validateLifecycleFixture(
          withPathValue('merge.in-progress', ['expected', 'disabledReason'], 'busy')
        ),
      'in progress'
    );
    // inProgress must match the scenario role.
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.confirm', ['expected', 'inProgress'], true)),
      'inProgress'
    );
    // Non-none dialogs require non-empty titles and messages.
    expectRangeError(
      () => validateLifecycleFixture(withPathValue('merge.confirm', ['expected', 'title'], '')),
      'must not be empty'
    );
    // None dialogs require empty title and message.
    expectRangeError(
      () =>
        validateLifecycleFixture(withPathValue('merge.in-progress', ['expected', 'title'], 'Oops')),
      "exactly ''"
    );
  });

  it('rejects non-object inputs', () => {
    expectTypeError(() => validateLifecycleFixture(null), 'must be an object');
    expectTypeError(() => validateLifecycleFixture(undefined), 'must be an object');
    expectTypeError(() => validateLifecycleFixture('merge.confirm'), 'must be an object');
    expectTypeError(() => validateLifecycleFixture([]), 'must be an object');
  });
});

describe('validateFixtureSet rejects unknown and incomplete sets', () => {
  it('accepts the canonical set unchanged (with or without its byScenarioId index)', () => {
    const set = requestLifecycleFixtureSet();
    expect(validateFixtureSet(set)).toEqual(set);
    const withoutIndex = mutableSet();
    delete withoutIndex.byScenarioId;
    expect(validateFixtureSet(withoutIndex)).toEqual(set);
  });

  it('rejects unknown set-level fields', () => {
    const candidate = mutableSet();
    candidate.extra = 'nope';
    expectTypeError(() => validateFixtureSet(candidate), '"extra"');
  });

  it('rejects a wrong contract version and contract id', () => {
    const versionCandidate = mutableSet();
    versionCandidate.contractVersion = 2;
    expectRangeError(() => validateFixtureSet(versionCandidate), 'contractVersion');

    const idCandidate = mutableSet();
    idCandidate.contractId = 'psyche.mobile.lifecycle.fixtures.v0';
    expectRangeError(() => validateFixtureSet(idCandidate), 'contractId');
  });

  it('rejects a set with an unknown fixture field inside', () => {
    const candidate = mutableSet();
    const fixtures = candidate.fixtures as Array<Record<string, unknown>>;
    fixtures[0] = { ...fixtures[0], bogus: 1 };
    expectTypeError(() => validateFixtureSet(candidate), '"bogus"');
  });

  it('rejects a set missing a required scenario from the catalog shape', () => {
    const candidate = mutableSet();
    const fixtures = candidate.fixtures as Array<Record<string, unknown>>;
    const removedIndex = fixtures.findIndex((f) => f.scenarioId === 'close.cancel');
    const removed = fixtures.splice(removedIndex, 1);
    expect(removed).toHaveLength(1);
    expectRangeError(
      () => validateFixtureSet(candidate),
      'missing required scenario "close.cancel"'
    );
  });

  it('rejects a set with a duplicate scenario or requester id', () => {
    const candidate = mutableSet();
    const fixtures = candidate.fixtures as Array<Record<string, unknown>>;
    fixtures[1] = JSON.parse(JSON.stringify(fixtures[0]));
    expectRangeError(() => validateFixtureSet(candidate), 'duplicate');
  });

  it('rejects a byScenarioId index that disagrees with the fixtures', () => {
    const candidate = mutableSet();
    const index = candidate.byScenarioId as Record<string, unknown>;
    delete index['merge.confirm'];
    expectRangeError(() => validateFixtureSet(candidate), 'byScenarioId');
  });

  it('rejects deleted required fixture fields inside a set', () => {
    const candidate = mutableSet();
    const fixtures = candidate.fixtures as Array<Record<string, unknown>>;
    delete fixtures[0].scope;
    expectTypeError(() => validateFixtureSet(candidate), 'missing required field');
  });

  it('rejects non-object sets and non-array fixture lists', () => {
    expectTypeError(() => validateFixtureSet(null), 'must be an object');
    expectTypeError(() => validateFixtureSet('set'), 'must be an object');
    const candidate = mutableSet();
    candidate.fixtures = 'not-an-array';
    expectTypeError(() => validateFixtureSet(candidate), 'must be an array');
  });
});

// ---------------------------------------------------------------------------
// Exported caps stay enforced by the validators above
// ---------------------------------------------------------------------------

describe('exported length caps', () => {
  it('exports the documented caps used by the strict validators', () => {
    expect(MAX_LIFECYCLE_FIELD_LENGTH).toBeGreaterThan(0);
    expect(MAX_LIFECYCLE_CONSEQUENCE_LENGTH).toBeGreaterThan(MAX_LIFECYCLE_FIELD_LENGTH);
  });
});
