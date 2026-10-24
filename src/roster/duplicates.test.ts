import { describe, expect, it } from "vitest";
import { as, type PeerId, type PlayerId } from "@/kernel";
import type { Member } from "@/transport";
import { challengeKey, planDuplicates, resolveChallenge } from "./duplicates";
import type { Entry, RosterState } from "./model";

const peer = as<PeerId>;
const player = as<PlayerId>;
const member = (p: string, pl?: string): Member => ({
  peerId: peer(p),
  joinedAt: 1,
  ...(pl && { playerId: player(pl) }),
});
const members = (...m: Member[]) => new Map(m.map((x) => [x.peerId, x]));
const entry = (peerId?: string): Entry => ({
  name: "n",
  joinedAt: 1,
  link: "active",
  ...(peerId && { peerId: peer(peerId) }),
});
const state = (entries: Record<string, Entry>): RosterState => ({ entries, bans: [] });

describe("planDuplicates", () => {
  const self = peer("host");

  it("no challenge when every player has one peer", () => {
    expect(planDuplicates(members(member("a", "pa")), state({ pa: entry("a") }), self)).toEqual([]);
  });

  it("a second live peer of the same player challenges the holder", () => {
    const out = planDuplicates(
      members(member("old", "pa"), member("new", "pa")),
      state({ pa: entry("old") }),
      self
    );
    expect(out).toEqual([{ playerId: "pa", holder: "old", others: ["new"] }]);
  });

  it("the host itself can be the holder, even though it is not in members", () => {
    const out = planDuplicates(members(member("new", "pa")), state({ pa: entry("host") }), self);
    expect(out).toEqual([{ playerId: "pa", holder: "host", others: ["new"] }]);
  });

  it("a ghost or a holder that left membership makes no challenge", () => {
    const m = members(member("new", "pa"));
    expect(planDuplicates(m, state({ pa: entry() }), self)).toEqual([]);
    expect(planDuplicates(m, state({ pa: entry("gone") }), self)).toEqual([]);
  });

  it("members without a verified playerId are ignored; others are sorted", () => {
    const out = planDuplicates(
      members(member("h", "pa"), member("z", "pa"), member("b", "pa"), member("nobody")),
      state({ pa: entry("h") }),
      self
    );
    expect(out[0]?.others).toEqual(["b", "z"]);
    expect(out).toHaveLength(1);
  });
});

describe("challengeKey / resolveChallenge", () => {
  const c = { playerId: "pa", holder: peer("old"), others: [peer("n1"), peer("n2")] };

  it("key is stable and mentions holder and newcomers", () => {
    expect(challengeKey(c)).toBe("pa|old|n1,n2");
  });
  it("holder answered: drop the newcomers. Silence: drop the holder", () => {
    expect(resolveChallenge(c, true)).toEqual(["n1", "n2"]);
    expect(resolveChallenge(c, false)).toEqual(["old"]);
  });
});
