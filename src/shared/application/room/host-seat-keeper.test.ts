import { describe, expect, it } from "vitest";
import { createPlayerStores } from "@/shared/infrastructure/player";
import { MemoryKeyValueStore } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakePageLifecycle } from "@/shared/testing/fake-page-lifecycle";
import { HostSeatKeeper } from "./host-seat-keeper";

function setup(host: boolean) {
  const state = { host };
  const claims = createPlayerStores({
    tabStore: new MemoryKeyValueStore(),
    profileStore: new MemoryKeyValueStore(),
    clock: new FakeClock(),
  }).hostClaims;
  const lifecycle = new FakePageLifecycle();
  const keeper = new HostSeatKeeper(claims, lifecycle);
  const source = { isHost: () => state.host, getLocalPeerId: () => "peer1" };
  return { state, keeper, lifecycle, source };
}

describe("HostSeatKeeper", () => {
  it("remembers the seat only while host", () => {
    const guest = setup(false);
    guest.keeper.remember("r", "p", guest.source);
    expect(guest.keeper.recall("r", "p")).toBeUndefined();

    const host = setup(true);
    host.keeper.remember("r", "p", host.source);
    expect(host.keeper.recall("r", "p")).toEqual({ peerId: "peer1", confirmedGone: false });
  });

  it("pagehide stamps the seat so the reload knows the old page is gone", () => {
    const { keeper, lifecycle, source } = setup(true);
    keeper.remember("r", "p", source);
    keeper.watchPageHide("r", source);
    lifecycle.hide();
    expect(keeper.recall("r", "p")?.confirmedGone).toBe(true);
  });

  it("pagehide does nothing for a guest, or after unsubscribing", () => {
    const { state, keeper, lifecycle, source } = setup(true);
    keeper.remember("r", "p", source);
    const off = keeper.watchPageHide("r", source);
    state.host = false;
    lifecycle.hide();
    expect(keeper.recall("r", "p")?.confirmedGone).toBe(false);

    state.host = true;
    off();
    lifecycle.hide();
    expect(keeper.recall("r", "p")?.confirmedGone).toBe(false);
  });

  it("forget removes the seat", () => {
    const { keeper, source } = setup(true);
    keeper.remember("r", "p", source);
    keeper.forget("r");
    expect(keeper.recall("r", "p")).toBeUndefined();
  });
});
