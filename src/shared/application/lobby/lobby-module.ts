import type { PlayerPresenceService } from "@/shared/application/presence";
import { FreeForAllLobbyService } from "./free-for-all-lobby-service";
import { LobbyPlayerView } from "./lobby-player-view";
import { TeamLobbyService } from "./team-lobby-service";
import type { Lobby, LobbyConfig, LobbyPlayer } from "./types";

type PlayerHandler = (player: LobbyPlayer) => void;

// Replaces LobbyController. It sends and receives nothing: the lobby config is
// replicated by the room state, and the client calls applyConfig() when it
// changes. Created once per room and never rebuilt on endGame.
//
// Player events come straight from the presence-backed view, so they keep
// working across mode switches. Subscribers never re-subscribe.
export class LobbyModule {
  private readonly view: LobbyPlayerView;
  private lobby: Lobby;
  private config: LobbyConfig;

  constructor(
    presence: PlayerPresenceService,
    getRound: () => number,
    config: LobbyConfig = { mode: "free-for-all" }
  ) {
    this.view = new LobbyPlayerView(presence, getRound);
    this.config = config;
    this.lobby = this.build(config);
  }

  getConfig(): LobbyConfig {
    return this.config;
  }

  applyConfig(config: LobbyConfig): void {
    this.config = config;
    this.lobby = this.build(config);
  }

  getPlayers(): LobbyPlayer[] {
    return this.lobby.getPlayers().map((p) => this.normalize(p));
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const player = this.lobby.getLocalPlayer();
    return player ? this.normalize(player) : undefined;
  }

  areAllPlayersReady(): boolean {
    return this.lobby.areAllPlayersReady();
  }

  setNickname(nickname: string): void {
    this.lobby.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.lobby.setReady(ready);
  }

  chooseTeam(teamId: string): void {
    const lobby = this.lobby;
    if (lobby.mode !== "teams") throw new Error("[LobbyModule] The lobby is not in teams mode.");
    lobby.chooseTeam(teamId);
  }

  leaveTeam(): void {
    const lobby = this.lobby;
    if (lobby.mode === "teams") lobby.leaveTeam();
  }

  onPlayerJoined(handler: PlayerHandler): () => void {
    return this.view.onPlayerJoined((p) => handler(this.normalize(p)));
  }

  onPlayerRejoined(handler: PlayerHandler): () => void {
    return this.view.onPlayerRejoined((p) => handler(this.normalize(p)));
  }

  onPlayerUpdated(handler: PlayerHandler): () => void {
    return this.view.onPlayerUpdated((p) => handler(this.normalize(p)));
  }

  onPlayerLeft(handler: PlayerHandler): () => void {
    return this.view.onPlayerLeft((p) => handler(this.normalize(p)));
  }

  private build(config: LobbyConfig): Lobby {
    return config.mode === "teams"
      ? new TeamLobbyService(this.view, config.teamIds)
      : new FreeForAllLobbyService(this.view);
  }

  // A teamId that is not valid for the current mode counts as unassigned.
  private normalize(player: LobbyPlayer): LobbyPlayer {
    const lobby = this.lobby;
    const valid =
      lobby.mode === "teams" &&
      player.teamId !== undefined &&
      lobby.getTeams().includes(player.teamId);
    return { ...player, teamId: valid ? player.teamId : undefined };
  }
}
