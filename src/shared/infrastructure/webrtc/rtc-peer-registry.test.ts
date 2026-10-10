import { expect, it } from "vitest";
import { NullLogger } from "@/shared/kernel";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";
import { RtcPeerRegistry } from "./rtc-peer-registry";

it("inspect lists each peer with its status and link state", () => {
  const registry = new RtcPeerRegistry({ logger: new NullLogger() });
  registry.add("p", {
    negotiator: { close: () => {} } as unknown as RtcLinkNegotiator,
    connection: null,
    status: "connecting",
  });
  expect(registry.inspect()).toEqual({ p: { status: "connecting", linkState: null } });
});
