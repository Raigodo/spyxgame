import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { BusRecovery, type RecoveryResult } from "./bus-recovery";
import type { ChannelCopy } from "./wire";

const copy = (rev: number): ChannelCopy => ({ ch: "n", epoch: 1, rev, value: rev, applied: {} });
const command = {
  __bus: 1 as const,
  kind: "command" as const,
  ch: "n",
  id: "c",
  seq: 1,
  type: "t",
  payload: 0,
};

function setup(expected: string[]) {
  const clock = new FakeClock();
  const onFinish = vi.fn<(r: RecoveryResult) => void>();
  const recovery = new BusRecovery({
    clock,
    windowMs: 3_000,
    maxMs: 10_000,
    getExpectedPeerIds: () => expected,
    onFinish,
  });
  return { clock, recovery, onFinish };
}

describe("BusRecovery", () => {
  it("finishes at once when nobody is expected", () => {
    const { recovery, onFinish } = setup([]);
    recovery.checkComplete();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("finishes when every expected peer has offered, and only once", () => {
    const { recovery, onFinish } = setup(["a", "b"]);
    recovery.recordOffer("a", [copy(1)]);
    expect(onFinish).not.toHaveBeenCalled();
    recovery.recordOffer("b", [copy(2)]);
    recovery.recordOffer("b", [copy(3)]);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0].offers).toBe(2);
  });

  it("keeps the newest copy per channel", () => {
    const { recovery, onFinish } = setup(["a", "b"]);
    recovery.recordOffer("a", [copy(5)]);
    recovery.recordOffer("b", [copy(2)]);
    expect(onFinish.mock.calls[0]?.[0].best.get("n")?.rev).toBe(5);
  });

  it("the window slides: finishes windowMs after the last activity", () => {
    const { clock, recovery, onFinish } = setup(["a", "b"]);
    recovery.recordOffer("a", [copy(1)]);
    clock.advance(2_000);
    recovery.noteActivity();
    clock.advance(2_000);
    expect(onFinish).not.toHaveBeenCalled();
    clock.advance(1_000);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("the cap finishes it even with no activity at all", () => {
    const { clock, onFinish } = setup(["a"]);
    clock.advance(10_000);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("returns held commands in arrival order", () => {
    const { recovery, onFinish } = setup(["a"]);
    recovery.hold(command, "x");
    recovery.hold({ ...command, id: "d" }, "y");
    recovery.recordOffer("a", []);
    expect(onFinish.mock.calls[0]?.[0].held.map((h) => h.w.id)).toEqual(["c", "d"]);
  });

  it("cancel prevents finishing and ignores later input", () => {
    const { clock, recovery, onFinish } = setup(["a"]);
    recovery.cancel();
    recovery.recordOffer("a", [copy(1)]);
    clock.advance(20_000);
    expect(onFinish).not.toHaveBeenCalled();
  });
});
