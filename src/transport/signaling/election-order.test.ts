import { describe, expect, it } from "vitest";
import { candidateDelayMs, compareIds, orderCandidates, pickNextHost } from "./election-order";

describe("compareIds", () => {
  it("orders by UTF-16 code units", () => {
    expect(compareIds("a", "b")).toBe(-1);
    expect(compareIds("b", "a")).toBe(1);
    expect(compareIds("a", "a")).toBe(0);
    expect(compareIds("B", "a")).toBe(-1); // uppercase sorts first
  });
});

describe("pickNextHost", () => {
  it("picks the smallest id, counting the local peer as live", () => {
    expect(pickNextHost(["c", "b"], "d")).toBe("b");
    expect(pickNextHost(["c", "b"], "a")).toBe("a");
  });
  it("excludes the given peer, and returns undefined when nobody is left", () => {
    expect(pickNextHost(["a", "b"], "c", "a")).toBe("b");
    expect(pickNextHost([], "a", "a")).toBeUndefined();
  });
  it("tolerates duplicates (local also in the live list)", () => {
    expect(pickNextHost(["a", "a", "b"], "a")).toBe("a");
  });
});

describe("orderCandidates", () => {
  it("keeps only live registered candidates, never the dead host, sorted", () => {
    expect(
      orderCandidates({
        registered: ["d", "c", "b", "x"],
        livePeerIds: ["b", "c", "d"],
        localPeerId: "e",
        deadHostPeerId: "d",
      })
    ).toEqual(["b", "c"]);
  });
  it("the local peer counts as live even when absent from membership", () => {
    expect(
      orderCandidates({
        registered: ["me", "b"],
        livePeerIds: [],
        localPeerId: "me",
        deadHostPeerId: "z",
      })
    ).toEqual(["me"]);
  });
});

describe("candidateDelayMs", () => {
  it("position 0 is immediate, later positions wait one interval each", () => {
    expect(candidateDelayMs(0, 1_500)).toBe(0);
    expect(candidateDelayMs(2, 1_500)).toBe(3_000);
  });
});
