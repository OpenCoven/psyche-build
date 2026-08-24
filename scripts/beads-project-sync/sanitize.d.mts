import type { BeadPriority, ParsedBead } from './model.mjs';

export interface SanitizePublicTextConfig {
  homeDirectories?: readonly string[] | ReadonlySet<string>;
}

export interface PublicBead {
  id: string;
  title: string;
  description: string | null;
  design: string | null;
  specId: string | null;
  acceptanceCriteria: string | null;
  notes: string | null;
  status: ParsedBead['status'];
  priority: BeadPriority;
  type: ParsedBead['type'];
  blocked: boolean;
  labels: string[];
  parentId: string | null;
  blockedByIds: string[];
  githubAssignee: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export function assertNoPublishableSecrets(value: string): void;

export function containsLocalOperationalPath(value: string): boolean;

export function sanitizePublicText(
  value: string | null | undefined,
  config?: SanitizePublicTextConfig,
): string | null;

export function toPublicBead(
  bead: ParsedBead,
  config?: SanitizePublicTextConfig,
): PublicBead;
