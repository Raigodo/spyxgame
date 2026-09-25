import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { LobbyPlayer } from "./types";

type LobbyPlayerHandler = (player: LobbyPlayer) => void;

// Mode-agnostic view over PlayerSession: nickname/ready control and a
// LobbyPlayer projection of the roster. Created once by LobbyController and
// shared by whichever lobby facade is currently active — never recreated on
// a mode switch, so subscriptions made through either facade survive a
// switch untouched.
export class LobbyRoster {
  private readonly joinedHandlers = new Set<LobbyPlayerHandler>();
  private readonly updatedHandlers = new Set<LobbyPlayerHandler>();
  private readonly leftHandlers = new Set<LobbyPlayerHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    this.cleanupFns.push(
      session.onPlayerJoined((p) => this.emit(this.joinedHandlers, p)),
      session.onPlayerUpdated((p) => this.emit(this.updatedHandlers, p)),
      session.onPlayerLeft((p) => this.emit(this.leftHandlers, p))
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const profile = this.session.getLocalPlayer();
    return profile ? toLobbyPlayer(profile) : undefined;
  }

  getPlayers(): LobbyPlayer[] {
    return this.session.getPlayers().map(toLobbyPlayer);
  }

  setNickname(nickname: string): void {
    this.session.updateLocalProfile({ nickname });
  }

  setReady(ready: boolean): void {
    this.session.updateLocalProfile({ metadata: { ready } });
  }

  // Used by lobby facades to write mode-specific metadata (e.g. teamId)
  // without each of them reimplementing updateLocalProfile.
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
    const player = toLobbyPlayer(profile);
    for (const handler of handlers) handler(player);
  }
}

function toLobbyPlayer(profile: PlayerProfile): LobbyPlayer {
  return {
    peerId: profile.peerId,
    nickname: profile.nickname,
    ready: Boolean(profile.metadata.ready),
    teamId: typeof profile.metadata.teamId === "string" ? profile.metadata.teamId : undefined,
  };
}
