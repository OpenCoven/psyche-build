import type { PsychePane } from '../types.js';
import {
  isTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from './TmuxServerIdentity.js';
import type { FullPaneTeardownTarget } from '../utils/paneTeardown.js';

export type TmuxResourceKind = 'pane' | 'window';

export interface TmuxResource {
  kind: TmuxResourceKind;
  id: string;
  generation?: TmuxServerIdentity;
  field: string;
}

export type TmuxTeardownOwnership =
  | 'verified'
  | 'legacy'
  | 'stale-generation'
  | 'unverified-generation'
  | 'ambiguous';

export interface TmuxTeardownAssessment {
  ownership: TmuxTeardownOwnership;
  target: FullPaneTeardownTarget;
}

type PaneRecord = Pick<PsychePane, 'id'> & Record<string, unknown>;

export interface TmuxResourceConflict {
  resource: TmuxResource;
  firstOwnerId: string;
  secondOwnerId: string;
}

/**
 * Returns all tmux resources persisted by one pane. Background records carry
 * their own generation because a restart/reused pane ID must never inherit
 * authority from the primary pane's old generation.
 */
export function tmuxResourcesForPane(pane: PaneRecord): TmuxResource[] {
  const primaryGeneration = tmuxGeneration(pane.tmuxServerIdentity);
  const resources: TmuxResource[] = [];
  addResource(resources, 'pane', pane.paneId, primaryGeneration, 'paneId');
  addResource(
    resources,
    'pane',
    pane.testPaneId,
    tmuxGeneration(pane.testTmuxServerIdentity),
    'testPaneId',
  );
  addResource(
    resources,
    'window',
    pane.testWindowId,
    tmuxGeneration(pane.testTmuxServerIdentity),
    'testWindowId',
  );
  addResource(
    resources,
    'pane',
    pane.devPaneId,
    tmuxGeneration(pane.devTmuxServerIdentity),
    'devPaneId',
  );
  addResource(
    resources,
    'window',
    pane.devWindowId,
    tmuxGeneration(pane.devTmuxServerIdentity),
    'devWindowId',
  );

  if (Array.isArray(pane.backgroundWindowRecoveries)) {
    for (const recovery of pane.backgroundWindowRecoveries) {
      if (!recovery || typeof recovery !== 'object') {
        continue;
      }
      const record = recovery as Record<string, unknown>;
      const generation = tmuxGeneration(record.tmuxServerIdentity);
      addResource(
        resources,
        'window',
        record.windowId,
        generation,
        'backgroundWindowRecoveries.windowId',
      );
      addResource(
        resources,
        'pane',
        record.paneId,
        generation,
        'backgroundWindowRecoveries.paneId',
      );
    }
  }
  return resources;
}

export function findTmuxResourceConflict(
  panes: readonly PaneRecord[] | undefined,
): TmuxResourceConflict | undefined {
  if (!panes) {
    return undefined;
  }
  const seen = new Map<string, Array<{ ownerId: string; resource: TmuxResource }>>();
  for (const pane of panes) {
    if (!pane || typeof pane.id !== 'string' || !pane.id) {
      continue;
    }
    for (const resource of tmuxResourcesForPane(pane)) {
      const key = `${resource.kind}\0${resource.id}`;
      const previous = seen.get(key) || [];
      for (const prior of previous) {
        if (
          prior.ownerId !== pane.id
          && sameGeneration(prior.resource.generation, resource.generation)
        ) {
          return {
            resource,
            firstOwnerId: prior.ownerId,
            secondOwnerId: pane.id,
          };
        }
      }
      previous.push({ ownerId: pane.id, resource });
      seen.set(key, previous);
    }
  }
  return undefined;
}

/**
 * The claim path runs under the config lease after a new tmux resource exists
 * but before it is persisted or receives a command. Only records with a
 * captured matching generation participate; legacy records retain their
 * compatibility behavior until they are rebound under a live server.
 */
export function assertTmuxResourcesAvailable(
  panes: readonly PaneRecord[] | undefined,
  ownerId: string,
  resources: readonly TmuxResource[],
): void {
  if (!panes) {
    return;
  }
  for (const pane of panes) {
    if (!pane || typeof pane.id !== 'string' || !pane.id) {
      continue;
    }
    for (const existing of tmuxResourcesForPane(pane)) {
      for (const requested of resources) {
        if (
          existing.kind !== requested.kind
          || existing.id !== requested.id
          || (
            pane.id === ownerId
            && existing.field === requested.field
          )
        ) {
          continue;
        }
        if (sameGeneration(existing.generation, requested.generation)) {
          throw new Error(
            `Tmux ${requested.kind} "${requested.id}" is already owned by pane "${pane.id}" in this server generation`,
          );
        }
      }
    }
  }
}

/**
 * A destructive caller must run this while holding the config lock. A stale
 * generation is safe to treat as absent because the caller will exact-CAS
 * remove that old record; an unknown or duplicate current ownership is not.
 */
export function assessTmuxTeardownOwnership(
  pane: PaneRecord,
  allPanes: readonly PaneRecord[],
  currentGeneration: TmuxServerIdentity | undefined,
): TmuxTeardownAssessment {
  const resources = tmuxResourcesForPane(pane);
  const generations = resources.map((resource) => resource.generation);
  // Any resource without a generation is a legacy identity. A record with a
  // partially-versioned background resource is still unsafe to kill: its
  // unversioned primary/background ID could have been reused by another
  // server. Callers may remove it only after a non-destructive absence probe.
  if (generations.some((generation) => !generation)) {
    return {
      ownership: 'legacy',
      target: fullPaneTarget(pane),
    };
  }
  if (!currentGeneration) {
    return {
      ownership: 'unverified-generation',
      target: {},
    };
  }

  const currentResources = resources.filter((resource) => (
    resource.generation
    && sameTmuxServerIdentity(resource.generation, currentGeneration)
  ));
  for (const candidate of allPanes) {
    if (!candidate || candidate === pane || candidate.id === pane.id) {
      continue;
    }
    for (const owned of currentResources) {
      for (const competing of tmuxResourcesForPane(candidate)) {
        if (owned.kind !== competing.kind || owned.id !== competing.id) {
          continue;
        }
        if (
          !competing.generation
          || sameTmuxServerIdentity(competing.generation, currentGeneration)
        ) {
          return {
            ownership: 'ambiguous',
            target: {},
          };
        }
      }
    }
  }
  if (currentResources.length === 0) {
    return {
      ownership: 'stale-generation',
      target: {},
    };
  }
  return {
    ownership: 'verified',
    target: teardownTargetForResources(currentResources),
  };
}

function fullPaneTarget(pane: PaneRecord): FullPaneTeardownTarget {
  const target: FullPaneTeardownTarget = {};
  for (const resource of tmuxResourcesForPane(pane)) {
    addResourceToTarget(target, resource);
  }
  return target;
}

function teardownTargetForResources(
  resources: readonly TmuxResource[],
): FullPaneTeardownTarget {
  const target: FullPaneTeardownTarget = {};
  for (const resource of resources) {
    addResourceToTarget(target, resource);
  }
  return target;
}

function addResourceToTarget(
  target: FullPaneTeardownTarget,
  resource: TmuxResource,
): void {
  if (
    resource.field === 'paneId'
    || resource.field === 'testPaneId'
    || resource.field === 'testWindowId'
    || resource.field === 'devPaneId'
    || resource.field === 'devWindowId'
  ) {
    target[resource.field] = resource.id;
    return;
  }
  if (resource.kind === 'pane') {
    target.additionalPaneIds = [
      ...(target.additionalPaneIds || []),
      resource.id,
    ];
  } else {
    target.additionalWindowIds = [
      ...(target.additionalWindowIds || []),
      resource.id,
    ];
  }
}

function addResource(
  resources: TmuxResource[],
  kind: TmuxResourceKind,
  value: unknown,
  generation: TmuxServerIdentity | undefined,
  field: string,
): void {
  if (typeof value === 'string' && value.length > 0) {
    resources.push({ kind, id: value, ...(generation ? { generation } : {}), field });
  }
}

function tmuxGeneration(value: unknown): TmuxServerIdentity | undefined {
  return isTmuxServerIdentity(value) ? value : undefined;
}

function sameGeneration(
  left: TmuxServerIdentity | undefined,
  right: TmuxServerIdentity | undefined,
): boolean {
  return Boolean(left && right && sameTmuxServerIdentity(left, right));
}
