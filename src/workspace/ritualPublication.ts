import {
  getBuiltInRituals,
  getProjectDefaultRitualId,
  readProjectRitualStore,
  type RitualDefinition,
  type RitualStoreListing,
} from '../utils/rituals.js';
import type {
  PublishedRitual,
  RitualPublicationSnapshot,
} from './snapshot.js';

/**
 * How many rituals one project may publish to a remote client. The listing is
 * bounded so a directory with unbounded ritual files cannot inflate every
 * workspace snapshot; the cut is applied after dedupe and sorting so exactly
 * which rituals survive is deterministic.
 */
export const MAX_PUBLISHED_RITUALS = 50;

const SCOPE_ORDER: Record<PublishedRitual['scope'], number> = {
  builtIn: 0,
  project: 1,
};

export interface RitualPublicationDeps {
  /** Host-owned launch templates publishable from any project. */
  builtInRituals?: () => RitualDefinition[];
  /** Classified read of the project's own ritual store. */
  readStore?: (projectRoot: string) => RitualStoreListing;
  /** The project's recorded default ritual, used to detect a stale listing. */
  readDefaultRitualId?: (projectRoot: string) => string | undefined;
}

/**
 * Compose the bounded, sanitized ritual publication for one canonical project.
 *
 * The publication never contains a command, prompt, pane list, or project-root
 * path from the underlying definitions — those stay host-side and are resolved
 * by the authoritative launcher at execution time. Every failure the client
 * can observe is carried explicitly as the publication state instead of being
 * silently substituted with fixture-shaped success:
 *
 * - `available` — the store was read faithfully and produced rituals.
 * - `empty` — the store was read faithfully and defines nothing publishable.
 * - `unavailable` — the store could not be read (or the host has no store
 *   reader wired); host-owned built-ins are still listed.
 * - `stale` — the project's own manifest references a ritual the listing no
 *   longer contains, so the listing cannot be trusted as current.
 * - `incompatible` — at least one stored entry does not satisfy the supported
 *   ritual shape; the compatible entries are still listed.
 * - `permission-denied` — the host may not read the project's store;
 *   host-owned built-ins are still listed.
 */
export function readProjectRitualPublication(
  projectRoot: string,
  deps: RitualPublicationDeps = {},
): RitualPublicationSnapshot {
  const builtInRituals = deps.builtInRituals ?? getBuiltInRituals;
  const readStore = deps.readStore ?? readProjectRitualStore;
  const readDefaultRitualId = deps.readDefaultRitualId ?? getProjectDefaultRitualId;

  return buildRitualPublication({
    builtIns: builtInRituals(),
    store: readStore(projectRoot),
    defaultRitualId: readDefaultRitualId(projectRoot),
  });
}

/**
 * Pure classifier over already-read inputs. Exported so the daemon snapshot
 * builder can compose the same publication from its own dependency seams
 * without re-reading the store.
 */
export function buildRitualPublication(input: {
  builtIns: readonly RitualDefinition[];
  store: Pick<RitualStoreListing, 'rituals' | 'incompatibleCount' | 'denied' | 'failed'>;
  defaultRitualId?: string | undefined;
}): RitualPublicationSnapshot {
  // A project ritual may shadow a built-in by id — mirror listAvailableRituals
  // precedence so what the client sees matches what a launch would run.
  const ritualsById = new Map<string, { ritual: RitualDefinition; scope: PublishedRitual['scope'] }>();
  for (const ritual of input.builtIns) {
    ritualsById.set(ritual.id, { ritual, scope: 'builtIn' });
  }
  for (const ritual of input.store.rituals) {
    ritualsById.set(ritual.id, { ritual, scope: 'project' });
  }

  const rituals = [...ritualsById.values()]
    .sort(comparePublished)
    .slice(0, MAX_PUBLISHED_RITUALS)
    .map(({ ritual, scope }): PublishedRitual => ({
      id: ritual.id,
      displayName: ritual.name,
      ...(ritual.description ? { description: ritual.description } : {}),
      scope,
    }));

  const state = publicationState({
    denied: input.store.denied,
    failed: input.store.failed,
    incompatibleCount: input.store.incompatibleCount,
    publishedIds: new Set(rituals.map((ritual) => ritual.id)),
    defaultRitualId: input.defaultRitualId,
  });

  return { state, rituals };
}

/**
 * Failure states win over healthy ones so a client never renders a masked
 * listing as trustworthy, and the most restrictive failure wins when several
 * apply.
 */
function publicationState(input: {
  denied: boolean;
  failed: boolean;
  incompatibleCount: number;
  publishedIds: ReadonlySet<string>;
  defaultRitualId: string | undefined;
}): RitualPublicationSnapshot['state'] {
  if (input.denied) return 'permission-denied';
  if (input.failed) return 'unavailable';
  if (input.incompatibleCount > 0) return 'incompatible';
  if (
    input.defaultRitualId
    && !input.publishedIds.has(input.defaultRitualId)
  ) {
    return 'stale';
  }
  return input.publishedIds.size > 0 ? 'available' : 'empty';
}

function comparePublished(
  left: { ritual: RitualDefinition; scope: PublishedRitual['scope'] },
  right: { ritual: RitualDefinition; scope: PublishedRitual['scope'] },
): number {
  const scopeDifference = SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope];
  if (scopeDifference) return scopeDifference;
  return compareStrings(left.ritual.id, right.ritual.id)
    || compareStrings(left.ritual.name, right.ritual.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
