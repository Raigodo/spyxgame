import { expect, it, vi } from "vitest";
import { NullLogger } from "@/shared/kernel";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { ActiveRtcConnection } from "./active-rtc-connection";

it("inspect lists each peer with its status and link state", () => {
  const registry = new RtcPeerRegistry({ logger: new NullLogger() });
  registry.add("p", {
    negotiator: { close: () => {} } as unknown as RtcLinkNegotiator,
    connection: null,
    status: "connecting",
  });
  expect(registry.inspect()).toEqual({ p: { status: "connecting", linkState: null } });
});

it("remove takes the entry out of the map before closing its link, and announces it once", () => {
  const registry = new RtcPeerRegistry({ logger: new NullLogger() });
  let presentWhenClosed: boolean | undefined;
  const left = vi.fn();
  registry.onPeerLeft(left);
  registry.add("p", {
    negotiator: { close: () => {} } as unknown as RtcLinkNegotiator,
    connection: {
      close: () => {
        presentWhenClosed = registry.has("p");
      },
    } as unknown as ActiveRtcConnection,
    status: "active",
  });
  registry.remove("p");
  registry.remove("p");
  expect(presentWhenClosed).toBe(false);
  expect(left).toHaveBeenCalledTimes(1);
});
