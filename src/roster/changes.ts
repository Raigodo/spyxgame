// Pure: what changed between two player lists. Drives the joined / rejoined / left events.

import type { Player } from "./model";

export type PlayerChange =
  | { kind: "joined"; player: Player }
  | { kind: "rejoined"; player: Player }
  | { kind: "left"; player: Player; reason: "expired" | "removed" };

const isGhost = (player: Player): boolean => player.peerId === undefined;

/**
 * `prev` is undefined before the first sync: nobody "joins" then, the room is just loaded.
 * joined: a new row. rejoined: a ghost got a peer again. left: a row disappeared
 * (a ghost that expired, or a live row that was kicked or banned).
 */
export function diffPlayers(
  prev: readonly Player[] | undefined,
  next: readonly Player[]
): PlayerChange[] {
  if (!prev) return [];
  const before = new Map(prev.map((p) => [p.id, p]));
  const after = new Map(next.map((p) => [p.id, p]));
  const changes: PlayerChange[] = [];

  for (const player of next) {
    const old = before.get(player.id);
    if (!old) changes.push({ kind: "joined", player });
    else if (isGhost(old) && !isGhost(player)) changes.push({ kind: "rejoined", player });
  }
  for (const old of prev) {
    if (!after.has(old.id)) {
      changes.push({ kind: "left", player: old, reason: isGhost(old) ? "expired" : "removed" });
    }
  }
  return changes;
}
