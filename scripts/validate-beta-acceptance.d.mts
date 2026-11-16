export const BETA_ACCEPTANCE_ROWS: ReadonlyArray<{
  readonly id: string;
  readonly gate: string;
  readonly title: string;
}>;
export const BETA_AGENT_IDS: ReadonlyArray<string>;
export const BETA_AGENTS_WITH_PROMPT_IN_ARGV: ReadonlyArray<string>;
export function validateBetaAcceptanceManifest(
  manifest: unknown,
  options?: {
    requireComplete?: boolean;
    requireAccepted?: boolean;
    provenanceText?: string;
    sha256sumsText?: string;
  },
): string[];
