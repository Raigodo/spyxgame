import { sanitizeLobbyConfig, type LobbyConfig } from "@/shared/application/lobby";
import { isRecord } from "@/shared/kernel";

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
  /** Opaque here. The game definition validates and types it. */
  config: unknown;
  context: GameContext;
}

/** Network input: a valid GameContext or undefined. */
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
