import {
  readWorktreeRecoveryMarkers,
  type WorktreeRecoveryMarker,
} from '../services/WorktreeRecoveryMarker.js';
import { readPaneSlugOwnershipRecords } from '../services/PaneSlugRegistry.js';
import type { QuarantinedRecoveryFile } from '../services/QuarantinedRecoveryFile.js';

export interface RecoveryReportInput {
  markers: WorktreeRecoveryMarker[];
  quarantined: QuarantinedRecoveryFile[];
}

export interface RecoveryReport {
  text: string;
  exitCode: number;
}

/**
 * Collects everything `psyche recover` must show for a project.
 *
 * Recovery state lives in two directories: target-project worktree markers and
 * session-local pane slug ownership. A file this version cannot read in either
 * one keeps destructive cleanup refused, so reporting only the first would let
 * the command claim a clean project while cleanup stays blocked.
 */
export async function collectRecoveryListing(
  projectRoot: string,
): Promise<RecoveryReportInput> {
  const [markerListing, ownershipListing] = await Promise.all([
    readWorktreeRecoveryMarkers(projectRoot),
    readPaneSlugOwnershipRecords(projectRoot),
  ]);
  return {
    markers: markerListing.markers,
    quarantined: [...markerListing.quarantined, ...ownershipListing.quarantined]
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** A recovery directory can hold many unreadable files; the report stays bounded. */
const MAX_RENDERED_QUARANTINES = 20;

/**
 * Renders `psyche recover` output.
 *
 * A quarantined file is still a reason to refuse destructive cleanup, so it
 * keeps the blocked exit code even when no marker could be read. Only the file
 * path, its declared version and a bounded salvaged slug are printed; the
 * payload of a file this version cannot validate is never echoed.
 */
export function formatRecoveryReport(input: RecoveryReportInput): RecoveryReport {
  const sections: string[] = [];

  for (const marker of input.markers) {
    sections.push([
      `${marker.id} ${marker.operation}`,
      `  worktree: ${marker.worktreePath}`,
      `  pane: ${marker.pane.id} (${marker.pane.paneId})`,
      `  reason: ${marker.reason}`,
      `  ${marker.operatorInstructions}`,
    ].join('\n'));
  }

  if (input.quarantined.length > 0) {
    const count = input.quarantined.length;
    const rendered = input.quarantined.slice(0, MAX_RENDERED_QUARANTINES);
    const withheld = count - rendered.length;
    sections.push([
      `${count} quarantined recovery file${count === 1 ? '' : 's'} could not be read by this Psyche version.`,
      'They are left untouched and destructive worktree cleanup stays refused for them.',
      ...rendered.map((entry) => [
        `  ${entry.path}`,
        `    reason: ${entry.reason}`,
        ...(entry.slug
          ? [`    treat pane slug ${entry.slug} as occupied until this file is resolved`]
          : []),
      ].join('\n')),
      ...(withheld > 0
        ? [`  … and ${withheld} more not listed; this report is bounded to ${MAX_RENDERED_QUARANTINES} files.`]
        : []),
      'Resolve each file with the Psyche version that wrote it, or move it aside deliberately after inspecting it.',
    ].join('\n'));
  }

  if (sections.length === 0) {
    return { text: 'No worktree recovery markers found.', exitCode: 0 };
  }

  return { text: sections.join('\n'), exitCode: 2 };
}
