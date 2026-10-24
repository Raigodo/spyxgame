import { describe, expect, it } from "vitest";
import { as, type PeerId } from "@/kernel";
import { decideDeadLinkAction } from "./link-policy";

const id = as<PeerId>;

describe("decideDeadLinkAction", () => {
  it("a host always reconnects", () => {
    expect(decideDeadLinkAction({ isHost: true, peerId: id("g"), hostPeerId: id("me") })).toBe(
      "reconnect-as-host"
    );
  });
  it("a guest reconnects only for the host's link", () => {
    expect(decideDeadLinkAction({ isHost: false, peerId: id("h"), hostPeerId: id("h") })).toBe(
      "reconnect-as-guest"
    );
  });
  it("a guest drops any other dead link (never read as a dead host)", () => {
    expect(decideDeadLinkAction({ isHost: false, peerId: id("x"), hostPeerId: id("h") })).toBe(
      "drop-stale"
    );
    expect(decideDeadLinkAction({ isHost: false, peerId: id("x"), hostPeerId: undefined })).toBe(
      "drop-stale"
    );
  });
});
