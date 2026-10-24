// Pure decisions of the game feature: the play gate, the start check, roster sync, late joins,
// the next wake-up and the end of a game. No ports, no clock (callers pass `now`). Everything
// here is a table or a small function to test directly.

import type { PlayerId } from "@/kernel";
import type { PrivateWrite } from "@/bus";
import type { GameConfig } from "./config";
import type {
  GameRuntime,
  GameState,
  Observation,
  PlayGateReject,
  Slot,
  SlotEnv,
  SlotSetup,
  StartReject,
} from "./model";
import { isPaused, presenceOf, withPresence } from "./slot/presence";
import { applyPrivatePatches } from "./slot/private";
import { nextDeadline } from "./slot/timers";

// ─── The play gate ──────────────────────────────────────────────────────────

export type PlayCaller = { fromHost: boolean; playerId?: PlayerId };

/**
 * One table, in this order: no slot, a stale page of another game, an unknown game id, an unknown
 * command, paused, host-only, not a participant. undefined: allowed.
 */
export function authorize(
  slot: Slot | null,
  runtime: GameRuntime | undefined,
  gameId: string,
  commandType: string,
  caller: PlayCaller
): PlayGateReject | undefined {
  if (!slot) return "no-active-game";
  if (gameId !== slot.gameId) return "wrong-game";
  if (!runtime) return "unknown-game";
  const who = runtime.commandWho(commandType);
  if (who === undefined) return "unknown-command";
  if (who !== "host" && isPaused(slot)) return "paused";
  if (who === "host") return caller.fromHost ? undefined : "host-only";
  if (who === "participant") {
    const isParticipant =
      caller.playerId !== undefined && slot.setup.participants.includes(caller.playerId);
    return isParticipant ? undefined : "not-a-participant";
  }
  return undefined;
}

// ─── Start ──────────────────────────────────────────────────────────────────

export type StartCheckReject = Exclude<StartReject, "not-host" | "not-ready">;

const jsonSize = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * What the framework checks before the game's own `runtime.start` (mode, player counts, settings
 * schema). Settings are capped because `last.settings` is replicated.
 */
export function checkStart(
  state: GameState,
  runtime: GameRuntime | undefined,
  settings: unknown,
  setup: SlotSetup,
  config: GameConfig
): StartCheckReject | undefined {
  if (state.slot) return "already-playing";
  if (!runtime) return "unknown-game";
  if (jsonSize(settings) > config.maxSettingsChars) return "invalid-settings";
  if (setup.participants.length + setup.spectators.length > config.maxSlotPlayers) {
    return "too-many-players";
  }
  return undefined;
}

// ─── Roster sync (the `observe` command) ────────────────────────────────────

/** Records names (cut to `maxNameChars`; a new name past `maxSlotPlayers` is not recorded). Same slot when nothing changed. */
export function recordNames(slot: Slot, observation: Observation, config: GameConfig): Slot {
  let names = slot.setup.names;
  let count = Object.keys(names).length;
  for (const player of observation.players) {
    const name = player.name.slice(0, config.maxNameChars);
    const known = names[player.id] !== undefined;
    if (known ? names[player.id] === name : count >= config.maxSlotPlayers) continue;
    if (names === slot.setup.names) names = { ...names };
    names[player.id] = name;
    if (!known) count += 1;
  }
  return names === slot.setup.names ? slot : { ...slot, setup: { ...slot.setup, names } };
}

/** Players here that the slot has never placed, and that were not removed on purpose. */
export function newcomers(slot: Slot, observation: Observation): PlayerId[] {
  const known = new Set<string>([...slot.setup.participants, ...slot.setup.spectators]);
  const removed = new Set<string>(observation.removed);
  return observation.players
    .filter((p) => p.here && !known.has(p.id) && !removed.has(p.id))
    .map((p) => p.id);
}

// ─── Late join ──────────────────────────────────────────────────────────────

/**
 * Places a newcomer: a spectator unless the game admits them (`late`), as a new participant or in
 * the seat of an away one. Pure; the pieces to commit come back as `writes`.
 */
export function lateJoin(
  slot: Slot,
  playerId: PlayerId,
  runtime: GameRuntime,
  env: SlotEnv
): { slot: Slot; writes: PrivateWrite[] } {
  const { setup } = slot;
  const spectate = (): { slot: Slot; writes: PrivateWrite[] } => ({
    slot:
      setup.participants.length + setup.spectators.length >= env.config.maxSlotPlayers
        ? slot
        : { ...slot, setup: { ...setup, spectators: [...setup.spectators, playerId] } },
    writes: [],
  });

  const decision = runtime.late(slot, playerId);
  if (!decision) return spectate();
  const replaced = decision.replaces;
  if (replaced !== undefined && !presenceOf(slot).away.includes(replaced)) return spectate();
  if (replaced === undefined && setup.participants.length >= runtime.players.max) return spectate();

  let teams = setup.teams;
  if (setup.mode === "teams") {
    const team = decision.team ?? (replaced !== undefined ? setup.teams[replaced] : undefined);
    if (!team || !setup.teamIds?.includes(team)) return spectate();
    teams = { ...setup.teams, [playerId]: team };
  }

  const presence = presenceOf(slot);
  const since = { ...presence.since };
  if (replaced !== undefined) delete since[replaced];
  const joined = withPresence(
    {
      ...slot,
      state: decision.state !== undefined ? decision.state : slot.state,
      setup: {
        ...setup,
        teams,
        participants:
          replaced === undefined
            ? [...setup.participants, playerId]
            : setup.participants.map((id) => (id === replaced ? playerId : id)),
        spectators: replaced === undefined ? setup.spectators : [...setup.spectators, replaced],
      },
    },
    {
      ...presence,
      since,
      away: replaced === undefined ? presence.away : presence.away.filter((id) => id !== replaced),
    }
  );

  // The joiner's piece, and the replaced player's removed.
  const patches: Record<string, unknown> = {};
  if (replaced !== undefined) patches[replaced] = null;
  const piece = decision.private ?? runtime.initialPrivate(joined, playerId);
  if (piece !== undefined) patches[playerId] = piece;
  const applied = applyPrivatePatches(joined, patches, env);
  return applied.ok ? applied.value : spectate();
}

// ─── The host's wake-up ─────────────────────────────────────────────────────

/**
 * Host time of the next moment something may need doing: the earliest away boundary
 * (`since + awayAfterMs`) or running timer deadline. The wake-up is only a nudge, the truth is in the slot.
 */
export function nextWakeAt(
  slot: Slot | null,
  runtime: GameRuntime | undefined,
  config: GameConfig
): number | undefined {
  if (!slot || !runtime) return undefined;
  const awayAfterMs = runtime.presence.awayAfterMs ?? config.awayAfterMs;
  let next = nextDeadline(slot);
  for (const since of Object.values(presenceOf(slot).since)) {
    const boundary = since + awayAfterMs;
    if (next === undefined || boundary < next) next = boundary;
  }
  return next;
}

// ─── The end ────────────────────────────────────────────────────────────────

/** The one way a game ends: slot cleared, round advanced, `last` set, all in one commit. */
export function finish(state: GameState): GameState {
  if (!state.slot) return state;
  return {
    round: state.round + 1,
    last: { gameId: state.slot.gameId, settings: state.slot.settings },
    slot: null,
  };
}
