import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import { LobbyPresenceTracker } from "./lobby-presence-tracker";
import type { LobbyPlayer } from "./types";

type LobbyPlayerHandler = (player: LobbyPlayer) => void;
type SupersededHandler = () => void;

export class LobbyRoster {
  private readonly presence: LobbyPresenceTracker;
  private readonly joinedHandlers = new Set<LobbyPlayerHandler>();
  private readonly rejoinedHandlers = new Set<LobbyPlayerHandler>();
  private readonly updatedHandlers = new Set<LobbyPlayerHandler>();
  private readonly leftHandlers = new Set<LobbyPlayerHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    this.presence = new LobbyPresenceTracker(session);

    this.cleanupFns.push(
      // A genuinely new player and a returning one both arrive through
      // PlayerSession's single onPlayerJoined event — LobbyPresenceTracker
      // has already decided which, by the time this fires (it subscribes
      // first, inside its own constructor, above). A newcomer currently
      // being arbitrated as a duplicate is suppressed here entirely — its
      // join event fires later, via onPeerRevealed, if it turns out to be
      // the side that survives. The local player is exempt from
      // suppression: a peer waiting on its own arbitration outcome must
      // still see its own join fire normally.
      session.onPlayerJoined((p) => {
        const localPeerId = session.getLocalPlayer()?.peerId;
        if (p.peerId !== localPeerId && this.presence.isHiddenDuringArbitration(p.peerId)) return;
        const { returning } = this.presence.getPresence(p.peerId);
        this.emit(returning ? this.rejoinedHandlers : this.joinedHandlers, p);
      }),
      session.onPlayerUpdated((p) => this.emit(this.updatedHandlers, p)),
      session.onPlayerLeft((p) => this.emit(this.leftHandlers, p)),

      this.presence.onPeerRevealed((peerId) => {
        const profile = this.session.getPlayers().find((p) => p.peerId === peerId);
        if (!profile) return;
        const { returning } = this.presence.getPresence(peerId);
        this.emit(returning ? this.rejoinedHandlers : this.joinedHandlers, profile);
      }),

      // Connection status / returning flips don't flow through
      // PlayerSession's own profile events, so re-project everyone as
      // "updated" whenever presence data changes (this also covers a
      // reconnecting → normal status flip once arbitration resolves).
      this.presence.onChanged(() => {
        for (const profile of this.session.getPlayers()) {
          if (this.presence.isHiddenDuringArbitration(profile.peerId)) continue;
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
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    return this.session
      .getPlayers()
      .filter((p) => p.peerId === localPeerId || !this.presence.isHiddenDuringArbitration(p.peerId))
      .map((p) => this.toLobbyPlayer(p));
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

  onPlayerRejoined(handler: LobbyPlayerHandler): () => void {
    this.rejoinedHandlers.add(handler);
    return () => this.rejoinedHandlers.delete(handler);
  }

  onPlayerUpdated(handler: LobbyPlayerHandler): () => void {
    this.updatedHandlers.add(handler);
    return () => this.updatedHandlers.delete(handler);
  }

  onPlayerLeft(handler: LobbyPlayerHandler): () => void {
    this.leftHandlers.add(handler);
    return () => this.leftHandlers.delete(handler);
  }

  onSessionSuperseded(handler: SupersededHandler): () => void {
    return this.presence.onSessionSuperseded(handler);
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
