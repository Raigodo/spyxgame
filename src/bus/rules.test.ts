import { describe, expect, it } from "vitest";
import {
  compareVersions,
  computeSync,
  continuedOffset,
  hostClockOffset,
  isDuplicateCommand,
  isRecoveryComplete,
  needsResync,
  pickPeer,
  pruneApplied,
  shouldReplaceBest,
  type SyncInput,
} from "./rules";

describe("versions", () => {
  it("epoch dominates rev", () => {
    expect(compareVersions({ epoch: 2, rev: 0 }, { epoch: 1, rev: 99 })).toBeGreaterThan(0);
    expect(compareVersions({ epoch: 1, rev: 3 }, { epoch: 1, rev: 5 })).toBeLessThan(0);
    expect(compareVersions({ epoch: 1, rev: 3 }, { epoch: 1, rev: 3 })).toBe(0);
  });
  it("shouldReplaceBest only for strictly newer, or when nothing is held", () => {
    const v = { epoch: 1, rev: 1 };
    expect(shouldReplaceBest(v, undefined)).toBe(true);
    expect(shouldReplaceBest(v, v)).toBe(false);
    expect(shouldReplaceBest({ epoch: 1, rev: 2 }, v)).toBe(true);
    expect(shouldReplaceBest({ epoch: 0, rev: 9 }, v)).toBe(false);
  });
});

describe("isDuplicateCommand", () => {
  it("anything at or below the mark is a re-send", () => {
    expect(isDuplicateCommand({ a: 3 }, "a", 3)).toBe(true);
    expect(isDuplicateCommand({ a: 3 }, "a", 2)).toBe(true);
    expect(isDuplicateCommand({ a: 3 }, "a", 4)).toBe(false);
    expect(isDuplicateCommand({}, "a", 1)).toBe(false);
  });
});

describe("isRecoveryComplete", () => {
  it("true when everyone expected offered, vacuously with no peers", () => {
    expect(isRecoveryComplete([], new Set())).toBe(true);
    expect(isRecoveryComplete(["a", "b"], new Set(["a"]))).toBe(false);
    expect(isRecoveryComplete(["a"], new Set(["a", "z"]))).toBe(true);
  });
});

describe("pruneApplied", () => {
  it("drops non-members; same object when nothing dropped", () => {
    const applied = { a: 1, b: 2 };
    expect(pruneApplied(applied, new Set(["a", "b"]))).toBe(applied);
    expect(pruneApplied(applied, new Set(["a"]))).toEqual({ a: 1 });
    expect(applied).toEqual({ a: 1, b: 2 });
  });
});

describe("computeSync / needsResync", () => {
  const base: SyncInput = {
    started: true,
    isHost: false,
    recovering: false,
    hostLinkActive: true,
    allChannelsSynced: true,
  };
  it("table", () => {
    expect(computeSync({ ...base, started: false })).toBe("syncing");
    expect(computeSync({ ...base, isHost: true })).toBe("ready");
    expect(computeSync({ ...base, isHost: true, recovering: true })).toBe("syncing");
    expect(computeSync({ ...base, hostLinkActive: false })).toBe("lost");
    expect(computeSync({ ...base, allChannelsSynced: false })).toBe("syncing");
    expect(computeSync(base)).toBe("ready");
  });
  it("resync only for a started guest with a host link that is not fully synced", () => {
    const unsynced = { ...base, allChannelsSynced: false };
    expect(needsResync(unsynced)).toBe(true);
    expect(needsResync(base)).toBe(false);
    expect(needsResync({ ...unsynced, isHost: true })).toBe(false);
    expect(needsResync({ ...unsynced, hostLinkActive: false })).toBe(false);
    expect(needsResync({ ...unsynced, started: false })).toBe(false);
  });
});

describe("host time", () => {
  it("hostClockOffset", () => {
    expect(hostClockOffset(1_000, 400)).toBe(600);
  });
  it("continuedOffset uses the newest real commit and ignores epoch 0", () => {
    expect(continuedOffset([], 0)).toBeUndefined();
    expect(continuedOffset([{ epoch: 0, asOf: 9_999 }], 0)).toBeUndefined();
    expect(
      continuedOffset(
        [
          { epoch: 1, asOf: 500 },
          { epoch: 2, asOf: 800 },
          { epoch: 0, asOf: 9_999 },
        ],
        300
      )
    ).toBe(500);
  });
});

describe("pickPeer", () => {
  it("prefers an active link, then the newest join", () => {
    expect(pickPeer([])).toBeUndefined();
    expect(
      pickPeer([
        { peerId: "old", joinedAt: 1, active: true },
        { peerId: "new-inactive", joinedAt: 9, active: false },
      ])
    ).toBe("old");
    expect(
      pickPeer([
        { peerId: "a", joinedAt: 1, active: true },
        { peerId: "b", joinedAt: 5, active: true },
      ])
    ).toBe("b");
    expect(
      pickPeer([
        { peerId: "a", joinedAt: 1, active: false },
        { peerId: "b", joinedAt: 5, active: false },
      ])
    ).toBe("b");
  });
});
