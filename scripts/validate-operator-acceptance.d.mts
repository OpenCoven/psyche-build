export interface OperatorAcceptanceManifest {
  schemaVersion: number;
  terminalState: 'incomplete' | 'complete';
  [key: string]: unknown;
}

export function validateOperatorAcceptanceManifest(
  manifest: OperatorAcceptanceManifest,
  options?: { requireComplete?: boolean },
): string[];
