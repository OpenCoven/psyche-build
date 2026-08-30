import { describe, expect, it } from 'vitest';
import {
  PAIRING_EVENT_KINDS,
  PAIRING_FLOW_STATES,
  PAIRING_TRANSITIONS,
  PSYCHE_BONJOUR_SERVICE_TYPE,
  RESOLUTION_STATES,
  advanceResolution,
  candidateFromRecord,
  compareCandidates,
  expireStaleEntries,
  isPairingStatusConnectable,
  normalizeCertificateFingerprint,
  parseDiscoveredHostCandidate,
  parseDiscoveredServiceRecord,
  pairingStatusForRecord,
  pairingTransition,
  reconcileBrowseBatch,
  resolvePairingStatus,
  selectDiscoveredHost,
} from '../src/mobile/discoveredHostFlow.js';
import type {
  BonjourServiceKey,
  DiscoveredHostCandidate,
  DiscoveredHostIdentity,
  DiscoveredServiceRecord,
  ResolvedEndpoint,
} from '../src/mobile/discoveredHostFlow.js';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

function svc(name: string, domain = 'local.'): BonjourServiceKey {
  return { serviceType: PSYCHE_BONJOUR_SERVICE_TYPE, serviceName: name, domain };
}

function ident(serverID: string, fp = FP_A): DiscoveredHostIdentity {
  return {
    serverID,
    serverName: `Studio (${serverID})`,
    certificateFingerprint: fp,
    supportedVersions: [3],
  };
}

function ep(host: string, port = 8787): ResolvedEndpoint {
  return { host, port };
}

function rec(overrides: Partial<DiscoveredServiceRecord> = {}): DiscoveredServiceRecord {
  return { service: svc('Studio'), state: 'discovered', lastSeenAt: 0, ...overrides };
}

function resolvedRec(serverID = 'server-a', fp = FP_A): DiscoveredServiceRecord {
  return {
    service: svc('Studio'),
    state: 'resolved',
    lastSeenAt: 10,
    identity: ident(serverID, fp),
    endpoint: ep('192.168.1.10'),
  };
}

function resolvingRec(): DiscoveredServiceRecord {
  return { ...resolvedRec(), state: 'resolving' };
}

function cand(overrides: Partial<DiscoveredHostCandidate> = {}): DiscoveredHostCandidate {
  return {
    service: svc('Studio'),
    state: 'resolved',
    identity: ident('server-a'),
    endpoint: ep('192.168.1.10'),
    pairingStatus: 'unpaired',
    ...overrides,
  };
}

function selectAuto(candidates: readonly DiscoveredHostCandidate[]) {
  return selectDiscoveredHost(candidates, { basis: 'auto' });
}

describe('record parsing (strict boundary)', () => {
  it('accepts a well-formed resolved record', () => {
    const parsed = parseDiscoveredServiceRecord(resolvedRec());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.identity?.serverID).toBe('server-a');
      expect(parsed.value.endpoint?.port).toBe(8787);
    }
  });

  it('rejects unknown fields on the record and on nested objects', () => {
    const rogue = parseDiscoveredServiceRecord({ ...resolvedRec(), rogueField: true });
    expect(rogue.ok).toBe(false);
    if (!rogue.ok) {
      expect(rogue.problems.map((p) => p.code)).toContain('unknown-field');
    }
    const tamperedEndpoint = parseDiscoveredServiceRecord({
      ...resolvedRec(),
      endpoint: { ...resolvedRec().endpoint!, gateway: '192.168.1.1' },
    });
    expect(tamperedEndpoint.ok).toBe(false);

    const tamperedIdentity = {
      ...resolvedRec(),
      identity: { ...ident('server-a'), region: 'eu' },
    };
    expect(parseDiscoveredServiceRecord(tamperedIdentity).ok).toBe(false);
  });

  it('rejects a resolveFailed record without a non-empty failureReason', () => {
    const withoutReason = parseDiscoveredServiceRecord({
      service: svc('Studio'),
      state: 'resolveFailed',
      lastSeenAt: 9,
    });
    expect(withoutReason.ok).toBe(false);
    if (!withoutReason.ok) {
      expect(withoutReason.problems.some((p) => p.code === 'missing-failure-reason')).toBe(true);
    }
    const blank = parseDiscoveredServiceRecord({
      service: svc('Studio'),
      state: 'resolveFailed',
      lastSeenAt: 9,
      failureReason: '  ',
    });
    expect(blank.ok).toBe(false);
  });

  it('rejects an endpoint carried by a state that cannot have one', () => {
    const parsed = parseDiscoveredServiceRecord({
      service: svc('Studio'),
      state: 'discovered',
      lastSeenAt: 1,
      endpoint: ep('192.168.1.10'),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems[0]?.code).toBe('endpoint-in-invalid-state');
    }
  });

  it('rejects invalid states, ports, and fingerprints with typed problems', () => {
    expect(parseDiscoveredServiceRecord({ ...rec({}), state: 'vanished' }).ok).toBe(false);
    expect(parseDiscoveredHostCandidate(cand({ endpoint: ep('192.168.1.10', 0) })).ok).toBe(false);
    expect(
      parseDiscoveredHostCandidate(
        cand({ identity: { ...ident('server-a'), certificateFingerprint: 'zz' } }),
      ).ok,
    ).toBe(false);
    expect(parseDiscoveredServiceRecord({ ...rec({}), lastSeenAt: -1 }).ok).toBe(false);
  });
});

describe('fingerprint normalization and pairing status', () => {
  it('strips colons and lowercases like the Swift pinning delegate', () => {
    const colonForm = FP_A.toUpperCase().match(/.{2}/g)!.join(':');
    const normalized = normalizeCertificateFingerprint(colonForm);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value).toBe(FP_A);
    }
    expect(normalizeCertificateFingerprint('not-a-fingerprint').ok).toBe(false);
    expect(normalizeCertificateFingerprint('a'.repeat(63)).ok).toBe(false);
  });

  it('mirrors PairedHostStore.pairingStatus', () => {
    expect(resolvePairingStatus({ presentedFingerprint: FP_A })).toBe('unpaired');
    const colonForm = FP_A.toUpperCase().replace(/(..)/g, '$1:').replace(/:$/, '');
    expect(
      resolvePairingStatus({ storedFingerprint: FP_A, presentedFingerprint: colonForm }),
    ).toBe('paired');
    expect(resolvePairingStatus({ storedFingerprint: FP_A, presentedFingerprint: FP_B })).toBe(
      'requiresRePairing',
    );
    expect(resolvePairingStatus({ storedFingerprint: FP_A, presentedFingerprint: 'nothex' })).toBe(
      'requiresRePairing',
    );
  });

  it('never offers requiresRePairing as connectable', () => {
    expect(isPairingStatusConnectable('unpaired')).toBe(true);
    expect(isPairingStatusConnectable('paired')).toBe(true);
    expect(isPairingStatusConnectable('requiresRePairing')).toBe(false);
  });

  it('derives a record pairing status from a stored fingerprint', () => {
    expect(pairingStatusForRecord(resolvedRec('server-a', FP_B), { certificateFingerprint: FP_A })).toBe(
      'requiresRePairing',
    );
    expect(pairingStatusForRecord(resolvedRec('server-a', FP_A), { certificateFingerprint: FP_A })).toBe('paired');
  });
});


describe('resolution transitions', () => {
  it('walks discovered to resolving to resolved', () => {
    const discovered = rec({ identity: ident('server-a') });
    const resolving = advanceResolution(discovered, { kind: 'resolve-started', at: 5 });
    expect(resolving.ok).toBe(true);
    if (!resolving.ok) return;
    expect(resolving.value.state).toBe('resolving');
    const out = advanceResolution(resolving.value, {
      kind: 'resolve-succeeded',
      endpoint: ep('192.168.1.11'),
      at: 6,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.state).toBe('resolved');
      expect(out.value.endpoint?.host).toBe('192.168.1.11');
      expect(out.value.lastSeenAt).toBe(6);
    }
  });

  it('refuses to resolve a service without parsed identity', () => {
    const noIdentity: DiscoveredServiceRecord = {
      service: svc('Studio'),
      state: 'resolving',
      lastSeenAt: 1,
    };
    const out = advanceResolution(noIdentity, {
      kind: 'resolve-succeeded',
      endpoint: ep('192.168.1.10'),
      at: 2,
    });
    expect(out.ok).toBe(false);
  });
});

describe('resolution failure and refresh visibility', () => {
  it('surfaces resolution failure with a reason and drops the stale endpoint', () => {
    const failed = advanceResolution(resolvingRec(), {
      kind: 'resolve-failed',
      reason: 'host stopped answering the resolve',
      at: 8,
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.value.state).toBe('resolveFailed');
      expect(failed.value.endpoint).toBeUndefined();
      expect(failed.value.failureReason).toBe('host stopped answering the resolve');
    }
    const silent = advanceResolution(resolvingRec(), { kind: 'resolve-failed', reason: '  ', at: 8 });
    expect(silent.ok).toBe(false);
  });

  it('keeps a resolved endpoint visible but unselectable while re-resolving', () => {
    const resolving = advanceResolution(resolvedRec(), { kind: 'resolve-started', at: 11 });
    expect(resolving.ok).toBe(true);
    if (resolving.ok) {
      expect(resolving.value.state).toBe('resolving');
      expect(resolving.value.endpoint).toEqual(ep('192.168.1.10'));
      const derived = candidateFromRecord(resolving.value, 'paired');
      expect(derived.ok).toBe(false);
    }
  });

  it('marks a service absent from a browse batch as disappeared and drops its endpoint', () => {
    const refreshed = advanceResolution(resolvedRec(), {
      kind: 'browse-refresh',
      present: false,
      at: 12,
    });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.value.state).toBe('disappeared');
      expect(refreshed.value.endpoint).toBeUndefined();
    }
  });

  it('returns a re-observed disappeared service to discovered and requires a fresh resolve', () => {
    const gone = advanceResolution(resolvedRec(), { kind: 'browse-refresh', present: false, at: 12 });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const reobserved = advanceResolution(gone.value, {
      kind: 'browse-refresh',
      present: true,
      at: 13,
    });
    expect(reobserved.ok).toBe(true);
    if (reobserved.ok) {
      expect(reobserved.value.state).toBe('discovered');
      expect(reobserved.value.endpoint).toBeUndefined();
    }
    const retried = advanceResolution(gone.value, { kind: 'resolve-retried', at: 14 });
    expect(retried.ok && retried.value.state).toBe('resolving');
  });

  it('only retries from resolveFailed or disappeared', () => {
    expect(advanceResolution(resolvedRec(), { kind: 'resolve-retried', at: 12 }).ok).toBe(false);
    expect(advanceResolution(rec({}), { kind: 'resolve-retried', at: 2 }).ok).toBe(false);
  });

  it('attaches parsed identity and rejects identity-parsed on a disappeared service', () => {
    const parsed = advanceResolution(rec({}), {
      kind: 'identity-parsed',
      identity: ident('server-x'),
      at: 3,
    });
    expect(parsed.ok).toBe(true);
    const gone = advanceResolution(resolvedRec(), { kind: 'browse-refresh', present: false, at: 12 });
    expect(gone.ok).toBe(true);
    if (gone.ok) {
      const attempt = advanceResolution(gone.value, {
        kind: 'identity-parsed',
        identity: ident('server-y'),
        at: 13,
      });
      expect(attempt.ok).toBe(false);
    }
  });
});

describe('resolution transition totality', () => {
  it('is total over every state and event kind (never throws, always typed)', () => {
    for (const state of RESOLUTION_STATES) {
      for (const kind of [
        'resolve-started',
        'resolve-succeeded',
        'resolve-failed',
        'browse-refresh',
        'resolve-retried',
        'identity-parsed',
      ] as const) {
        const event =
          kind === 'resolve-succeeded'
            ? { kind, endpoint: ep('10.0.0.1'), at: 2 }
            : kind === 'resolve-failed'
              ? { kind, reason: 'boom', at: 2 }
              : kind === 'browse-refresh'
                ? { kind, present: true, at: 2 }
                : { kind, at: 2 };
        const out = advanceResolution(stateRec(state), event as never);
        expect(typeof out.ok).toBe('boolean');
      }
    }
  });
});

function stateRec(state: DiscoveredServiceRecord['state']): DiscoveredServiceRecord {
  return { service: svc('Studio'), state, lastSeenAt: 1 };
}

describe('deliberate host selection', () => {
  it('rejects an empty candidate set instead of returning undefined', () => {
    const out = selectAuto([]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('no-connectable-host');
      expect(out.message).toContain('no discovered hosts');
    }
  });

  it('selects a sole resolved unpaired host deterministically', () => {
    const out = selectAuto([cand({})]);
    expect(out.status).toBe('selected');
    if (out.status === 'selected') {
      expect(out.basis).toBe('sole-connectable-host');
      expect(out.host.identity.serverID).toBe('server-a');
      expect(out.alternates).toEqual([]);
    }
  });

  it('selects the explicitly requested server ID over another connectable host', () => {
    const a = cand({ identity: ident('server-a') });
    const b = cand({ identity: ident('server-b'), endpoint: ep('192.168.1.11') });
    const out = selectDiscoveredHost([a, b], { basis: 'explicit', serverID: 'server-b' });
    expect(out.status).toBe('selected');
    if (out.status === 'selected') {
      expect(out.basis).toBe('explicit-user-selection');
      expect(out.host.identity.serverID).toBe('server-b');
    }
  });

  it('rejects explicit selection of an unknown server ID', () => {
    const out = selectDiscoveredHost([cand({})], { basis: 'explicit', serverID: 'ghost' });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('explicit-selection-unknown');
    }
  });

  it('never offers a fingerprint-changed host as connectable, even as the sole host', () => {
    const repaired = cand({ identity: ident('server-a'), pairingStatus: 'requiresRePairing' });
    const out = selectAuto([cand({ identity: ident('server-a'), pairingStatus: 'requiresRePairing' })]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('no-connectable-host');
      expect(out.ruledOut[0]?.reason).toContain('re-pair');
    }
    const explicit = selectDiscoveredHost(
      [cand({ identity: ident('server-a'), pairingStatus: 'requiresRePairing' })],
      { basis: 'explicit', serverID: 'server-a' },
    );
    expect(explicit.status).toBe('rejected');
    if (explicit.status === 'rejected') {
      expect(explicit.code).toBe('explicit-selection-not-connectable');
      expect(explicit.ruledOut[0]?.reason).toContain('requires re-pairing');
    }
  });

  it('refuses to auto-pick among multiple distinct connectable hosts', () => {
    const a = cand({ identity: ident('server-a') });
    const b = cand({ identity: ident('server-b'), endpoint: ep('192.168.1.11') });
    const out = selectAuto([b, a]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('deliberate-selection-required');
      expect(out.orderedConnectable?.map((c) => c.identity.serverID)).toEqual([
        'server-a',
        'server-b',
      ]);
      expect(out.message).not.toContain('connect to "server-b" by default');
    }
  });

  it('orders duplicate service names for one identity by endpoint uniqueness with alternates', () => {
    const primary = cand({
      identity: ident('server-a'),
      endpoint: ep('192.168.1.20'),
    });
    const secondary = cand({ identity: ident('server-a'), endpoint: ep('10.0.0.5') });
    const duplicateInstance = cand({
      identity: ident('server-a'),
      endpoint: ep('192.168.1.10'),
      service: svc('Studio', 'home.local.'),
    });
    const out = selectAuto([secondary, duplicateInstance, primary]);
    expect(out.status).toBe('selected');
    if (out.status === 'selected') {
      expect(out.basis).toBe('stable-ordering-tie-break');
      expect(out.host.endpoint).toEqual(ep('10.0.0.5'));
      expect(out.alternates.map((c) => c.endpoint.host)).toEqual([
        '192.168.1.10',
        '192.168.1.20',
      ]);
    }
  });

  it('rejects same-name services advertised with conflicting fingerprints', () => {
    const a = cand({ identity: ident('server-a', FP_A) });
    const b = cand({
      identity: ident('server-a', FP_B),
      endpoint: ep('192.168.1.11'),
      service: svc('Studio', 'other.local.'),
    });
    const out = selectAuto([a, b]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('ambiguous-candidate-set');
      expect(out.ruledOut[0]?.reason).toContain('conflicting certificate fingerprints');
    }
  });

  it('is deterministic under input reordering, including duplicate service names', () => {
    const a = cand({ identity: ident('server-a'), endpoint: ep('192.168.1.20') });
    const b = cand({ identity: ident('server-a'), endpoint: ep('10.0.0.5') });
    const again = cand({ identity: ident('server-a'), endpoint: ep('10.0.0.5') });
    const first = selectAuto([a, b, again]);
    const second = selectAuto([again, a, b]);
    expect(first).toEqual(selectAuto([b, again, a]));
    expect(first.status).toBe('selected');
    if (first.status === 'selected') {
      expect(first.host.endpoint).toEqual(ep('10.0.0.5'));
      expect(first.alternates.map((c) => c.endpoint.host)).toEqual(['192.168.1.20']);
    }
  });

  it('rejects a candidate with unknown fields before anything is selected', () => {
    const malformed = { ...cand({}), extra: 'junk' };
    const out = selectAuto([cand({}), malformed as unknown as DiscoveredHostCandidate]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('malformed-candidate');
    }
  });
});


describe('pairing transitions', () => {
  it('walks the happy pairing path to paired', () => {
    const started = pairingTransition('unpaired', { kind: 'startPairing' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.state).toBe('pairing');
    const paired = pairingTransition(started.state, { kind: 'pairingSucceeded' });
    expect(paired.ok).toBe(true);
    if (paired.ok) {
      expect(paired.state).toBe('paired');
    }
  });

  it('routes a fingerprint change through the re-pair gate, never back to paired silently', () => {
    expect(pairingTransition('paired', { kind: 'fingerprintChanged' })).toEqual({
      ok: true,
      state: 'requiresRePairing',
    });
    const startRe = pairingTransition('requiresRePairing', { kind: 'startRePairing' });
    expect(startRe.ok).toBe(true);
    if (!startRe.ok) return;
    expect(startRe.state).toBe('re-pairing');
    const confirmed = pairingTransition(startRe.state, { kind: 'rePairConfirmed' });
    expect(confirmed.ok).toBe(true);
});

  it('returns a failed re-pair to requiresRePairing, never to paired', () => {
    expect(pairingTransition('re-pairing', { kind: 'pairingFailed' })).toEqual({
      ok: true,
      state: 'requiresRePairing',
    });
    expect(pairingTransition('re-pairing', { kind: 'rePairAbandoned' })).toEqual({
      ok: true,
      state: 'requiresRePairing',
    });
    expect(pairingTransition('re-pairing', { kind: 'pairingSucceeded' }).ok).toBe(false);
  });

  it('rejects pairing a host that requires re-pairing and duplicate in-flight pairings', () => {
    expect(pairingTransition('requiresRePairing', { kind: 'startPairing' }).ok).toBe(false);
    expect(pairingTransition('pairing', { kind: 'startPairing' }).ok).toBe(false);
    expect(pairingTransition('re-pairing', { kind: 'startRePairing' }).ok).toBe(false);
    expect(pairingTransition('paired', { kind: 'startPairing' }).ok).toBe(false);
  });

  it('forgets a host from any pairing state back to unpaired', () => {
    for (const state of PAIRING_FLOW_STATES) {
      const out = pairingTransition(state, { kind: 'hostForgotten' });
      expect(out.ok).toBe(true);
    }
  });

  it('is exhaustive over every state and event kind against the table', () => {
    expect(PAIRING_FLOW_STATES).toEqual([
      'unpaired',
      'pairing',
      'paired',
      'requiresRePairing',
      're-pairing',
    ]);
    expect(PAIRING_EVENT_KINDS).toEqual([
      'startPairing',
      'pairingSucceeded',
      'pairingFailed',
      'fingerprintChanged',
      'startRePairing',
      'rePairConfirmed',
      'rePairAbandoned',
      'hostForgotten',
    ]);
    for (const state of PAIRING_FLOW_STATES) {
      for (const kind of PAIRING_EVENT_KINDS) {
        const tableOutcome = PAIRING_TRANSITIONS[state][kind];
        const out = pairingTransition(state, { kind } as never);
        if (typeof tableOutcome === 'string') {
          expect(out).toEqual({ ok: true, state: tableOutcome });
        } else {
          expect(out.ok).toBe(false);
        }
      }
    }
  });
});


describe('browse-batch reconciliation', () => {
  it('adds new services as discovered and refreshes observed ones', () => {
    const added = reconcileBrowseBatch([], [svc('Studio'), svc('Loft')], 5);
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.value.map((r) => r.service.serviceName).sort()).toEqual(['Loft', 'Studio']);
      expect(added.value.every((r) => r.state === 'discovered' && r.lastSeenAt === 5)).toBe(true);
    }
  });

  it('drops a service the batch no longer reports', () => {
    const base = reconcileBrowseBatch([], [svc('Studio'), svc('Loft')], 5);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = reconcileBrowseBatch(base.value, [svc('Studio')], 6);
    expect(next.ok).toBe(true);
    if (next.ok) {
      const loft = next.value.find((r) => r.service.serviceName === 'Loft');
      expect(loft?.state).toBe('disappeared');
      const studio = next.value.find((r) => r.service.serviceName === 'Studio');
      expect(studio?.state).toBe('discovered');
      expect(studio?.lastSeenAt).toBe(6);
    }
  });

  it('rejects malformed observed keys with typed problems', () => {
    const out = reconcileBrowseBatch([], [{ ...svc('Studio'), bogus: 1 } as never], 5);
    expect(out.ok).toBe(false);
  });
});

describe('stale-entry expiry', () => {
  it('expires records past their window and keeps the rest', () => {
    const records = [
      { service: svc('Studio'), state: 'resolved', lastSeenAt: 5 },
      { service: svc('Loft'), state: 'discovered', lastSeenAt: 9 },
    ];
    const out = expireStaleEntries(records as DiscoveredServiceRecord[], {
      now: 20,
      staleAfter: 14,
    });
    expect(out.retained.map((r) => r.service.serviceName)).toEqual(['Loft']);
    expect(out.expired.map((r) => r.service.serviceName)).toEqual(['Studio']);
    expect(out.expired[0]?.state).toBe('disappeared');
    expect(out.expired[0]?.endpoint).toBeUndefined();
  });

  it('treats the boundary as expired and throws on malformed options', () => {
    const records = [{ service: svc('Studio'), state: 'discovered', lastSeenAt: 5 }];
    const boundary = expireStaleEntries(records as DiscoveredServiceRecord[], {
      now: 20,
      staleAfter: 15,
    });
    expect(boundary.expired).toHaveLength(1);
    expect(() =>
      expireStaleEntries(records as DiscoveredServiceRecord[], { now: -1, staleAfter: 5 }),
    ).toThrow();
  });
});

describe('end-to-end discovered-host flow', () => {
  it('carries a discovered host from browse to a selectable paired candidate', () => {
    const batch = reconcileBrowseBatch([], [svc('Studio')], 1);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const withIdentity = advanceResolution(batch.value[0], {
      kind: 'identity-parsed',
      identity: ident('server-a'),
      at: 2,
    });
    expect(withIdentity.ok).toBe(true);
    if (!withIdentity.ok) return;
    const resolving = advanceResolution(withIdentity.value, { kind: 'resolve-started', at: 3 });
    expect(resolving.ok).toBe(true);
    if (!resolving.ok) return;
    const resolved = advanceResolution(resolving.value, {
      kind: 'resolve-succeeded',
      endpoint: ep('192.168.1.10'),
      at: 4,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const unpaired = candidateFromRecord(resolved.value, 'unpaired');
    expect(unpaired.ok).toBe(true);
    const selection = selectAuto(unpaired.ok ? [unpaired.value] : []);
    expect(selection.status).toBe('selected');
    if (selection.status !== 'selected') return;

    const pairing = pairingTransition(selection.host.pairingStatus, { kind: 'startPairing' });
    expect(pairing.ok).toBe(true);
    if (!pairing.ok) return;
    const paired = pairingTransition(pairing.state, { kind: 'pairingSucceeded' });
    expect(paired.ok && paired.state).toBe('paired');
  });

  it('presents a fingerprint-changed host as requiring re-pairing, not connectable', () => {
    const record = resolvedRec('server-a', FP_B);
    const status = pairingStatusForRecord(record, { certificateFingerprint: FP_A });
    expect(status).toBe('requiresRePairing');
    const out = selectAuto([
      {
        service: record.service,
        state: record.state,
        identity: record.identity!,
        endpoint: record.endpoint!,
        pairingStatus: status,
      },
    ]);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.ruledOut[0]?.reason).toContain('requires re-pairing');
    }
  });
});
