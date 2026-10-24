// The room's diagnostic snapshot. Pure: plain values in, plain object out.

import type { PeerId, PlayerId, RoomId, Store } from "@/kernel";
import type { Roster } from "@/roster";
import type { Transport } from "@/transport";
import type { RoomEnd } from "./model";

export interface DebugParts {
  roomId: RoomId;
  playerId: PlayerId;
  self: PeerId;
  sync: Store<string>;
  ended: Store<RoomEnd | undefined>;
  transport: Pick<Transport, "role" | "host" | "members" | "links">;
  roster: Roster;
}

export function describeRoom(p: DebugParts): Record<string, unknown> {
  return {
    roomId: p.roomId,
    playerId: p.playerId,
    self: p.self,
    role: p.transport.role.get(),
    host: p.transport.host.get(),
    sync: p.sync.get(),
    ended: p.ended.get(),
    members: [...p.transport.members.get().values()],
    links: [...p.transport.links.get().entries()],
    players: p.roster.state.players.get(),
    bans: [...p.roster.state.bans.get()],
  };
}
