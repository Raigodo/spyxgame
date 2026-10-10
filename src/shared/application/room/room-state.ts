// The one replicated room-level value. Owned by the host, carried by a
// RoomBus state channel, validated here because it arrives over the network.

import { sanitizeGameContext, type ActiveGame } from "@/shared/application/game";
import { sanitizeLobbyConfig, type LobbyConfig } from "@/shared/application/lobby";
import { isRecord } from "@/shared/kernel";

// Kept here so existing imports of these two types from the room module keep working.
export type { ActiveGame, GameContext } from "@/shared/application/game";

export type RoomPhase = "lobby" | "in-game";

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
