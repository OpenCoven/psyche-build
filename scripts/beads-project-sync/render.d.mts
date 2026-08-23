import type { PublicBead } from './sanitize.mjs';

export interface RenderContext {
  inventoryById?: ReadonlyMap<string, PublicBead> | Record<string, PublicBead>;
  mirroredIssueUrlsByBeadId?: ReadonlyMap<string, string> | Record<string, string>;
  sourceRepositoryUrl?: string | null;
  sourceRef?: string | null;
  inventoryTimestamp?: string | null;
  projectName?: string | null;
  projectMarker?: string | null;
  issueMarker?: string | null;
  legacyProjectMarkers?: readonly string[];
  legacyIssueMarkers?: readonly string[];
}

export function renderIssueTitle(bead: PublicBead): string;

export function renderIssueBody(
  bead: PublicBead,
  context?: RenderContext,
): string;

export function renderProjectReadme(
  inventory: readonly PublicBead[],
  context?: RenderContext,
): string;
