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
  let inviteToken: string | null = null;
  try {
    inviteToken = new URL(qrPayload).searchParams.get("psyche_invite");
  } catch {
    ctx.setStatusMessage?.("bridge returned an invalid mobile invite");
    return;
  }
  if (!inviteToken) {
    ctx.setStatusMessage?.("bridge returned an invalid mobile invite");
    return;
  }
  ctx.showPairBanner?.({ qrPayload, inviteId: mobileInviteId(inviteToken) });
}
