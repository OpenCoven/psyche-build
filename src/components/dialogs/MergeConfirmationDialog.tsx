import React from 'react';
import { Box, Text } from 'ink';
import type { PsychePane } from '../../types.js';
import { COLORS } from '../../theme/colors.js';

interface MergeConfirmationDialogProps {
  pane: PsychePane;
}

const MergeConfirmationDialog: React.FC<MergeConfirmationDialogProps> = ({ pane }) => {
  return (
    <Box borderStyle="double" borderColor={COLORS.success} paddingX={1} marginTop={1}>
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={COLORS.success} bold>Worktree merged successfully!</Text>
        </Box>
        <Text>Close the pane "{pane.slug}"? (y/n)</Text>
      </Box>
    </Box>
  );
};

export default MergeConfirmationDialog;
