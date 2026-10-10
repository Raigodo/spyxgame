import { expect, it } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { Countdown } from "./countdown";

it("isRunning is true from start until it fires or is stopped", () => {
  const clock = new FakeClock();
  const countdown = new Countdown(clock, () => {});
  expect(countdown.isRunning()).toBe(false);
  countdown.start(100);
  expect(countdown.isRunning()).toBe(true);
  clock.advance(100);
  expect(countdown.isRunning()).toBe(false);
  countdown.start(100);
  countdown.stop();
  expect(countdown.isRunning()).toBe(false);
});
