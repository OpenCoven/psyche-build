import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import PairBanner from "../src/components/ui/PairBanner";

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
});
