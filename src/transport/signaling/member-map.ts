import type { PeerId } from "@/kernel";
import type { Member } from "../model";
import type { SignalingPeer } from "./types";

/** Builds the next members map in incoming (join) order, reusing unchanged Member objects. */
export function buildMembers(
  previous: ReadonlyMap<PeerId, Member>,
  upserts: readonly { peer: SignalingPeer }[]
): ReadonlyMap<PeerId, Member> {
  const next = new Map<PeerId, Member>();
  for (const { peer } of upserts) {
    const peerId = peer.peerId as PeerId;
    const joinedAt = peer.joinedAt.getTime();
    const old = previous.get(peerId);
    next.set(peerId, old && old.joinedAt === joinedAt ? old : { peerId, joinedAt });
  }
  return next;
}

/** Equal when every member is the same object (buildMembers reuses unchanged ones). */
export function sameMembers(
  a: ReadonlyMap<PeerId, Member>,
  b: ReadonlyMap<PeerId, Member>
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, member] of a) if (b.get(id) !== member) return false;
  return true;
}
