export interface ProjectAccent {
  readonly id: string;
  readonly label: string;
  readonly rgb: string;
}

export interface ProjectGlyph {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ProjectAppearanceOverride {
  readonly accent?: string;
  readonly glyph?: string;
}

export interface ResolvedProjectAppearance {
  readonly key: string;
  readonly accent: ProjectAccent;
  readonly glyph: ProjectGlyph | null;
  readonly customized: boolean;
  readonly override: Readonly<ProjectAppearanceOverride>;
}

export const PROJECT_ACCENTS: readonly ProjectAccent[];
export const PROJECT_GLYPHS: readonly ProjectGlyph[];

export function normalizeProjectAppearanceKey(root?: string, fallback?: string): string;
export function stableProjectAppearanceHash(value: string): number;
export function sanitizeProjectAppearance(value: unknown): ProjectAppearanceOverride;
export function parseProjectAppearances(raw: string): Record<string, ProjectAppearanceOverride>;
export function resolveProjectAppearance(
  project: { root?: string; name?: string },
  appearances?: Record<string, ProjectAppearanceOverride>,
): ResolvedProjectAppearance;
export function updateProjectAppearance(
  appearances: Record<string, ProjectAppearanceOverride>,
  key: string,
  patch: ProjectAppearanceOverride | { accent?: string | null; glyph?: string | null } | null,
): Record<string, ProjectAppearanceOverride>;
