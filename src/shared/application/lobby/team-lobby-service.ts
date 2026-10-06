import type { LobbyPlayerView } from "./lobby-player-view";
import type { LobbyPlayer } from "./types";

export class TeamLobbyService {
  readonly mode = "teams" as const;

  constructor(
    private readonly players: LobbyPlayerView,
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
    return this.players.getLocalPlayer();
  }

  getPlayers(): LobbyPlayer[] {
    return this.players.getPlayers();
  }

  getPlayersByTeam(): Record<string, LobbyPlayer[]> {
    const result: Record<string, LobbyPlayer[]> = {};
    for (const teamId of this.teamIds) result[teamId] = [];

    for (const player of this.getPlayers()) {
      const bucket = player.teamId ? result[player.teamId] : undefined;
      bucket?.push(player);
    }
    return result;
  }

  getUnassignedPlayers(): LobbyPlayer[] {
    return this.getPlayers().filter((p) => !p.teamId || !this.teamIds.includes(p.teamId));
  }

  setNickname(nickname: string): void {
    this.players.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.players.setReady(ready);
  }

  chooseTeam(teamId: string): void {
    if (!this.teamIds.includes(teamId)) {
      throw new Error(`[TeamLobbyService] Unknown team "${teamId}".`);
    }
    this.players.setLocalMetadata({ teamId });
  }

  leaveTeam(): void {
    this.players.setLocalMetadata({ teamId: null });
  }

  areAllPlayersReady(): boolean {
    const players = this.getPlayers();
    return players.length > 0 && players.every((p) => p.ready);
  }

  onPlayerJoined(handler: (player: LobbyPlayer) => void): () => void {
    return this.players.onPlayerJoined(handler);
  }

  onPlayerRejoined(handler: (player: LobbyPlayer) => void): () => void {
    return this.players.onPlayerRejoined(handler);
  }

  onPlayerUpdated(handler: (player: LobbyPlayer) => void): () => void {
    return this.players.onPlayerUpdated(handler);
  }

  onPlayerLeft(handler: (player: LobbyPlayer) => void): () => void {
    return this.players.onPlayerLeft(handler);
  }
}
