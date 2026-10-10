import { describe, expect, it, vi } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { nextMacrotask } from "@/shared/testing/next-macrotask";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import type { SignalingSession } from "../signaling";
import { HostReclaimController } from "./host-reclaim-controller";

type ClaimResult = "claimed" | "former-present" | "host-changed";

function setup(results: ClaimResult[]) {
  let onLeft: (peer: { peerId: string }) => void = () => {};
  const claimHost = vi.fn(async () => results.shift() ?? "host-changed");
  const removePeer = vi.fn(async () => {});
  const session = {
    host: { claimHost },
    removePeer,
    onPeerLeft: (handler: (peer: { peerId: string }) => void) => {
      onLeft = handler;
      return () => {};
    },
  } as unknown as SignalingSession;
  const clock = new FakeClock();
  const config = createConfig().webrtc;
  const controller = new HostReclaimController({
    session,
    clock,
    logger: new RecordingLogger(),
    config,
  });
  return {
    controller,
    claimHost,
    removePeer,
    clock,
    config,
    leave: (id: string) => onLeft({ peerId: id }),
  };
}

describe("HostReclaimController", () => {
  it("keeps waiting while the former peer is present, then claims when it leaves", async () => {
    const { controller, claimHost, leave } = setup(["former-present", "claimed"]);
    controller.start({ peerId: "old", confirmedGone: false });
    await nextMacrotask();
    expect(controller.former).toBe("old");

    leave("old");
    await nextMacrotask();
    expect(claimHost).toHaveBeenCalledTimes(2);
    expect(controller.former).toBeUndefined();
  });

  it("with a pagehide stamp, removes the former peer first and then claims", async () => {
    const { controller, claimHost, removePeer } = setup(["claimed"]);
    controller.start({ peerId: "old", confirmedGone: true });
    await nextMacrotask();
    expect(removePeer).toHaveBeenCalledWith("old");
    expect(claimHost).toHaveBeenCalledTimes(1);
    expect(controller.former).toBeUndefined();
  });

  it("makes a final attempt when the window ends and then stops", async () => {
    const { controller, claimHost, clock, config } = setup(["former-present", "former-present"]);
    controller.start({ peerId: "old", confirmedGone: false });
    await nextMacrotask();
    clock.advance(config.reclaimWindowMs);
    await nextMacrotask();
    expect(claimHost).toHaveBeenCalledTimes(2);
    expect(controller.former).toBeUndefined();
  });

  it("stops when the host document names someone else, not when it still names the former", async () => {
    const { controller } = setup(["former-present"]);
    controller.start({ peerId: "old", confirmedGone: false });
    await nextMacrotask();

    controller.onHostDocument("old");
    expect(controller.former).toBe("old");
    controller.onHostDocument("someone-else");
    expect(controller.former).toBeUndefined();
  });
});
