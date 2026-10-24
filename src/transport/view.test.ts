import { describe, expect, it } from "vitest";
import { as, type PeerId } from "@/kernel";
import type { LinkState, Member } from "./model";
import { composeMembers, narrowLinks, sameLinks, sameMembers } from "./view";

const id = as<PeerId>;
const links = new Map<PeerId, LinkState>([
  [id("h"), "active"],
  [id("g"), "connecting"],
]);
const member = (p: string, joinedAt = 1, playerId?: string): Member => ({
  peerId: id(p),
  joinedAt,
  ...(playerId && { playerId: playerId as Member["playerId"] }),
});

describe("narrowLinks", () => {
  it("a host sees every link", () => {
    expect(narrowLinks("host", id("me"), links)).toBe(links);
  });
  it("a guest sees only the host link", () => {
    const out = narrowLinks("guest", id("h"), links);
    expect(Array.from(out)).toEqual([[id("h"), "active"]]);
  });
  it("a guest with no host or no link to it sees none", () => {
    expect(narrowLinks("guest", undefined, links).size).toBe(0);
    expect(narrowLinks("guest", id("zz"), links).size).toBe(0);
  });
});

describe("sameLinks", () => {
  it("compares content", () => {
    expect(sameLinks(links, new Map(links))).toBe(true);
    expect(sameLinks(links, new Map([[id("h"), "active"]]))).toBe(false);
    expect(
      sameLinks(
        links,
        new Map<PeerId, LinkState>([
          [id("h"), "active"],
          [id("g"), "active"],
        ])
      )
    ).toBe(false);
  });
});

describe("composeMembers", () => {
  const members = new Map([
    [id("a"), member("a")],
    [id("b"), member("b")],
  ]);
  it("a host attaches verified playerIds where known", () => {
    const out = composeMembers("host", members, new Map([[id("a"), "pa"]]));
    expect(out.get(id("a"))?.playerId).toBe("pa");
    expect(out.get(id("b"))?.playerId).toBeUndefined();
  });
  it("a guest passes membership through untouched", () => {
    expect(composeMembers("guest", members, new Map([[id("a"), "pa"]]))).toBe(members);
  });
});

describe("sameMembers", () => {
  it("compares peers, joinedAt and playerId", () => {
    const a = new Map([[id("a"), member("a", 1, "p")]]);
    expect(sameMembers(a, new Map([[id("a"), member("a", 1, "p")]]))).toBe(true);
    expect(sameMembers(a, new Map([[id("a"), member("a", 2, "p")]]))).toBe(false);
    expect(sameMembers(a, new Map([[id("a"), member("a", 1, "q")]]))).toBe(false);
    expect(sameMembers(a, new Map())).toBe(false);
  });
});
