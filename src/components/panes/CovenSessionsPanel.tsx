import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { COLORS, getPsycheThemeAccent } from '../../theme/colors.js';
import type { PsycheThemeName } from '../../types.js';
import {
  covenSessionsForProject,
  pickCovenSessionToOpen,
  type CovenSessionVisibility,
  type CovenSessionsLoadState,
} from '../../utils/covenSessions.js';

interface CovenSessionsPanelProps {
  projectRoot: string;
  state: CovenSessionsLoadState;
  isActive: boolean;
  themeName: PsycheThemeName;
}

const ROW_WIDTH = 40;
const MAX_SESSIONS_PER_PROJECT = 4;

const CovenSessionsPanel: React.FC<CovenSessionsPanelProps> = memo(({
  projectRoot,
  state,
  isActive,
  themeName,
}) => {
  const accent = getPsycheThemeAccent(themeName);
  const sessions = useMemo(
    () => covenSessionsForProject(projectRoot, state.sessions),
    [projectRoot, state.sessions]
  );
  const openTarget = useMemo(
    () => pickCovenSessionToOpen(projectRoot, state.sessions),
    [projectRoot, state.sessions]
  );

  if (sessions.length === 0) {
    if (!isActive) return null;

    if (state.status === 'unavailable') {
      return (
        <Box flexDirection="column" width={ROW_WIDTH}>
          <Text color={COLORS.unselected}>{fit('☾ Coven not running', ROW_WIDTH)}</Text>
          <Text color={COLORS.border}>{fit(covenUnavailableHint(state.reason), ROW_WIDTH)}</Text>
        </Box>
      );
    }

    return (
      <Box width={ROW_WIDTH}>
        <Text color={COLORS.unselected}>{fit('☾ Coven: no sessions yet', ROW_WIDTH)}</Text>
      </Box>
    );
  }

  const visibleSessions = sessions.slice(0, MAX_SESSIONS_PER_PROJECT);
  const hiddenCount = Math.max(0, sessions.length - visibleSessions.length);

  return (
    <Box flexDirection="column" width={ROW_WIDTH}>
      <Text color={isActive ? accent : COLORS.border} bold={isActive}>
        {fit(isActive && openTarget ? '☾ Coven sessions  [o]pen' : '☾ Coven sessions', ROW_WIDTH)}
      </Text>
      {visibleSessions.map((session) => (
        <Text key={session.id}>
          <Text color={statusColor(session.status)}>{statusIcon(session.status)}</Text>
          <Text color={COLORS.border}> </Text>
          <Text color={COLORS.unselected}>{fit(formatSession(session), ROW_WIDTH - 2)}</Text>
        </Text>
      ))}
      {hiddenCount > 0 && (
        <Text color={COLORS.border}>{fit(`  +${hiddenCount} more Coven session${hiddenCount === 1 ? '' : 's'}`, ROW_WIDTH)}</Text>
      )}
      {isActive && openTarget && (
        <Text color={COLORS.border}>{fit(`  [o] open ${openTarget.title || openTarget.id}`, ROW_WIDTH)}</Text>
      )}
    </Box>
  );
});

function formatSession(session: CovenSessionVisibility): string {
  const harness = session.harness ? `[${session.harness}] ` : '';
  const title = session.title || session.id;
  const status = session.status ? ` · ${session.status}` : '';
  return `${harness}${title}${status}`;
}

function covenUnavailableHint(reason: string): string {
  return isCovenCliMissing(reason)
    ? '  install: npm i -g @opencoven/cli'
    : '  run: coven start';
}

function isCovenCliMissing(reason: string): boolean {
  return /\bnot found\b/i.test(reason) || /\bENOENT\b/i.test(reason);
}

function statusIcon(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'starting':
      return '●';
    case 'waiting':
      return '◐';
    case 'completed':
      return '✓';
    case 'archived':
      return '◇';
    case 'failed':
    case 'killed':
    case 'orphaned':
      return '×';
    default:
      return '○';
  }
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'starting':
      return COLORS.success;
    case 'waiting':
      return COLORS.warning;
    case 'completed':
      return COLORS.info;
    case 'failed':
    case 'killed':
    case 'orphaned':
      return COLORS.error;
    default:
      return COLORS.border;
  }
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

export default CovenSessionsPanel;
