import { describe, expect, it } from "vitest";
import { FakeClock } from "@/kernel/fakes";
import { IceBatcher } from "./ice-batcher";

const c = (n: number) => ({ candidate: `c${n}` });

function make(maxBatch = 3) {
  const clock = new FakeClock();
  const batches: string[][] = [];
  const b = new IceBatcher({
    clock,
    windowMs: 300,
    maxBatch,
    send: (list) => batches.push(list.map((x) => x.candidate ?? "")),
  });
  return { clock, batches, b };
}

describe("IceBatcher", () => {
  it("sends one batch when the window ends", () => {
    const { clock, batches, b } = make();
    b.add(c(1));
    b.add(c(2));
    clock.advance(299);
    expect(batches).toEqual([]);
    clock.advance(1);
    expect(batches).toEqual([["c1", "c2"]]);
  });
  it("the window starts at the first candidate and does not slide", () => {
    const { clock, batches, b } = make();
    b.add(c(1));
    clock.advance(200);
    b.add(c(2));
    clock.advance(100);
    expect(batches).toEqual([["c1", "c2"]]);
  });
  it("flushes at once at maxBatch and cancels the timer", () => {
    const { clock, batches, b } = make(2);
    b.add(c(1));
    b.add(c(2));
    expect(batches).toEqual([["c1", "c2"]]);
    clock.advance(1_000);
    expect(batches).toHaveLength(1);
  });
  it("cancel drops what is pending; flush with nothing sends nothing", () => {
    const { clock, batches, b } = make();
    b.add(c(1));
    b.cancel();
    clock.advance(1_000);
    b.flush();
    expect(batches).toEqual([]);
  });
});
