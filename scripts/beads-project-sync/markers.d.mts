export const DEFAULT_PROJECT_MARKER: 'psyche-beads-project-sync:v1';
export const DEFAULT_ISSUE_MARKER: 'psyche-bead-sync:v1';
export const LEGACY_PROJECT_MARKERS: readonly ['psyche-bead-sync:v1'];
export const LEGACY_ISSUE_MARKERS: readonly ['psyche-bead-sync:v1'];

export function normalizeMarker(value: unknown, context: string): string;

export function recognizedMarkers(
  current: unknown,
  legacy: unknown,
  context: string,
): string[];

export function projectReadmeMarker(marker: string): string;

export function issueBeadMarker(marker: string, beadId: string): string;

export function renderHashMarker(marker: string, renderHash: string): string;

export function markerPattern(
  markers: readonly string[],
  suffix: string,
  flags?: string,
): RegExp;
