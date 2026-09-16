import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  listWorktreeRecoveryMarkers,
  readWorktreeRecoveryMarkers,
  worktreeRecoveryMarkerDirectory,
  writeWorktreeRecoveryMarker,
} from '../src/services/WorktreeRecoveryMarker.js';
import {
  listPaneSlugOwnershipRecords,
  paneSlugOwnershipDirectory,
  readPaneSlugOwnershipRecords,
  writePaneSlugOwnershipRecord,
} from '../src/services/PaneSlugRegistry.js';
import { reconcileStalePaneSlugReservations } from '../src/services/PaneSlugReservation.js';
import { formatRecoveryReport } from '../src/diagnostics/recoveryReport.js';

const directories: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(path.join(process.cwd(), '.psyche-recovery-listing-'));
  directories.push(root);
  return root;
}

async function writeReadableMarker(projectRoot: string): Promise<string> {
  const worktreePath = path.join(projectRoot, '.psyche', 'worktrees', 'readable');
  mkdirSync(worktreePath, { recursive: true });
  const written = await writeWorktreeRecoveryMarker({
    projectRoot,
    worktreePath,
    pane: { id: 'pane-readable', paneId: '%1', slug: 'readable' },
    operation: 'attach-agent',
    reason: 'tmux teardown could not be verified',
  });
  return written.marker.id;
}

function writeUnknownVersionMarker(projectRoot: string, slug: string): string {
  const directory = worktreeRecoveryMarkerDirectory(projectRoot);
  mkdirSync(directory, { recursive: true });
  const markerPath = path.join(directory, `${'f'.repeat(64)}.json`);
  writeFileSync(markerPath, JSON.stringify({
    version: 99,
    id: 'f'.repeat(64),
    projectRoot,
    worktreePath: path.join(projectRoot, '.psyche', 'worktrees', 'newer'),
    pane: { id: 'pane-newer', paneId: '%2', slug },
    operation: 'attach-agent',
    reason: 'written by a newer Psyche',
    createdAt: new Date().toISOString(),
    operatorInstructions: 'acknowledge with a newer Psyche',
  }), 'utf8');
  return markerPath;
}

function writeOwnershipRecordFile(
  sessionProjectRoot: string,
  recoveryId: string,
  body: string,
): string {
  const directory = paneSlugOwnershipDirectory(sessionProjectRoot);
  mkdirSync(directory, { recursive: true });
  const recordPath = path.join(directory, `${recoveryId}.json`);
  writeFileSync(recordPath, body, 'utf8');
  return recordPath;
}

function ownershipRecord(
  sessionProjectRoot: string,
  slug: string,
): Parameters<typeof writePaneSlugOwnershipRecord>[0] {
  const now = new Date().toISOString();
  return {
    version: 1,
    recoveryId: randomUUID(),
    state: 'provisional',
    sessionProjectRoot,
    projectRoot: sessionProjectRoot,
    worktreePath: path.join(sessionProjectRoot, '.psyche', 'worktrees', slug),
    slug,
    pane: { id: `pane-${slug}`, paneId: `%${slug.length}` },
    owner: { pid: process.pid, nonce: randomUUID() },
    operation: 'attach-agent',
    createdAt: now,
    updatedAt: now,
  };
}

describe('unknown-version recovery listings quarantine instead of throwing', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps readable worktree recovery markers visible beside an unknown version', async () => {
    const projectRoot = createProjectRoot();
    const readableId = await writeReadableMarker(projectRoot);
    const quarantinedPath = writeUnknownVersionMarker(projectRoot, 'newer');

    const listing = await readWorktreeRecoveryMarkers(projectRoot);

    expect(listing.markers.map((marker) => marker.id)).toEqual([readableId]);
    expect(listing.quarantined).toEqual([
      {
        path: quarantinedPath,
        reason: 'unrecognized worktree recovery marker version 99',
        version: 99,
        slug: 'newer',
      },
    ]);
  });

  it('quarantines an unparseable worktree recovery marker without losing the rest', async () => {
    const projectRoot = createProjectRoot();
    const readableId = await writeReadableMarker(projectRoot);
    const directory = worktreeRecoveryMarkerDirectory(projectRoot);
    const truncated = path.join(directory, `${'e'.repeat(64)}.json`);
    writeFileSync(truncated, '{"version": 5, "id": "', 'utf8');

    const listing = await readWorktreeRecoveryMarkers(projectRoot);

    expect(listing.markers.map((marker) => marker.id)).toEqual([readableId]);
    expect(listing.quarantined).toHaveLength(1);
    expect(listing.quarantined[0]).toMatchObject({ path: truncated });
    expect(listing.quarantined[0].reason).toContain('could not be parsed');
    expect(listing.quarantined[0].version).toBeUndefined();
  });

  it('keeps the strict marker listing fail-closed for allocation callers', async () => {
    const projectRoot = createProjectRoot();
    await writeReadableMarker(projectRoot);
    const quarantinedPath = writeUnknownVersionMarker(projectRoot, 'newer');

    await expect(listWorktreeRecoveryMarkers(projectRoot)).rejects.toThrow(
      `Invalid worktree recovery marker: ${quarantinedPath}`,
    );
  });

  it('keeps readable pane slug ownership records visible beside an unknown version', async () => {
    const sessionProjectRoot = createProjectRoot();
    const readable = ownershipRecord(sessionProjectRoot, 'readable');
    await writePaneSlugOwnershipRecord(readable);
    const unknownId = randomUUID();
    const quarantinedPath = writeOwnershipRecordFile(
      sessionProjectRoot,
      unknownId,
      JSON.stringify({ ...ownershipRecord(sessionProjectRoot, 'newer'), version: 99 }),
    );

    const listing = await readPaneSlugOwnershipRecords(sessionProjectRoot);

    expect(listing.records.map((record) => record.slug)).toEqual(['readable']);
    expect(listing.quarantined).toEqual([
      {
        path: quarantinedPath,
        reason: 'unrecognized pane slug ownership record version 99',
        version: 99,
        slug: 'newer',
      },
    ]);

    await expect(listPaneSlugOwnershipRecords(sessionProjectRoot)).rejects.toThrow(
      `Invalid pane slug ownership record: ${quarantinedPath}`,
    );
  });

  it('reconciles every readable reservation before reporting an unreadable one', async () => {
    const sessionProjectRoot = createProjectRoot();
    const readable = ownershipRecord(sessionProjectRoot, 'readable');
    await writePaneSlugOwnershipRecord(readable);
    const quarantinedPath = writeOwnershipRecordFile(
      sessionProjectRoot,
      randomUUID(),
      '{"version": 1, "recoveryId": "',
    );

    await expect(reconcileStalePaneSlugReservations({
      sessionProjectRoot,
      ownerProbe: { isProcessAlive: () => false },
      probePane: async () => 'absent',
    })).rejects.toThrow(quarantinedPath);

    // The readable stale reservation was still reconciled: its slug is released.
    const listing = await readPaneSlugOwnershipRecords(sessionProjectRoot);
    expect(listing.records).toEqual([]);
    expect(listing.quarantined).toHaveLength(1);
  });
});

describe('operator recovery report', () => {
  it('reports readable markers and quarantined files with a non-zero status', () => {
    const report = formatRecoveryReport({
      markers: [{
        version: 5,
        id: 'a'.repeat(64),
        projectRoot: '/project',
        worktreePath: '/project/.psyche/worktrees/uncertain',
        pane: { id: 'pane-1', paneId: '%9' },
        operation: 'attach-agent',
        reason: 'tmux teardown could not be verified',
        createdAt: '2026-09-16T00:00:00.000Z',
        operatorInstructions: 'acknowledge before cleanup',
      }],
      quarantined: [{
        path: '/project/.psyche/runtime/worktree-recovery/newer.json',
        reason: 'unrecognized worktree recovery marker version 99',
        version: 99,
        slug: 'newer',
      }],
    });

    expect(report.exitCode).toBe(2);
    expect(report.text).toContain('a'.repeat(64));
    expect(report.text).toContain('1 quarantined recovery file');
    expect(report.text).toContain('unrecognized worktree recovery marker version 99');
    expect(report.text).toContain('pane slug newer');
  });

  it('reports a clean project with a zero status', () => {
    const report = formatRecoveryReport({ markers: [], quarantined: [] });

    expect(report.exitCode).toBe(0);
    expect(report.text).toBe('No worktree recovery markers found.');
  });

  it('blocks on quarantined files even when no marker is readable', () => {
    const report = formatRecoveryReport({
      markers: [],
      quarantined: [{
        path: '/project/.psyche/runtime/worktree-recovery/broken.json',
        reason: 'could not be parsed: Unexpected end of JSON input',
      }],
    });

    expect(report.exitCode).toBe(2);
    expect(report.text).toContain('1 quarantined recovery file');
    expect(report.text).not.toContain('No worktree recovery markers found.');
  });
});
