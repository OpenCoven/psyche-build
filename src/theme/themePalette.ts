import type { PsycheThemeName } from '../types.js';

export const PSYCHE_THEME_NAMES = [
  'red',
  'blue',
  'yellow',
  'orange',
  'green',
  'purple',
  'cyan',
  'magenta',
] as const satisfies readonly PsycheThemeName[];

export const DEFAULT_PSYCHE_THEME: PsycheThemeName = 'orange';

export const PSYCHE_THEME_LABELS: Record<PsycheThemeName, string> = {
  red: 'Crimson',
  blue: 'Indigo',
  yellow: 'Gold',
  orange: 'Brand Purple',
  green: 'Graphite',
  purple: 'Violet',
  cyan: 'Lilac',
  magenta: 'Orchid',
};

export function isPsycheThemeName(value: unknown): value is PsycheThemeName {
  return typeof value === 'string' && (PSYCHE_THEME_NAMES as readonly string[]).includes(value);
}

export function normalizePsycheTheme(value: unknown): PsycheThemeName {
  return isPsycheThemeName(value) ? value : DEFAULT_PSYCHE_THEME;
}

export function getPsycheThemeLabel(value: unknown): string {
  return PSYCHE_THEME_LABELS[normalizePsycheTheme(value)];
}
