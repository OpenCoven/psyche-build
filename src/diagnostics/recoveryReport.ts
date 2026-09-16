import type { WorktreeRecoveryMarkerListing } from '../services/WorktreeRecoveryMarker.js';

export interface RecoveryReport {
  text: string;
  exitCode: number;
}

/**
 * Renders `psyche recover` output.
 *
 * A quarantined file is still a reason to refuse destructive cleanup, so it
 * keeps the blocked exit code even when no marker could be read. Only the file
 * path, its declared version and a salvaged slug are printed; the payload of a
 * file this version cannot validate is never echoed.
 */
export function formatRecoveryReport(
  listing: WorktreeRecoveryMarkerListing,
): RecoveryReport {
  const sections: string[] = [];

  for (const marker of listing.markers) {
    sections.push([
      `${marker.id} ${marker.operation}`,
      `  worktree: ${marker.worktreePath}`,
      `  pane: ${marker.pane.id} (${marker.pane.paneId})`,
      `  reason: ${marker.reason}`,
      `  ${marker.operatorInstructions}`,
    ].join('\n'));
  }

  if (listing.quarantined.length > 0) {
    const count = listing.quarantined.length;
    sections.push([
      `${count} quarantined recovery file${count === 1 ? '' : 's'} could not be read by this Psyche version.`,
      'They are left untouched and destructive worktree cleanup stays refused for them.',
      ...listing.quarantined.map((entry) => [
        `  ${entry.path}`,
        `    reason: ${entry.reason}`,
        ...(entry.slug
          ? [`    treat pane slug ${entry.slug} as occupied until this file is resolved`]
          : []),
      ].join('\n')),
      'Resolve each file with the Psyche version that wrote it, or move it aside deliberately after inspecting it.',
    ].join('\n'));
  }

  if (sections.length === 0) {
    return { text: 'No worktree recovery markers found.', exitCode: 0 };
  }

  return { text: sections.join('\n'), exitCode: 2 };
}
