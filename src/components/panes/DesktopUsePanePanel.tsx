import React, { memo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { PsycheThemeName } from '../../types.js';
import { COLORS, getPsycheThemeAccent } from '../../theme/colors.js';
import type { DesktopUsePaneState } from '../../utils/covenDesktopUse.js';

interface DesktopUsePanePanelProps {
  state?: DesktopUsePaneState;
  selected: boolean;
  themeName: PsycheThemeName;
}

const ROW_WIDTH = 40;

const DesktopUsePanePanel: React.FC<DesktopUsePanePanelProps> = memo(({ state, selected, themeName }) => {
  const accent = getPsycheThemeAccent(themeName);

  if (!state) {
    return (
      <Box width={ROW_WIDTH} flexDirection="column">
        <Text color={COLORS.border}>{fit('  ⌘ desktop-use: connecting…', ROW_WIDTH)}</Text>
      </Box>
    );
  }

  const action = state.currentAction?.label || 'idle';
  const status = state.session?.status || (state.connected ? 'connected' : 'offline');
  const permissions = state.permissions ? formatPermissions(state.permissions) : undefined;
  const details = state.error
    ? `error: ${state.error}`
    : state.accessibilitySummary
      ? `ax: ${state.accessibilitySummary}`
      : state.screenSummary
        ? `screen: ${state.screenSummary}`
        : state.screenshotPath
          ? `shot: ${state.screenshotPath}`
          : 'waiting for Coven desktop events';

  return (
    <Box width={ROW_WIDTH} flexDirection="column">
      <Text color={selected ? accent : COLORS.border}>{fit(`  ⌘ ${status} · ${action}`, ROW_WIDTH)}</Text>
      {permissions && <Text color={COLORS.muted}>{fit(`  perms ${permissions}`, ROW_WIDTH)}</Text>}
      <Text color={state.error ? COLORS.error : COLORS.unselected}>{fit(`  ${details}`, ROW_WIDTH)}</Text>
      {selected && (
        <Text color={COLORS.border}>{fit('  [g]shot [o]inspect [v]perms [y]approve [X]deny', ROW_WIDTH)}</Text>
      )}
    </Box>
  );
});

function formatPermissions(permissions: Record<string, string>): string {
  const entries = Object.entries(permissions).slice(0, 3);
  return entries.map(([key, value]) => `${shortKey(key)}:${shortValue(value)}`).join(' ');
}

function shortKey(value: string): string {
  return value
    .replace(/screenCapture/i, 'screen')
    .replace(/accessibility/i, 'ax')
    .replace(/microphone/i, 'mic')
    .slice(0, 8);
}

function shortValue(value: string): string {
  if (value === 'granted') return 'ok';
  if (value === 'denied') return 'no';
  if (value === 'required-by-system') return 'sys';
  return value.slice(0, 6);
}

function fit(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 1) return '…';

  let output = '';
  for (const char of value) {
    if (stringWidth(`${output}${char}…`) > width) break;
    output += char;
  }
  return `${output}…`;
}

export default DesktopUsePanePanel;
