import { describe, expect, it, vi } from "vitest";
import { createConfig, NullLogger } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import type { HostElectionService } from "../signaling";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcReconnectionManager } from "./rtc-reconnection-manager";
import type { PeerEntry } from "./types";

function setup() {
  const clock = new FakeClock();
  const logger = new NullLogger();
  const registry = new RtcPeerRegistry({ logger });
  const makeEntry = (): PeerEntry => ({
    negotiator: { close: () => {} } as unknown as RtcLinkNegotiator,
    connection: null,
    status: "active",
  });
  const linkFactory = { create: () => makeEntry() } as unknown as RtcPeerLinkFactory;
  const election = {
    reportSuspectedDeath: vi.fn(),
    getSuspectedDeadHostId: () => undefined,
    cancelPendingElection: vi.fn(),
  } as unknown as HostElectionService;
  const config = createConfig().webrtc;
  const manager = new RtcReconnectionManager({
    registry,
    linkFactory,
    getHostElection: () => election,
    isHost: () => false,
    isLeaving: () => false,
    getHostPeerId: () => "host",
    clock,
    logger,
    config,
  });
  registry.add("host", makeEntry());
  return { clock, registry, manager, config, election };
}

describe("guest reconnect", () => {
  it("marks the host reconnecting, reports suspicion, then removes it if no offer comes", async () => {
    const { clock, registry, manager, config, election } = setup();
    await manager.handleConnectionDied("host");
    expect(registry.get("host")?.status).toBe("reconnecting");
    expect(election.reportSuspectedDeath).toHaveBeenCalledWith("host");
    clock.advance(config.reconnectTimeoutMs);
    expect(registry.has("host")).toBe(false);
  });
  it("cancels the pending removal on stop()", async () => {
    const { clock, registry, manager, config } = setup();
    await manager.handleConnectionDied("host");
    manager.stop();
    clock.advance(config.reconnectTimeoutMs);
    expect(registry.has("host")).toBe(true);
  });
});
