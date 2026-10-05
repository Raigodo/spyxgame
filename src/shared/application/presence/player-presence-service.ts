import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import { PlayerReconnectionCoordinator } from "./player-reconnection-coordinator";
import type { RosterPlayer } from "./types";
import { RoomBus } from "../messaging";
import { SignalingPeerId } from "@/shared/infrastructure/signaling";

type RosterPlayerHandler = (player: RosterPlayer) => void;
type SupersededHandler = () => void;

// The single shared read-model for "who's in the room right now, with what
// connection status." Constructed once, right after PlayerSession.join(),
// and handed to whatever needs it — the lobby, then the game, then whatever
// comes after that — for as long as the player stays in the room. None of
// those consumers implement their own reconnect / duplicate-session /
// status-broadcast logic; it all lives in PlayerReconnectionCoordinator,
// wrapped here, disposed once, when the room is actually left.
export class PlayerPresenceService {
  private readonly reconnection: PlayerReconnectionCoordinator;
  private readonly joinedHandlers = new Set<RosterPlayerHandler>();
  private readonly rejoinedHandlers = new Set<RosterPlayerHandler>();
  private readonly updatedHandlers = new Set<RosterPlayerHandler>();
  private readonly leftHandlers = new Set<RosterPlayerHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(
    private readonly session: PlayerSession,
    bus: RoomBus
  ) {
    this.reconnection = new PlayerReconnectionCoordinator(session, bus);

    this.cleanupFns.push(
      // A genuinely new player and a returning one both arrive through
      // PlayerSession's single onPlayerJoined event — the reconnection
      // coordinator has already decided which, by the time this fires (it
      // subscribes first, inside its own constructor, above). A newcomer
      // currently being arbitrated as a duplicate is suppressed here
      // entirely — its join event fires later, via onPeerRevealed, if it
      // turns out to be the side that survives. The local player is exempt
      // from suppression: a peer waiting on its own arbitration outcome
      // must still see its own join fire normally.
      session.onPlayerJoined((p) => {
        const localPeerId = session.getLocalPlayer()?.peerId;
        if (p.peerId !== localPeerId && this.reconnection.isHiddenDuringArbitration(p.peerId)) {
          return;
        }
        const { returning } = this.reconnection.getPresence(p.peerId);
        this.emit(returning ? this.rejoinedHandlers : this.joinedHandlers, p);
      }),
      session.onPlayerUpdated((p) => this.emit(this.updatedHandlers, p)),
      session.onPlayerLeft((p) => this.emit(this.leftHandlers, p)),

      this.reconnection.onPeerRevealed((peerId) => {
        const profile = this.session.getPlayers().find((p) => p.peerId === peerId);
        if (!profile) return;
        const { returning } = this.reconnection.getPresence(peerId);
        this.emit(returning ? this.rejoinedHandlers : this.joinedHandlers, profile);
      }),

      // Connection status / returning flips don't flow through
      // PlayerSession's own profile events, so re-project everyone as
      // "updated" whenever presence data changes (this also covers a
      // reconnecting → normal status flip once arbitration resolves).
      this.reconnection.onChanged(() => {
        for (const profile of this.session.getPlayers()) {
          if (this.reconnection.isHiddenDuringArbitration(profile.peerId)) continue;
          this.emit(this.updatedHandlers, profile);
        }
      })
    );
  }

  // Bound to room membership, not to any particular app phase — call this
  // when the player actually leaves the room, not when the lobby (or the
  // game) is merely done with it.
  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.reconnection.dispose();
  }

  getLocalPlayer(): RosterPlayer | undefined {
    const profile = this.session.getLocalPlayer();
    return profile ? this.toRosterPlayer(profile) : undefined;
  }

  getPlayers(): RosterPlayer[] {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    return this.session
      .getPlayers()
      .filter(
        (p) => p.peerId === localPeerId || !this.reconnection.isHiddenDuringArbitration(p.peerId)
      )
      .map((p) => this.toRosterPlayer(p));
  }

  setNickname(nickname: string): void {
    this.session.updateLocalProfile({ nickname });
  }

  setLocalMetadata(metadata: Record<string, unknown>): void {
    if (this.reconnection.isLocalPending()) {
      console.warn("[PlayerPresenceService] Ignoring metadata change while reconnecting");
      return;
    }
    this.session.updateLocalProfile({ metadata });
  }

  onPlayerJoined(handler: RosterPlayerHandler): () => void {
    this.joinedHandlers.add(handler);
    return () => this.joinedHandlers.delete(handler);
  }

  onPlayerRejoined(handler: RosterPlayerHandler): () => void {
    this.rejoinedHandlers.add(handler);
    return () => this.rejoinedHandlers.delete(handler);
  }

  onPlayerUpdated(handler: RosterPlayerHandler): () => void {
    this.updatedHandlers.add(handler);
    return () => this.updatedHandlers.delete(handler);
  }

  onPlayerLeft(handler: RosterPlayerHandler): () => void {
    this.leftHandlers.add(handler);
    return () => this.leftHandlers.delete(handler);
  }

  // Fires on whichever side the host's duplicate-session arbitration
  // rejects. Relevant for the whole room lifetime, not just the lobby — so
  // subscribe to it once, independent of lobby/game phase, rather than
  // through whatever screen happens to be active when it fires.
  onSessionSuperseded(handler: SupersededHandler): () => void {
    return this.reconnection.onSessionSuperseded(handler);
  }

  /** Host only. Removes a player from the room; they are told why. Returns false if it could not be done. */
  kickPlayer(peerId: SignalingPeerId): boolean {
    return this.reconnection.kick(peerId);
  }

  /** Fires on the player the host removed. */
  onKicked(handler: SupersededHandler): () => void {
    return this.reconnection.onKicked(handler);
  }

  private emit(handlers: Set<RosterPlayerHandler>, profile: PlayerProfile): void {
    const player = this.toRosterPlayer(profile);
    for (const handler of handlers) handler(player);
  }

  private toRosterPlayer(profile: PlayerProfile): RosterPlayer {
    const presence = this.reconnection.getPresence(profile.peerId);
    return {
      peerId: profile.peerId,
      playerId:
        typeof profile.metadata.playerId === "string" ? profile.metadata.playerId : profile.peerId,
      nickname: profile.nickname,
      metadata: profile.metadata,
      connectionStatus: presence.status,
      returning: presence.returning,
    };
  }

  isLocalPending(): boolean {
    return this.reconnection.isLocalPending();
  }

  // Fires whenever presence data changes, including pending → ready.
  onPresenceChanged(handler: () => void): () => void {
    return this.reconnection.onChanged(handler);
  }
}
