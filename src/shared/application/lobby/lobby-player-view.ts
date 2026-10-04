import type { PlayerPresenceService, RosterPlayer } from "@/shared/application/presence";
import type { LobbyPlayer } from "./types";

type LobbyPlayerHandler = (player: LobbyPlayer) => void;

// Adapts the shared PlayerPresenceService into the lobby's player shape,
// adding the two pieces of state that are the lobby's concern: ready and team.
//
// "Ready" is stored in metadata as `readyRound`. A player counts as ready only
// if readyRound equals the room's current round, so ending a game resets
// everyone without anyone clearing a flag, and a stale restore replaying an
// old readyRound is ignored automatically.
export class LobbyPlayerView {
  constructor(
    private readonly presence: PlayerPresenceService,
    private readonly getRound: () => number
  ) {}

  getLocalPlayer(): LobbyPlayer | undefined {
    const player = this.presence.getLocalPlayer();
    return player ? this.project(player) : undefined;
  }

  getPlayers(): LobbyPlayer[] {
    return this.presence.getPlayers().map(this.project);
  }

  setNickname(nickname: string): void {
    this.presence.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.presence.setLocalMetadata({ readyRound: ready ? this.getRound() : null });
  }

  setLocalMetadata(metadata: Record<string, unknown>): void {
    this.presence.setLocalMetadata(metadata);
  }

  onPlayerJoined(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerJoined((p) => handler(this.project(p)));
  }

  onPlayerRejoined(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerRejoined((p) => handler(this.project(p)));
  }

  onPlayerUpdated(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerUpdated((p) => handler(this.project(p)));
  }

  onPlayerLeft(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerLeft((p) => handler(this.project(p)));
  }

  private readonly project = (player: RosterPlayer): LobbyPlayer => ({
    ...player,
    ready: player.metadata.readyRound === this.getRound(),
    teamId: typeof player.metadata.teamId === "string" ? player.metadata.teamId : undefined,
  });
}
