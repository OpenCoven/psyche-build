import type { CanonicalTargets } from './outcomes.mjs';

export const TRACKER_DRIFT_REPORT_SCHEMA_VERSION: 1;
export const TRACKER_DRIFT_FINDING_LIMIT: 100;

export interface DriftBead {
  id: string;
  status: string;
  priority: number;
  externalRef?: string | null;
}

export interface DriftManagedIssue {
  beadId: string;
  number: number;
  state: string;
  labels?: readonly string[];
  body?: string | null;
  renderHash?: string | null;
}

export type TrackerDriftFindingKind =
  | 'duplicate_mirror'
  | 'missing_mirror'
  | 'orphan_mirror'
  | 'state_mismatch'
  | 'priority_mismatch'
  | 'source_status_metadata_mismatch'
  | 'source_priority_metadata_mismatch'
  | 'missing_render_hash';

export interface TrackerDriftFinding {
  kind: TrackerDriftFindingKind;
  beadId: string;
  issueNumber?: number;
  sourceStatus?: string;
  mirrorState?: string;
  sourcePriority?: number;
}

export interface TrackerDriftReport {
  schemaVersion: 1;
  result: 'pass' | 'fail';
  sourceCount: number;
  managedMirrorCount: number;
  canonicalOutcomeCount: number;
  findingCount: number;
  findings: readonly TrackerDriftFinding[];
  findingsOmitted: number;
}

export function validateTrackerDrift(
  beads: readonly DriftBead[],
  managedIssues: readonly DriftManagedIssue[],
  canonicalTargets: CanonicalTargets,
): TrackerDriftReport;
