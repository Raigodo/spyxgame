import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";

const design = readFileSync(
  fileURLToPath(new URL("../../../doc/design.md", import.meta.url)),
  "utf8"
);

// Headings may or may not carry "## " (the doc has been reformatted before), so match the
// numbered title at the start of a line and end at the next numbered heading.
function inventorySection(): string {
  const heading = /^(?:#{1,6}\s+)?10\.\s+Timer inventory\s*$/m.exec(design);
  if (!heading) return "";
  const rest = design.slice(heading.index + heading[0].length);
  const next = /^(?:#{1,6}\s+)?\d+\.\s+\S/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

const timerKeys = Object.values(DEFAULT_CONFIG).flatMap((section) =>
  Object.keys(section).filter((key) => /(Ms|Seconds)$/.test(key))
);

describe("timer inventory", () => {
  it("design.md has the inventory section", () => {
    expect(inventorySection()).not.toBe("");
  });
  it("lists every timer in DEFAULT_CONFIG", () => {
    const section = inventorySection();
    const missing = timerKeys.filter((key) => !section.includes(`\`${key}\``));
    expect(missing).toEqual([]);
  });
});

describe("timer relations", () => {
  const { signaling, bus, presence } = DEFAULT_CONFIG;

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
});
