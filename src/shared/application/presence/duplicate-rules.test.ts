import { describe, expect, it } from "vitest";
import {
  findDuplicateGroups,
  findExistingDuplicate,
  findSurvivor,
  planArbitration,
} from "./duplicate-rules";

const p = (peerId: string, playerId?: string) => ({
  peerId,
  metadata: playerId ? { playerId } : {},
});

describe("duplicate-rules", () => {
  it("finds no group when every playerId is unique", () => {
    expect(findDuplicateGroups([p("a", "x"), p("b", "y"), p("c")], "a")).toEqual([]);
  });
  it("picks the last remote entry as newcomer and never the local peer", () => {
    const profiles = [p("a", "x"), p("b", "x")];
    expect(findDuplicateGroups(profiles, "c")[0]).toMatchObject({
      newcomerPeerId: "b",
      involvedPeerIds: ["a", "b"],
    });
    expect(findDuplicateGroups(profiles, "b")[0]).toMatchObject({
      newcomerPeerId: "a",
      involvedPeerIds: ["a"],
    });
  });
  it("finds the existing holder of a playerId", () => {
    expect(findExistingDuplicate([p("a", "x"), p("b", "x")], p("b", "x"), "x")?.peerId).toBe("a");
    expect(findExistingDuplicate([p("b", "x")], p("b", "x"), "x")).toBeUndefined();
  });
  it("skips the ping when the host's own tab is the existing one", () => {
    expect(planArbitration("h", "h")).toBe("reject-newcomer");
    expect(planArbitration("a", "h")).toBe("ping-existing");
  });
  it("returns the newcomer only if the old side departed and the newcomer is present", () => {
    const dups = [{ oldPeerId: "o", newPeerId: "n" }];
    expect(findSurvivor(dups, "o", new Set(["n"]))).toBe("n");
    expect(findSurvivor(dups, "o", new Set())).toBeUndefined();
    expect(findSurvivor(dups, "z", new Set(["n"]))).toBeUndefined();
  });
});
