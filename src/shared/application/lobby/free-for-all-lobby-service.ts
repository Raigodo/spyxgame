import type { LobbyPlayerView } from "./lobby-player-view";
import type { LobbyPlayer } from "./types";

export class FreeForAllLobbyService {
  readonly mode = "free-for-all" as const;

  constructor(private readonly players: LobbyPlayerView) {}

  getLocalPlayer(): LobbyPlayer | undefined {
    return this.players.getLocalPlayer();
  }

  getPlayers(): LobbyPlayer[] {
    return this.players.getPlayers();
  }

  setNickname(nickname: string): void {
    this.players.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.players.setReady(ready);
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
