import { describe, expect, it } from "vitest";
import { as, type PeerId, type PlayerId } from "@/kernel";
import type { LinkState } from "../model";
import {
  activeTargets,
  bindHello,
  fitsLimit,
  pruneBindings,
  sameBindings,
  shouldAnnounce,
} from "./rules";

const peer = as<PeerId>;
const player = as<PlayerId>;

describe("bindHello", () => {
  it("binds a new peer", () => {
    const { outcome, next } = bindHello(new Map(), peer("a"), player("pa"));
    expect(outcome).toBe("new");
    expect(next.get(peer("a"))).toBe("pa");
  });
  it("same claim again changes nothing", () => {
    const first = bindHello(new Map(), peer("a"), player("pa")).next;
    const again = bindHello(first, peer("a"), player("pa"));
    expect(again.outcome).toBe("same");
    expect(again.next).toBe(first);
  });
  it("a different claim for a bound peer is a conflict and changes nothing", () => {
    const first = bindHello(new Map(), peer("a"), player("pa")).next;
    const again = bindHello(first, peer("a"), player("other"));
    expect(again.outcome).toBe("conflict");
    expect(again.next.get(peer("a"))).toBe("pa");
  });
  it("never mutates the input map", () => {
    const input = new Map<PeerId, PlayerId>();
    bindHello(input, peer("a"), player("pa"));
    expect(input.size).toBe(0);
  });
});

describe("pruneBindings / sameBindings", () => {
  const b = new Map<PeerId, PlayerId>([
    [peer("a"), player("pa")],
    [peer("b"), player("pb")],
  ]);
  it("drops non-members, keeps the same map when nothing dropped", () => {
    expect(pruneBindings(b, () => true)).toBe(b);
    const pruned = pruneBindings(b, (id) => id === "a");
    expect(Array.from(pruned.keys())).toEqual(["a"]);
    expect(b.size).toBe(2);
  });
  it("sameBindings compares content", () => {
    expect(sameBindings(b, new Map(b))).toBe(true);
    expect(sameBindings(b, new Map([[peer("a"), player("pa")]]))).toBe(false);
    expect(
      sameBindings(
        b,
        new Map([
          [peer("a"), player("pa")],
          [peer("b"), player("zz")],
        ])
      )
    ).toBe(false);
  });
});

describe("activeTargets", () => {
  it("returns active links minus the excluded", () => {
    const links = new Map<PeerId, LinkState>([
      [peer("a"), "active"],
      [peer("b"), "connecting"],
      [peer("c"), "active"],
      [peer("d"), "reconnecting"],
    ]);
    expect(activeTargets(links, [peer("c")])).toEqual(["a"]);
    expect(activeTargets(links, [])).toEqual(["a", "c"]);
  });
});

describe("fitsLimit", () => {
  it("is inclusive", () => {
    expect(fitsLimit("abc", 3)).toBe(true);
    expect(fitsLimit("abcd", 3)).toBe(false);
  });
});

describe("shouldAnnounce", () => {
  const base = {
    role: "guest" as const,
    host: peer("h"),
    hostLink: "active" as LinkState | undefined,
    announcedHost: undefined as PeerId | undefined,
    wasActive: false,
  };
  it("announces when the host link becomes active", () => {
    expect(shouldAnnounce(base)).toEqual({ announce: true, active: true });
  });
  it("does not repeat for the same host while the link stays active", () => {
    expect(shouldAnnounce({ ...base, wasActive: true, announcedHost: peer("h") })).toEqual({
      announce: false,
      active: true,
    });
  });
  it("announces again after a host change or a link flap", () => {
    expect(shouldAnnounce({ ...base, wasActive: true, announcedHost: peer("old") }).announce).toBe(
      true
    );
    expect(shouldAnnounce({ ...base, wasActive: false, announcedHost: peer("h") }).announce).toBe(
      true
    );
  });
  it("never announces as host, without a host, or without an active link", () => {
    expect(shouldAnnounce({ ...base, role: "host" }).active).toBe(false);
    expect(shouldAnnounce({ ...base, host: undefined }).announce).toBe(false);
    expect(shouldAnnounce({ ...base, hostLink: "connecting" }).announce).toBe(false);
    expect(shouldAnnounce({ ...base, hostLink: undefined }).active).toBe(false);
  });
});
