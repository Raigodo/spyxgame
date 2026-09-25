import type { LobbyRoster } from "./lobby-roster";
import type { LobbyPlayer } from "./types";

export class TeamLobbyService {
  readonly mode = "teams" as const;

  constructor(
    private readonly roster: LobbyRoster,
    private readonly teamIds: readonly string[]
  ) {
    if (teamIds.length < 2) {
      throw new Error("[TeamLobbyService] Requires at least two teams.");
    }
  }

  getTeams(): readonly string[] {
    return this.teamIds;
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    return this.roster.getLocalPlayer();
  }

  getPlayers(): LobbyPlayer[] {
    return this.roster.getPlayers();
  }

  getPlayersByTeam(): Record<string, LobbyPlayer[]> {
    const result: Record<string, LobbyPlayer[]> = {};
    for (const teamId of this.teamIds) result[teamId] = [];

    for (const player of this.getPlayers()) {
      if (player.teamId && result[player.teamId]) {
        result[player.teamId].push(player);
      }
    }
    return result;
  }

  getUnassignedPlayers(): LobbyPlayer[] {
    return this.getPlayers().filter((p) => !p.teamId || !this.teamIds.includes(p.teamId));
  }

  setNickname(nickname: string): void {
    this.roster.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.roster.setReady(ready);
  }

  chooseTeam(teamId: string): void {
    if (!this.teamIds.includes(teamId)) {
      throw new Error(`[TeamLobbyService] Unknown team "${teamId}".`);
    }
    this.roster.setLocalMetadata({ teamId });
  }

  leaveTeam(): void {
    this.roster.setLocalMetadata({ teamId: null });
  }

  areAllPlayersReady(): boolean {
    const players = this.getPlayers();
    return players.length > 0 && players.every((p) => p.ready);
  }

  onPlayerJoined(handler: (player: LobbyPlayer) => void): () => void {
    return this.roster.onPlayerJoined(handler);
  }

  onPlayerUpdated(handler: (player: LobbyPlayer) => void): () => void {
    return this.roster.onPlayerUpdated(handler);
  }

  onPlayerLeft(handler: (player: LobbyPlayer) => void): () => void {
    return this.roster.onPlayerLeft(handler);
  }
}
