import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import { LobbyPresenceTracker } from "./lobby-presence-tracker";
import type { LobbyPlayer } from "./types";

type LobbyPlayerHandler = (player: LobbyPlayer) => void;

export class LobbyRoster {
  private readonly presence: LobbyPresenceTracker;
  private readonly joinedHandlers = new Set<LobbyPlayerHandler>();
  private readonly updatedHandlers = new Set<LobbyPlayerHandler>();
  private readonly leftHandlers = new Set<LobbyPlayerHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    this.presence = new LobbyPresenceTracker(session);

    this.cleanupFns.push(
      session.onPlayerJoined((p) => this.emit(this.joinedHandlers, p)),
      session.onPlayerUpdated((p) => this.emit(this.updatedHandlers, p)),
      session.onPlayerLeft((p) => this.emit(this.leftHandlers, p)),

      // Connection status / returning flips don't flow through
      // PlayerSession's own profile events (they're not part of the synced
      // profile), so re-project everyone as "updated" whenever presence
      // data changes.
      this.presence.onChanged(() => {
        for (const profile of this.session.getPlayers()) {
          this.emit(this.updatedHandlers, profile);
        }
      })
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.presence.dispose();
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const profile = this.session.getLocalPlayer();
    return profile ? this.toLobbyPlayer(profile) : undefined;
  }

  getPlayers(): LobbyPlayer[] {
    return this.session.getPlayers().map((p) => this.toLobbyPlayer(p));
  }

  setNickname(nickname: string): void {
    this.session.updateLocalProfile({ nickname });
  }

  setReady(ready: boolean): void {
    this.session.updateLocalProfile({ metadata: { ready } });
  }

  setLocalMetadata(metadata: Record<string, unknown>): void {
    this.session.updateLocalProfile({ metadata });
  }

  onPlayerJoined(handler: LobbyPlayerHandler): () => void {
    this.joinedHandlers.add(handler);
    return () => this.joinedHandlers.delete(handler);
  }

  onPlayerUpdated(handler: LobbyPlayerHandler): () => void {
    this.updatedHandlers.add(handler);
    return () => this.updatedHandlers.delete(handler);
  }

  onPlayerLeft(handler: LobbyPlayerHandler): () => void {
    this.leftHandlers.add(handler);
    return () => this.leftHandlers.delete(handler);
  }

  private emit(handlers: Set<LobbyPlayerHandler>, profile: PlayerProfile): void {
    const player = this.toLobbyPlayer(profile);
    for (const handler of handlers) handler(player);
  }

  private toLobbyPlayer(profile: PlayerProfile): LobbyPlayer {
    const presence = this.presence.getPresence(profile.peerId);
    return {
      peerId: profile.peerId,
      playerId:
        typeof profile.metadata.playerId === "string" ? profile.metadata.playerId : profile.peerId,
      nickname: profile.nickname,
      ready: Boolean(profile.metadata.ready),
      teamId: typeof profile.metadata.teamId === "string" ? profile.metadata.teamId : undefined,
      connectionStatus: presence.status,
      returning: presence.returning,
    };
  }
}
