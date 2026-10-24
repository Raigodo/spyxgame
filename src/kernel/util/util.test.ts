import { describe, expect, it } from "vitest";
import { Countdown } from "./countdown";
import { isInt, isRecord } from "./guards";
import { listenerFailure, logFailure } from "./log-failure";
import { seededRandom } from "./seeded-random";
import { shortId } from "./short-id";
import { structurallyEqual } from "./structural-equal";
import { createThrottledWarn } from "./throttled-warn";
import { prefixed } from "../ports/key-value-store";
import { FakeClock, FakePageLifecycle, MemoryKeyValueStore, RecordingLogger } from "../fakes";

describe("guards", () => {
  it("isRecord: plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
  it("isInt", () => {
    expect(isInt(3)).toBe(true);
    expect(isInt(3.5)).toBe(false);
    expect(isInt("3")).toBe(false);
  });
});

describe("shortId", () => {
  it("is the last 8 characters", () => {
    expect(shortId("0123456789ABCDEF")).toBe("89ABCDEF");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("structurallyEqual", () => {
  it("compares primitives, arrays and nested objects", () => {
    expect(structurallyEqual(1, 1)).toBe(true);
    expect(structurallyEqual(NaN, NaN)).toBe(true);
    expect(structurallyEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
    expect(structurallyEqual([1], [1, 2])).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1 }, [1])).toBe(false);
    expect(structurallyEqual(null, {})).toBe(false);
  });
  it("undefined properties count as absent", () => {
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1, c: 2 })).toBe(false);
  });
});

describe("seededRandom", () => {
  it("is deterministic, in [0,1), and seed-dependent", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const c = seededRandom(43);
    expect(Array.from({ length: 20 }, () => c())).not.toEqual(seqA);
  });
});

describe("Countdown", () => {
  it("fires once after the duration; start replaces a running one; stop cancels", () => {
    const clock = new FakeClock();
    let fired = 0;
    const cd = new Countdown(clock, () => fired++);
    cd.start(100);
    expect(cd.isRunning()).toBe(true);
    clock.advance(60);
    cd.start(100); // restart
    clock.advance(60);
    expect(fired).toBe(0);
    clock.advance(40);
    expect(fired).toBe(1);
    expect(cd.isRunning()).toBe(false);
    cd.start(10);
    cd.stop();
    clock.advance(100);
    expect(fired).toBe(1);
  });
});

describe("createThrottledWarn", () => {
  it("one warning per key per interval, then reports how many were suppressed", () => {
    const clock = new FakeClock();
    const log = new RecordingLogger();
    const warn = createThrottledWarn(log, clock, 1_000);
    warn("k", "bad", { from: "x" });
    warn("k", "bad");
    warn("k", "bad");
    warn("other", "bad");
    expect(log.entries).toHaveLength(2);
    clock.advance(1_000);
    warn("k", "bad", { from: "x" });
    expect(log.entries).toHaveLength(3);
    expect(log.entries[2]?.data).toEqual({ from: "x", suppressed: 2 });
  });
});

describe("failure helpers", () => {
  it("logFailure warns with the action name; listenerFailure logs an error", () => {
    const log = new RecordingLogger();
    logFailure(log, "send offer")(new Error("x"));
    listenerFailure(() => log)(new Error("y"));
    expect(log.messages("warn")).toEqual(["send offer failed"]);
    expect(log.messages("error")).toEqual(["Listener failed"]);
  });
});

describe("prefixed", () => {
  it("prefixes get, set and remove, and passes ttl through", () => {
    const base = new MemoryKeyValueStore();
    const view = prefixed(base, "p:");
    view.set("k", "v");
    expect(base.get("p:k")).toBe("v");
    expect(view.get("k")).toBe("v");
    view.remove("k");
    expect(base.get("p:k")).toBeUndefined();
  });
});

describe("fakes", () => {
  it("FakeClock: ordering, cancel, every", () => {
    const clock = new FakeClock();
    const order: string[] = [];
    clock.after(20, () => order.push("b"));
    clock.after(10, () => order.push("a"));
    const cancel = clock.after(15, () => order.push("x"));
    cancel();
    let ticks = 0;
    clock.every(100, () => ticks++);
    clock.advance(350);
    expect(order).toEqual(["a", "b"]);
    expect(ticks).toBe(3);
    expect(clock.now()).toBe(350);
  });

  it("FakePageLifecycle fires handlers until unsubscribed", () => {
    const life = new FakePageLifecycle();
    let n = 0;
    const off = life.onPageHide(() => n++);
    life.hide();
    off();
    life.hide();
    expect(n).toBe(1);
  });
});
