import type { BeadPriority } from './model.mjs';

export interface CanonicalTarget {
  issue: number;
  title: string;
  priority: BeadPriority;
}

export type CanonicalTargets = Readonly<Record<string, Readonly<CanonicalTarget>>>;

export interface CanonicalOutcomeBead {
  id: string;
  status: string;
  priority: number;
  externalRef?: string | null;
}

export interface CanonicalOutcomeValidation {
  mappedActiveCount: number;
  unmappedActiveBeadIds: readonly string[];
  unknownTargetBeadIds: readonly string[];
  priorityMismatchBeadIds: readonly string[];
}

export const CANONICAL_OUTCOME_REF_PATTERN: RegExp;
export const CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT: 50;

export function normalizeCanonicalOutcomeRef(
  value: unknown,
  context: string,
  options?: { allowNull?: false },
): string;

export function normalizeCanonicalOutcomeRef(
  value: unknown,
  context: string,
  options: { allowNull: true },
): string | null;

export function canonicalOutcomeIssueNumber(reference: string): number;

export class CanonicalOutcomeValidationError extends Error {
  constructor(message: string, diagnostics: CanonicalOutcomeValidation);
  readonly diagnostics: CanonicalOutcomeValidation;
}

export function validateCanonicalOutcomes(
  beads: readonly CanonicalOutcomeBead[],
  canonicalTargets: CanonicalTargets,
): CanonicalOutcomeValidation;
