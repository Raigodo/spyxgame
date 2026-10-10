import {
  Emitter,
  listenerFailure,
  type Clock,
  type IdGenerator,
  type Logger,
  type PresenceConfig,
} from "@/shared/kernel";
import type { RoomBus } from "@/shared/application/messaging";
import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { DepartureGhosts } from "./departure-ghosts";
import { readPlayerId } from "./duplicate-rules";
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
// Constructed once, right after PlayerSession.join(), and handed to whatever needs it for as
// long as the player stays in the room. Reconnect, duplicate-session and status-broadcast logic
// lives in PlayerReconnectionCoordinator; departed players linger as ghosts (DepartureGhosts).
export class PlayerPresenceService {
  private readonly session: PlayerSession;
  private readonly log: Logger;
  private readonly reconnection: PlayerReconnectionCoordinator;
  private readonly ghosts: DepartureGhosts;
  private readonly onListenerError = listenerFailure(() => this.log);
  private readonly joined = new Emitter<RosterPlayer>(this.onListenerError);
  private readonly rejoined = new Emitter<RosterPlayer>(this.onListenerError);
  private readonly updated = new Emitter<RosterPlayer>(this.onListenerError);
  private readonly left = new Emitter<RosterPlayer>(this.onListenerError);
  private readonly cleanupFns: Array<() => void> = [];

  constructor(deps: PlayerPresenceServiceDeps) {
    const { session, bus, clock, ids, logger, config } = deps;
    this.session = session;
    this.log = logger;
    this.ghosts = new DepartureGhosts({
      clock,
      graceMs: config.departureGraceMs,
      onExpired: (player) => this.left.emit(player),
    });
    this.reconnection = new PlayerReconnectionCoordinator({
      session,
      bus,
      clock,
      ids,
      logger: logger.child("reconnection"),
      config,
    });

    this.cleanupFns.push(
      // A new player and a returning one both arrive through PlayerSession's onPlayerJoined; the
      // coordinator has already decided which by the time this fires (it subscribed first). A
      // newcomer under duplicate arbitration is suppressed: its join fires later, via
      // onPeerRevealed, if it survives.
      session.onPlayerJoined((p) => {
        if (!this.isVisible(p)) return;
        this.noteArrival(p);
        const { returning } = this.reconnection.getPresence(p.peerId);
        this.emit(returning ? this.rejoined : this.joined, p);
      }),
      session.onPlayerUpdated((p) => this.emit(this.updated, p)),
      session.onPlayerLeft((p) => this.handleDeparture(p)),

      this.reconnection.onPeerRevealed((peerId) => {
        const profile = this.session.getPlayers().find((p) => p.peerId === peerId);
        if (!profile) return;
        this.noteArrival(profile);
        const { returning } = this.reconnection.getPresence(peerId);
        this.emit(returning ? this.rejoined : this.joined, profile);
      }),

      this.reconnection.onFarewell((playerId) => {
        const ghost = this.ghosts.drop(playerId);
        if (ghost) this.left.emit(ghost);
        else this.ghosts.announceRemoval(playerId);
      }),

      // Connection status and returning flips don't flow through PlayerSession's profile events,
      // so re-project everyone as "updated" whenever presence data changes.
      this.reconnection.onChanged(() => {
        for (const profile of this.session.getPlayers()) {
          if (!this.isVisible(profile)) continue;
          this.emit(this.updated, profile);
        }
      })
    );
  }

  // Bound to room membership, not to any app phase: call it when the player actually leaves.
  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.ghosts.dispose();
    this.reconnection.dispose();
  }

  getLocalPlayer(): RosterPlayer | undefined {
    const profile = this.session.getLocalPlayer();
    return profile ? this.toRosterPlayer(profile) : undefined;
  }

  getPlayers(): RosterPlayer[] {
    const live = this.session
      .getPlayers()
      .filter((p) => this.isVisible(p))
      .map((p) => this.toRosterPlayer(p));
    return [...live, ...this.ghosts.list()];
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

  inspect(): Record<string, unknown> {
    return {
      ghosts: this.ghosts.list().map((g) => ({ peerId: g.peerId, playerId: g.playerId })),
      coordinator: this.reconnection.inspect(),
    };
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

  // Fires on whichever side the host's duplicate-tab arbitration rejects.
  onSuperseded(handler: () => void): () => void {
    return this.reconnection.onSuperseded(handler);
  }

  /** Host only. Removes a player from the room; they are told why. Returns false if it could not be done. */
  kickPlayer(peerId: SignalingPeerId): boolean {
    const ghostPlayerId = this.ghosts.findPlayerIdByPeer(peerId);
    if (ghostPlayerId !== undefined) {
      const ghost = this.ghosts.drop(ghostPlayerId); // nothing to disconnect: just drop the row
      if (ghost) this.left.emit(ghost);
      return true;
    }
    return this.reconnection.kick(peerId);
  }

  /** Fires on the player the host removed. */
  onKicked(handler: () => void): () => void {
    return this.reconnection.onKicked(handler);
  }

  // ─── Visibility and ghosts ────────────────────────────────────────────────

  // One rule for what the local player may see: their own row, minus newcomers under duplicate
  // arbitration, minus their own previous incarnation (a refresh).
  private isVisible(profile: PlayerProfile): boolean {
    if (profile.peerId === this.session.getLocalPlayer()?.peerId) return true;
    if (this.reconnection.isHiddenDuringArbitration(profile.peerId)) return false;
    const own = this.localPlayerId();
    return own === undefined || readPlayerId(profile.metadata) !== own;
  }

  private localPlayerId(): string | undefined {
    const profile = this.session.getLocalPlayer();
    return profile && readPlayerId(profile.metadata);
  }

  // A player left. Unless it is us, was removed on purpose, or already has a live replacement,
  // keep a "reconnecting" row for the grace period instead of dropping them.
  private handleDeparture(profile: PlayerProfile): void {
    const playerId = readPlayerId(profile.metadata);
    if (playerId === undefined || !this.shouldShowAsReconnecting(playerId)) {
      this.emit(this.left, profile);
      return;
    }
    const ghost: RosterPlayer = {
      ...this.toRosterPlayer(profile),
      connectionStatus: "reconnecting",
      returning: false,
    };
    this.ghosts.add(playerId, ghost);
    this.updated.emit(ghost);
  }

  private shouldShowAsReconnecting(playerId: string): boolean {
    const removedOnPurpose = this.ghosts.takeRemoval(playerId);
    const isOwn = playerId === this.localPlayerId();
    const hasReplacement = this.session
      .getPlayers()
      .some((p) => readPlayerId(p.metadata) === playerId);
    return !removedOnPurpose && !isOwn && !hasReplacement;
  }

  // The same player arrived again: any ghost row has done its job.
  private noteArrival(profile: PlayerProfile): void {
    const playerId = readPlayerId(profile.metadata);
    if (playerId === undefined) return;
    this.ghosts.takeRemoval(playerId);
    const ghost = this.ghosts.drop(playerId);
    if (ghost) this.left.emit(ghost);
  }

  private emit(emitter: Emitter<RosterPlayer>, profile: PlayerProfile): void {
    emitter.emit(this.toRosterPlayer(profile));
  }

  private toRosterPlayer(profile: PlayerProfile): RosterPlayer {
    const presence = this.reconnection.getPresence(profile.peerId);
    return {
      peerId: profile.peerId,
      playerId: readPlayerId(profile.metadata) ?? profile.peerId,
      nickname: profile.nickname,
      metadata: profile.metadata,
      connectionStatus: presence.status,
      returning: presence.returning,
    };
  }
}
