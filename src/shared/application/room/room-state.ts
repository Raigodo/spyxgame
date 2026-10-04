// application/room/room-state.ts
// The one replicated room-level value. Owned by the host, carried by a
// RoomBus state channel, validated here because it arrives over the network.

import type { LobbyConfig } from "@/shared/application/lobby";

export type RoomPhase = "lobby" | "in-game";

/**
 * Frozen by the host at game start, replicated with the room state, so a
 * newly promoted host (or a refreshed tab) boots the running game from it.
 */
export interface GameContext {
  /** Which lobby type the game was started from. */
  lobby: LobbyConfig;
  /** playerId -> teamId, empty unless lobby.mode === "teams". Keyed by the durable id. */
  teams: Record<string, string>;
  /** playerIds present at start. Anyone else who shows up later is a spectator by default. */
  participants: string[];
}

export interface ActiveGame {
  id: string;
  /** Opaque here. The game definition (step 5) validates and types it. */
  config: unknown;
  context: GameContext;
}

export interface RoomState {
  phase: RoomPhase;
  lobby: LobbyConfig;
  /** Incremented on every endGame(). A player is ready only if readyRound === round. */
  round: number;
  game?: ActiveGame;
}

export const INITIAL_ROOM_STATE: RoomState = {
  phase: "lobby",
  lobby: { mode: "free-for-all" },
  round: 0,
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function sanitizeLobbyConfig(v: unknown): LobbyConfig | undefined {
  if (!isRecord(v)) return undefined;
  if (v.mode === "free-for-all") return { mode: "free-for-all" };
  if (v.mode === "teams" && Array.isArray(v.teamIds)) {
    const ids = v.teamIds
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 32);
    const unique = Array.from(new Set(ids));
    if (unique.length >= 2 && unique.length <= 8) return { mode: "teams", teamIds: unique };
  }
  return undefined;
}

export function sanitizeGameContext(v: unknown): GameContext | undefined {
  if (!isRecord(v)) return undefined;
  const lobby = sanitizeLobbyConfig(v.lobby);
  if (!lobby || !isRecord(v.teams) || !Array.isArray(v.participants)) return undefined;

  const teams: Record<string, string> = {};
  for (const [playerId, teamId] of Object.entries(v.teams)) {
    if (typeof teamId === "string") teams[playerId] = teamId;
  }
  const participants = v.participants.filter((p): p is string => typeof p === "string");
  return { lobby, teams, participants };
}

export function sanitizeRoomState(v: unknown): RoomState | undefined {
  if (!isRecord(v)) return undefined;
  if (v.phase !== "lobby" && v.phase !== "in-game") return undefined;
  const lobby = sanitizeLobbyConfig(v.lobby);
  if (!lobby) return undefined;
  if (typeof v.round !== "number" || !Number.isInteger(v.round) || v.round < 0) return undefined;

  let game: ActiveGame | undefined;
  if (v.game !== undefined && v.game !== null) {
    if (!isRecord(v.game) || typeof v.game.id !== "string") return undefined;
    const context = sanitizeGameContext(v.game.context);
    if (!context) return undefined;
    game = { id: v.game.id, config: v.game.config, context };
  }

  // phase and game must agree
  if ((v.phase === "in-game") !== (game !== undefined)) return undefined;
  return { phase: v.phase, lobby, round: v.round, game };
}
