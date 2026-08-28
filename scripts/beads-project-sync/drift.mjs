// @ts-check

import {
  CanonicalOutcomeValidationError,
  canonicalOutcomeIssueNumber,
  validateCanonicalOutcomes,
} from './outcomes.mjs';

export const TRACKER_DRIFT_REPORT_SCHEMA_VERSION = 1;
export const TRACKER_DRIFT_FINDING_LIMIT = 100;

/**
 * @typedef {{
 *   id: string,
 *   status: string,
 *   priority: number,
 *   externalRef?: string | null,
 * }} DriftBead
 */

/**
 * @typedef {{
 *   beadId?: string | null,
 *   number: number,
 *   state: string,
 *   labels?: readonly string[],
 *   body?: string | null,
 *   renderHash?: string | null,
 *   markerFindingKinds?: readonly (
 *     | 'duplicate_bead_marker'
 *     | 'empty_bead_marker'
 *     | 'malformed_bead_marker'
 *   )[],
 * }} DriftManagedIssue
 */

/**
 * @typedef {{
 *   kind:
 *     | 'duplicate_mirror'
 *     | 'missing_mirror'
 *     | 'orphan_mirror'
 *     | 'state_mismatch'
 *     | 'priority_mismatch'
 *     | 'source_status_metadata_mismatch'
 *     | 'source_priority_metadata_mismatch'
 *     | 'missing_render_hash'
 *     | 'canonical_mapping_missing'
 *     | 'canonical_mapping_malformed'
 *     | 'canonical_mapping_unknown'
 *     | 'canonical_priority_mismatch'
 *     | 'duplicate_bead_marker'
 *     | 'empty_bead_marker'
 *     | 'malformed_bead_marker',
 *   beadId?: string,
 *   issueNumber?: number,
 *   sourceStatus?: string,
 *   mirrorState?: string,
 *   sourcePriority?: number,
 *   mirrorSourceStatus?: string | null,
 *   mirrorSourcePriority?: number | null,
 * }} TrackerDriftFinding
 */

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   result: 'pass' | 'fail',
 *   sourceCount: number,
 *   managedMirrorCount: number,
 *   canonicalOutcomeCount: number,
 *   findingCount: number,
 *   findings: readonly TrackerDriftFinding[],
 *   findingsOmitted: number,
 * }} TrackerDriftReport
 */

/**
 * @param {string} left
 * @param {string} right
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {string} status */
function expectedMirrorState(status) {
  return status === 'closed' ? 'closed' : 'open';
}

/**
 * @param {string | null} body
 * @param {string} field
 */
function sourceMetadata(body, field) {
  if (typeof body !== 'string') return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const value = body.match(
    new RegExp(`^\\s*-\\s+${escaped}:\\s*([^\\r\\n]+)\\s*$`, 'imu'),
  )?.[1]?.trim() ?? null;
  if (value == null) return null;
  return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1).trim() : value;
}

/** @param {string | null} body */
function safeMirrorSourceStatus(body) {
  const value = sourceMetadata(body, 'Source status');
  return value != null && /^[a-z][a-z0-9_-]{0,31}$/u.test(value) ? value : null;
}

/** @param {string | null} body */
function safeMirrorSourcePriority(body) {
  const value = sourceMetadata(body, 'Source priority');
  const match = value?.match(/^P([0-4])$/u);
  return match == null ? null : Number(match[1]);
}

/** @param {TrackerDriftFinding} finding */
function findingSortKey(finding) {
  return `${finding.beadId ?? ''}\u0000${String(finding.issueNumber ?? 0).padStart(10, '0')}\u0000${finding.kind}`;
}

/**
 * @param {DriftBead} bead
 * @returns {number | undefined}
 */
function canonicalIssueNumber(bead) {
  try {
    return bead.externalRef == null ? undefined : canonicalOutcomeIssueNumber(bead.externalRef);
  } catch {
    return undefined;
  }
}

/**
 * Compare authoritative Beads state with the normalized public managed-issue
 * projection. This function is deliberately pure: it neither queries nor
 * mutates GitHub and it never reads credentials.
 *
 * @param {readonly DriftBead[]} beads
 * @param {readonly DriftManagedIssue[]} managedIssues
 * @param {import('./outcomes.mjs').CanonicalTargets} canonicalTargets
 * @returns {TrackerDriftReport}
 */
export function validateTrackerDrift(beads, managedIssues, canonicalTargets) {
  /** @type {TrackerDriftFinding[]} */
  const findings = [];
  const sourceById = new Map(beads.map((bead) => [bead.id, bead]));
  let preOmittedFindingCount = 0;
  let canonical;
  try {
    canonical = validateCanonicalOutcomes(beads, canonicalTargets);
  } catch (error) {
    if (!(error instanceof CanonicalOutcomeValidationError)) throw error;
    canonical = error.diagnostics;
    /** @type {readonly [
     *   TrackerDriftFinding['kind'],
     *   readonly string[],
     * ][]} */
    const canonicalFindingGroups = [
      ['canonical_mapping_missing', canonical.unmappedActiveBeadIds],
      ['canonical_mapping_malformed', canonical.malformedTargetBeadIds],
      ['canonical_mapping_unknown', canonical.unknownTargetBeadIds],
      ['canonical_priority_mismatch', canonical.priorityMismatchBeadIds],
    ];
    const retainedCanonicalFindingCount = canonicalFindingGroups
      .reduce((count, [, beadIds]) => count + beadIds.length, 0);
    preOmittedFindingCount = Math.max(0, error.failureCount - retainedCanonicalFindingCount);
    for (const [kind, beadIds] of canonicalFindingGroups) {
      for (const beadId of beadIds) {
        const bead = sourceById.get(beadId);
        findings.push({
          kind,
          beadId,
          ...(bead == null
            ? {}
            : {
                sourceStatus: bead.status,
                sourcePriority: bead.priority,
              }),
          ...(
            kind === 'canonical_mapping_unknown' || kind === 'canonical_priority_mismatch'
              ? { issueNumber: bead == null ? undefined : canonicalIssueNumber(bead) }
              : {}
          ),
        });
      }
    }
  }
  const mirrorsByBeadId = new Map();

  for (const issue of managedIssues) {
    for (const kind of issue.markerFindingKinds ?? []) {
      findings.push({
        kind,
        ...(issue.beadId == null ? {} : { beadId: issue.beadId }),
        issueNumber: issue.number,
      });
    }
    if (issue.beadId == null || (issue.markerFindingKinds?.length ?? 0) > 0) {
      continue;
    }
    const existing = mirrorsByBeadId.get(issue.beadId);
    if (existing != null) {
      findings.push({
        kind: 'duplicate_mirror',
        beadId: issue.beadId,
        issueNumber: issue.number,
      });
      continue;
    }
    mirrorsByBeadId.set(issue.beadId, issue);
  }

  for (const bead of beads) {
    const issue = mirrorsByBeadId.get(bead.id);
    if (issue == null) {
      findings.push({
        kind: 'missing_mirror',
        beadId: bead.id,
        sourceStatus: bead.status,
        sourcePriority: bead.priority,
      });
      continue;
    }

    const expectedState = expectedMirrorState(bead.status);
    if (issue.state !== expectedState) {
      findings.push({
        kind: 'state_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourceStatus: bead.status,
        mirrorState: issue.state,
      });
    }

    const labels = new Set(issue.labels ?? []);
    if (!labels.has(`priority:P${bead.priority}`)) {
      findings.push({
        kind: 'priority_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourcePriority: bead.priority,
      });
    }

    const mirrorSourceStatus = safeMirrorSourceStatus(issue.body ?? null);
    if (mirrorSourceStatus !== bead.status) {
      findings.push({
        kind: 'source_status_metadata_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourceStatus: bead.status,
        mirrorState: issue.state,
        mirrorSourceStatus,
      });
    }

    const mirrorSourcePriority = safeMirrorSourcePriority(issue.body ?? null);
    if (mirrorSourcePriority !== bead.priority) {
      findings.push({
        kind: 'source_priority_metadata_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourcePriority: bead.priority,
        mirrorSourcePriority,
      });
    }

    if (issue.renderHash == null || !issue.renderHash.trim()) {
      findings.push({
        kind: 'missing_render_hash',
        beadId: bead.id,
        issueNumber: issue.number,
      });
    }
  }

  for (const issue of managedIssues) {
    if (
      issue.beadId != null
      && (issue.markerFindingKinds?.length ?? 0) === 0
      && !sourceById.has(issue.beadId)
    ) {
      findings.push({
        kind: 'orphan_mirror',
        beadId: issue.beadId,
        issueNumber: issue.number,
        mirrorState: issue.state,
      });
    }
  }

  findings.sort((left, right) => compareStrings(findingSortKey(left), findingSortKey(right)));
  const bounded = findings.slice(0, TRACKER_DRIFT_FINDING_LIMIT).map((finding) => Object.freeze({ ...finding }));
  const findingCount = findings.length + preOmittedFindingCount;

  return Object.freeze({
    schemaVersion: TRACKER_DRIFT_REPORT_SCHEMA_VERSION,
    result: findingCount === 0 ? 'pass' : 'fail',
    sourceCount: beads.length,
    managedMirrorCount: managedIssues.length,
    canonicalOutcomeCount: canonical.mappedActiveCount,
    findingCount,
    findings: Object.freeze(bounded),
    findingsOmitted: Math.max(0, findingCount - bounded.length),
  });
}
