import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import PairBanner, { shouldDismissPairBanner, type PairBannerState } from "../src/components/ui/PairBanner";

describe("PairBanner", () => {
  it("renders an Open on phone QR invite without exposing its raw URL", () => {
    const invite = "psyche://invite?psyche_invite=super-secret-token";
    const { lastFrame, unmount } = render(
      <PairBanner qrPayload={invite} onDismiss={vi.fn()} />,
    );

    expect(lastFrame()).toContain("Open on phone");
    expect(lastFrame()).not.toContain(invite);
    expect(lastFrame()).not.toContain("super-secret-token");
    unmount();
  });

  it("only dismisses the currently rendered invite when it redeems", () => {
    const inviteA = { qrPayload: "psyche://invite?psyche_invite=first-secret", inviteId: "invite-a" };
    const inviteB = { qrPayload: "psyche://invite?psyche_invite=second-secret", inviteId: "invite-b" };
    const first = render(
      <PairBanner qrPayload={inviteA.qrPayload} onDismiss={vi.fn()} />,
    );
    expect(first.lastFrame()).toContain("Open on phone");
    first.unmount();

    const { lastFrame, unmount } = render(
      <PairBanner qrPayload={inviteB.qrPayload} onDismiss={vi.fn()} />,
    );

    expect(lastFrame()).toContain("Open on phone");
    let displayedInvite: PairBannerState | null = inviteB;
    if (shouldDismissPairBanner(displayedInvite, inviteA.inviteId)) displayedInvite = null;
    expect(displayedInvite).toBe(inviteB);
    if (shouldDismissPairBanner(displayedInvite, inviteB.inviteId)) displayedInvite = null;
    expect(displayedInvite).toBeNull();
    unmount();
  });
});
