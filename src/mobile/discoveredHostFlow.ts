// Bonjour discovered-host connect flow (v1) — platform-neutral reference logic.
//
// Companion to `docs/mobile/BONJOUR-CONNECT-FLOW.md` for Bead `psyche-i7c.11`
// (OpenCoven/psyche-build#216, "Wire Bonjour discovery into a connectable host
// flow"). Phase 3 shipped `BonjourHostParser`/`BonjourHostDiscovery` in Swift
// with full parsing/filtering coverage (see
// `native/ios/PsycheCore/Sources/PsycheCore/Pairing/`), but nothing consumes
// them, `NWEndpoint.service(name:type:domain:)` still has to be resolved to a
// host and port before it can become a `HostEndpoint` for the wss:// URL, and
// `ConnectionManager.connectToStoredHost()` picks `hosts().first` — the
// lexicographically-lowest server ID rather than a deliberate choice.
//
// This module pins the contract the Swift owner implements:
//
//   discovered → resolving → resolved | resolveFailed | disappeared
//
// plus a deliberate host-selection rule that replaces silent first-picks:
// explicit user selection first, then a stable ordering by server ID and
// endpoint uniqueness — never a silent first-pick, and never a connect offer
// for a host whose pinned fingerprint changed.
//
// This is a reference slice only: no I/O, no clock (every timestamp is a
// caller-supplied logical tick), no runtime state, deterministic. The Swift
// implementation itself is a documented gap tracked by the Beads source.

/** Schema version of the flow records produced and validated here. */
export const DISCOVERED_HOST_FLOW_VERSION = 1;

/**
 * The `_psyche._tcp` service type BonjourHostParser browses. Mirrors
 * `BonjourHostParser.serviceType`; carried on records so a caller cannot mix
 * foreign service types into this flow by accident.
 */
export const PSYCHE_BONJOUR_SERVICE_TYPE = '_psyche._tcp';

/**
 * A discovered Bonjour service as the browser presents it: type, instance
 * name, and domain. This triple is the service key; the instance name alone
 * collides when two hosts pick the same one, so identity lives in the parsed
 * TXT server ID, not here.
 */
export interface BonjourServiceKey {
  readonly serviceType: string;
  readonly serviceName: string;
  readonly domain: string;
}

/** A resolved host and port — routing information only, never trust. */
export interface ResolvedEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * Validated identity metadata parsed from a service's TXT record: the server
 * ID (identity), a display name, the certificate fingerprint this client
 * pins, and at least one supported protocol version. Mirrors Swift
 * `BonjourHostIdentity`.
 */
export interface DiscoveredHostIdentity {
  readonly serverID: string;
  readonly serverName: string;
  /** Normalized SHA-256 fingerprint: 64 lowercase hex characters, no colons. */
  readonly certificateFingerprint: string;
  readonly supportedVersions: readonly number[];
}

/**
 * Resolution state of one discovered service:
 *
 * - `discovered` — seen in a browse batch; identity may or may not be parsed
 *   yet; no endpoint.
 * - `resolving` — service resolution in flight. A host that was previously
 *   `resolved` keeps its stale endpoint visible while refreshing, matching
 *   `BonjourHostDiscovery`'s batch behavior, but it is not selectable until
 *   it resolves again.
 * - `resolved` — host and port available; the only selectable state.
 * - `resolveFailed` — the resolver returned an error. Surfaced with a reason
 *   (an actionable message, never a silent no-op) and removable by retry.
 * - `disappeared` — absent from a browse batch or past its stale deadline;
 *   removed from the connectable candidate set.
 */
export type ServiceResolutionState =
  | 'discovered'
  | 'resolving'
  | 'resolved'
  | 'resolveFailed'
  | 'disappeared';

/** Every valid resolution state, in lifecycle order. */
export const RESOLUTION_STATES: readonly ServiceResolutionState[] = [
  'discovered',
  'resolving',
  'resolved',
  'resolveFailed',
  'disappeared',
];

/**
 * One discovered service record: the service key, its resolution state, the
 * optional parsed identity and resolved endpoint, and the logical tick it was
 * last observed at. `failureReason` is required whenever the state is
 * `resolveFailed` — resolution failure is surfaced, not swallowed.
 */
export interface DiscoveredServiceRecord {
  readonly service: BonjourServiceKey;
  readonly state: ServiceResolutionState;
  /** Caller-supplied logical tick of last observation (no clock in here). */
  readonly lastSeenAt: number;
  readonly identity?: DiscoveredHostIdentity;
  readonly endpoint?: ResolvedEndpoint;
  readonly failureReason?: string;
}

/**
 * A candidate the user could connect to: a fully resolved service record plus
 * the store-derived pairing status for its server ID. Mirrors Swift
 * `DiscoveredHost` (identity + endpoint) extended with the pairing gate.
 */
export interface DiscoveredHostCandidate {
  readonly service: BonjourServiceKey;
  readonly state: ServiceResolutionState;
  readonly identity: DiscoveredHostIdentity;
  readonly endpoint: ResolvedEndpoint;
  readonly pairingStatus: PairingStatus;
}

/**
 * Store-derived pairing status for a server ID. Mirrors Swift
 * `PairingStatus` (`PairedHostStore.pairingStatus(forServerID:
 * certificateFingerprint:)`): `unpaired` when no record exists, `paired` when
 * the pinned fingerprint still matches, and `requiresRePairing` when the
 * presented fingerprint differs from what was pinned — which is presented as
 * requiring re-pairing and is never offered as connectable.
 */
export type PairingStatus = 'unpaired' | 'paired' | 'requiresRePairing';

/** A structured problem: a stable code plus a human-readable message. */
export interface DiscoveredFlowProblem {
  readonly code: string;
  readonly message: string;
}

export type DiscoveredFlowResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly DiscoveredFlowProblem[] };

function problem(code: string, message: string): DiscoveredFlowProblem {
  return { code, message };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecordLike(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * Normalize a certificate fingerprint exactly like Swift
 * `PinnedCertificateDelegate.normalizeFingerprint`: strip colons, lowercase,
 * and require exactly 64 ASCII hex characters (a SHA-256 digest). Fails
 * closed on anything else.
 */
export function normalizeCertificateFingerprint(
  input: string,
): DiscoveredFlowResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, problems: [problem('invalid-fingerprint', 'fingerprint must be a string')] };
  }
  const normalized = input.split(':').join('').toLowerCase();
  if (normalized.length !== 64 || [...normalized].some((c) => !HEX_DIGITS.includes(c))) {
    return {
      ok: false,
      problems: [
        problem(
          'invalid-fingerprint',
          'fingerprint must be a 64-character hexadecimal SHA-256 digest (colons allowed)',
        ),
      ],
    };
  }
  return { ok: true, value: normalized };
}

/**
 * Store-derived pairing status for a server ID, mirroring
 * `PairedHostStore.pairingStatus(forServerID:certificateFingerprint:)`:
 * no stored record → `unpaired`; the presented fingerprint fails
 * normalization or differs from the pinned one → `requiresRePairing`;
 * equal → `paired`.
 */
export function resolvePairingStatus(input: {
  readonly storedFingerprint?: string;
  readonly presentedFingerprint: string;
}): PairingStatus {
  if (input.storedFingerprint === undefined) {
    return 'unpaired';
  }
  const normalized = normalizeCertificateFingerprint(input.presentedFingerprint);
  if (!normalized.ok || normalized.value !== input.storedFingerprint) {
    return 'requiresRePairing';
  }
  return 'paired';
}

/**
 * Whether a pairing status allows a connect offer. `requiresRePairing` is
 * never offered as connectable — the host is presenting a different
 * certificate than the one pinned at pairing, so the only path is an explicit
 * re-pair.
 */
export function isPairingStatusConnectable(status: PairingStatus): boolean {
  return status !== 'requiresRePairing';
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): DiscoveredFlowProblem[] {
  const problems: DiscoveredFlowProblem[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(
        problem('unknown-field', `${label} has unknown field ${JSON.stringify(key)}`),
      );
    }
  }
  return problems;
}

function parseServiceKey(value: unknown): DiscoveredFlowResult<BonjourServiceKey> {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problems: [problem('invalid-service-key', 'service key must be an object')],
    };
  }
  const problems = exactKeys(value, ['serviceType', 'serviceName', 'domain'], 'service key');
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const { serviceType, serviceName, domain } = value;
  for (const [name, field] of [
    ['serviceType', serviceType],
    ['serviceName', serviceName],
    ['domain', domain],
  ] as const) {
    if (typeof field !== 'string' || field.trim().length === 0) {
      return {
        ok: false,
        problems: [problem('invalid-service-key', `service key ${name} must be a non-empty string`)],
      };
    }
  }
  return {
    ok: true,
    value: {
      serviceType: serviceType as string,
      serviceName: serviceName as string,
      domain: domain as string,
    },
  };
}

function parseEndpoint(value: unknown): DiscoveredFlowResult<ResolvedEndpoint> {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problems: [problem('invalid-endpoint', 'endpoint must be an object')],
    };
  }
  const problems = exactKeys(value, ['host', 'port'], 'endpoint');
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const { host, port } = value;
  if (typeof host !== 'string' || host.trim().length === 0) {
    return {
      ok: false,
      problems: [problem('invalid-endpoint', 'endpoint host must be a non-empty string')],
    };
  }
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return {
      ok: false,
      problems: [problem('invalid-endpoint', 'endpoint port must be an integer in 1...65535')],
    };
  }
  return { ok: true, value: { host, port } };
}

function parseIdentity(value: unknown): DiscoveredFlowResult<DiscoveredHostIdentity> {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problems: [problem('invalid-identity', 'identity must be an object')],
    };
  }
  const problems = exactKeys(
    value,
    ['serverID', 'serverName', 'certificateFingerprint', 'supportedVersions'],
    'identity',
  );
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const { serverID, serverName, certificateFingerprint, supportedVersions } = value;
  if (typeof serverID !== 'string' || serverID.trim().length === 0) {
    return {
      ok: false,
      problems: [problem('invalid-identity', 'identity serverID must be a non-empty string')],
    };
  }
  if (typeof serverName !== 'string' || serverName.trim().length === 0) {
    return {
      ok: false,
      problems: [problem('invalid-identity', 'identity serverName must be a non-empty string')],
    };
  }
  if (!Array.isArray(supportedVersions) || supportedVersions.length === 0) {
    return {
      ok: false,
      problems: [
        problem(
          'invalid-identity',
          'identity supportedVersions must be a non-empty array of integers',
        ),
      ],
    };
  }
  for (const version of supportedVersions) {
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      return {
        ok: false,
        problems: [
          problem('invalid-identity', 'identity supportedVersions must contain only integers'),
        ],
      };
    }
  }
  const fingerprint = normalizeCertificateFingerprint(
    typeof certificateFingerprint === 'string' ? certificateFingerprint : '',
  );
  if (!fingerprint.ok) {
    return { ok: false, problems: fingerprint.problems };
  }
  return {
    ok: true,
    value: {
      serverID,
      serverName,
      certificateFingerprint: fingerprint.value,
      supportedVersions: [...supportedVersions],
    },
  };
}

const DISCOVERED_SERVICE_RECORD_FIELDS = [
  'service',
  'state',
  'lastSeenAt',
  'identity',
  'endpoint',
  'failureReason',
] as const;

/**
 * Strictly parse a discovered service record from an untrusted boundary.
 * Unknown fields, wrong types, invalid service keys/endpoints/identities,
 * unparseable fingerprints, and a `resolveFailed` record without a
 * non-empty `failureReason` are all rejected with typed problems instead of
 * being coerced into half-formed records.
 */
export function parseDiscoveredServiceRecord(
  input: unknown,
): DiscoveredFlowResult<DiscoveredServiceRecord> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      problems: [problem('invalid-record', 'discovered service record must be an object')],
    };
  }
  const problems = exactKeys(
    input,
    DISCOVERED_SERVICE_RECORD_FIELDS,
    'discovered service record',
  );
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const service = parseServiceKey(input.service);
  if (!service.ok) {
    return service;
  }
  const { state, lastSeenAt } = input;
  if (
    typeof state !== 'string' ||
    !RESOLUTION_STATES.includes(state as ServiceResolutionState)
  ) {
    return {
      ok: false,
      problems: [
        problem(
          'invalid-state',
          `record state must be one of ${RESOLUTION_STATES.join('|')}`,
        ),
      ],
    };
  }
  if (!isFiniteNonNegativeNumber(lastSeenAt)) {
    return {
      ok: false,
      problems: [
        problem('invalid-last-seen', 'record lastSeenAt must be a finite non-negative number'),
      ],
    };
  }
  let identity: DiscoveredHostIdentity | undefined;
  if (input.identity !== undefined) {
    const parsed = parseIdentity(input.identity);
    if (!parsed.ok) {
      return parsed;
    }
    identity = parsed.value;
  }
  let endpoint: ResolvedEndpoint | undefined;
  if (input.endpoint !== undefined) {
    const parsed = parseEndpoint(input.endpoint);
    if (!parsed.ok) {
      return parsed;
    }
    endpoint = parsed.value;
  }
  let failureReason: string | undefined;
  if (input.failureReason !== undefined) {
    if (typeof input.failureReason !== 'string' || input.failureReason.trim().length === 0) {
      return {
        ok: false,
        problems: [
          problem('invalid-failure-reason', 'failureReason, when present, must be a non-empty string'),
        ],
      };
    }
    failureReason = input.failureReason;
  }
  if (state === 'resolveFailed' && failureReason === undefined) {
    return {
      ok: false,
      problems: [
        problem(
          'missing-failure-reason',
          'a resolveFailed record must carry a non-empty failureReason so the failure is actionable',
        ),
      ],
    };
  }
  // An endpoint may only ride along while it is current (`resolved`) or while
  // it is kept visible during a refresh (`resolving`). Every other state has
  // no trustworthy address.
  if (endpoint !== undefined && state !== 'resolved' && state !== 'resolving') {
    return {
      ok: false,
      problems: [
        problem(
          'endpoint-in-invalid-state',
          `a ${state} record cannot carry a resolved endpoint`,
        ),
      ],
    };
  }
  return {
    ok: true,
    value: {
      service: service.value,
      state: state as ServiceResolutionState,
      lastSeenAt,
      identity,
      endpoint,
      failureReason,
    },
  };
}

/**
 * Strictly parse a connectable candidate from an untrusted boundary. The
 * candidate must be fully resolved, carry a parsed identity and endpoint, and
 * name a valid pairing status; anything else fails closed.
 */
export function parseDiscoveredHostCandidate(
  input: unknown,
): DiscoveredFlowResult<DiscoveredHostCandidate> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      problems: [problem('invalid-candidate', 'candidate must be an object')],
    };
  }
  const problems = exactKeys(
    input,
    ['service', 'state', 'identity', 'endpoint', 'pairingStatus'],
    'candidate',
  );
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const service = parseServiceKey(input.service);
  if (!service.ok) {
    return service;
  }
  const identity = parseIdentity(input.identity);
  if (!identity.ok) {
    return identity;
  }
  const endpoint = parseEndpoint(input.endpoint);
  if (!endpoint.ok) {
    return endpoint;
  }
  if (input.state !== 'resolved') {
    return {
      ok: false,
      problems: [
        problem(
          'unresolved-candidate',
          `a connectable candidate must be resolved; got ${JSON.stringify(input.state ?? null)}`,
        ),
      ],
    };
  }
  if (
    typeof input.pairingStatus !== 'string' ||
    !['unpaired', 'paired', 'requiresRePairing'].includes(input.pairingStatus)
  ) {
    return {
      ok: false,
      problems: [
        problem(
          'invalid-pairing-status',
          'pairingStatus must be one of unpaired|paired|requiresRePairing',
        ),
      ],
    };
  }
  return {
    ok: true,
    value: {
      service: service.value,
      state: 'resolved',
      identity: identity.value,
      endpoint: endpoint.value,
      pairingStatus: input.pairingStatus as PairingStatus,
    },
  };
}

/**
 * Derive a connectable candidate from a resolved service record. Fails closed
 * unless the record is `resolved` and carries both a parsed identity and an
 * endpoint; the pairing status comes from the caller (the store lookup for
 * the record's server ID, or `unpaired` when nothing is stored).
 */
export function candidateFromRecord(
  record: DiscoveredServiceRecord,
  pairingStatus: PairingStatus,
): DiscoveredFlowResult<DiscoveredHostCandidate> {
  if (record.state !== 'resolved' || record.endpoint === undefined) {
    return {
      ok: false,
      problems: [
        problem(
          'unresolved-candidate',
          `service ${JSON.stringify(record.service.serviceName)} is ${record.state}, not resolved`,
        ),
      ],
    };
  }
  if (record.identity === undefined) {
    return {
      ok: false,
      problems: [
        problem(
          'missing-identity',
          `service ${JSON.stringify(record.service.serviceName)} has no parsed identity`,
        ),
      ],
    };
  }
  const candidate: DiscoveredHostCandidate = {
    service: record.service,
    state: record.state,
    identity: record.identity,
    endpoint: record.endpoint,
    pairingStatus,
  };
  return parseDiscoveredHostCandidate(candidate);
}

/**
 * Derive the pairing status for a record's server ID from a stored pairing,
 * mirroring `PairedHostStore.pairingStatus(forServerID:certificateFingerprint:)`.
 */
export function pairingStatusForRecord(
  record: DiscoveredServiceRecord,
  stored?: { readonly certificateFingerprint: string },
): PairingStatus {
  const presented = record.identity?.certificateFingerprint;
  if (presented === undefined) {
    return 'unpaired';
  }
  return resolvePairingStatus({
    storedFingerprint: stored?.certificateFingerprint,
    presentedFingerprint: presented,
  });
}

// ---------------------------------------------------------------------------
// Resolution transitions
// ---------------------------------------------------------------------------

export type ResolutionEvent =
  | { kind: 'resolve-started'; at: number }
  | { kind: 'resolve-succeeded'; endpoint: ResolvedEndpoint; at: number }
  | { kind: 'resolve-failed'; reason: string; at: number }
  | { kind: 'browse-refresh'; present: boolean; at: number }
  | { kind: 'resolve-retried'; at: number }
  | { kind: 'identity-parsed'; identity: DiscoveredHostIdentity; at: number };

export const RESOLUTION_EVENT_KINDS: readonly ResolutionEvent['kind'][] = [
  'resolve-started',
  'resolve-succeeded',
  'resolve-failed',
  'browse-refresh',
  'resolve-retried',
  'identity-parsed',
];

function withLastSeen(
  record: DiscoveredServiceRecord,
  at: number,
): DiscoveredServiceRecord {
  return { ...record, lastSeenAt: at };
}

/**
 * Advance one service record's resolution state machine. Deterministic and
 * total: every (state, event) pair either produces the next record or a typed
 * problem — nothing is silently swallowed. Notable rules:
 *
 * - `resolve-succeeded` requires a parsed identity (Swift only publishes
 *   hosts whose TXT parsed) and replaces the endpoint.
 * - Re-resolving a `resolved` host keeps its stale endpoint visible during
 *   the refresh but the host is not selectable until it resolves again.
 * - A `resolveFailed` host must carry a non-empty reason, and its stale
 *   endpoint is dropped — a failed refresh must not leave a trusted-looking
 *   address behind.
 * - A service absent from a browse batch becomes `disappeared` and is removed
 *   from the candidate set; a re-observed `disappeared` service returns to
 *   `discovered` and must resolve again before it is selectable.
 */
export function advanceResolution(
  record: DiscoveredServiceRecord,
  event: ResolutionEvent,
): DiscoveredFlowResult<DiscoveredServiceRecord> {
  if (!isFiniteNonNegativeNumber(event.at)) {
    return {
      ok: false,
      problems: [problem('invalid-timestamp', 'event at must be a finite non-negative number')],
    };
  }
  switch (event.kind) {
    case 'resolve-started': {
      if (record.state === 'disappeared') {
        return rejectedTransition(record, event.kind, 're-observe the service first');
      }
      if (record.state === 'resolveFailed') {
        return rejectedTransition(record, event.kind, 'retry resolution explicitly first');
      }
      return ok(withLastSeen({ ...record, state: 'resolving' }, event.at));
    }
    case 'resolve-succeeded': {
      if (record.state !== 'resolving') {
        return rejectedTransition(record, event.kind, `state is ${record.state}, not resolving`);
      }
      if (record.identity === undefined) {
        return {
          ok: false,
          problems: [
            problem(
              'resolve-succeeded-without-identity',
              'a service cannot resolve to a connectable host without parsed identity metadata',
            ),
          ],
        };
      }
      const endpoint = parseEndpoint(event.endpoint);
      if (!endpoint.ok) {
        return endpoint;
      }
      return ok(
        withLastSeen(
          { ...record, state: 'resolved', endpoint: endpoint.value, failureReason: undefined },
          event.at,
        ),
      );
    }
    case 'resolve-failed': {
      if (record.state !== 'resolving') {
        return rejectedTransition(record, event.kind, `state is ${record.state}, not resolving`);
      }
      if (typeof event.reason !== 'string' || event.reason.trim().length === 0) {
        return {
          ok: false,
          problems: [
            problem(
              'missing-failure-reason',
              'resolve-failed requires a non-empty reason so the failure is actionable',
            ),
          ],
        };
      }
      // Drop any stale endpoint: a failed refresh must not leave an address
      // that looks trusted behind.
      return ok(
        withLastSeen(
          { ...record, state: 'resolveFailed', endpoint: undefined, failureReason: event.reason },
          event.at,
        ),
      );
    }
    case 'browse-refresh': {
      if (event.present) {
        const next =
          record.state === 'disappeared'
            ? // A re-observed service starts fresh: endpoint cleared, and it
              // must resolve again before it is selectable.
              { ...record, state: 'discovered' as const, endpoint: undefined, failureReason: undefined }
            : record;
        return ok(withLastSeen(next, event.at));
      }
      return ok(
        withLastSeen(
          { ...record, state: 'disappeared', endpoint: undefined, failureReason: undefined },
          event.at,
        ),
      );
    }
    case 'resolve-retried': {
      if (record.state !== 'resolveFailed' && record.state !== 'disappeared') {
        return rejectedTransition(
          record,
          event.kind,
          `state is ${record.state}; retry applies to resolveFailed or disappeared`,
        );
      }
      return ok(withLastSeen({ ...record, state: 'resolving' }, event.at));
    }
    case 'identity-parsed': {
      if (record.state === 'disappeared') {
        return rejectedTransition(record, event.kind, 're-observe the service first');
      }
      const identity = parseIdentity(event.identity);
      if (!identity.ok) {
        return identity;
      }
      return ok(withLastSeen({ ...record, identity: identity.value }, event.at));
    }
  }
}

function rejectedTransition(
  record: DiscoveredServiceRecord,
  kind: ResolutionEvent['kind'],
  detail: string,
): DiscoveredFlowResult<DiscoveredServiceRecord> {
  return {
    ok: false,
    problems: [
      problem(
        'invalid-transition',
        `event ${kind} is not valid while service ${JSON.stringify(record.service.serviceName)} is ${record.state}: ${detail}`,
      ),
    ],
  };
}

function ok<T>(value: T): DiscoveredFlowResult<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Browse-batch reconciliation and stale expiry
// ---------------------------------------------------------------------------

function serviceKeyString(key: BonjourServiceKey): string {
  return `${key.serviceType}|${key.serviceName}|${key.domain}`;
}

/**
 * Reconcile the current records against one browse batch. Services the batch
 * no longer reports become `disappeared` and drop out of the candidate set;
 * services it still reports have their observation tick refreshed, and a
 * `disappeared` service the batch sees again returns to `discovered` (fresh,
 * endpoint cleared, must resolve again). Mirrors `BonjourHostDiscovery`'s
 * batch behavior: a host is removed only when the batch proves it gone.
 */
export function reconcileBrowseBatch(
  records: readonly DiscoveredServiceRecord[],
  observed: readonly BonjourServiceKey[],
  at: number,
): DiscoveredFlowResult<readonly DiscoveredServiceRecord[]> {
  if (!isFiniteNonNegativeNumber(at)) {
    return {
      ok: false,
      problems: [problem('invalid-timestamp', 'batch at must be a finite non-negative number')],
    };
  }
  const observedKeys = new Map<string, BonjourServiceKey>();
  for (const key of observed) {
    const parsed = parseServiceKey(key);
    if (!parsed.ok) {
      return parsed;
    }
    observedKeys.set(serviceKeyString(parsed.value), parsed.value);
  }
  const next: DiscoveredServiceRecord[] = [];
  for (const record of records) {
    const refreshed = advanceResolution(record, {
      kind: 'browse-refresh',
      present: observedKeys.has(serviceKeyString(record.service)),
      at,
    });
    if (!refreshed.ok) {
      return refreshed;
    }
    next.push(refreshed.value);
  }
  for (const key of observedKeys.keys()) {
    if (!records.some((record) => serviceKeyString(record.service) === key)) {
      next.push({
        service: observedKeys.get(key)!,
        state: 'discovered',
        lastSeenAt: at,
      });
    }
  }
  return ok(next);
}

/**
 * Expire stale entries: any record whose `lastSeenAt` is older than
 * `staleAfter` ticks before `now` becomes `disappeared` (endpoint dropped) and
 * is returned separately from the retained records. Deterministic — `now` and
 * `staleAfter` are caller-supplied; nothing in this module reads a clock.
 */
export function expireStaleEntries(
  records: readonly DiscoveredServiceRecord[],
  options: { readonly now: number; readonly staleAfter: number },
): { readonly retained: readonly DiscoveredServiceRecord[]; readonly expired: readonly DiscoveredServiceRecord[] } {
  if (!isFiniteNonNegativeNumber(options.now) || !isFiniteNonNegativeNumber(options.staleAfter)) {
    throw new Error('discoveredHostFlow: stale-expiry options must be finite non-negative numbers');
  }
  const retained: DiscoveredServiceRecord[] = [];
  const expired: DiscoveredServiceRecord[] = [];
  for (const record of records) {
    if (record.lastSeenAt + options.staleAfter <= options.now) {
      expired.push({
        ...record,
        state: 'disappeared',
        endpoint: undefined,
        failureReason: 'stale: service not observed within the expiry window',
      });
    } else {
      retained.push(record);
    }
  }
  return { retained, expired };
}

// ---------------------------------------------------------------------------
// Deliberate host selection (replaces hosts().first)
// ---------------------------------------------------------------------------

export type HostSelectionRequest =
  | { readonly basis: 'explicit'; readonly serverID: string }
  | { readonly basis: 'auto' };

/**
 * Why a host was selected. `stable-ordering-tie-break` is used only when one
 * identity exposes several distinct endpoints: the ordering below picks one
 * deterministically and the others are reported as alternates. Two different
 * server IDs are never silently ordered into a pick.
 */
export type SelectionBasis =
  | 'explicit-user-selection'
  | 'sole-connectable-host'
  | 'stable-ordering-tie-break';

export type HostSelectionRejectionCode =
  | 'empty-candidate-set'
  | 'malformed-candidate'
  | 'ambiguous-candidate-set'
  | 'explicit-selection-unknown'
  | 'explicit-selection-not-connectable'
  | 'no-connectable-host'
  | 'deliberate-selection-required';

/** A candidate that was not selected, with the concrete reason. */
export interface RuledOutCandidate {
  readonly serverID: string;
  readonly serverName: string;
  readonly endpoint?: ResolvedEndpoint;
  readonly reason: string;
}

export type HostSelection =
  | {
      readonly status: 'selected';
      readonly host: DiscoveredHostCandidate;
      readonly basis: SelectionBasis;
      /** Same server ID, different endpoints, in deterministic order. */
      readonly alternates: readonly DiscoveredHostCandidate[];
      readonly ruledOut: readonly RuledOutCandidate[];
    }
  | {
      readonly status: 'rejected';
      readonly code: HostSelectionRejectionCode;
      readonly message: string;
      readonly ruledOut: readonly RuledOutCandidate[];
      /** Connectable hosts in deterministic order, when a user choice is needed. */
      readonly orderedConnectable?: readonly DiscoveredHostCandidate[];
    };

/**
 * Deterministic candidate ordering: server ID ascending (the identity), then
 * endpoint host and port ascending (endpoint uniqueness), then service key
 * fields so the order is total even for duplicate endpoint keys.
 */
export function compareCandidates(
  a: DiscoveredHostCandidate,
  b: DiscoveredHostCandidate,
): number {
  const serverOrder = a.identity.serverID.localeCompare(b.identity.serverID);
  if (serverOrder !== 0) {
    return serverOrder;
  }
  const hostOrder = a.endpoint.host.localeCompare(b.endpoint.host);
  if (hostOrder !== 0) {
    return hostOrder;
  }
  const portOrder = a.endpoint.port - b.endpoint.port;
  if (portOrder !== 0) {
    return portOrder;
  }
  return (
    a.service.serviceType.localeCompare(b.service.serviceType) ||
    a.service.serviceName.localeCompare(b.service.serviceName) ||
    a.service.domain.localeCompare(b.service.domain)
  );
}

function endpointKey(endpoint: ResolvedEndpoint): string {
  return `${endpoint.host}|${endpoint.port}`;
}

/**
 * Select a discovered host to connect to. This is the deliberate rule that
 * replaces `hosts().first`:
 *
 * 1. Malformed candidates (including unknown fields) fail the whole selection
 *    closed — an untrusted surface must not degrade into a partial pick.
 * 2. Two candidates claiming the same server ID with different normalized
 *    certificate fingerprints are an identity conflict: rejected as
 *    `ambiguous-candidate-set`, never silently arbitrated.
 * 3. Only resolved candidates whose pairing status is connectable
 *    (`unpaired` — connect to pair — or `paired`) can be selected. A host
 *    whose pinned fingerprint changed is excluded with a
 *    `requires-re-pairing` reason, not offered as connectable.
 * 4. An explicit user selection wins when it names a known, connectable
 *    server ID; otherwise the selection is rejected with the concrete reason.
 * 5. With no explicit selection: a sole connectable identity is selected
 *    (`sole-connectable-host`); one identity with several distinct endpoints
 *    is disambiguated deterministically (`stable-ordering-tie-break`,
 *    alternates reported); more than one distinct connectable server ID is
 *    never silently arbitrated — the caller must surface a deliberate user
 *    choice (`deliberate-selection-required`) with the ordered connectable
 *    list. This is the anti-`hosts().first` rule: the lexicographically-lowest
 *    server ID is an ordering for display, never a choice.
 */
export function selectDiscoveredHost(
  candidates: readonly DiscoveredHostCandidate[],
  request: HostSelectionRequest,
): HostSelection {
  const ruledOut: RuledOutCandidate[] = [];
  for (const candidate of candidates) {
    const validated = parseDiscoveredHostCandidate(candidate);
    if (!validated.ok) {
      return {
        status: 'rejected',
        code: 'malformed-candidate',
        message: `a candidate failed validation: ${validated.problems
          .map((p) => `${p.code} (${p.message})`)
          .join('; ')}`,
        ruledOut: [],
      };
    }
  }

  // Identity conflicts fail closed before anything is selected.
  const byServerID = new Map<string, DiscoveredHostCandidate[]>();
  for (const candidate of candidates) {
    const group = byServerID.get(candidate.identity.serverID);
    if (group) {
      group.push(candidate);
    } else {
      byServerID.set(candidate.identity.serverID, [candidate]);
    }
  }
  for (const [serverID, group] of byServerID) {
    const fingerprints = new Set(group.map((c) => c.identity.certificateFingerprint));
    if (fingerprints.size > 1) {
      return {
        status: 'rejected',
        code: 'ambiguous-candidate-set',
        message: `server ID ${JSON.stringify(
          serverID,
        )} is advertised with conflicting certificate fingerprints; refusing to arbitrate — re-observe the LAN and re-pair if the certificate really changed`,
        ruledOut: group.map((c) => ({
          serverID: c.identity.serverID,
          serverName: c.identity.serverName,
          endpoint: c.endpoint,
          reason: 'conflicting certificate fingerprints for one server ID',
        })),
      };
    }
  }

  const connectable: DiscoveredHostCandidate[] = [];
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (candidate.state === 'resolved' && isPairingStatusConnectable(candidate.pairingStatus)) {
      connectable.push(candidate);
    } else {
      ruledOut.push({
        serverID: candidate.identity.serverID,
        serverName: candidate.identity.serverName,
        endpoint: candidate.endpoint,
        reason:
          candidate.pairingStatus === 'requiresRePairing'
            ? 'pinned fingerprint changed; requires re-pairing, not connectable'
            : `not connectable in state ${candidate.state}`,
      });
    }
  }

  const ruledOutFor = (serverID?: string): RuledOutCandidate[] =>
    serverID === undefined ? ruledOut : ruledOut.filter((r) => r.serverID === serverID);

  if (request.basis === 'explicit') {
    const serverID = request.serverID;
    if (typeof serverID !== 'string' || serverID.trim().length === 0) {
      return {
        status: 'rejected',
        code: 'explicit-selection-unknown',
        message: 'explicit selection must name a non-empty server ID',
        ruledOut,
      };
    }
    const group = byServerID.get(serverID);
    if (!group) {
      return {
        status: 'rejected',
        code: 'explicit-selection-unknown',
        message: `explicitly selected server ID ${JSON.stringify(serverID)} is not among the discovered hosts`,
        ruledOut,
      };
    }
    const groupConnectable = connectable.filter((c) => c.identity.serverID === serverID);
    if (groupConnectable.length === 0) {
      return {
        status: 'rejected',
        code: 'explicit-selection-not-connectable',
        message: `server ID ${JSON.stringify(serverID)} cannot be connected to right now: ${ruledOutFor(serverID)
          .map((r) => r.reason)
          .join('; ')}`,
        ruledOut,
      };
    }
    return selectFromGroup(groupConnectable, 'explicit-user-selection', ruledOut);
  }

  // Auto basis: deliberate, never a silent first-pick.
  if (connectable.length === 0) {
    return {
      status: 'rejected',
      code: 'no-connectable-host',
      message:
        ruledOut.length > 0
          ? `no connectable host: ${ruledOut.map((r) => `${r.serverName} — ${r.reason}`).join('; ')}`
          : 'no discovered hosts',
      ruledOut,
    };
  }
  const distinctServerIDs = new Set(connectable.map((c) => c.identity.serverID));
  if (distinctServerIDs.size > 1) {
    return {
      status: 'rejected',
      code: 'deliberate-selection-required',
      message: `${distinctServerIDs.size} distinct hosts are connectable; surface them and let the user choose — do not connect to ${JSON.stringify(
        [...distinctServerIDs].sort()[0],
      )} by default`,
      ruledOut,
      orderedConnectable: connectable,
    };
  }
  return selectFromGroup(connectable, undefined, ruledOut);
}

function selectFromGroup(
  group: readonly DiscoveredHostCandidate[],
  explicitBasis: SelectionBasis | undefined,
  ruledOut: readonly RuledOutCandidate[],
): HostSelection {
  const ordered = [...group].sort(compareCandidates);
  const primary = ordered[0];
  const alternates: DiscoveredHostCandidate[] = [];
  const seenEndpoints = new Set([endpointKey(primary.endpoint)]);
  for (const candidate of ordered.slice(1)) {
    const key = endpointKey(candidate.endpoint);
    if (!seenEndpoints.has(key)) {
      seenEndpoints.add(key);
      alternates.push(candidate);
    }
  }
  const basis: SelectionBasis = explicitBasis ?? (alternates.length > 0
    ? 'stable-ordering-tie-break'
    : 'sole-connectable-host');
  return {
    status: 'selected',
    host: primary,
    basis,
    alternates,
    ruledOut,
  };
}

// ---------------------------------------------------------------------------
// Pairing flow transitions
// ---------------------------------------------------------------------------

/**
 * Pairing flow state for one host. Extends the store's `PairingStatus` fact
 * with the in-flight states the connect flow passes through: `pairing` while
 * a first pairing is being negotiated and `re-pairing` while the user is
 * explicitly replacing a fingerprint that no longer matches.
 */
export type PairingFlowState =
  | 'unpaired'
  | 'pairing'
  | 'paired'
  | 'requiresRePairing'
  | 're-pairing';

export type PairingEventKind =
  | 'startPairing'
  | 'pairingSucceeded'
  | 'pairingFailed'
  | 'fingerprintChanged'
  | 'startRePairing'
  | 'rePairConfirmed'
  | 'rePairAbandoned'
  | 'hostForgotten';

export const PAIRING_FLOW_STATES: readonly PairingFlowState[] = [
  'unpaired',
  'pairing',
  'paired',
  'requiresRePairing',
  're-pairing',
];

export const PAIRING_EVENT_KINDS: readonly PairingEventKind[] = [
  'startPairing',
  'pairingSucceeded',
  'pairingFailed',
  'fingerprintChanged',
  'startRePairing',
  'rePairConfirmed',
  'rePairAbandoned',
  'hostForgotten',
];

/** The complete, exhaustive pairing transition table. */
export const PAIRING_TRANSITIONS: Readonly<
  Record<PairingFlowState, Readonly<Record<PairingEventKind, PairingFlowState | { reject: string }>>>
> = {
  unpaired: {
    startPairing: 'pairing',
    pairingSucceeded: { reject: 'pairing-not-in-progress' },
    pairingFailed: { reject: 'pairing-not-in-progress' },
    fingerprintChanged: { reject: 'no-pinned-fingerprint' },
    startRePairing: { reject: 'nothing-to-re-pair' },
    rePairConfirmed: { reject: 're-pairing-not-in-progress' },
    rePairAbandoned: { reject: 're-pairing-not-in-progress' },
    hostForgotten: 'unpaired',
  },
  pairing: {
    startPairing: { reject: 'pairing-already-in-progress' },
    pairingSucceeded: 'paired',
    pairingFailed: 'unpaired',
    fingerprintChanged: { reject: 'no-pinned-fingerprint' },
    startRePairing: { reject: 'nothing-to-re-pair' },
    rePairConfirmed: { reject: 're-pairing-not-in-progress' },
    rePairAbandoned: { reject: 're-pairing-not-in-progress' },
    hostForgotten: 'unpaired',
  },
  paired: {
    startPairing: { reject: 'already-paired' },
    pairingSucceeded: { reject: 'pairing-not-in-progress' },
    pairingFailed: { reject: 'pairing-not-in-progress' },
    fingerprintChanged: 'requiresRePairing',
    startRePairing: { reject: 're-pairing-follows-a-fingerprint-change' },
    rePairConfirmed: { reject: 're-pairing-not-in-progress' },
    rePairAbandoned: { reject: 're-pairing-not-in-progress' },
    hostForgotten: 'unpaired',
  },
  requiresRePairing: {
    startPairing: { reject: 'requires-re-pairing' },
    pairingSucceeded: { reject: 'pairing-not-in-progress' },
    pairingFailed: { reject: 'pairing-not-in-progress' },
    fingerprintChanged: { reject: 'already-requires-re-pairing' },
    startRePairing: 're-pairing',
    rePairConfirmed: { reject: 're-pairing-not-in-progress' },
    rePairAbandoned: { reject: 're-pairing-not-in-progress' },
    hostForgotten: 'unpaired',
  },
  're-pairing': {
    startPairing: { reject: 're-pairing-already-in-progress' },
    pairingSucceeded: { reject: 'confirm-the-new-fingerprint-explicitly' },
    pairingFailed: 'requiresRePairing',
    fingerprintChanged: { reject: 're-pairing-already-in-progress' },
    startRePairing: { reject: 're-pairing-already-in-progress' },
    rePairConfirmed: 'paired',
    rePairAbandoned: 'requiresRePairing',
    hostForgotten: 'unpaired',
  },
};

export type PairingEvent =
  | { kind: 'startPairing' }
  | { kind: 'pairingSucceeded' }
  | { kind: 'pairingFailed' }
  | { kind: 'fingerprintChanged' }
  | { kind: 'startRePairing' }
  | { kind: 'rePairConfirmed' }
  | { kind: 'rePairAbandoned' }
  | { kind: 'hostForgotten' };

export type PairingTransition =
  | { readonly ok: true; readonly state: PairingFlowState }
  | {
      readonly ok: false;
      readonly code: 'invalid-transition' | 'invalid-state' | 'invalid-event';
      readonly message: string;
    };

/**
 * Apply one pairing event to a pairing flow state. Every (state, event kind)
 * pair is defined in {@link PAIRING_TRANSITIONS}; a pair marked as rejected
 * produces a typed problem, never a silent state change. Notable rules:
 * `requiresRePairing` is only left by an explicit re-pair that the user
 * confirms (`rePairConfirmed` → paired) or by forgetting the host; a failed
 * re-pair returns to `requiresRePairing`, never silently back to `paired`.
 */
export function pairingTransition(
  state: PairingFlowState,
  event: PairingEvent,
): PairingTransition {
  if (!PAIRING_FLOW_STATES.includes(state)) {
    return {
      ok: false,
      code: 'invalid-state',
      message: `unknown pairing flow state ${JSON.stringify(state)}`,
    };
  }
  const table = PAIRING_TRANSITIONS[state];
  const outcome = table[event.kind];
  if (outcome === undefined) {
    return {
      ok: false,
      code: 'invalid-event',
      message: `unknown pairing event ${JSON.stringify((event as { kind?: unknown }).kind ?? null)}`,
    };
  }
  if (typeof outcome === 'string') {
    return { ok: true, state: outcome };
  }
  return {
    ok: false,
    code: 'invalid-transition',
    message: `event ${event.kind} is not valid while pairing state is ${state}: ${outcome.reject}`,
  };
}

/** The pairing flow state implied by a store-derived pairing status. */
export function pairingFlowStateForStatus(status: PairingStatus): PairingFlowState {
  return status;
}
