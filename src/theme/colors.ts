import { SettingsManager } from '../utils/settingsManager.js';
import type { PsycheThemeName } from '../types.js';
import {
  DEFAULT_PSYCHE_THEME,
  isPsycheThemeName,
  normalizePsycheTheme,
} from './themePalette.js';

interface ThemePalette {
  accentHex: string;
  activeBorder: string;
  artPrimary: string;
  artTail: string[];
}

const ANSI_16_HEX_COLORS = [
  '#000000', '#800000', '#008000', '#808000',
  '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00',
  '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

const THEME_PALETTES: Record<PsycheThemeName, ThemePalette> = {
  red: {
    accentHex: '#ff5f5f',
    activeBorder: '203',
    artPrimary: '\x1b[38;5;203m',
    artTail: ['\x1b[38;5;210m', '\x1b[38;5;203m', '\x1b[38;5;196m', '\x1b[38;5;160m', '\x1b[38;5;124m', '\x1b[38;5;88m', '\x1b[38;5;52m', '\x1b[38;5;236m'],
  },
  blue: {
    accentHex: '#8b5cf6',
    activeBorder: '99',
    artPrimary: '\x1b[38;5;99m',
    artTail: ['\x1b[38;5;183m', '\x1b[38;5;141m', '\x1b[38;5;135m', '\x1b[38;5;99m', '\x1b[38;5;63m', '\x1b[38;5;57m', '\x1b[38;5;55m', '\x1b[38;5;236m'],
  },
  yellow: {
    accentHex: '#ffd75f',
    activeBorder: '221',
    artPrimary: '\x1b[38;5;221m',
    artTail: ['\x1b[38;5;227m', '\x1b[38;5;221m', '\x1b[38;5;220m', '\x1b[38;5;214m', '\x1b[38;5;178m', '\x1b[38;5;142m', '\x1b[38;5;100m', '\x1b[38;5;236m'],
  },
  orange: {
    accentHex: '#a78bfa',
    activeBorder: '141',
    artPrimary: '\x1b[38;5;141m',
    artTail: ['\x1b[38;5;183m', '\x1b[38;5;177m', '\x1b[38;5;141m', '\x1b[38;5;135m', '\x1b[38;5;99m', '\x1b[38;5;63m', '\x1b[38;5;57m', '\x1b[38;5;236m'],
  },
  green: {
    accentHex: '#6b7280',
    activeBorder: '245',
    artPrimary: '\x1b[38;5;245m',
    artTail: ['\x1b[38;5;252m', '\x1b[38;5;250m', '\x1b[38;5;248m', '\x1b[38;5;246m', '\x1b[38;5;244m', '\x1b[38;5;242m', '\x1b[38;5;240m', '\x1b[38;5;236m'],
  },
  purple: {
    accentHex: '#c084fc',
    activeBorder: '177',
    artPrimary: '\x1b[38;5;177m',
    artTail: ['\x1b[38;5;219m', '\x1b[38;5;183m', '\x1b[38;5;177m', '\x1b[38;5;141m', '\x1b[38;5;135m', '\x1b[38;5;99m', '\x1b[38;5;61m', '\x1b[38;5;236m'],
  },
  cyan: {
    accentHex: '#c4b5fd',
    activeBorder: '183',
    artPrimary: '\x1b[38;5;183m',
    artTail: ['\x1b[38;5;225m', '\x1b[38;5;189m', '\x1b[38;5;183m', '\x1b[38;5;147m', '\x1b[38;5;141m', '\x1b[38;5;105m', '\x1b[38;5;61m', '\x1b[38;5;236m'],
  },
  magenta: {
    accentHex: '#d8b4fe',
    activeBorder: '177',
    artPrimary: '\x1b[38;5;177m',
    artTail: ['\x1b[38;5;219m', '\x1b[38;5;213m', '\x1b[38;5;177m', '\x1b[38;5;171m', '\x1b[38;5;135m', '\x1b[38;5;99m', '\x1b[38;5;61m', '\x1b[38;5;236m'],
  },
};

function assignMutableRecord<T extends Record<string, string>>(target: T, source: T): void {
  for (const [key, value] of Object.entries(source)) {
    target[key as keyof T] = value as T[keyof T];
  }
}

export const COLORS = {
  accent: '',
  accentSoft: '#c4b5fd',
  accentMuted: '#a78bfa',
  selected: '',
  unselected: 'white',
  border: 'gray',
  borderSelected: '',
  success: '#9ca3af',
  error: '#f87171',
  warning: '#ffd75f',
  info: '#a78bfa',
  working: '#8b5cf6',
  analyzing: '#c4b5fd',
  waiting: '#a78bfa',
  muted: '#6b7280',
  textOnAccent: '#ffffff',
  textOnSuccess: '#ffffff',
} as const satisfies Record<string, string>;

export const TMUX_COLORS = {
  activeBorder: '',
  inactiveBorder: '240',
} as const satisfies Record<string, string>;

export const DECORATIVE_THEME = {
  primary: '',
  fill: '\x1b[38;5;238m',
  reset: '\x1b[0m',
  tail: Array.from({ length: 8 }, () => ''),
} as const;

let activeThemeName: PsycheThemeName = DEFAULT_PSYCHE_THEME;

export function getPsycheThemePalette(themeName: unknown): ThemePalette {
  return THEME_PALETTES[normalizePsycheTheme(themeName)];
}

export function getPsycheThemeAccent(themeName: unknown): string {
  return getPsycheThemePalette(themeName).accentHex;
}

function xterm256IndexToHex(colorIndex: number): string | undefined {
  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 255) {
    return undefined;
  }

  if (colorIndex < 16) {
    return ANSI_16_HEX_COLORS[colorIndex];
  }

  if (colorIndex >= 232) {
    const gray = 8 + ((colorIndex - 232) * 10);
    const grayHex = gray.toString(16).padStart(2, '0');
    return `#${grayHex}${grayHex}${grayHex}`;
  }

  const cubeIndex = colorIndex - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const red = steps[Math.floor(cubeIndex / 36)];
  const green = steps[Math.floor((cubeIndex % 36) / 6)];
  const blue = steps[cubeIndex % 6];

  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function getPsycheThemeActiveBorderHex(themeName: unknown): string {
  const activeBorderIndex = Number.parseInt(getPsycheThemePalette(themeName).activeBorder, 10);
  const activeBorderHex = xterm256IndexToHex(activeBorderIndex);
  return activeBorderHex || getPsycheThemeAccent(themeName);
}

export function applyPsycheTheme(themeName: PsycheThemeName): PsycheThemeName {
  const nextTheme = getPsycheThemePalette(themeName);
  activeThemeName = themeName;

  assignMutableRecord(COLORS as unknown as Record<string, string>, {
    ...COLORS,
    accent: nextTheme.accentHex,
    selected: nextTheme.accentHex,
    borderSelected: nextTheme.accentHex,
  });

  assignMutableRecord(TMUX_COLORS as unknown as Record<string, string>, {
    ...TMUX_COLORS,
    activeBorder: nextTheme.activeBorder,
  });

  (DECORATIVE_THEME as { primary: string }).primary = nextTheme.artPrimary;
  (DECORATIVE_THEME as { tail: string[] }).tail = [...nextTheme.artTail];

  return activeThemeName;
}

export function getActivePsycheTheme(): PsycheThemeName {
  return activeThemeName;
}

export function syncPsycheThemeFromSettings(projectRoot?: string): PsycheThemeName {
  try {
    const settings = new SettingsManager(projectRoot || process.cwd()).getSettings();
    return applyPsycheTheme(normalizePsycheTheme(settings.colorTheme));
  } catch {
    return applyPsycheTheme(DEFAULT_PSYCHE_THEME);
  }
}

// Keep module consumers working without explicit setup.
if (process.env.PSYCHE_THEME && isPsycheThemeName(process.env.PSYCHE_THEME)) {
  applyPsycheTheme(process.env.PSYCHE_THEME);
} else {
  syncPsycheThemeFromSettings(process.cwd());
}
