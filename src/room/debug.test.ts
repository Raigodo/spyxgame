import { describe, expect, it } from "vitest";
import { Cell, as, type PeerId, type PlayerId, type RoomId } from "@/kernel";
import type { Roster } from "@/roster";
import type { LinkState, Member } from "@/transport";
import { describeRoom } from "./debug";
import type { RoomEnd } from "./model";

const peer = as<PeerId>;

describe("describeRoom", () => {
  it("returns a plain snapshot of the room's current values", () => {
    const member: Member = { peerId: peer("p"), joinedAt: 1 };
    const out = describeRoom({
      roomId: as<RoomId>("r"),
      playerId: as<PlayerId>("me"),
      self: peer("p"),
      sync: new Cell<string>("ready"),
      ended: new Cell<RoomEnd | undefined>({ reason: "kicked" }),
      transport: {
        role: new Cell<"guest" | "host">("host"),
        host: new Cell<PeerId | undefined>(peer("p")),
        members: new Cell<ReadonlyMap<PeerId, Member>>(new Map([[peer("p"), member]])),
        links: new Cell<ReadonlyMap<PeerId, LinkState>>(new Map([[peer("p"), "active"]])),
      },
      roster: {
        state: {
          players: new Cell([]),
          bans: new Cell<ReadonlySet<PlayerId>>(new Set([as<PlayerId>("x")])),
        },
      } as unknown as Roster,
    });
    expect(out).toEqual({
      roomId: "r",
      playerId: "me",
      self: "p",
      role: "host",
      host: "p",
      sync: "ready",
      ended: { reason: "kicked" },
      members: [member],
      links: [["p", "active"]],
      players: [],
      bans: ["x"],
    });
  });
});
