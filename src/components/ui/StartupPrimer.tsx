import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../theme/colors.js';

interface StartupPrimerProps {
  show: boolean;
}

const StartupPrimer: React.FC<StartupPrimerProps> = memo(({ show }) => {
  if (!show) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={COLORS.accent}>New to psyche</Text>
      <Text dimColor>Sidebar focused: arrows move, Enter activates, n agent, t terminal, e renames.</Text>
      <Text dimColor>Mouse mode: click a thread/worktree to select; double-click to rename.</Text>
      <Text dimColor>Pane focused: Ctrl-b then Left returns to the sidebar.</Text>
      <Text dimColor>Press ? for shortcuts. Press Shift+D to hide this.</Text>
    </Box>
  );
});

export default StartupPrimer;
