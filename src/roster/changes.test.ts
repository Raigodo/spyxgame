import { describe, expect, it } from "vitest";
import { as, type PeerId, type PlayerId } from "@/kernel";
import { diffPlayers } from "./changes";
import type { Player } from "./model";

const P = (id: string, peerId?: string): Player => ({
  id: as<PlayerId>(id),
  name: id,
  ...(peerId && { peerId: as<PeerId>(peerId) }),
  presence: peerId ? "online" : "reconnecting",
  isHost: false,
  joinedAt: 1,
});

describe("diffPlayers", () => {
  it("nothing before the first sync", () => {
    expect(diffPlayers(undefined, [P("a", "x")])).toEqual([]);
  });
  it("no change, no events", () => {
    expect(diffPlayers([P("a", "x")], [P("a", "x")])).toEqual([]);
  });
  it("joined: a new row", () => {
    expect(diffPlayers([P("a", "x")], [P("a", "x"), P("b", "y")])).toEqual([
      { kind: "joined", player: P("b", "y") },
    ]);
  });
  it("rejoined: a ghost got a peer again", () => {
    expect(diffPlayers([P("a")], [P("a", "x")])).toEqual([
      { kind: "rejoined", player: P("a", "x") },
    ]);
  });
  it("left: expired for a ghost, removed for a live row", () => {
    expect(diffPlayers([P("a")], [])).toEqual([
      { kind: "left", player: P("a"), reason: "expired" },
    ]);
    expect(diffPlayers([P("a", "x")], [])).toEqual([
      { kind: "left", player: P("a", "x"), reason: "removed" },
    ]);
  });
  it("a live row turning into a ghost is not an event", () => {
    expect(diffPlayers([P("a", "x")], [P("a")])).toEqual([]);
  });
});
