import {
  Emitter,
  shortId,
  type Cancel,
  type Clock,
  type IdGenerator,
  type Logger,
  type PresenceConfig,
} from "@/shared/kernel";
import type { EventChannel, RoomBus } from "@/shared/application/messaging";
import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";
import type { PlayerPresence } from "./types";
import {
  findDuplicateGroups,
  findExistingDuplicate,
  findSurvivor,
  planArbitration,
  readPlayerId,
} from "./duplicate-rules";

type PersistedMetadata = Record<string, unknown>;

type PresenceEntry = { status: RtcPeerStatus; returning: boolean };
type PresenceMap = Record<SignalingPeerId, PresenceEntry>;

// Everything this layer sends travels as one event on the bus channel "presence". The bus
// delivers the host-verified sender as `from`.
type PresenceEvent =
  | { t: "status"; presence: PresenceMap } // host -> all
  | { t: "restore"; metadata: PersistedMetadata } // host -> returning peer
  | { t: "ping"; nonce: string } // host -> old peer
  | { t: "pong"; nonce: string } // old peer -> host
  | { t: "rejected" } // host -> rejected peer
  | { t: "duplicate"; playerId: string; oldPeerId: SignalingPeerId; newPeerId: SignalingPeerId } // host -> all
  | { t: "hello" } // guest -> host: "send me the presence status"
  | { t: "kicked" }; // host -> kicked peer

const STATUSES: readonly string[] = ["connecting", "active", "reconnecting"];
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Network input: never trust its shape.
function parsePresenceEvent(raw: unknown): PresenceEvent | undefined {
  if (!isRec(raw)) return undefined;
  switch (raw.t) {
    case "status": {
      if (!isRec(raw.presence)) return undefined;
      const presence: PresenceMap = {};
      for (const [peerId, entry] of Object.entries(raw.presence)) {
        if (
          isRec(entry) &&
          typeof entry.status === "string" &&
          STATUSES.includes(entry.status) &&
          typeof entry.returning === "boolean"
        ) {
          presence[peerId] = { status: entry.status as RtcPeerStatus, returning: entry.returning };
        }
      }
      return { t: "status", presence };
    }
    case "restore":
      return isRec(raw.metadata) ? { t: "restore", metadata: raw.metadata } : undefined;
    case "ping":
      return typeof raw.nonce === "string" ? { t: "ping", nonce: raw.nonce } : undefined;
    case "pong":
      return typeof raw.nonce === "string" ? { t: "pong", nonce: raw.nonce } : undefined;
    case "rejected":
      return { t: "rejected" };
    case "duplicate":
      return typeof raw.playerId === "string" &&
        typeof raw.oldPeerId === "string" &&
        typeof raw.newPeerId === "string"
        ? {
            t: "duplicate",
            playerId: raw.playerId,
            oldPeerId: raw.oldPeerId,
            newPeerId: raw.newPeerId,
          }
        : undefined;
    case "hello":
      return { t: "hello" };
    case "kicked":
      return { t: "kicked" };
    default:
      return undefined;
  }
}

interface PendingArbitration {
  nonce: string;
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  cancelTimeout: Cancel;
}

interface ActiveDuplicate {
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  cancelSafety: Cancel;
}

export interface PlayerReconnectionCoordinatorDeps {
  session: PlayerSession;
  bus: RoomBus;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: PresenceConfig;
}

// The only place in the app that knows about connection status, "have we seen this playerId
// before" history, and the same-playerId-live-twice case. Wrapped by PlayerPresenceService:
// nothing above that layer needs to know any of this exists.
//
//  - Connection status tracking: host-only. The host is the only peer with a direct RTC link to
//    everyone, so it broadcasts that state to everyone else.
//  - Returning-player detection: host-only. On a player's departure, their entire metadata bag
//    is snapshotted under their durable playerId; if that playerId rejoins later (new peerId,
//    same person), the host replays the snapshot back to them. This layer never looks inside it.
//  - Duplicate-session arbitration: host-only and liveness-based. When a new peer's playerId
//    matches an already-live peer, the host pings the existing one and waits briefly. A reply
//    means it's alive, so the newcomer is rejected. Silence means it's a ghost, so the existing
//    one is removed. Also runs when a guest is promoted to host (see onPromoted).
//  - Display hiding: the moment arbitration starts, the host broadcasts which pair of peerIds is
//    involved, so every peer shows ONE entry for the disputed playerId and withholds the newcomer
//    until the outcome is known.
export class PlayerReconnectionCoordinator {
  private readonly session: PlayerSession;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly log: Logger;
  private readonly config: PresenceConfig;

  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, PersistedMetadata>();
  private remotePresence: PresenceMap = {};

  // Host-only: the ping/timeout for an in-flight liveness check, per playerId.
  private readonly pendingArbitrations = new Map<string, PendingArbitration>();

  // Every peer: which (playerId -> old/new peerId pair) is currently disputed.
  private readonly activeDuplicates = new Map<string, ActiveDuplicate>();

  // Cancel functions for arbitrations waiting on data-channel links.
  private readonly linkWaits = new Set<() => void>();

  private readonly changed = new Emitter();
  private readonly superseded = new Emitter();
  private readonly kicked = new Emitter();
  private readonly revealed = new Emitter<SignalingPeerId>();
  private readonly cleanupFns: Array<() => void> = [];

  private readonly channel: EventChannel<PresenceEvent>;
  private wasHost: boolean;

  constructor(deps: PlayerReconnectionCoordinatorDeps) {
    this.session = deps.session;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.log = deps.logger;
    this.config = deps.config;
    const { session, bus } = deps;

    // Registered before bus.start(), like every channel.
    this.channel = bus.eventChannel<PresenceEvent>({
      id: "presence",
      validate: parsePresenceEvent,
    });
    this.wasHost = session.isHost();

    const localPeerId = session.getLocalPlayer()?.peerId;
    for (const profile of session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      const status = session.getPeerConnectionStatus(profile.peerId);
      if (status) this.hostStatuses.set(profile.peerId, status);
    }
    if (session.isHost()) this.arbitrateExistingDuplicates();

    this.cleanupFns.push(
      session.onPeerConnectionStatusChanged((peer) => {
        if (!session.isHost()) {
          if (peer.status === "active" && peer.signalingPeerId === session.getHostPeerId()) {
            this.sayHelloIfPending();
          }
          return;
        }
        this.hostStatuses.set(peer.signalingPeerId, peer.status);
        this.syncAndBroadcast();
      }),

      session.onHostChanged(() => this.handleHostChanged()),

      session.onPlayerJoined((profile) => {
        if (session.isHost()) {
          this.arbitrateIfDuplicate(profile);

          this.hostStatuses.set(
            profile.peerId,
            session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
          );

          const playerId = readPlayerId(profile.metadata);
          const remembered = playerId ? this.history.get(playerId) : undefined;
          if (remembered) {
            this.returningPeerIds.add(profile.peerId);
            this.channel.sendTo(profile.peerId, { t: "restore", metadata: remembered });
          }

          this.syncAndBroadcast();
        }
      }),

      session.onPlayerLeft((profile) => {
        const playerId = readPlayerId(profile.metadata);
        if (playerId) {
          this.history.set(playerId, { ...profile.metadata });
        }

        // Refresh case: the ghost (old peer) leaves while its replacement is already in the
        // room. The join-time restore found nothing in `history` back then, so hand the ghost's
        // metadata to the survivor now. Must run BEFORE resolveActiveDuplicate, which fires the
        // reveal that decides joined-vs-rejoined from `returning`.
        if (session.isHost() && playerId) {
          const survivor = this.findSurvivorReplacing(profile.peerId);
          if (survivor) {
            this.returningPeerIds.add(survivor);
            this.channel.sendTo(survivor, { t: "restore", metadata: { ...profile.metadata } });
          }
        }

        this.resolveActiveDuplicate(profile.peerId);

        if (session.isHost()) {
          this.hostStatuses.delete(profile.peerId);
          this.returningPeerIds.delete(profile.peerId);
          this.syncAndBroadcast();
        }
      }),

      this.channel.onEvent((event, from) => this.handleEvent(event, from))
    );

    // The host's one-time status broadcast can be dropped around a host change; keep asking
    // while pending.
    this.cleanupFns.push(
      this.clock.every(this.config.helloIntervalMs, () => this.sayHelloIfPending())
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    for (const cancel of Array.from(this.linkWaits)) cancel();
    this.linkWaits.clear();
    for (const arbitration of this.pendingArbitrations.values()) arbitration.cancelTimeout();
    for (const duplicate of this.activeDuplicates.values()) duplicate.cancelSafety();
    this.pendingArbitrations.clear();
    this.activeDuplicates.clear();
    this.hostStatuses.clear();
    this.returningPeerIds.clear();
    this.history.clear();
    this.remotePresence = {};
  }

  getPresence(targetPeerId: SignalingPeerId): PlayerPresence {
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    if (targetPeerId === localPeerId) {
      return { status: "self", returning: this.remotePresence[targetPeerId]?.returning ?? false };
    }

    if (this.isReconnectingDuringArbitration(targetPeerId)) {
      return { status: "reconnecting", returning: this.returningPeerIds.has(targetPeerId) };
    }

    if (this.session.isHost()) {
      return {
        status: this.hostStatuses.get(targetPeerId) ?? "connecting",
        returning: this.returningPeerIds.has(targetPeerId),
      };
    }

    if (targetPeerId === this.session.getHostPeerId()) {
      return {
        status: this.session.getPeerConnectionStatus(targetPeerId) ?? "connecting",
        returning: this.remotePresence[targetPeerId]?.returning ?? false,
      };
    }

    const remote = this.remotePresence[targetPeerId];
    return { status: remote?.status ?? "connecting", returning: remote?.returning ?? false };
  }

  // True for the newcomer's peerId while its duplicate is being arbitrated. PlayerPresenceService
  // filters these out of getPlayers() entirely, except for the local player's own row.
  isHiddenDuringArbitration(peerId: SignalingPeerId): boolean {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.newPeerId === peerId) return true;
    }
    return false;
  }

  // True while the local (guest) peer is still being acknowledged by the host or is the newcomer
  // in a duplicate-session arbitration. Local state-changing actions should wait until this is
  // false, so a pending restore can never overwrite something the user just did.
  isLocalPending(): boolean {
    if (this.session.isHost()) return false;
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!localPeerId) return false;

    if (this.remotePresence[localPeerId] === undefined) return true; // host hasn't acknowledged us yet
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.newPeerId === localPeerId) return true;
    }
    return false;
  }

  private isReconnectingDuringArbitration(peerId: SignalingPeerId): boolean {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.oldPeerId === peerId) return true;
    }
    return false;
  }

  onChanged(handler: () => void): () => void {
    return this.changed.on(handler);
  }

  // Fires on whichever side the host's arbitration rejects.
  onSessionSuperseded(handler: () => void): () => void {
    return this.superseded.on(handler);
  }

  // Fires on the player the host removed.
  onKicked(handler: () => void): () => void {
    return this.kicked.on(handler);
  }

  // Host only. Tells the player why, then removes them from the room.
  kick(peerId: SignalingPeerId): boolean {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!this.session.isHost() || peerId === localPeerId) return false;
    if (!this.session.getPlayers().some((p) => p.peerId === peerId)) return false;
    this.reject(peerId, "kicked");
    return true;
  }

  // Fires with a peerId that was hidden as a newcomer-under-arbitration and has now been
  // confirmed as the surviving side.
  onPeerRevealed(handler: (peerId: SignalingPeerId) => void): () => void {
    return this.revealed.on(handler);
  }

  // ─── Incoming events ──────────────────────────────────────────────────────

  private handleEvent(event: PresenceEvent, from: SignalingPeerId): void {
    const hostPeerId = this.session.getHostPeerId();
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    // These can arrive at (or need applying by) anyone regardless of role: a guest must answer a
    // ping, act on a rejection, and hide a duplicate, even though only the host initiates them.
    if (event.t === "ping" && from === hostPeerId) {
      this.channel.sendTo(from, { t: "pong", nonce: event.nonce });
      return;
    }
    if (event.t === "rejected" && from === hostPeerId) {
      this.superseded.emit();
      this.session
        .leave()
        .catch((error) => this.log.warn("Failed to leave after rejection", error));
      return;
    }

    if (event.t === "kicked" && from === hostPeerId) {
      this.kicked.emit();
      this.session
        .leave()
        .catch((error) => this.log.warn("Failed to leave after being kicked", error));
      return;
    }

    if (event.t === "duplicate" && from === hostPeerId) {
      this.registerActiveDuplicate(event.playerId, event.oldPeerId, event.newPeerId);
      this.changed.emit();
      return;
    }

    if (event.t === "hello") {
      if (this.session.isHost() && from !== localPeerId) this.sendStatusTo(from);
      return;
    }

    // A pong travels guest -> host, so `from` is the old peer, not the host. It must be handled
    // before the host-only guards below, or every arbitration times out and a live old tab is
    // treated as a ghost.
    if (event.t === "pong") {
      if (this.session.isHost()) this.handlePong(from, event.nonce);
      return;
    }

    if (from === localPeerId) return; // our own broadcast, echoed back
    if (from !== hostPeerId) return; // everything else is host-only

    if (event.t === "status") {
      this.remotePresence = event.presence;
      this.changed.emit();
    } else if (event.t === "restore") {
      this.session.updateLocalProfile({ metadata: event.metadata });
    }
  }

  // ─── Host role changes ────────────────────────────────────────────────────

  private handleHostChanged(): void {
    const isHost = this.session.isHost();
    this.sayHelloIfPending();
    if (isHost === this.wasHost) return;
    this.wasHost = isHost;
    if (isHost) this.onPromoted();
    else this.onDemoted();
  }

  // A guest just became host. It missed every join that happened before, so seed what it can
  // observe directly, then arbitrate duplicates that already exist.
  private onPromoted(): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    for (const profile of this.session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      this.hostStatuses.set(
        profile.peerId,
        this.session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
      );
    }
    this.syncAndBroadcast();
    this.arbitrateExistingDuplicates();
  }

  // Lost the host role: drop host-only bookkeeping. Guests learn presence from the new host.
  private onDemoted(): void {
    for (const cancel of Array.from(this.linkWaits)) cancel();
    this.linkWaits.clear();
    for (const arbitration of this.pendingArbitrations.values()) arbitration.cancelTimeout();
    this.pendingArbitrations.clear();
    this.hostStatuses.clear();
    this.returningPeerIds.clear();
  }

  // ─── Every peer: reacting to a duplicate-detected broadcast ───────────────

  private registerActiveDuplicate(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    if (this.activeDuplicates.has(playerId)) return;
    const cancelSafety = this.clock.after(this.config.duplicateRevealTimeoutMs, () => {
      // We never heard a definitive resolution (a dropped message, most likely): reveal
      // whichever side is actually still present rather than hiding it forever.
      this.activeDuplicates.delete(playerId);
      const stillThere = this.session.getPlayers().some((p) => p.peerId === newPeerId);
      if (stillThere) this.revealed.emit(newPeerId);
      this.changed.emit();
    });

    this.activeDuplicates.set(playerId, { oldPeerId, newPeerId, cancelSafety });
  }

  private resolveActiveDuplicate(departedPeerId: SignalingPeerId): void {
    for (const [playerId, duplicate] of this.activeDuplicates) {
      if (duplicate.oldPeerId !== departedPeerId && duplicate.newPeerId !== departedPeerId) {
        continue;
      }

      duplicate.cancelSafety();
      this.activeDuplicates.delete(playerId);

      // The ghost (old) left and the newcomer survived: it was hidden this whole time and needs
      // its join event fired now, for the first time.
      if (duplicate.oldPeerId === departedPeerId) this.revealed.emit(duplicate.newPeerId);
      this.changed.emit();
      return;
    }
  }

  // ─── Host-only arbitration ────────────────────────────────────────────────

  private arbitrateExistingDuplicates(): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    for (const group of findDuplicateGroups(this.session.getPlayers(), localPeerId)) {
      this.afterLinksActive(group.involvedPeerIds, () => {
        if (!this.session.isHost()) return;
        const current = this.session.getPlayers().find((p) => p.peerId === group.newcomerPeerId);
        if (current) this.arbitrateIfDuplicate(current);
      });
    }
  }

  private afterLinksActive(peerIds: SignalingPeerId[], run: () => void): void {
    const ready = () =>
      peerIds.every((id) => this.session.getPeerConnectionStatus(id) === "active");
    if (ready()) {
      run();
      return;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      cancelTimer();
      this.linkWaits.delete(cancel);
      run();
    };
    const cancel = () => {
      finished = true;
      off();
      cancelTimer();
      this.linkWaits.delete(cancel);
    };
    const off = this.session.onPeerConnectionStatusChanged(() => {
      if (ready()) finish();
    });
    const cancelTimer = this.clock.after(this.config.linkWaitMs, finish);
    this.linkWaits.add(cancel);
  }

  private arbitrateIfDuplicate(newProfile: PlayerProfile): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    // Never treat our own local join as "the newcomer": the host-refreshes-itself case is handled
    // by the dead-host detection and the returning-player restore instead, not this path.
    if (newProfile.peerId === localPeerId) return;

    const playerId = readPlayerId(newProfile.metadata);
    if (!playerId) return;
    if (this.pendingArbitrations.has(playerId)) return; // one arbitration at a time per playerId

    const existing = findExistingDuplicate(this.session.getPlayers(), newProfile, playerId);
    if (!existing) return;

    this.broadcastDuplicateDetected(playerId, existing.peerId, newProfile.peerId);

    if (planArbitration(existing.peerId, localPeerId) === "reject-newcomer") {
      this.reject(newProfile.peerId);
      return;
    }

    const nonce = this.ids.next();
    const cancelTimeout = this.clock.after(this.config.pingTimeoutMs, () => {
      const pending = this.pendingArbitrations.get(playerId);
      if (!pending || pending.nonce !== nonce) return; // already resolved by a pong
      this.pendingArbitrations.delete(playerId);
      this.reject(pending.oldPeerId); // no reply in time: treat as a ghost
    });

    this.pendingArbitrations.set(playerId, {
      nonce,
      oldPeerId: existing.peerId,
      newPeerId: newProfile.peerId,
      cancelTimeout,
    });

    this.channel.sendTo(existing.peerId, { t: "ping", nonce });
  }

  private handlePong(fromPeerId: SignalingPeerId, nonce: string): void {
    for (const [playerId, pending] of this.pendingArbitrations) {
      if (pending.oldPeerId !== fromPeerId || pending.nonce !== nonce) continue;
      pending.cancelTimeout();
      this.pendingArbitrations.delete(playerId);
      this.reject(pending.newPeerId); // pre-existing connection answered: genuinely alive
      return;
    }
  }

  private reject(peerId: SignalingPeerId, notice: "rejected" | "kicked" = "rejected"): void {
    this.log.debug(`Removing peer=${shortId(peerId)} (${notice})`);
    this.channel.sendTo(peerId, { t: notice }); // best-effort courtesy notice
    this.session
      .hostRemovePeer(peerId)
      .catch((error) => this.log.warn("Failed to remove peer", error));
  }

  // Broadcasts the "hide this pair" signal for every OTHER peer, and applies it directly to our
  // own state too.
  private broadcastDuplicateDetected(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    this.channel.broadcast({ t: "duplicate", playerId, oldPeerId, newPeerId });
    this.registerActiveDuplicate(playerId, oldPeerId, newPeerId);
    this.changed.emit();
  }

  private sayHelloIfPending(): void {
    if (this.session.isHost() || !this.isLocalPending()) return;
    const hostPeerId = this.session.getHostPeerId();
    if (hostPeerId && this.session.getPeerConnectionStatus(hostPeerId) === "active") {
      this.channel.sendTo(hostPeerId, { t: "hello" });
    }
  }

  private sendStatusTo(peerId: SignalingPeerId): void {
    // A promoted host may not have observed this guest yet; make sure the reply includes it.
    if (!this.hostStatuses.has(peerId)) {
      this.hostStatuses.set(peerId, this.session.getPeerConnectionStatus(peerId) ?? "connecting");
    }
    this.channel.sendTo(peerId, { t: "status", presence: this.buildPresenceMap() });
  }

  private buildPresenceMap(): PresenceMap {
    const presence: PresenceMap = {};
    for (const [peerId, status] of this.hostStatuses) {
      presence[peerId] = { status, returning: this.returningPeerIds.has(peerId) };
    }
    return presence;
  }

  private syncAndBroadcast(): void {
    this.channel.broadcast({ t: "status", presence: this.buildPresenceMap() });
    this.changed.emit();
  }

  // The newcomer's peerId if `departedPeerId` was the old side of a disputed pair and the
  // newcomer is still in the room.
  private findSurvivorReplacing(departedPeerId: SignalingPeerId): SignalingPeerId | undefined {
    const present = new Set(this.session.getPlayers().map((p) => p.peerId));
    return findSurvivor(this.activeDuplicates.values(), departedPeerId, present);
  }
}
