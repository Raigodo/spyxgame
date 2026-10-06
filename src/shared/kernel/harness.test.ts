import { describe, expect, it, vi } from "vitest";

describe("test harness", () => {
  it("runs and supports fake timers", () => {
    vi.useFakeTimers();
    let fired = false;
    setTimeout(() => (fired = true), 1_000);
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(true);
    vi.useRealTimers();
  });
});
