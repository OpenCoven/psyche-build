import React from "react";
import { Box, Text, useInput } from "ink";
import QRCode from "./QRCode.js";

export interface PairBannerState {
  qrPayload: string;
}

interface Props {
  qrPayload: string;
  onDismiss: () => void;
}

/**
 * PairBanner - Inline non-modal banner shown while a mobile invite is open.
 *
 * Displays a scannable QR payload without printing the raw invite URL. Press
 * `q` to dismiss early.
 */
export const PairBanner: React.FC<Props> = ({ qrPayload, onDismiss }) => {
  useInput((input) => {
    if (input === "q") onDismiss();
  });

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
      <Text>
        <Text color="magenta" bold>Open on phone</Text>
      </Text>
      <Text dimColor>
        Scan this code in Psyche to connect this Mac. Press q to dismiss.
      </Text>
      <QRCode url={qrPayload} />
    </Box>
  );
};

export default PairBanner;
