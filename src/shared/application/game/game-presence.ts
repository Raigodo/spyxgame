// Pure presence rules for a running game. No clock, no ports: the host runtime supplies who is
// present, whose absence timer expired, and who was removed on purpose.

export type PresenceChangeKind = "away" | "returned" | "dropped";

export interface PresenceChange {
  playerId: string;
  /**
   * away: marked absent. returned: back in the same place.
   * dropped: moved to spectators (came back with rejoin "spectate", or was kicked or banned).
   */
  kind: PresenceChangeKind;
}

export type RejoinStrategy = "restore" | "spectate";
export type BelowMin = "continue" | "pause" | "end";

export interface QuorumPolicy {
  minPresent: number;
  belowMin: BelowMin;
}

interface PresenceSlot {
  participants: string[];
  spectators: string[];
  away: string[];
}

interface QuorumSlot extends PresenceSlot {
  paused: boolean;
  forced: boolean;
}

/** Participants that are missing and not yet marked away: the ones that need an absence timer. */
export function findAbsent(
  slot: Pick<PresenceSlot, "participants" | "away">,
  present: ReadonlySet<string>
): Set<string> {
  const away = new Set(slot.away);
  return new Set(slot.participants.filter((id) => !present.has(id) && !away.has(id)));
}

/** Participants not marked away. */
export function presentCount(slot: Pick<PresenceSlot, "participants" | "away">): number {
  const away = new Set(slot.away);
  return slot.participants.filter((id) => !away.has(id)).length;
}

/** Returns the same slot object when nothing changed. */
export function computePresence<T extends PresenceSlot>(
  slot: T,
  present: ReadonlySet<string>,
  expired: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  rejoin: (playerId: string) => RejoinStrategy
): { slot: T; changes: PresenceChange[] } {
  const changes: PresenceChange[] = [];
  const away = new Set(slot.away);
  const dropped = new Set<string>();
  const absent = findAbsent(slot, present);

  for (const playerId of slot.participants) {
    if (removed.has(playerId)) {
      away.delete(playerId);
      dropped.add(playerId);
      changes.push({ playerId, kind: "dropped" });
    } else if (present.has(playerId)) {
      if (!away.has(playerId)) continue;
      away.delete(playerId);
      if (rejoin(playerId) === "spectate") {
        dropped.add(playerId);
        changes.push({ playerId, kind: "dropped" });
      } else {
        changes.push({ playerId, kind: "returned" });
      }
    } else if (absent.has(playerId) && expired.has(playerId)) {
      away.add(playerId);
      changes.push({ playerId, kind: "away" });
    }
  }

  if (changes.length === 0) return { slot, changes };
  return {
    slot: {
      ...slot,
      participants: slot.participants.filter((id) => !dropped.has(id)),
      spectators: [...slot.spectators, ...dropped],
      away: Array.from(away),
    },
    changes,
  };
}

/**
 * Pause and end rules. "pause": paused while below the minimum, unless the host forced the game
 * on (forced lasts until the count recovers, then resets). "end": reports that the game should end.
 * Returns the same slot object when nothing changed.
 */
export function applyQuorum<T extends QuorumSlot>(
  slot: T,
  policy: QuorumPolicy | undefined
): { slot: T; end: boolean } {
  if (!policy || policy.belowMin === "continue") return { slot, end: false };
  const below = presentCount(slot) < policy.minPresent;
  if (policy.belowMin === "end") return { slot, end: below };

  const paused = below && !slot.forced;
  const forced = below && slot.forced;
  if (paused === slot.paused && forced === slot.forced) return { slot, end: false };
  return { slot: { ...slot, paused, forced }, end: false };
}
