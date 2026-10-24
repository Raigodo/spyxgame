// Pure client-side projections of the replicated state: the atomic GameView, the setup a game
// sees, and the diff that turns notice `seq` into "each notice once". No ports.

import type { PlayerId } from "@/kernel";
import type {
  GameRuntime,
  GameState,
  GameTimer,
  GameTypes,
  GameView,
  ModeOf,
  SetupOf,
  SlotSetup,
  ViewPlayer,
} from "./model";
import { awayOf, isPaused } from "./slot/presence";
import { noticesOf } from "./slot/notices";
import { timersOf } from "./slot/timers";

/** What a game's reducers and view see of the lobby it was started from. */
export const setupView = (setup: SlotSetup): SetupOf<ModeOf<GameTypes>> =>
  setup.mode === "teams"
    ? {
        mode: "teams",
        teamIds: setup.teamIds ?? [],
        teams: setup.teams,
        participants: setup.participants,
      }
    : { mode: "free-for-all", participants: setup.participants };

/**
 * undefined unless this game is the active one and the channel is synced. `mine` is this player's
 * raw private piece; the game's own schema runs here because a piece can arrive before its slot.
 */
export function buildView<T extends GameTypes>(input: {
  runtime: GameRuntime;
  playerId: PlayerId;
  state: GameState | undefined;
  synced: boolean;
  mine: unknown;
}): GameView<T> | undefined {
  const { runtime, playerId, state, synced, mine } = input;
  const slot = state?.slot;
  if (!state || !slot || !synced || slot.gameId !== runtime.id) return undefined;

  const { setup } = slot;
  const away = new Set(awayOf(slot));
  const players: ViewPlayer[] = [
    ...setup.participants.map((id) => ({
      id,
      name: setup.names[id] ?? id,
      role: "player" as const,
      away: away.has(id),
    })),
    ...setup.spectators.map((id) => ({
      id,
      name: setup.names[id] ?? id,
      role: "spectator" as const,
      away: false,
    })),
  ];
  const timers: GameTimer[] = Object.entries(timersOf(slot)).map(([id, t]) => ({
    id,
    timer: t.timer,
    payload: t.payload,
    deadlineAt: t.deadlineAt,
    paused: t.frozenMs !== undefined,
    ...(t.frozenMs !== undefined && { remainingMs: t.frozenMs }),
  }));
  const piece = mine === undefined ? undefined : runtime.parsePrivate(mine);
  const team = setup.mode === "teams" ? setup.teams[playerId] : undefined;

  return {
    round: state.round,
    settings: slot.settings,
    state: slot.state,
    setup: setupView(setup),
    me: {
      playerId,
      role: setup.participants.includes(playerId) ? "player" : "spectator",
      ...(team !== undefined && { team }),
      ...(piece && { private: piece.value }),
    },
    players,
    away: awayOf(slot),
    paused: isPaused(slot),
    notices: noticesOf(slot).list.map((n) => n.event),
    timers,
  } as unknown as GameView<T>;
}

/** "none": seen the channel with no slot of this game. undefined: not seen it yet. */
export type NoticeCursor = { round: number; seq: number } | "none" | undefined;

/**
 * Notices not seen before. The first sight of a slot is a baseline (never replayed, so a late
 * joiner or a refreshed tab is quiet); a slot that starts while we watch is new from seq 0.
 */
export function diffNotices(
  cursor: NoticeCursor,
  state: GameState | undefined,
  gameId: string
): { events: unknown[]; cursor: NoticeCursor } {
  if (!state) return { events: [], cursor };
  const slot = state.slot?.gameId === gameId ? state.slot : undefined;
  if (!slot) return { events: [], cursor: "none" };
  const { seq, list } = noticesOf(slot);
  if (cursor === undefined) return { events: [], cursor: { round: state.round, seq } };
  const base = cursor === "none" || cursor.round !== state.round ? 0 : cursor.seq;
  return {
    events: list.filter((n) => n.seq > base).map((n) => n.event),
    cursor: { round: state.round, seq: Math.max(base, seq) },
  };
}
