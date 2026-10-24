import { describe, expect, it } from "vitest";
import { diffPeers } from "./peer-diff";

const peer = (peerId: string) => ({ peerId, joinedAt: new Date(0) });

describe("diffPeers", () => {
  it("marks unknown peers new, keeps incoming order", () => {
    const d = diffPeers(["a"], [peer("a"), peer("b")], undefined);
    expect(d.upserts.map((u) => [u.peer.peerId, u.isNew])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(d.removed).toEqual([]);
  });
  it("reports known peers missing from the incoming list as removed", () => {
    const d = diffPeers(["a", "b", "c"], [peer("b")], undefined);
    expect(d.removed).toEqual(["a", "c"]);
  });
  it("never tracks the local peer", () => {
    const d = diffPeers([], [peer("me"), peer("a")], "me");
    expect(d.upserts.map((u) => u.peer.peerId)).toEqual(["a"]);
    expect(d.removed).toEqual([]);
  });
  it("handles an empty snapshot", () => {
    expect(diffPeers(["a"], [], "me")).toEqual({ upserts: [], removed: ["a"] });
  });
});
