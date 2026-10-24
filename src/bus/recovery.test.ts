import { describe, expect, it } from "vitest";
import { as, type ChannelId, type PeerId } from "@/kernel";
import { FakeClock } from "@/kernel/fakes";
import { DEFAULT_BUS_CONFIG } from "./config";
import { BusRecovery, type RecoveryResult } from "./recovery";
import type { ChannelCopy } from "./wire";

const peer = as<PeerId>;
const copy = (ch: string, epoch: number, rev: number): ChannelCopy => ({
  ch: as<ChannelId>(ch),
  epoch,
  rev,
  asOf: 0,
  value: {},
  applied: {},
});

function make(expected: string[], linked: string[] = expected) {
  const clock = new FakeClock();
  const results: RecoveryResult[] = [];
  const recovery = new BusRecovery({
    clock,
    config: DEFAULT_BUS_CONFIG,
    expectedPeerIds: () => expected.map(peer),
    linkedPeerIds: () => linked.map(peer),
    onFinish: (r) => results.push(r),
  });
  return { clock, recovery, results };
}

describe("BusRecovery", () => {
  it("finishes at once when nobody is expected", () => {
    const { recovery, results } = make([]);
    recovery.checkComplete();
    expect(results).toHaveLength(1);
  });

  it("finishes when every expected peer has offered", () => {
    const { recovery, results } = make(["a", "b"]);
    recovery.recordOffer(peer("a"), [copy("c", 1, 1)]);
    expect(results).toHaveLength(0);
    recovery.recordOffer(peer("b"), [copy("c", 1, 2)]);
    expect(results).toHaveLength(1);
    expect(results[0]?.offers).toBe(2);
  });

  it("adopts the strictly newest copy per channel", () => {
    const { recovery, results } = make(["a", "b"]);
    recovery.recordOffer(peer("a"), [copy("c", 1, 5), copy("d", 1, 1)]);
    recovery.recordOffer(peer("b"), [copy("c", 1, 3), copy("d", 2, 0)]);
    const best = results[0]?.best;
    expect(best?.get(as<ChannelId>("c"))?.rev).toBe(5);
    expect(best?.get(as<ChannelId>("d"))?.epoch).toBe(2);
  });

  it("the sliding window finishes after the last activity", () => {
    const { clock, recovery, results } = make(["a", "b"]);
    recovery.recordOffer(peer("a"), [copy("c", 1, 1)]);
    clock.advance(2_999);
    expect(results).toHaveLength(0);
    clock.advance(1);
    expect(results).toHaveLength(1);
  });

  it("after the link grace only active links are waited for", () => {
    const { clock, recovery, results } = make(["a", "b"], ["a"]);
    recovery.recordOffer(peer("a"), [copy("c", 1, 1)]);
    clock.advance(1_999);
    expect(results).toHaveLength(0);
    clock.advance(1);
    expect(results).toHaveLength(1);
  });

  it("the cap finishes it even with no offers", () => {
    const { clock, results } = make(["a"]);
    clock.advance(9_999);
    expect(results).toHaveLength(0);
    clock.advance(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.offers).toBe(0);
  });

  it("holds commands in arrival order", () => {
    const { recovery, results } = make(["a"]);
    const msg = (id: string) => ({
      kind: "command" as const,
      ch: as<ChannelId>("c"),
      id,
      seq: 1,
      type: "t",
      payload: null,
    });
    recovery.hold(msg("1"), peer("a"));
    recovery.hold(msg("2"), peer("a"));
    recovery.recordOffer(peer("a"), []);
    expect(results[0]?.held.map((h) => h.msg.id)).toEqual(["1", "2"]);
  });

  it("finishes once; later input is ignored", () => {
    const { clock, recovery, results } = make(["a"]);
    recovery.recordOffer(peer("a"), []);
    recovery.recordOffer(peer("a"), [copy("c", 9, 9)]);
    clock.advance(60_000);
    expect(results).toHaveLength(1);
    expect(results[0]?.best.size).toBe(0);
  });

  it("cancel prevents finishing", () => {
    const { clock, recovery, results } = make(["a"]);
    recovery.cancel();
    clock.advance(60_000);
    recovery.checkComplete();
    expect(results).toHaveLength(0);
  });
});
