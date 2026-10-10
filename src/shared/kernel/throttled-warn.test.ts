import { describe, expect, it } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { createThrottledWarn } from "./throttled-warn";

describe("createThrottledWarn", () => {
  it("logs the first warning and suppresses repeats inside the interval", () => {
    const log = new RecordingLogger();
    const warn = createThrottledWarn(log, new FakeClock(), 1_000);
    warn("k", "bad", { from: "a" });
    warn("k", "bad", { from: "a" });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.data).toEqual({ from: "a" });
  });
  it("reports how many were suppressed once the interval passes", () => {
    const log = new RecordingLogger();
    const clock = new FakeClock();
    const warn = createThrottledWarn(log, clock, 1_000);
    warn("k", "bad", { from: "a" });
    warn("k", "bad", { from: "a" });
    warn("k", "bad", { from: "a" });
    clock.advance(1_000);
    warn("k", "bad", { from: "a" });
    expect(log.entries).toHaveLength(2);
    expect(log.entries[1]?.data).toEqual({ from: "a", suppressed: 2 });
  });
  it("keeps keys independent", () => {
    const log = new RecordingLogger();
    const warn = createThrottledWarn(log, new FakeClock(), 1_000);
    warn("a", "bad");
    warn("b", "bad");
    expect(log.entries).toHaveLength(2);
  });
});
