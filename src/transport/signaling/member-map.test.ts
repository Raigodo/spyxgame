import { describe, expect, it } from "vitest";
import { as, type PeerId } from "@/kernel";
import { buildMembers, sameMembers } from "./member-map";

const p = (id: string, ms: number) => ({ peer: { peerId: id, joinedAt: new Date(ms) } });

describe("buildMembers", () => {
  it("builds in incoming order", () => {
    const m = buildMembers(new Map(), [p("b", 2), p("a", 1)]);
    expect(Array.from(m.keys())).toEqual(["b", "a"]);
    expect(m.get(as<PeerId>("a"))).toEqual({ peerId: "a", joinedAt: 1 });
  });
  it("reuses unchanged Member objects, replaces ones whose joinedAt changed", () => {
    const first = buildMembers(new Map(), [p("a", 1), p("b", 2)]);
    const next = buildMembers(first, [p("a", 1), p("b", 3)]);
    expect(next.get(as<PeerId>("a"))).toBe(first.get(as<PeerId>("a")));
    expect(next.get(as<PeerId>("b"))).not.toBe(first.get(as<PeerId>("b")));
  });
  it("drops peers not in the upserts", () => {
    const first = buildMembers(new Map(), [p("a", 1), p("b", 2)]);
    expect(Array.from(buildMembers(first, [p("a", 1)]).keys())).toEqual(["a"]);
  });
});

describe("sameMembers", () => {
  it("equal when every member is the same object", () => {
    const a = buildMembers(new Map(), [p("a", 1)]);
    expect(sameMembers(a, buildMembers(a, [p("a", 1)]))).toBe(true);
    expect(sameMembers(a, buildMembers(a, [p("a", 2)]))).toBe(false);
    expect(sameMembers(a, new Map())).toBe(false);
  });
});
