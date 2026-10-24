// Pure: duplicate-tab detection and verdict. The host learns a player's id from the verified hello,
// so two member peers with the same playerId are two tabs of one player.

import type { PeerId } from "@/kernel";
import type { Member } from "@/transport";
import type { RosterState } from "./model";

export interface Challenge {
  playerId: string;
  /** The peer that owns the roster entry. */
  holder: PeerId;
  /** Other member peers claiming the same player. */
  others: readonly PeerId[];
}

/**
 * A challenge exists while the entry's holder is alive (it is the host itself or a member) and
 * other members share its playerId. A holder that left membership is a ghost: no challenge.
 */
export function planDuplicates(
  members: ReadonlyMap<PeerId, Member>,
  state: RosterState,
  self: PeerId
): Challenge[] {
  const byPlayer = new Map<string, PeerId[]>();
  for (const member of members.values()) {
    if (member.playerId === undefined) continue;
    const list = byPlayer.get(member.playerId) ?? [];
    list.push(member.peerId);
    byPlayer.set(member.playerId, list);
  }

  const challenges: Challenge[] = [];
  for (const [playerId, peers] of byPlayer) {
    const holder = state.entries[playerId]?.peerId;
    if (holder === undefined) continue;
    if (holder !== self && !members.has(holder)) continue;
    const others = peers.filter((peer) => peer !== holder).sort();
    if (others.length > 0) challenges.push({ playerId, holder, others });
  }
  return challenges;
}

export const challengeKey = (c: Challenge): string =>
  `${c.playerId}|${c.holder}|${c.others.join(",")}`;

/**
 * Which peers to drop. The holder answered: it is alive, the newcomers are superseded.
 * No answer: the holder is a dead tab, drop it; the newcomer's repeated join then takes over.
 */
export function resolveChallenge(c: Challenge, holderAnswered: boolean): readonly PeerId[] {
  return holderAnswered ? c.others : [c.holder];
}
