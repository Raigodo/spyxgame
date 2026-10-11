import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";

const timers = readFileSync(
  fileURLToPath(new URL("../../../docs/timers.md", import.meta.url)),
  "utf8"
);

const timerKeys = Object.values(DEFAULT_CONFIG).flatMap((section) =>
  Object.keys(section).filter((key) => /(Ms|Seconds)$/.test(key))
);

describe("timer inventory", () => {
  it("docs/timers.md has a row for every timer in DEFAULT_CONFIG", () => {
    const missing = timerKeys.filter((key) => !timers.includes(`| \`${key}\``));
    expect(missing).toEqual([]);
  });
});

describe("timer relations", () => {
  const { signaling, bus, presence, webrtc } = DEFAULT_CONFIG;

  it("commands outlive a failover", () => {
    const failoverBudgetMs =
      signaling.candidateCollectionWindowMs +
      signaling.candidateConfirmWindowMs +
      2 * signaling.positionIntervalMs +
      bus.recoveryMaxMs;
    expect(bus.commandTtlMs).toBeGreaterThan(failoverBudgetMs);
  });
  it("the duplicate reveal safety waits for the ping to time out", () => {
    expect(presence.duplicateRevealTimeoutMs).toBeGreaterThan(presence.pingTimeoutMs);
  });
  it("recovery cap is not below its sliding window", () => {
    expect(bus.recoveryMaxMs).toBeGreaterThanOrEqual(bus.recoveryWindowMs);
  });
  it("transient docs outlive the checks that read them", () => {
    expect(signaling.messageRetentionMs).toBeGreaterThan(signaling.ackTimeoutMs);
    const electionBudgetMs =
      signaling.candidateCollectionWindowMs + 2 * signaling.positionIntervalMs;
    expect(signaling.candidateRetentionMs).toBeGreaterThan(electionBudgetMs);
  });
  it("room docs outlive Firestore's TTL deletion lag", () => {
    expect(signaling.roomRetentionMs).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
  it("the probe waits at least as long between pings as for an answer", () => {
    expect(webrtc.probeIdleMs).toBeGreaterThanOrEqual(webrtc.probeTimeoutMs);
  });
  it("the recovery link grace ends before the recovery cap", () => {
    expect(bus.recoveryLinkGraceMs).toBeLessThan(bus.recoveryMaxMs);
  });
});
