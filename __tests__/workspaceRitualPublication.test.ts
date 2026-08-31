import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildRitualPublication,
  MAX_PUBLISHED_RITUALS,
  readProjectRitualPublication,
} from '../src/workspace/ritualPublication.js';
import { readProjectRitualStore, type RitualDefinition } from '../src/utils/rituals.js';
import type { RitualStoreListing } from '../src/utils/rituals.js';

describe('ritual publication', () => {
  describe('buildRitualPublication state classification', () => {
    it('publishes built-in and project rituals as available and sanitized', () => {
      const publication = buildRitualPublication({
        builtIns: [ritual({ id: 'start-coding', name: 'Start Coding', scope: 'builtin' })],
        store: listing({
          rituals: [ritual({
            id: 'release-checklist',
            name: 'Release checklist',
            description: 'Prepare a release safely.',
            scope: 'project',
            panes: [{ kind: 'terminal', command: 'npm publish' }],
          })],
        }),
      });

      expect(publication.state).toBe('available');
      expect(publication.rituals).toEqual([
        { id: 'start-coding', displayName: 'Start Coding', scope: 'builtIn' },
        {
          id: 'release-checklist',
          displayName: 'Release checklist',
          description: 'Prepare a release safely.',
          scope: 'project',
        },
      ]);

      // The publication must not carry launch mechanics or unrestricted paths.
      const serialized = JSON.stringify(publication);
      expect(serialized).not.toContain('"command"');
      expect(serialized).not.toContain('"prompt"');
      expect(serialized).not.toContain('"projectRoot"');
      expect(serialized).not.toContain('"projects"');
    });

    it('reports empty when the store reads faithfully and defines nothing publishable', () => {
      const publication = buildRitualPublication({ builtIns: [], store: listing() });
      expect(publication.state).toBe('empty');
      expect(publication.rituals).toEqual([]);
    });

    it('reports unavailable when the store read failed but still lists built-ins', () => {
      const publication = buildRitualPublication({
        builtIns: [ritual({ id: 'start-coding', name: 'Start Coding', scope: 'builtin' })],
        store: listing({ failed: true }),
      });
      expect(publication.state).toBe('unavailable');
      expect(publication.rituals.map((ritual) => ritual.id)).toEqual(['start-coding']);
    });

    it('reports permission-denied when the host may not read the store', () => {
      const publication = buildRitualPublication({
        builtIns: [ritual({ id: 'start-coding', name: 'Start Coding', scope: 'builtin' })],
        store: listing({ denied: true }),
      });
      expect(publication.state).toBe('permission-denied');
      expect(publication.rituals.map((ritual) => ritual.id)).toEqual(['start-coding']);
    });

    it('reports incompatible when an entry does not satisfy the supported shape', () => {
      const publication = buildRitualPublication({
        builtIns: [],
        store: listing({
          rituals: [ritual({ id: 'kept', name: 'Kept', scope: 'project' })],
          incompatibleCount: 2,
        }),
      });
      expect(publication.state).toBe('incompatible');
      expect(publication.rituals.map((ritual) => ritual.id)).toEqual(['kept']);
    });

    it('reports stale when the recorded default ritual is missing from the listing', () => {
      const publication = buildRitualPublication({
        builtIns: [],
        store: listing({
          rituals: [ritual({ id: 'current', name: 'Current', scope: 'project' })],
        }),
        defaultRitualId: 'deleted-ritual',
      });
      expect(publication.state).toBe('stale');
      expect(publication.rituals).toHaveLength(1);
    });

    it('does not report stale when the default ritual is still published', () => {
      const publication = buildRitualPublication({
        builtIns: [],
        store: listing({
          rituals: [ritual({ id: 'current', name: 'Current', scope: 'project' })],
        }),
        defaultRitualId: 'current',
      });
      expect(publication.state).toBe('available');
    });

    it('lets the most restrictive failure state win', () => {
      const denied = buildRitualPublication({
        builtIns: [],
        store: listing({ denied: true, failed: true, incompatibleCount: 3 }),
      });
      expect(denied.state).toBe('permission-denied');

      const unavailable = buildRitualPublication({
        builtIns: [],
        store: listing({ failed: true, incompatibleCount: 3 }),
      });
      expect(unavailable.state).toBe('unavailable');
    });
  });

  describe('bounded deterministic listing', () => {
    it('caps the published listing and cuts it deterministically', () => {
      const builtIns = Array.from({ length: 10 }, (_, index) => ritual({
        id: `built-in-${String(index).padStart(2, '0')}`,
        name: `Built in ${index}`,
        scope: 'builtin',
      }));
      const projectRituals = Array.from({ length: MAX_PUBLISHED_RITUALS + 20 }, (_, index) => ritual({
        id: `project-${String(index).padStart(3, '0')}`,
        name: `Project ${index}`,
        scope: 'project',
      }));

      const publication = buildRitualPublication({
        builtIns,
        store: listing({ rituals: projectRituals }),
      });

      expect(publication.rituals).toHaveLength(MAX_PUBLISHED_RITUALS);
      // built-ins sort before project rituals, then by id — so the cut is
      // stable across reads and clients observe identical listings.
      expect(publication.rituals[0]!.id).toBe('built-in-00');
      expect(publication.rituals[9]!.id).toBe('built-in-09');
      expect(publication.rituals[10]!.id).toBe('project-000');
      expect(publication.rituals.at(-1)!.id).toBe('project-039');
    });

    it('lets a project ritual shadow a built-in sharing its id', () => {
      const publication = buildRitualPublication({
        builtIns: [ritual({ id: 'shared', name: 'Built in', scope: 'builtin' })],
        store: listing({
          rituals: [ritual({ id: 'shared', name: 'Project override', scope: 'project' })],
        }),
      });

      expect(publication.rituals).toEqual([{
        id: 'shared',
        displayName: 'Project override',
        scope: 'project',
      }]);
    });
  });

  describe('readProjectRitualPublication', () => {
    it('composes the publication from the real store reader by default', () => {
      const root = tempProjectWithRituals();
      try {
        const publication = readProjectRitualPublication(root);
        expect(publication.state).toBe('available');
        expect(publication.rituals.some((ritual) => ritual.id === 'project-standup')).toBe(true);
        // Host built-ins are always advertised.
        expect(publication.rituals.some((ritual) => ritual.scope === 'builtIn')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('publishes permission-denied when an existing ritual store is inaccessible', () => {
      const root = tempProjectWithRituals();
      const psycheDir = path.join(root, '.psyche');
      try {
        chmodSync(psycheDir, 0o000);
        const publication = readProjectRitualPublication(root);
        expect(publication.state).toBe('permission-denied');
        expect(publication.rituals.every((ritual) => ritual.scope === 'builtIn')).toBe(true);
      } finally {
        chmodSync(psycheDir, 0o755);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('propagates reader failures to the provider degradation seam', () => {
      expect(() => readProjectRitualPublication('/repo', {
        builtInRituals: () => [],
        readStore: () => {
          throw new Error('reader exploded');
        },
        readDefaultRitualId: () => undefined,
      })).toThrow('reader exploded');
    });
  });

  describe('readProjectRitualStore', () => {
    it('classifies an absent store as an empty faithful read', () => {
      const listing = readProjectRitualStore(path.join(tmpdir(), `psyche-absent-${Date.now()}`));
      expect(listing).toEqual({ rituals: [], incompatibleCount: 0, denied: false, failed: false });
    });

    it('reads valid rituals and counts malformed entries as incompatible', () => {
      const root = tempProjectWithRituals();
      try {
        writeFileSync(path.join(root, '.psyche', 'rituals', 'broken.json'), '{ not json', 'utf-8');
        const listing = readProjectRitualStore(root);
        expect(listing.rituals.map((ritual) => ritual.id)).toEqual(['project-standup']);
        expect(listing.incompatibleCount).toBe(1);
        expect(listing.denied).toBe(false);
        expect(listing.failed).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('reports denied when the store directory is unreadable', () => {
      const root = tempProjectWithRituals();
      try {
        chmodSync(path.join(root, '.psyche', 'rituals'), 0o000);
        const listing = readProjectRitualStore(root);
        expect(listing.denied).toBe(true);
        expect(listing.failed).toBe(false);
      } finally {
        chmodSync(path.join(root, '.psyche', 'rituals'), 0o755);
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

function ritual(overrides: {
  id: string;
  name: string;
  scope: 'builtin' | 'project';
  description?: string;
  panes?: Array<{ kind: 'terminal' | 'agent'; command?: string; prompt?: string }>;
}): RitualDefinition {
  return {
    version: 1,
    id: overrides.id,
    name: overrides.name,
    scope: overrides.scope,
    projects: [{
      panes: overrides.panes ?? [{ kind: 'terminal' }],
    }],
    ...(overrides.description ? { description: overrides.description } : {}),
  };
}

function listing(
  overrides: Partial<RitualStoreListing> = {},
): RitualStoreListing {
  return {
    rituals: [],
    incompatibleCount: 0,
    denied: false,
    failed: false,
    ...overrides,
  };
}

function tempProjectWithRituals(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'psyche-ritual-publication-'));
  const ritualsDir = path.join(root, '.psyche', 'rituals');
  mkdirSync(ritualsDir, { recursive: true });
  writeFileSync(
    path.join(ritualsDir, 'project-standup.json'),
    `${JSON.stringify(ritual({
      id: 'project-standup',
      name: 'Project standup',
      scope: 'project',
      description: 'Open the daily standup panes.',
    }))}\n`,
    'utf-8',
  );
  return root;
}
