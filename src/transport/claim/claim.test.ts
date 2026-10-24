import { describe, expect, it } from "vitest";
import { as, type PeerId, type PlayerId, type RoomId } from "@/kernel";
import { FakeClock, MemoryKeyValueStore } from "@/kernel/fakes";
import { HostClaim } from "./host-claim";
import { confirmedGone, parseClaim } from "./rules";

describe("parseClaim", () => {
  it("accepts a valid claim, with or without leftAt", () => {
    expect(parseClaim('{"playerId":"p","peerId":"x"}')).toEqual({
      playerId: "p",
      peerId: "x",
      leftAt: undefined,
    });
    expect(parseClaim('{"playerId":"p","peerId":"x","leftAt":5}')?.leftAt).toBe(5);
  });
  it("treats stored text as untrusted", () => {
    for (const bad of [
      undefined,
      "",
      "nope",
      "null",
      "[]",
      '{"playerId":1,"peerId":"x"}',
      '{"playerId":"p"}',
    ]) {
      expect(parseClaim(bad)).toBeUndefined();
    }
    expect(parseClaim('{"playerId":"p","peerId":"x","leftAt":"soon"}')?.leftAt).toBeUndefined();
  });
});

describe("confirmedGone", () => {
  const claim = { playerId: "p", peerId: "x" };
  it("true only for a recent pagehide stamp", () => {
    expect(confirmedGone(claim, 100, 15_000)).toBe(false);
    expect(confirmedGone({ ...claim, leftAt: 1_000 }, 16_000, 15_000)).toBe(true);
    expect(confirmedGone({ ...claim, leftAt: 1_000 }, 16_001, 15_000)).toBe(false);
  });
});

describe("HostClaim", () => {
  const room = as<RoomId>("r");
  const player = as<PlayerId>("p");
  const peer = as<PeerId>("x");
  const make = () => {
    const clock = new FakeClock();
    const store = new MemoryKeyValueStore();
    return {
      clock,
      store,
      claim: new HostClaim({ store, clock, config: { hostClaimMaxAgeMs: 15_000 } }),
    };
  };

  it("recalls the remembered seat for the same player only", () => {
    const { claim } = make();
    expect(claim.recall(room, player)).toBeUndefined();
    claim.remember(room, player, peer);
    expect(claim.recall(room, player)).toEqual({ peerId: "x", confirmedGone: false });
    expect(claim.recall(room, as<PlayerId>("other"))).toBeUndefined();
  });
  it("markLeaving stamps the claim, trusted only within the max age", () => {
    const { claim, clock } = make();
    claim.remember(room, player, peer);
    claim.markLeaving(room);
    expect(claim.recall(room, player)?.confirmedGone).toBe(true);
    clock.advance(15_001);
    expect(claim.recall(room, player)?.confirmedGone).toBe(false);
  });
  it("markLeaving without a claim is harmless; forget removes the claim", () => {
    const { claim } = make();
    claim.markLeaving(room);
    expect(claim.recall(room, player)).toBeUndefined();
    claim.remember(room, player, peer);
    claim.forget(room);
    expect(claim.recall(room, player)).toBeUndefined();
  });
  it("a corrupt stored value is ignored", () => {
    const { claim, store } = make();
    store.set(room, "garbage");
    expect(claim.recall(room, player)).toBeUndefined();
  });
});
