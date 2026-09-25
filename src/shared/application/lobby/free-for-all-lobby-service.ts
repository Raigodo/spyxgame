import type { LobbyRoster } from "./lobby-roster";
import type { LobbyPlayer } from "./types";

export class FreeForAllLobbyService {
  readonly mode = "free-for-all" as const;

  constructor(private readonly roster: LobbyRoster) {}

  getLocalPlayer(): LobbyPlayer | undefined {
    return this.roster.getLocalPlayer();
  }

  getPlayers(): LobbyPlayer[] {
    return this.roster.getPlayers();
  }

  setNickname(nickname: string): void {
    this.roster.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.roster.setReady(ready);
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
