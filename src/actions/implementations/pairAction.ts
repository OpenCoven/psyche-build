/**
 * PAIR Action - Open a mobile invite on the bridge daemon and show a TUI banner.
 *
 * This is a session-level command (not a pane action), invoked via the `:pair`
 * colon command in useInputHandling.ts.
 */

export interface PairActionContext {
  bridgeDaemon: {
    openMobileInvite(): string;
  } | null | undefined;
  setStatusMessage?: (msg: string) => void;
  showPairBanner?: (opts: { qrPayload: string }) => void;
}

export async function runPairAction(ctx: PairActionContext): Promise<void> {
  if (!ctx.bridgeDaemon) {
    ctx.setStatusMessage?.("bridge daemon not running");
    return;
  }
  const qrPayload = ctx.bridgeDaemon.openMobileInvite();
  ctx.showPairBanner?.({ qrPayload });
}
