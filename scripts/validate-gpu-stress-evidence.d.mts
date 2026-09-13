export interface GpuStressEvidenceReport {
  status: 'invalid' | 'incomplete';
  findings: string[];
  scenarios: {
    paneCount: 1 | 6 | 12 | 24;
    cpu: 'measured' | 'not_measured';
    rss: 'measured' | 'not_measured';
    contextLoss: 'requested' | 'unsupported';
  }[];
}
export function validateGpuStressEvidence(text: unknown): GpuStressEvidenceReport;
