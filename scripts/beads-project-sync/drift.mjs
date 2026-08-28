// @ts-check

import { validateCanonicalOutcomes } from './outcomes.mjs';

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
 *   beadId: string,
 *   number: number,
 *   state: string,
 *   labels?: readonly string[],
 *   body?: string | null,
 *   renderHash?: string | null,
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
 *     | 'missing_render_hash',
 *   beadId: string,
 *   issueNumber?: number,
 *   sourceStatus?: string,
 *   mirrorState?: string,
 *   sourcePriority?: number,
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

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectedMirrorState(status) {
  return status === 'closed' ? 'closed' : 'open';
}

function sourceMetadata(body, field) {
  if (typeof body !== 'string') return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return body.match(new RegExp(`^\\s*-\\s+${escaped}:\\s*([^\\r\\n]+)\\s*$`, 'imu'))?.[1]?.trim() ?? null;
}

function findingSortKey(finding) {
  return `${finding.beadId}\u0000${String(finding.issueNumber ?? 0).padStart(10, '0')}\u0000${finding.kind}`;
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
  const canonical = validateCanonicalOutcomes(beads, canonicalTargets);
  const findings = [];
  const mirrorsByBeadId = new Map();

  for (const issue of managedIssues) {
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

  const sourceById = new Map(beads.map((bead) => [bead.id, bead]));

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

    const sourceStatus = sourceMetadata(issue.body ?? null, 'Source status');
    if (sourceStatus !== bead.status) {
      findings.push({
        kind: 'source_status_metadata_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourceStatus: bead.status,
        mirrorState: issue.state,
      });
    }

    const sourcePriority = sourceMetadata(issue.body ?? null, 'Source priority');
    if (sourcePriority !== `P${bead.priority}`) {
      findings.push({
        kind: 'source_priority_metadata_mismatch',
        beadId: bead.id,
        issueNumber: issue.number,
        sourcePriority: bead.priority,
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
    if (!sourceById.has(issue.beadId)) {
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

  return Object.freeze({
    schemaVersion: TRACKER_DRIFT_REPORT_SCHEMA_VERSION,
    result: findings.length === 0 ? 'pass' : 'fail',
    sourceCount: beads.length,
    managedMirrorCount: managedIssues.length,
    canonicalOutcomeCount: canonical.mappedActiveCount,
    findingCount: findings.length,
    findings: Object.freeze(bounded),
    findingsOmitted: Math.max(0, findings.length - bounded.length),
  });
}
