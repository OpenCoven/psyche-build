import React from "react";
import { Box, Text, useInput } from "ink";

export interface PairBannerState {
  code: string;
  expiresAt: Date;
}

interface Props {
  code: string;
  expiresAt: Date;
  onDismiss: () => void;
}

/**
 * PairBanner - Inline non-modal banner shown while a bridge pairing window is open.
 *
 * Displays the pairing code with a countdown timer. Auto-dismisses when the
 * caller detects a `pairingEvents.close` event (parent sets banner to null).
 * Press `q` to dismiss early.
 */
export const PairBanner: React.FC<Props> = ({ code, expiresAt, onDismiss }) => {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useInput((input) => {
    if (input === "q") onDismiss();
  });

  const remainingMs = Math.max(0, expiresAt.getTime() - now);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);
  const formatted = code.split("").join(" ");

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
      <Text>
        <Text color="magenta" bold>psyche pair</Text>
        {"  "}
        <Text bold>{formatted}</Text>
        {"  "}
        <Text dimColor>expires in {mm}:{String(ss).padStart(2, "0")}</Text>
      </Text>
      <Text dimColor>
        Open psyche on your iPhone, tap "Add Mac", enter the code. Press q to dismiss.
      </Text>
    </Box>
  );
};

export default PairBanner;
