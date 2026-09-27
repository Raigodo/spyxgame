import type { PlayerPresenceService, RosterPlayer } from "@/shared/application/presence";
import type { LobbyPlayer } from "./types";

type LobbyPlayerHandler = (player: LobbyPlayer) => void;

// Adapts the shared PlayerPresenceService — connection status, reconnects,
// duplicate arbitration, none of which this class or the lobby modes above
// it know or care about — into the lobby's own player shape, adding the two
// pieces of state that ARE the lobby's concern: ready and team assignment.
// FreeForAllLobbyService and TeamLobbyService both hold one of these
// instead of duplicating this mapping between them.
export class LobbyPlayerView {
  constructor(private readonly presence: PlayerPresenceService) {}

  getLocalPlayer(): LobbyPlayer | undefined {
    const player = this.presence.getLocalPlayer();
    return player ? toLobbyPlayer(player) : undefined;
  }

  getPlayers(): LobbyPlayer[] {
    return this.presence.getPlayers().map(toLobbyPlayer);
  }

  setNickname(nickname: string): void {
    this.presence.setNickname(nickname);
  }

  setReady(ready: boolean): void {
    this.presence.setLocalMetadata({ ready });
  }

  setLocalMetadata(metadata: Record<string, unknown>): void {
    this.presence.setLocalMetadata(metadata);
  }

  onPlayerJoined(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerJoined((p) => handler(toLobbyPlayer(p)));
  }

  onPlayerRejoined(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerRejoined((p) => handler(toLobbyPlayer(p)));
  }

  onPlayerUpdated(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerUpdated((p) => handler(toLobbyPlayer(p)));
  }

  onPlayerLeft(handler: LobbyPlayerHandler): () => void {
    return this.presence.onPlayerLeft((p) => handler(toLobbyPlayer(p)));
  }
}

function toLobbyPlayer(player: RosterPlayer): LobbyPlayer {
  return {
    ...player,
    ready: Boolean(player.metadata.ready),
    teamId: typeof player.metadata.teamId === "string" ? player.metadata.teamId : undefined,
  };
}
