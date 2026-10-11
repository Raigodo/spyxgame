import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { IceBatcher } from "./ice-batcher";

const c = (n: number) => ({ candidate: `c${n}` });

function setup(maxBatch = 3) {
  const clock = new FakeClock();
  const send = vi.fn();
  return { clock, send, batcher: new IceBatcher({ clock, windowMs: 300, maxBatch, send }) };
}

describe("IceBatcher", () => {
  it("sends everything collected in the window as one batch", () => {
    const { clock, send, batcher } = setup();
    batcher.add(c(1));
    clock.advance(100);
    batcher.add(c(2));
    clock.advance(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([c(1), c(2)]);
  });
  it("flushes at once when the batch is full, and starts a new window after", () => {
    const { clock, send, batcher } = setup();
    [1, 2, 3].forEach((n) => batcher.add(c(n)));
    expect(send).toHaveBeenCalledTimes(1);
    batcher.add(c(4));
    clock.advance(300);
    expect(send).toHaveBeenLastCalledWith([c(4)]);
  });
  it("cancel drops pending candidates and the timer", () => {
    const { clock, send, batcher } = setup();
    batcher.add(c(1));
    batcher.cancel();
    clock.advance(1_000);
    expect(send).not.toHaveBeenCalled();
  });
  it("flush with nothing pending sends nothing", () => {
    const { send, batcher } = setup();
    batcher.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
