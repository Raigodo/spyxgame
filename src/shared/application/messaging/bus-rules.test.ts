import { describe, expect, it } from "vitest";
import {
  compareVersions,
  computeBusStatus,
  isDuplicateCommand,
  isRecoveryComplete,
  shouldReplaceBest,
} from "./bus-rules";

describe("bus-rules", () => {
  it("orders by epoch first, then rev", () => {
    expect(compareVersions({ epoch: 2, rev: 0 }, { epoch: 1, rev: 99 })).toBeGreaterThan(0);
    expect(compareVersions({ epoch: 1, rev: 1 }, { epoch: 1, rev: 2 })).toBeLessThan(0);
    expect(compareVersions({ epoch: 1, rev: 1 }, { epoch: 1, rev: 1 })).toBe(0);
  });
  it("treats seq at or below the mark as a duplicate", () => {
    expect(isDuplicateCommand({ a: 2 }, "a", 2)).toBe(true);
    expect(isDuplicateCommand({ a: 2 }, "a", 3)).toBe(false);
    expect(isDuplicateCommand({}, "a", 1)).toBe(false);
  });
  it("replaces best only when strictly newer", () => {
    const v = { epoch: 1, rev: 1 };
    expect(shouldReplaceBest(v, undefined)).toBe(true);
    expect(shouldReplaceBest(v, v)).toBe(false);
    expect(shouldReplaceBest({ epoch: 1, rev: 2 }, v)).toBe(true);
  });
  it("recovery is complete when everyone offered (vacuously with no peers)", () => {
    expect(isRecoveryComplete([], new Set())).toBe(true);
    expect(isRecoveryComplete(["a", "b"], new Set(["a"]))).toBe(false);
    expect(isRecoveryComplete(["a"], new Set(["a", "z"]))).toBe(true);
  });
  it("computes status", () => {
    const base = {
      started: true,
      isHost: false,
      recovering: false,
      hostLinkActive: true,
      allChannelsSynced: true,
    };
    expect(computeBusStatus({ ...base, started: false })).toBe("syncing");
    expect(computeBusStatus({ ...base, isHost: true, recovering: true })).toBe("syncing");
    expect(computeBusStatus({ ...base, isHost: true })).toBe("ready");
    expect(computeBusStatus(base)).toBe("ready");
    expect(computeBusStatus({ ...base, allChannelsSynced: false })).toBe("syncing");
    expect(computeBusStatus({ ...base, hostLinkActive: false })).toBe("syncing");
  });
});
