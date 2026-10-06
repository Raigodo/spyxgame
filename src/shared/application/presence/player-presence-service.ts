import {
  Emitter,
  type Clock,
  type IdGenerator,
  type Logger,
  type PresenceConfig,
} from "@/shared/kernel";
import type { RoomBus } from "@/shared/application/messaging";
import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { PlayerReconnectionCoordinator } from "./player-reconnection-coordinator";
import type { RosterPlayer } from "./types";

export interface PlayerPresenceServiceDeps {
  session: PlayerSession;
  bus: RoomBus;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: PresenceConfig;
}

// The single shared read-model for "who's in the room right now, with what connection status."
// Constructed once, right after PlayerSession.join(), and handed to whatever needs it (the
// lobby, then the game, ...) for as long as the player stays in the room. None of those
// consumers implement their own reconnect / duplicate-session / status-broadcast logic; it all
// lives in PlayerReconnectionCoordinator, wrapped here, disposed once when the room is left.
export class PlayerPresenceService {
  private readonly session: PlayerSession;
  private readonly log: Logger;
  private readonly reconnection: PlayerReconnectionCoordinator;
  private readonly joined = new Emitter<RosterPlayer>();
  private readonly rejoined = new Emitter<RosterPlayer>();
  private readonly updated = new Emitter<RosterPlayer>();
  private readonly left = new Emitter<RosterPlayer>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(deps: PlayerPresenceServiceDeps) {
    const { session, bus, clock, ids, logger, config } = deps;
    this.session = session;
    this.log = logger;
    this.reconnection = new PlayerReconnectionCoordinator({
      session,
      bus,
      clock,
      ids,
      logger: logger.child("reconnection"),
      config,
    });

    this.cleanupFns.push(
      // A genuinely new player and a returning one both arrive through PlayerSession's single
      // onPlayerJoined event; the reconnection coordinator has already decided which by the time
      // this fires (it subscribed first, inside its own constructor). A newcomer currently being
      // arbitrated as a duplicate is suppressed entirely: its join event fires later, via
      // onPeerRevealed, if it turns out to be the side that survives. The local player is exempt:
      // a peer waiting on its own arbitration outcome must still see its own join fire normally.
      session.onPlayerJoined((p) => {
        const localPeerId = session.getLocalPlayer()?.peerId;
        if (p.peerId !== localPeerId && this.reconnection.isHiddenDuringArbitration(p.peerId)) {
          return;
        }
        const { returning } = this.reconnection.getPresence(p.peerId);
        this.emit(returning ? this.rejoined : this.joined, p);
      }),
      session.onPlayerUpdated((p) => this.emit(this.updated, p)),
      session.onPlayerLeft((p) => this.emit(this.left, p)),

      this.reconnection.onPeerRevealed((peerId) => {
        const profile = this.session.getPlayers().find((p) => p.peerId === peerId);
        if (!profile) return;
        const { returning } = this.reconnection.getPresence(peerId);
        this.emit(returning ? this.rejoined : this.joined, profile);
      }),

      // Connection status / returning flips don't flow through PlayerSession's own profile
      // events, so re-project everyone as "updated" whenever presence data changes (this also
      // covers a reconnecting -> normal status flip once arbitration resolves).
      this.reconnection.onChanged(() => {
        for (const profile of this.session.getPlayers()) {
          if (this.reconnection.isHiddenDuringArbitration(profile.peerId)) continue;
          this.emit(this.updated, profile);
        }
      })
    );
  }

  // Bound to room membership, not to any app phase: call this when the player actually leaves
  // the room, not when the lobby (or the game) is merely done with it.
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
      this.log.warn("Ignoring metadata change while reconnecting");
      return;
    }
    this.session.updateLocalProfile({ metadata });
  }

  isLocalPending(): boolean {
    return this.reconnection.isLocalPending();
  }

  onPlayerJoined(handler: (player: RosterPlayer) => void): () => void {
    return this.joined.on(handler);
  }

  onPlayerRejoined(handler: (player: RosterPlayer) => void): () => void {
    return this.rejoined.on(handler);
  }

  onPlayerUpdated(handler: (player: RosterPlayer) => void): () => void {
    return this.updated.on(handler);
  }

  onPlayerLeft(handler: (player: RosterPlayer) => void): () => void {
    return this.left.on(handler);
  }

  // Fires whenever presence data changes, including pending -> ready.
  onPresenceChanged(handler: () => void): () => void {
    return this.reconnection.onChanged(handler);
  }

  // Fires on whichever side the host's duplicate-session arbitration rejects. Relevant for the
  // whole room lifetime, so subscribe once, independent of lobby/game phase.
  onSessionSuperseded(handler: () => void): () => void {
    return this.reconnection.onSessionSuperseded(handler);
  }

  /** Host only. Removes a player from the room; they are told why. Returns false if it could not be done. */
  kickPlayer(peerId: SignalingPeerId): boolean {
    return this.reconnection.kick(peerId);
  }

  /** Fires on the player the host removed. */
  onKicked(handler: () => void): () => void {
    return this.reconnection.onKicked(handler);
  }

  private emit(emitter: Emitter<RosterPlayer>, profile: PlayerProfile): void {
    emitter.emit(this.toRosterPlayer(profile));
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
}
