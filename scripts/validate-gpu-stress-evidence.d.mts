export type GpuStressEvidenceFinding =
  | 'invalid_export'
  | 'invalid_arguments'
  | 'input_unavailable'
  | 'frame_not_measured'
  | 'input_to_next_paint_not_measured'
  | 'queue_not_measured'
  | 'ipc_not_measured'
  | 'throughput_not_measured'
  | 'physical_acceleration_unverified'
  | 'physical_recovery_unverified';

export interface GpuStressEvidenceReport {
  status: 'invalid' | 'incomplete';
  findings: GpuStressEvidenceFinding[];
  scenarios: {
    paneCount: 1 | 6 | 12 | 24;
    cpu: 'measured' | 'not_measured';
    rss: 'measured' | 'not_measured';
    contextLoss: 'requested' | 'unsupported';
  }[];
}
export function validateGpuStressEvidence(text: unknown): GpuStressEvidenceReport;
