import { mobileInviteId } from "../../services/bridge/MobileInviteStore.js";

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
  showPairBanner?: (opts: { qrPayload: string; inviteId: string }) => void;
}

export async function runPairAction(ctx: PairActionContext): Promise<void> {
  if (!ctx.bridgeDaemon) {
    ctx.setStatusMessage?.("bridge daemon not running");
    return;
  }
  const qrPayload = ctx.bridgeDaemon.openMobileInvite();
  const inviteToken = new URL(qrPayload).searchParams.get("psyche_invite");
  if (!inviteToken) throw new Error("bridge returned an invalid mobile invite");
  ctx.showPairBanner?.({ qrPayload, inviteId: mobileInviteId(inviteToken) });
}
