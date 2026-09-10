export interface RecoveryPair {
  readonly beadId: string;
  readonly survivor: number;
  readonly alias: number;
}

export const RECOVERY_PAIRS: readonly RecoveryPair[];
export function retirementNotice(beadId: string, survivor: number, alias: number): string;
export function partitionRecoveryIssues<T extends {
  number: number;
  body?: string | null;
  repository?: string | null;
  author?: string | null;
}>(issues: readonly T[]): {
  canonical: T[];
  aliases: { issue: T; beadId: string; survivor: number }[];
};
