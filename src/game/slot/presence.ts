// Slot feature `presence`: who is away, since when each missing participant was first seen
// missing, and the pause/forced flags. Pure; the host's `observe` command drives it.
// Ported from legacy game-presence.ts (computePresence, applyQuorum). Away is judged from the
// replicated `since` stamps on the bus's host time, so a new host continues the same count.

import { s, type PlayerId } from "@/kernel";
import type {
  BelowMin,
  ObserveResult,
  Observation,
  PresenceChange,
  RejoinStrategy,
  Slot,
  SlotEnv,
  SlotFeature,
} from "../model";
import { SLOT_KEY } from "../names";

export type PresenceX = {
  /** Participants marked away. */
  away: PlayerId[];
  /** Missing participants not yet away: playerId -> host time first seen missing. */
  since: Record<string, number>;
  /** Below the minimum and not forced: only host commands run, timers are frozen. */
  paused: boolean;
  /** The host chose to continue below the minimum. Resets when enough players are back. */
  forced: boolean;
};

const INITIAL: PresenceX = { away: [], since: {}, paused: false, forced: false };

// Readers assume a parsed slot (a slot of an unknown game is never read through them).
export const presenceOf = (slot: Slot): PresenceX =>
  (slot.x[SLOT_KEY.presence] as PresenceX | undefined) ?? INITIAL;
export const isPaused = (slot: Slot): boolean => presenceOf(slot).paused;
export const awayOf = (slot: Slot): readonly PlayerId[] => presenceOf(slot).away;

export const withPresence = (slot: Slot, x: PresenceX): Slot => ({
  ...slot,
  x: { ...slot.x, [SLOT_KEY.presence]: x },
});

const sameRecord = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

export type PresenceStep = {
  participants: PlayerId[];
  spectators: PlayerId[];
  x: PresenceX;
  changes: PresenceChange[];
};

/**
 * Stamps `since` for missing participants, marks away those missing for `awayAfterMs`, restores
 * or demotes returning ones, demotes removed ones. Returns the same arrays and `x` when nothing changed.
 */
export function computePresence(input: {
  participants: PlayerId[];
  spectators: PlayerId[];
  x: PresenceX;
  present: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  now: number;
  awayAfterMs: number;
  rejoin(playerId: PlayerId): RejoinStrategy;
}): PresenceStep {
  const { participants, spectators, x, present, removed, now, awayAfterMs, rejoin } = input;
  const changes: PresenceChange[] = [];
  const away = new Set(x.away);
  const dropped = new Set<PlayerId>();
  const since: Record<string, number> = {};

  for (const playerId of participants) {
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
    } else if (!away.has(playerId)) {
      const first = x.since[playerId] ?? now;
      if (now - first >= awayAfterMs) {
        away.add(playerId);
        changes.push({ playerId, kind: "away" });
      } else {
        since[playerId] = first;
      }
    }
  }

  if (changes.length === 0 && sameRecord(x.since, since)) {
    return { participants, spectators, x, changes };
  }
  return {
    participants: dropped.size === 0 ? participants : participants.filter((id) => !dropped.has(id)),
    spectators: dropped.size === 0 ? spectators : [...spectators, ...dropped],
    x: { ...x, away: changes.length === 0 ? x.away : Array.from(away), since },
    changes,
  };
}

/**
 * Pause and end rules. "pause": paused while below the minimum, unless the host forced the game
 * on (forced lasts until the count recovers, then resets). "end": reports that the game should end.
 * Returns the same `x` when nothing changed.
 */
export function applyQuorum(
  participants: readonly PlayerId[],
  x: PresenceX,
  policy: { minPresent?: number; belowMin: BelowMin }
): { x: PresenceX; end: boolean } {
  if (policy.minPresent === undefined || policy.belowMin === "continue") return { x, end: false };
  const away = new Set(x.away);
  const below = participants.filter((id) => !away.has(id)).length < policy.minPresent;
  if (policy.belowMin === "end") return { x, end: below };

  const paused = below && !x.forced;
  const forced = below && x.forced;
  if (paused === x.paused && forced === x.forced) return { x, end: false };
  return { x: { ...x, paused, forced }, end: false };
}

/** The `continue` command: a paused game runs on below the minimum. undefined: not paused. */
export function resume(slot: Slot): Slot | undefined {
  const x = presenceOf(slot);
  return x.paused ? withPresence(slot, { ...x, paused: false, forced: true }) : undefined;
}

function observe(slot: Slot, observation: Observation, env: SlotEnv): ObserveResult {
  const present = new Set<string>();
  for (const player of observation.players) if (player.here) present.add(player.id);

  const step = computePresence({
    participants: slot.setup.participants,
    spectators: slot.setup.spectators,
    x: presenceOf(slot),
    present,
    removed: new Set(observation.removed),
    now: env.now,
    awayAfterMs: env.runtime.presence.awayAfterMs ?? env.config.awayAfterMs,
    rejoin: (playerId) => env.runtime.rejoin(slot, playerId),
  });

  let next = slot;
  if (step.x !== presenceOf(slot) || step.participants !== slot.setup.participants) {
    next = withPresence(
      {
        ...slot,
        setup: { ...slot.setup, participants: step.participants, spectators: step.spectators },
      },
      step.x
    );
  }

  let effects: ObserveResult["effects"];
  let patches: ObserveResult["private"];
  if (step.changes.length > 0) {
    const reduction = env.runtime.changed(next, step.changes, env.private);
    if (reduction) {
      next = { ...next, state: reduction.state };
      effects = reduction.effects;
      patches = reduction.private;
    }
  }

  const quorum = applyQuorum(next.setup.participants, presenceOf(next), env.runtime.presence);
  if (quorum.x !== presenceOf(next)) next = withPresence(next, quorum.x);
  if (quorum.end) effects = [...(effects ?? []), { type: "end" }];

  return {
    slot: next,
    ...(effects && effects.length > 0 && { effects }),
    ...(patches && { private: patches }),
  };
}

export const presence: SlotFeature<PresenceX> = {
  key: SLOT_KEY.presence,
  initial: () => INITIAL,
  parse(raw, _setup, env) {
    if (raw === undefined) return INITIAL;
    const max = env.config.maxSlotPlayers;
    return s
      .object({
        away: s.list(s.id("player"), { max, onInvalid: "reject" }),
        since: s.record(s.number(), { maxKeys: max, onInvalid: "reject" }),
        paused: s.boolean(),
        forced: s.boolean(),
      })
      .parse(raw);
  },
  observe,
};
