import type { PlayerPresenceService } from "@/shared/application/presence";
import { allReady, normalizeTeam, teamChoiceError } from "./lobby-rules";
import { LobbyPlayerView } from "./lobby-player-view";
import type { LobbyConfig, LobbyPlayer } from "./types";

type PlayerHandler = (player: LobbyPlayer) => void;

// The one lobby service. It sends and receives nothing: the lobby config (mode and teams) is
// replicated by the room state, and the client calls applyConfig() when it changes. Created once
// per room and never rebuilt on endGame. Rules live in lobby-rules.ts.
//
// Player events come straight from the presence-backed view, so they keep working across mode
// switches. Subscribers never re-subscribe.
export class LobbyModule {
  private readonly view: LobbyPlayerView;
  private config: LobbyConfig;

  constructor(
    presence: PlayerPresenceService,
    getRound: () => number,
    config: LobbyConfig = { mode: "free-for-all" }
  ) {
    this.view = new LobbyPlayerView(presence, getRound);
    this.config = config;
  }

  getConfig(): LobbyConfig {
    return this.config;
  }

  applyConfig(config: LobbyConfig): void {
    this.config = config;
  }

  getPlayers(): LobbyPlayer[] {
    return this.view.getPlayers().map((p) => normalizeTeam(p, this.config));
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const player = this.view.getLocalPlayer();
    return player ? normalizeTeam(player, this.config) : undefined;
  }

  areAllPlayersReady(): boolean {
    return allReady(this.view.getPlayers());
  }

  setNickname(nickname: string): void {
    this.view.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.view.setReady(ready);
  }

  chooseTeam(teamId: string): void {
    const problem = teamChoiceError(this.config, teamId);
    if (problem) throw new Error(`[LobbyModule] ${problem}`);
    this.view.setLocalMetadata({ teamId });
  }

  leaveTeam(): void {
    if (this.config.mode === "teams") this.view.setLocalMetadata({ teamId: null });
  }

  onPlayerJoined(handler: PlayerHandler): () => void {
    return this.view.onPlayerJoined((p) => handler(normalizeTeam(p, this.config)));
  }

  onPlayerRejoined(handler: PlayerHandler): () => void {
    return this.view.onPlayerRejoined((p) => handler(normalizeTeam(p, this.config)));
  }

  onPlayerUpdated(handler: PlayerHandler): () => void {
    return this.view.onPlayerUpdated((p) => handler(normalizeTeam(p, this.config)));
  }

  onPlayerLeft(handler: PlayerHandler): () => void {
    return this.view.onPlayerLeft((p) => handler(normalizeTeam(p, this.config)));
  }
}
