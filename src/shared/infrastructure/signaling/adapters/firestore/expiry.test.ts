import { expect, it } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { expiresAt } from "./expiry";

it("adds the TTL to now by default", () => {
  const clock = new FakeClock();
  clock.advance(1_000);
  expect(expiresAt(clock, 500).toMillis()).toBe(1_500);
});

it("adds the TTL to an explicit start time", () => {
  expect(expiresAt(new FakeClock(), 500, 10_000).toMillis()).toBe(10_500);
});
