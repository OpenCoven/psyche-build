import { useEffect, useState } from 'react';
import { TmuxService } from '../services/TmuxService.js';
import { resolveSidePanelLayoutWidth } from '../utils/sidePanel.js';

/**
 * Reads the width the responsive layout should be measured against.
 *
 * Inside tmux this is the window width, not `process.stdout.columns` — psyche
 * renders in its own narrow sidebar pane, so stdout reports the sidebar rather
 * than the terminal. Outside tmux stdout is the terminal, so it is used as-is.
 */
function readLayoutWidth(): number {
  let tmuxWindowWidth: number | null = null;

  if (process.env.TMUX) {
    try {
      const { width } = TmuxService.getInstance().getWindowDimensionsSync();
      tmuxWindowWidth = width;
    } catch {
      // Fall back to stdout below; a missing tmux answer is not fatal here.
      tmuxWindowWidth = null;
    }
  }

  return resolveSidePanelLayoutWidth(tmuxWindowWidth, process.stdout.columns);
}

export default function useLayoutWidth() {
  const [layoutWidth, setLayoutWidth] = useState<number>(() => readLayoutWidth());

  useEffect(() => {
    const handleResize = () => {
      setLayoutWidth(readLayoutWidth());
    };

    // The sidebar pane keeps its width when the window grows, so stdout's own
    // resize event can stay silent. tmux's hook (SIGUSR1) and SIGWINCH still
    // fire, which is how a widened window reaches us.
    process.stdout.on('resize', handleResize);
    process.on('SIGWINCH', handleResize);
    process.on('SIGUSR1', handleResize);

    return () => {
      process.stdout.off('resize', handleResize);
      process.off('SIGWINCH', handleResize);
      process.off('SIGUSR1', handleResize);
    };
  }, []);

  return layoutWidth;
}
