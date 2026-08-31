import {
  getBuiltInRituals,
  MAX_PUBLISHED_RITUAL_DESCRIPTION_BYTES,
  MAX_PUBLISHED_RITUAL_ID_BYTES,
  MAX_PUBLISHED_RITUAL_NAME_BYTES,
  readProjectRitualManifest,
  readProjectRitualStore,
  type RitualDefinition,
  type RitualManifestListing,
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
  /** Classified read of the project's default ritual manifest. */
  readManifest?: (projectRoot: string) => RitualManifestListing;
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
 * - `limit-exceeded` — the store or a publishable metadata field exceeded a
 *   bounded resource limit; entries within the limits may still be listed.
 * - `permission-denied` — the host may not read the project's store;
 *   host-owned built-ins are still listed.
 */
export function readProjectRitualPublication(
  projectRoot: string,
  deps: RitualPublicationDeps = {},
): RitualPublicationSnapshot {
  const builtInRituals = deps.builtInRituals ?? getBuiltInRituals;
  const readStore = deps.readStore ?? readProjectRitualStore;
  const readManifest = deps.readManifest ?? readProjectRitualManifest;

  return buildRitualPublication({
    builtIns: builtInRituals(),
    store: readStore(projectRoot),
    manifest: readManifest(projectRoot),
  });
}

/**
 * Pure classifier over already-read inputs. Exported so the daemon snapshot
 * builder can compose the same publication from its own dependency seams
 * without re-reading the store.
 */
export function buildRitualPublication(input: {
  builtIns: readonly RitualDefinition[];
  store: Pick<
    RitualStoreListing,
    'rituals' | 'incompatibleCount' | 'denied' | 'failed' | 'limitExceeded'
  >;
  manifest?: Pick<
    RitualManifestListing,
    'defaultRitualId' | 'denied' | 'failed' | 'incompatible' | 'limitExceeded'
  >;
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

  let limitExceeded = input.store.limitExceeded;
  const publishableRituals = [...ritualsById.values()].filter(({ ritual }) => {
    const publishable = isBoundedPublishedRitual(ritual);
    limitExceeded ||= !publishable;
    return publishable;
  });
  const sortedRituals = publishableRituals.sort(comparePublished);
  if (sortedRituals.length > MAX_PUBLISHED_RITUALS) {
    limitExceeded = true;
  }
  const rituals = sortedRituals
    .slice(0, MAX_PUBLISHED_RITUALS)
    .map(({ ritual, scope }): PublishedRitual => ({
      id: ritual.id,
      displayName: ritual.name,
      ...(ritual.description ? { description: ritual.description } : {}),
      scope,
    }));

  const state = publicationState({
    denied: input.store.denied || input.manifest?.denied === true,
    failed: input.store.failed || input.manifest?.failed === true,
    limitExceeded: limitExceeded || input.manifest?.limitExceeded === true,
    incompatible: input.store.incompatibleCount > 0 || input.manifest?.incompatible === true,
    publishedIds: new Set(rituals.map((ritual) => ritual.id)),
    defaultRitualId: input.manifest?.defaultRitualId ?? input.defaultRitualId,
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
  limitExceeded: boolean;
  incompatible: boolean;
  publishedIds: ReadonlySet<string>;
  defaultRitualId: string | undefined;
}): RitualPublicationSnapshot['state'] {
  if (input.denied) return 'permission-denied';
  if (input.limitExceeded) return 'limit-exceeded';
  if (input.failed) return 'unavailable';
  if (input.incompatible) return 'incompatible';
  if (
    input.defaultRitualId
    && !input.publishedIds.has(input.defaultRitualId)
  ) {
    return 'stale';
  }
  return input.publishedIds.size > 0 ? 'available' : 'empty';
}

function isBoundedPublishedRitual(ritual: RitualDefinition): boolean {
  return isBoundedUtf8(ritual.id, MAX_PUBLISHED_RITUAL_ID_BYTES)
    && isBoundedUtf8(ritual.name, MAX_PUBLISHED_RITUAL_NAME_BYTES)
    && (
      ritual.description === undefined
      || isBoundedUtf8(ritual.description, MAX_PUBLISHED_RITUAL_DESCRIPTION_BYTES)
    );
}

function isBoundedUtf8(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
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
