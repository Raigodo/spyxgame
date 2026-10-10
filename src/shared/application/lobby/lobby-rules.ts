import type { LobbyConfig, LobbyPlayer } from "./types";

/** A teamId that is not valid for the current mode counts as unassigned. */
export function normalizeTeam(player: LobbyPlayer, config: LobbyConfig): LobbyPlayer {
  const valid =
    config.mode === "teams" &&
    player.teamId !== undefined &&
    config.teamIds.includes(player.teamId);
  return { ...player, teamId: valid ? player.teamId : undefined };
}

export function allReady(players: readonly { ready: boolean }[]): boolean {
  return players.length > 0 && players.every((p) => p.ready);
}

/** Why `teamId` cannot be chosen in this lobby, or undefined if it can. */
export function teamChoiceError(config: LobbyConfig, teamId: string): string | undefined {
  if (config.mode !== "teams") return "The lobby is not in teams mode.";
  if (!config.teamIds.includes(teamId)) return `Unknown team "${teamId}".`;
  return undefined;
}
