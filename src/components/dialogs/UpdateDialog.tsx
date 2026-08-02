import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../theme/colors.js';

interface UpdateDialogProps {
  updateInfo: any;
}

const UpdateDialog: React.FC<UpdateDialogProps> = ({ updateInfo }) => {
  if (!updateInfo) return null;
  return (
    <Box borderStyle="double" borderColor={COLORS.accent} paddingX={1} marginTop={1}>
      <Box flexDirection="column">
        <Text color={COLORS.accent} bold>🎉 psyche Update Available!</Text>
        <Text>
          Current version: <Text color={COLORS.info}>{updateInfo.currentVersion}</Text>
        </Text>
        <Text>
          Latest version: <Text color={COLORS.accent}>{updateInfo.latestVersion}</Text>
        </Text>
        {updateInfo.installMethod === 'global' && updateInfo.packageManager && (
          <Text>
            Detected global install via: <Text color="yellow">{updateInfo.packageManager}</Text>
          </Text>
        )}
        <Box marginTop={1}>
          {updateInfo.installMethod === 'global' && updateInfo.packageManager ? (
            <Text>
              [U]pdate now • [S]kip this version • [L]ater
            </Text>
          ) : (
            <Text>
              Manual update required: <Text color={COLORS.info}>{updateInfo.packageManager || 'npm'} update -g psyche</Text>
              {'\n'}[S]kip this version • [L]ater
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default UpdateDialog;
