import type { PublicBead } from './sanitize.mjs';
import type { CanonicalTargets } from './outcomes.mjs';

export interface RenderContext {
  inventoryById?: ReadonlyMap<string, PublicBead> | Record<string, PublicBead>;
  mirroredIssueUrlsByBeadId?: ReadonlyMap<string, string> | Record<string, string>;
  canonicalTargets?: CanonicalTargets;
  sourceRepositoryUrl?: string | null;
  sourceRef?: string | null;
  inventoryTimestamp?: string | null;
  projectName?: string | null;
  repositoryIdentity?: string | null;
  projectMarker?: string | null;
  issueMarker?: string | null;
  legacyProjectMarkers?: readonly string[];
  legacyIssueMarkers?: readonly string[];
}

export const GITHUB_ISSUE_BODY_MAX_CODE_POINTS: 65536;
export const GITHUB_PROJECT_README_MAX_CODE_POINTS: 10000;

export function renderIssueTitle(bead: PublicBead): string;

export function assertIssueBodyWithinLimit(beadId: string, body: string): void;

export function assertProjectReadmeWithinLimit(body: string): void;

export function renderIssueBody(
  bead: PublicBead,
  context?: RenderContext,
): string;

export function renderProjectReadme(
  inventory: readonly PublicBead[],
  context?: RenderContext,
): string;
