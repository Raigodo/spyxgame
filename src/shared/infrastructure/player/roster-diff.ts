import type { SignalingPeerId } from "../signaling";
import type { PlayerProfile } from "./types";

/** Known players missing from an incoming roster snapshot, collected up front so nothing is deleted mid-iteration. */
export function findDepartedPlayers(
  knownPeerIds: Iterable<SignalingPeerId>,
  incoming: readonly PlayerProfile[]
): SignalingPeerId[] {
  const incomingIds = new Set(incoming.map((p) => p.peerId));
  return Array.from(knownPeerIds).filter((id) => !incomingIds.has(id));
}
