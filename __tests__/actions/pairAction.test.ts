import { describe, expect, it, vi } from "vitest";
import { runPairAction } from "../../src/actions/implementations/pairAction";

describe("pairAction", () => {
  it("opens a mobile invite via the daemon and shows its QR payload", async () => {
    const showBanner = vi.fn();
    const fakeDaemon = {
      openMobileInvite: vi.fn(() => "psyche://invite?psyche_invite=secret"),
    };
    await runPairAction({
      bridgeDaemon: fakeDaemon,
      showPairBanner: showBanner,
    });
    expect(fakeDaemon.openMobileInvite).toHaveBeenCalled();
    expect(showBanner).toHaveBeenCalledWith({
      qrPayload: "psyche://invite?psyche_invite=secret",
      inviteId: "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
    });
  });

  it("status-messages when daemon is missing (null)", async () => {
    const setStatusMessage = vi.fn();
    await runPairAction({ bridgeDaemon: null, setStatusMessage });
    expect(setStatusMessage).toHaveBeenCalledWith("bridge daemon not running");
  });

  it("status-messages when daemon is undefined", async () => {
    const setStatusMessage = vi.fn();
    await runPairAction({ bridgeDaemon: undefined, setStatusMessage });
    expect(setStatusMessage).toHaveBeenCalledWith("bridge daemon not running");
  });

  it("does not throw when showPairBanner is omitted", async () => {
    const fakeDaemon = {
      openMobileInvite: vi.fn(() => "psyche://invite?psyche_invite=secret"),
    };
    await expect(runPairAction({ bridgeDaemon: fakeDaemon })).resolves.toBeUndefined();
  });
});
