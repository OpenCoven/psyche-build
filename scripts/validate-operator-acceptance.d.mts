export const REQUIRED_OBSERVATIONS: ReadonlySet<string>;
export function normalizeOperatorArchitecture(value: unknown): 'aarch64' | 'x86_64' | 'unknown';
export function validateOperatorAcceptanceManifest(
  manifest: unknown,
  options?: { requireComplete?: boolean },
): string[];
