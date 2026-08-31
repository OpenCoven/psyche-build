import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildRitualPublication,
  MAX_PUBLISHED_RITUALS,
  readProjectRitualPublication,
} from '../src/workspace/ritualPublication.js';
import {
  MAX_PROJECT_RITUAL_FILES,
  MAX_PROJECT_RITUAL_FILE_BYTES,
  MAX_PROJECT_RITUAL_STORE_BYTES,
  MAX_PUBLISHED_RITUAL_DESCRIPTION_BYTES,
  MAX_PUBLISHED_RITUAL_ID_BYTES,
  MAX_PUBLISHED_RITUAL_NAME_BYTES,
  readProjectRitualManifest,
  readProjectRitualStore,
  type RitualDefinition,
} from '../src/utils/rituals.js';
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

      const limited = buildRitualPublication({
        builtIns: [],
        store: listing({ failed: true, limitExceeded: true }),
      });
      expect(limited.state).toBe('limit-exceeded');
    });

    it('reports limit-exceeded and omits rituals with oversized published fields', () => {
      const publication = buildRitualPublication({
        builtIns: [],
        store: listing({
          rituals: [
            ritual({ id: 'kept', name: 'Kept', scope: 'project' }),
            ritual({
              id: 'i'.repeat(MAX_PUBLISHED_RITUAL_ID_BYTES + 1),
              name: 'Oversized id',
              scope: 'project',
            }),
            ritual({
              id: 'oversized-name',
              name: 'é'.repeat(Math.floor(MAX_PUBLISHED_RITUAL_NAME_BYTES / 2) + 1),
              scope: 'project',
            }),
            ritual({
              id: 'oversized-description',
              name: 'Oversized description',
              description: '🙂'.repeat(Math.floor(MAX_PUBLISHED_RITUAL_DESCRIPTION_BYTES / 4) + 1),
              scope: 'project',
            }),
          ],
        }),
      });

      expect(publication.state).toBe('limit-exceeded');
      expect(publication.rituals).toEqual([{
        id: 'kept',
        displayName: 'Kept',
        scope: 'project',
      }]);
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
      expect(publication.state).toBe('limit-exceeded');
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

    it('publishes permission-denied when the default ritual manifest is unreadable', () => {
      const root = tempProjectWithRituals();
      const manifestPath = path.join(root, '.psyche', 'rituals.json');
      try {
        writeFileSync(manifestPath, JSON.stringify({
          version: 1,
          defaultRitualId: 'project-standup',
        }), 'utf-8');
        chmodSync(manifestPath, 0o000);

        expect(readProjectRitualPublication(root).state).toBe('permission-denied');
      } finally {
        chmodSync(manifestPath, 0o644);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('publishes incompatible when the default ritual manifest is malformed', () => {
      const root = tempProjectWithRituals();
      try {
        writeFileSync(path.join(root, '.psyche', 'rituals.json'), '{ not json', 'utf-8');
        expect(readProjectRitualPublication(root).state).toBe('incompatible');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects a default ritual manifest through a symlinked .psyche directory', () => {
      const root = tempProject();
      const external = tempProjectWithRituals();
      try {
        writeFileSync(path.join(external, '.psyche', 'rituals.json'), JSON.stringify({
          version: 1,
          defaultRitualId: 'project-standup',
        }), 'utf-8');
        symlinkDirectory(path.join(external, '.psyche'), path.join(root, '.psyche'));

        const manifest = readProjectRitualManifest(root);
        expect(manifest.incompatible).toBe(true);
        expect(manifest.defaultRitualId).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it('rejects a FIFO default ritual manifest without blocking', () => {
      if (process.platform === 'win32') return;
      const root = tempProjectWithRituals();
      try {
        execFileSync('mkfifo', [path.join(root, '.psyche', 'rituals.json')]);
        const publication = readRitualPublicationInChild(root);
        expect(publication.state).toBe('incompatible');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('propagates reader failures to the provider degradation seam', () => {
      expect(() => readProjectRitualPublication('/repo', {
        builtInRituals: () => [],
        readStore: () => {
          throw new Error('reader exploded');
        },
        readManifest: () => manifestListing(),
      })).toThrow('reader exploded');
    });
  });

  describe('readProjectRitualStore', () => {
    it('classifies an absent store as an empty faithful read', () => {
      const listing = readProjectRitualStore(
        path.join(process.cwd(), `.psyche-absent-${process.pid}-${Date.now()}`),
      );
      expect(listing).toEqual({
        rituals: [],
        incompatibleCount: 0,
        denied: false,
        failed: false,
        limitExceeded: false,
        bytesRead: 0,
      });
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

    it('rejects a ritual store through a symlinked .psyche directory', () => {
      const root = tempProject();
      const external = tempProjectWithRituals();
      try {
        symlinkDirectory(path.join(external, '.psyche'), path.join(root, '.psyche'));

        const listing = readProjectRitualStore(root);
        expect(listing.rituals).toEqual([]);
        expect(listing.incompatibleCount).toBe(1);
        expect(listing.failed).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it('rejects a symlinked rituals directory', () => {
      const root = tempProject();
      const external = tempProjectWithRituals();
      try {
        mkdirSync(path.join(root, '.psyche'));
        symlinkDirectory(
          path.join(external, '.psyche', 'rituals'),
          path.join(root, '.psyche', 'rituals'),
        );

        const listing = readProjectRitualStore(root);
        expect(listing.rituals).toEqual([]);
        expect(listing.incompatibleCount).toBe(1);
        expect(listing.failed).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it('closes every ritual descriptor when post-open directory validation fails', () => {
      const root = tempProjectWithRituals();
      const ritualPath = path.join(root, '.psyche', 'rituals', 'project-standup.json');
      const openedRitualDescriptors: number[] = [];
      const closedDescriptors = new Set<number>();
      let failPostOpenValidation = false;
      const realOpenSync = fs.openSync.bind(fs);
      const realLstatSync = fs.lstatSync.bind(fs);
      const realCloseSync = fs.closeSync.bind(fs);
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((
        filePath,
        flags,
        mode,
      ) => {
        const descriptor = realOpenSync(filePath, flags, mode);
        if (filePath === ritualPath) {
          openedRitualDescriptors.push(descriptor);
          failPostOpenValidation = true;
        }
        return descriptor;
      });
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
        if (failPostOpenValidation) {
          failPostOpenValidation = false;
          throw Object.assign(new Error('directory replaced after ritual open'), {
            code: 'ENOENT',
          });
        }
        return realLstatSync(filePath, options);
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
        closedDescriptors.add(descriptor);
        return realCloseSync(descriptor);
      });

      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const listing = readProjectRitualStore(root);
          expect(listing.rituals).toEqual([]);
        }
        expect(openedRitualDescriptors).toHaveLength(8);
        expect(openedRitualDescriptors.every((descriptor) => (
          closedDescriptors.has(descriptor)
        ))).toBe(true);
      } finally {
        closeSpy.mockRestore();
        lstatSpy.mockRestore();
        openSpy.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('classifies a ritual file-count overflow before parsing the store', () => {
      const root = tempProjectWithRituals();
      try {
        const ritualsDir = path.join(root, '.psyche', 'rituals');
        for (let index = 1; index <= MAX_PROJECT_RITUAL_FILES; index += 1) {
          writeFileSync(
            path.join(ritualsDir, `extra-${String(index).padStart(3, '0')}.json`),
            `${JSON.stringify(ritual({
              id: `extra-${index}`,
              name: `Extra ${index}`,
              scope: 'project',
            }))}\n`,
            'utf-8',
          );
        }

        const listing = readProjectRitualStore(root);
        expect(listing.limitExceeded).toBe(true);
        expect(listing.rituals).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('classifies an oversized ritual file before parsing it', () => {
      const root = tempProjectWithRituals();
      try {
        writeFileSync(
          path.join(root, '.psyche', 'rituals', 'oversized.json'),
          JSON.stringify({
            ...ritual({ id: 'oversized', name: 'Oversized', scope: 'project' }),
            padding: 'x'.repeat(MAX_PROJECT_RITUAL_FILE_BYTES),
          }),
          'utf-8',
        );

        const listing = readProjectRitualStore(root);
        expect(listing.limitExceeded).toBe(true);
        expect(listing.rituals.map((entry) => entry.id)).toEqual(['project-standup']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('classifies aggregate ritual bytes before parsing beyond the store budget', () => {
      const root = tempProjectWithRituals();
      try {
        const ritualsDir = path.join(root, '.psyche', 'rituals');
        const padding = 'x'.repeat(60 * 1024);
        const fileCount = Math.ceil(MAX_PROJECT_RITUAL_STORE_BYTES / Buffer.byteLength(padding)) + 1;
        for (let index = 0; index < fileCount; index += 1) {
          writeFileSync(
            path.join(ritualsDir, `padded-${String(index).padStart(2, '0')}.json`),
            JSON.stringify({
              ...ritual({
                id: `padded-${index}`,
                name: `Padded ${index}`,
                scope: 'project',
              }),
              padding,
            }),
            'utf-8',
          );
        }

        const listing = readProjectRitualStore(root);
        expect(listing.limitExceeded).toBe(true);
        expect(listing.rituals.length).toBeLessThan(fileCount + 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects a FIFO ritual entry without blocking', () => {
      if (process.platform === 'win32') return;
      const root = tempProjectWithRituals();
      try {
        execFileSync('mkfifo', [path.join(root, '.psyche', 'rituals', 'special.json')]);
        const listing = readRitualStoreInChild(root);
        expect(listing.incompatibleCount).toBe(1);
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
    limitExceeded: false,
    bytesRead: 0,
    ...overrides,
  };
}

function manifestListing() {
  return {
    denied: false,
    failed: false,
    incompatible: false,
    limitExceeded: false,
    bytesRead: 0,
  };
}

function readRitualStoreInChild(root: string): RitualStoreListing {
  return runRitualReaderChild(
    root,
    "import { readProjectRitualStore } from './src/utils/rituals.ts';"
      + "process.stdout.write(JSON.stringify(readProjectRitualStore(process.env.RITUAL_TEST_ROOT)));",
  ) as RitualStoreListing;
}

function readRitualPublicationInChild(root: string): ReturnType<typeof readProjectRitualPublication> {
  return runRitualReaderChild(
    root,
    "import { readProjectRitualPublication } from './src/workspace/ritualPublication.ts';"
      + "process.stdout.write(JSON.stringify(readProjectRitualPublication(process.env.RITUAL_TEST_ROOT)));",
  ) as ReturnType<typeof readProjectRitualPublication>;
}

function runRitualReaderChild(root: string, source: string): unknown {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, RITUAL_TEST_ROOT: root },
      timeout: 15_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

function tempProjectWithRituals(): string {
  const root = tempProject();
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

function tempProject(): string {
  return mkdtempSync(path.join(process.cwd(), '.psyche-ritual-publication-'));
}

function symlinkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
