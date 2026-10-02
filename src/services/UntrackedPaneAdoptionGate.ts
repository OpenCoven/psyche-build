/**
 * Decides which untracked tmux panes the cockpit may try to adopt as shell
 * panes this polling cycle.
 *
 * Untracked-pane detection runs on every poll. Without this gate it treated
 * every pane missing from the pane registry as a stranger, which went wrong in
 * two ways:
 *
 *   - #516: a pane orphaned by a crash between split and record save was
 *     re-adopted on every cycle. Each failed attempt wrote another quarantine
 *     record and another recovery marker for the same tmux pane.
 *   - #517: a pane the cockpit was itself creating was seen after its split
 *     and before its record was saved, adopted, and quarantined as an
 *     adoption failure although its own transaction then saved it.
 *
 * The pane-slug ownership namespace already holds the durable answer to "is
 * someone accounting for this pane?", so the gate reads it rather than adding
 * new state. It reconciles stale reservations first, so a crashed creation's
 * reservation becomes its one quarantine and recovery marker before any
 * adoption decision. Then:
 *
 *   - a pane named by a quarantined record has been reported; it is not
 *     adopted again until an operator acknowledges that record (which removes
 *     it) and a later cycle decides afresh;
 *   - a pane named by a stale provisional record that reconciliation could
 *     not settle stays excluded, because reconciliation keeps rewriting that
 *     record's single deterministic marker;
 *   - a pane named by a live owner's provisional record belongs to a creation
 *     in flight and is excluded;
 *   - a live owner's provisional record with no pane bound yet may be between
 *     its split and binding the pane ID, so the whole cycle is deferred;
 *   - a live owner's record older than {@link IN_FLIGHT_PANE_CREATION_TTL_MS}
 *     is treated as abandoned and no longer excludes or defers anything.
 *
 * The gate never writes a marker itself and never hides a pane permanently:
 * everything it excludes is either already reported or bounded by the TTL.
 */

import {
  isPaneSlugOwnerStale,
  readPaneSlugOwnershipRecords,
  type PaneSlugOwnershipRecord,
  type PaneSlugRegistryOwnerProbe,
} from './PaneSlugRegistry.js';
import { reconcileStalePaneSlugReservations } from './PaneSlugReservation.js';
import type { ProjectPaneConfigLockOptions } from './ProjectPaneConfig.js';
import {
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from './TmuxServerIdentity.js';
import type { TmuxPanePresence } from '../utils/paneTeardown.js';

/**
 * How long a live owner's reservation shields its pane from adoption. A pane
 * creation takes seconds; a reservation this old belongs to a creation that
 * hung or leaked, and must not hide its pane indefinitely.
 */
export const IN_FLIGHT_PANE_CREATION_TTL_MS = 5 * 60_000;

export type UntrackedPaneExclusionReason =
  | 'recovery-quarantined'
  | 'recovery-pending'
  | 'creation-in-flight';

export interface UntrackedPaneExclusion {
  paneId: string;
  reason: UntrackedPaneExclusionReason;
  recoveryId: string;
}

export interface UntrackedPaneAdoptionDecision<T extends { paneId: string }> {
  adoptable: T[];
  excluded: UntrackedPaneExclusion[];
  /** Set when a live creation may own any pane, so none is adopted this cycle. */
  deferred?: { reason: 'creation-in-flight'; recoveryId: string };
}

export interface UntrackedPaneAdoptionOptions {
  ownerProbe?: PaneSlugRegistryOwnerProbe;
  probePane?: (paneId: string) => Promise<TmuxPanePresence>;
  lockOptions?: ProjectPaneConfigLockOptions;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
  inFlightTtlMs?: number;
  /** The current tmux server generation for a pane, when it can be read. */
  serverIdentityOf?: (paneId: string) => TmuxServerIdentity | undefined;
}

export async function gateUntrackedPaneAdoption<T extends { paneId: string }>(
  sessionProjectRoot: string,
  panes: readonly T[],
  options: UntrackedPaneAdoptionOptions = {},
): Promise<UntrackedPaneAdoptionDecision<T>> {
  if (panes.length === 0) {
    return { adoptable: [], excluded: [] };
  }
  // Throws on an ownership record this version cannot read, exactly as the
  // adoption reservation would: adoption fails closed rather than allocating
  // against a partial view.
  await reconcileStalePaneSlugReservations({
    sessionProjectRoot,
    probePane: options.probePane,
    ownerProbe: options.ownerProbe,
    lockOptions: options.lockOptions,
  });
  const listing = await readPaneSlugOwnershipRecords(sessionProjectRoot);
  return decideUntrackedPaneAdoption(panes, listing.records, options);
}

export function decideUntrackedPaneAdoption<T extends { paneId: string }>(
  panes: readonly T[],
  records: readonly PaneSlugOwnershipRecord[],
  options: UntrackedPaneAdoptionOptions = {},
): UntrackedPaneAdoptionDecision<T> {
  const now = (options.now ?? Date.now)();
  const ttl = options.inFlightTtlMs ?? IN_FLIGHT_PANE_CREATION_TTL_MS;
  const claims = new Map<string, Array<{
    record: PaneSlugOwnershipRecord;
    reason: UntrackedPaneExclusionReason;
  }>>();
  let deferred: UntrackedPaneAdoptionDecision<T>['deferred'];

  for (const record of records) {
    let reason: UntrackedPaneExclusionReason;
    if (record.state === 'quarantined') {
      reason = 'recovery-quarantined';
    } else if (isPaneSlugOwnerStale(record, options.ownerProbe)) {
      reason = 'recovery-pending';
    } else {
      const started = Date.parse(record.createdAt);
      if (!Number.isFinite(started) || now - started >= ttl) {
        continue;
      }
      reason = 'creation-in-flight';
      if (!record.pane.paneId) {
        deferred ??= { reason: 'creation-in-flight', recoveryId: record.recoveryId };
        continue;
      }
    }
    const paneId = record.pane.paneId;
    if (!paneId) {
      continue;
    }
    const existing = claims.get(paneId) ?? [];
    existing.push({ record, reason });
    claims.set(paneId, existing);
  }

  if (deferred) {
    return { adoptable: [], excluded: [], deferred };
  }

  const adoptable: T[] = [];
  const excluded: UntrackedPaneExclusion[] = [];
  for (const pane of panes) {
    const claim = (claims.get(pane.paneId) ?? []).find(({ record }) => (
      sameServerOrUnknown(record, pane.paneId, options.serverIdentityOf)
    ));
    if (claim) {
      excluded.push({
        paneId: pane.paneId,
        reason: claim.reason,
        recoveryId: claim.record.recoveryId,
      });
    } else {
      adoptable.push(pane);
    }
  }
  return { adoptable, excluded };
}

/**
 * A tmux pane ID is only meaningful on one server generation. A record bound
 * on a different, known generation describes some other pane. When either
 * side is unknown — quarantined records do not carry the generation — the
 * record is honoured, which keeps a reported pane from being re-adopted.
 */
function sameServerOrUnknown(
  record: PaneSlugOwnershipRecord,
  paneId: string,
  serverIdentityOf: UntrackedPaneAdoptionOptions['serverIdentityOf'],
): boolean {
  const recorded = record.pane.tmuxServerIdentity;
  if (!recorded || !serverIdentityOf) {
    return true;
  }
  let current: TmuxServerIdentity | undefined;
  try {
    current = serverIdentityOf(paneId);
  } catch {
    current = undefined;
  }
  return !current || sameTmuxServerIdentity(recorded, current);
}
