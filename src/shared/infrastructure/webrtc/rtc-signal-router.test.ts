import { describe, expect, it, vi } from "vitest";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcSignalRouter } from "./rtc-signal-router";
import type { PeerEntry } from "./types";

function setup() {
  const logger = new RecordingLogger();
  const registry = new RtcPeerRegistry({ logger });
  const negotiator = {
    applyOffer: vi.fn(async () => {}),
    applyAnswer: vi.fn(async () => {}),
    applyIceCandidate: vi.fn(async () => {}),
    close: () => {},
  };
  const makeEntry = (): PeerEntry => ({
    negotiator: negotiator as unknown as RtcLinkNegotiator,
    connection: null,
    status: "connecting",
  });
  const create = vi.fn(makeEntry);
  const linkFactory = { create } as unknown as RtcPeerLinkFactory;
  const router = new RtcSignalRouter({ registry, linkFactory, logger });
  return { router, registry, negotiator, create, logger, makeEntry };
}

describe("RtcSignalRouter", () => {
  it("an offer from an unknown peer creates and registers a link, then applies it", async () => {
    const { router, registry, negotiator, create } = setup();
    await router.handle("p", { type: "offer", sdp: "s" });
    expect(create).toHaveBeenCalledWith("p");
    expect(registry.has("p")).toBe(true);
    expect(negotiator.applyOffer).toHaveBeenCalledWith({ type: "offer", sdp: "s" });
  });

  it("an offer from a known peer reuses its link", async () => {
    const { router, registry, create, makeEntry } = setup();
    registry.add("p", makeEntry());
    await router.handle("p", { type: "offer", sdp: "s" });
    expect(create).not.toHaveBeenCalled();
  });

  it("an answer or ICE candidate from an unknown peer is ignored with a warning", async () => {
    const { router, negotiator, logger } = setup();
    await router.handle("p", { type: "answer", sdp: "s" });
    await router.handle("p", { type: "ice-candidate", candidate: { candidate: "c" } });
    expect(negotiator.applyAnswer).not.toHaveBeenCalled();
    expect(negotiator.applyIceCandidate).not.toHaveBeenCalled();
    expect(logger.messages("warn")).toHaveLength(2);
  });

  it("forwards an answer and an ICE candidate to a known peer's negotiator", async () => {
    const { router, registry, negotiator, makeEntry } = setup();
    registry.add("p", makeEntry());
    await router.handle("p", { type: "answer", sdp: "a" });
    await router.handle("p", { type: "ice-candidate", candidate: { candidate: "c" } });
    expect(negotiator.applyAnswer).toHaveBeenCalledWith({ type: "answer", sdp: "a" });
    expect(negotiator.applyIceCandidate).toHaveBeenCalledWith({ candidate: "c" });
  });
});
