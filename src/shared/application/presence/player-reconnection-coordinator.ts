import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";
import type { EventChannel, RoomBus } from "@/shared/application/messaging";
import type { PlayerPresence } from "./types";

type PersistedMetadata = Record<string, unknown>;

type PresenceEntry = { status: RtcPeerStatus; returning: boolean };
type PresenceMap = Record<SignalingPeerId, PresenceEntry>;

// Everything this layer sends travels as one event on the bus channel
// "presence". The bus delivers the host-verified sender as `from`.
type PresenceEvent =
  | { t: "status"; presence: PresenceMap } // host -> all
  | { t: "restore"; metadata: PersistedMetadata } // host -> returning peer
  | { t: "ping"; nonce: string } // host -> old peer
  | { t: "pong"; nonce: string } // old peer -> host
  | { t: "rejected" } // host -> rejected peer
  | { t: "duplicate"; playerId: string; oldPeerId: SignalingPeerId; newPeerId: SignalingPeerId } // host -> all
  | { t: "hello" } // guest -> host: "send me the presence status"
  | { t: "kicked" }; // host -> kicked peer

type ChangeHandler = () => void;
type SupersededHandler = () => void;
type RevealHandler = (peerId: SignalingPeerId) => void;

const PING_TIMEOUT_MS = 2000;
const HELLO_INTERVAL_MS = 3000;
// After a host promotion, how long to wait for data-channel links before
// arbitrating anyway (a link that never comes up means the peer is effectively gone).
const LINK_WAIT_MS = 8000;

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
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface ActiveDuplicate {
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  safetyTimeoutHandle: ReturnType<typeof setTimeout>;
}

// The only place in the app that knows about connection status, "have we
// seen this playerId before" history, and the same-playerId-live-twice
// case. Wrapped by PlayerPresenceService — nothing above that layer needs to
// know any of this exists.
//
//  - Connection status tracking: host-only. The host is the only peer with
//    a direct RTC link to everyone, so it broadcasts that state to everyone else.
//  - Returning-player detection: host-only. On a player's departure, their
//    entire metadata bag is snapshotted under their durable playerId; if that
//    playerId rejoins later (new peerId, same person), the host replays the
//    snapshot back to them. Generic: this layer never looks inside the bag.
//  - Duplicate-session arbitration: host-only and liveness-based. When a new
//    peer's playerId matches an already-live peer, the host pings the existing
//    one and waits briefly. A reply means it's alive, so the newcomer is
//    rejected. Silence means it's a ghost, so the existing one is removed.
//    Also runs when a guest is promoted to host (see onPromoted).
//  - Display hiding: the moment arbitration starts, the host broadcasts which
//    pair of peerIds is involved, so every peer shows ONE entry for the
//    disputed playerId and withholds the newcomer until the outcome is known.
export class PlayerReconnectionCoordinator {
  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, PersistedMetadata>();
  private remotePresence: PresenceMap = {};

  // Host-only: tracks the ping/timeout for an in-flight liveness check.
  private readonly pendingArbitrations = new Map<string, PendingArbitration>();

  // Every peer: which (playerId -> old/new peerId pair) is currently disputed.
  private readonly activeDuplicates = new Map<string, ActiveDuplicate>();

  // Cancel functions for arbitrations waiting on data-channel links.
  private readonly linkWaits = new Set<() => void>();
  private helloTimer?: ReturnType<typeof setInterval>;

  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly supersededHandlers = new Set<SupersededHandler>();
  private readonly revealHandlers = new Set<RevealHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  private readonly channel: EventChannel<PresenceEvent>;
  private wasHost: boolean;
  private readonly kickedHandlers = new Set<SupersededHandler>();

  constructor(
    private readonly session: PlayerSession,
    bus: RoomBus
  ) {
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

        // Refresh case: the ghost (old peer) leaves while its replacement is
        // already in the room. The join-time restore found nothing in `history`
        // back then, so hand the ghost's metadata to the survivor now. Must run
        // BEFORE resolveActiveDuplicate, which fires the reveal that decides
        // joined-vs-rejoined from `returning`.
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

    // The host's one-time status broadcast can be dropped around a host change; keep asking while pending.
    this.helloTimer = setInterval(() => this.sayHelloIfPending(), HELLO_INTERVAL_MS);
    this.cleanupFns.push(() => clearInterval(this.helloTimer));
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    for (const cancel of Array.from(this.linkWaits)) cancel();
    this.linkWaits.clear();
    for (const arbitration of this.pendingArbitrations.values()) {
      clearTimeout(arbitration.timeoutHandle);
    }
    for (const duplicate of this.activeDuplicates.values()) {
      clearTimeout(duplicate.safetyTimeoutHandle);
    }
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

  // True for the newcomer's peerId while its duplicate is being arbitrated —
  // PlayerPresenceService filters these out of getPlayers() entirely,
  // except for the local player's own row.
  isHiddenDuringArbitration(peerId: SignalingPeerId): boolean {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.newPeerId === peerId) return true;
    }
    return false;
  }

  // True while the local (guest) peer is still being acknowledged by the host
  // or is the newcomer in a duplicate-session arbitration. Local state-changing
  // actions should wait until this is false, so a pending restore can never
  // overwrite something the user just did.
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

  onChanged(handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  // Fires on whichever side the host's arbitration rejects.
  onSessionSuperseded(handler: SupersededHandler): () => void {
    this.supersededHandlers.add(handler);
    return () => this.supersededHandlers.delete(handler);
  }

  // Fires on the player the host removed.
  onKicked(handler: SupersededHandler): () => void {
    this.kickedHandlers.add(handler);
    return () => this.kickedHandlers.delete(handler);
  }

  // Host only. Tells the player why, then removes them from the room.
  kick(peerId: SignalingPeerId): boolean {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!this.session.isHost() || peerId === localPeerId) return false;
    if (!this.session.getPlayers().some((p) => p.peerId === peerId)) return false;
    this.reject(peerId, "kicked");
    return true;
  }

  // Fires with a peerId that was hidden as a newcomer-under-arbitration and
  // has now been confirmed as the surviving side.
  onPeerRevealed(handler: RevealHandler): () => void {
    this.revealHandlers.add(handler);
    return () => this.revealHandlers.delete(handler);
  }

  // ─── Incoming events ──────────────────────────────────────────────────────

  private handleEvent(event: PresenceEvent, from: SignalingPeerId): void {
    const hostPeerId = this.session.getHostPeerId();
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    // These can arrive at (or need applying by) anyone regardless of role — a
    // guest must answer a ping, act on a rejection, and hide a duplicate, even
    // though only the host ever initiates any of them.
    if (event.t === "ping" && from === hostPeerId) {
      this.channel.sendTo(from, { t: "pong", nonce: event.nonce });
      return;
    }
    if (event.t === "rejected" && from === hostPeerId) {
      for (const handler of this.supersededHandlers) handler();
      this.session
        .leave()
        .catch((error) =>
          console.warn("[PlayerReconnectionCoordinator] Failed to leave after rejection", error)
        );
      return;
    }

    if (event.t === "kicked" && from === hostPeerId) {
      for (const handler of this.kickedHandlers) handler();
      this.session
        .leave()
        .catch((error) =>
          console.warn("[PlayerReconnectionCoordinator] Failed to leave after being kicked", error)
        );
      return;
    }

    if (event.t === "duplicate" && from === hostPeerId) {
      this.registerActiveDuplicate(event.playerId, event.oldPeerId, event.newPeerId);
      this.emitChanged();
      return;
    }

    if (event.t === "hello") {
      if (this.session.isHost() && from !== localPeerId) this.sendStatusTo(from);
      return;
    }

    // A pong travels guest -> host, so `from` is the old peer, not the host.
    // (The pre-bus version dropped it at the host-only guard below, so every
    // arbitration timed out and a live old tab was treated as a ghost.)
    if (event.t === "pong") {
      if (this.session.isHost()) this.handlePong(from, event.nonce);
      return;
    }

    if (from === localPeerId) return; // our own broadcast, echoed back
    if (from !== hostPeerId) return; // everything else is host-only

    if (event.t === "status") {
      this.remotePresence = event.presence;
      this.emitChanged();
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

  // A guest just became host. It missed every join that happened before, so
  // seed what it can observe directly, then arbitrate duplicates that already
  // exist (this used to run only on a join event or at construction).
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
    for (const arbitration of this.pendingArbitrations.values()) {
      clearTimeout(arbitration.timeoutHandle);
    }
    this.pendingArbitrations.clear();
    this.hostStatuses.clear();
    this.returningPeerIds.clear();
  }

  // ─── Every peer — reacting to a duplicate-detected broadcast ──────────────

  private registerActiveDuplicate(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    if (this.activeDuplicates.has(playerId)) return;
    const safetyTimeoutHandle = setTimeout(() => {
      // We never heard a definitive resolution (a dropped message, most
      // likely) — reveal whichever side is actually still present rather
      // than hiding it forever.
      this.activeDuplicates.delete(playerId);
      const stillThere = this.session.getPlayers().some((p) => p.peerId === newPeerId);
      if (stillThere) {
        for (const handler of this.revealHandlers) handler(newPeerId);
      }
      this.emitChanged();
    }, PING_TIMEOUT_MS * 2);

    this.activeDuplicates.set(playerId, { oldPeerId, newPeerId, safetyTimeoutHandle });
  }

  private resolveActiveDuplicate(departedPeerId: SignalingPeerId): void {
    for (const [playerId, duplicate] of this.activeDuplicates) {
      if (duplicate.oldPeerId !== departedPeerId && duplicate.newPeerId !== departedPeerId) {
        continue;
      }

      clearTimeout(duplicate.safetyTimeoutHandle);
      this.activeDuplicates.delete(playerId);

      // The ghost (old) left and the newcomer survived — it was hidden this
      // whole time and needs its join event fired now, for the first time.
      if (duplicate.oldPeerId === departedPeerId) {
        for (const handler of this.revealHandlers) handler(duplicate.newPeerId);
      }
      this.emitChanged();
      return;
    }
  }

  // ─── Host-only arbitration ──────────────────────────────────────────────

  // Arbitrates every playerId that is already present more than once. Waits
  // for the data-channel links first: a ping sent before the link is active is
  // silently dropped, which would make a live tab look like a ghost.
  private arbitrateExistingDuplicates(): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    const groups = new Map<string, PlayerProfile[]>();
    for (const profile of this.session.getPlayers()) {
      const playerId = readPlayerId(profile.metadata);
      if (playerId) groups.set(playerId, [...(groups.get(playerId) ?? []), profile]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Directory order is join order for peers we heard about; treat the last
      // remote entry as the newcomer. One pair per group per call.
      const newcomer = [...group].reverse().find((p) => p.peerId !== localPeerId);
      if (!newcomer) continue;
      const involved = group.map((p) => p.peerId).filter((id) => id !== localPeerId);

      this.afterLinksActive(involved, () => {
        if (!this.session.isHost()) return;
        const current = this.session.getPlayers().find((p) => p.peerId === newcomer.peerId);
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
      clearTimeout(timer);
      this.linkWaits.delete(cancel);
      run();
    };
    const cancel = () => {
      finished = true;
      off();
      clearTimeout(timer);
      this.linkWaits.delete(cancel);
    };
    const off = this.session.onPeerConnectionStatusChanged(() => {
      if (ready()) finish();
    });
    const timer = setTimeout(finish, LINK_WAIT_MS);
    this.linkWaits.add(cancel);
  }

  private arbitrateIfDuplicate(newProfile: PlayerProfile): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    // Never treat our own local join as "the newcomer" — the
    // host-refreshes-itself case is handled by the existing dead-host
    // detection + returning-player restore instead, not this path.
    if (newProfile.peerId === localPeerId) return;

    const playerId = readPlayerId(newProfile.metadata);
    if (!playerId) return;
    if (this.pendingArbitrations.has(playerId)) return; // one arbitration at a time per playerId

    const existing = this.session
      .getPlayers()
      .find((p) => p.peerId !== newProfile.peerId && readPlayerId(p.metadata) === playerId);
    if (!existing) return;

    this.broadcastDuplicateDetected(playerId, existing.peerId, newProfile.peerId);

    // The host's own tab is trivially known to be alive — no ping needed.
    if (existing.peerId === localPeerId) {
      this.reject(newProfile.peerId);
      return;
    }

    const nonce = crypto.randomUUID();
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingArbitrations.get(playerId);
      if (!pending || pending.nonce !== nonce) return; // already resolved by a pong
      this.pendingArbitrations.delete(playerId);
      this.reject(pending.oldPeerId); // no reply in time — treat as a ghost
    }, PING_TIMEOUT_MS);

    this.pendingArbitrations.set(playerId, {
      nonce,
      oldPeerId: existing.peerId,
      newPeerId: newProfile.peerId,
      timeoutHandle,
    });

    this.channel.sendTo(existing.peerId, { t: "ping", nonce });
  }

  private handlePong(fromPeerId: SignalingPeerId, nonce: string): void {
    for (const [playerId, pending] of this.pendingArbitrations) {
      if (pending.oldPeerId !== fromPeerId || pending.nonce !== nonce) continue;
      clearTimeout(pending.timeoutHandle);
      this.pendingArbitrations.delete(playerId);
      this.reject(pending.newPeerId); // pre-existing connection answered — genuinely alive
      return;
    }
  }

  private reject(peerId: SignalingPeerId, notice: "rejected" | "kicked" = "rejected"): void {
    this.channel.sendTo(peerId, { t: notice }); // best-effort courtesy notice
    this.session
      .hostRemovePeer(peerId)
      .catch((error) =>
        console.warn("[PlayerReconnectionCoordinator] Failed to remove peer", error)
      );
  }

  // Broadcasts the "hide this pair" signal for every OTHER peer, and applies
  // it directly to our own state too.
  private broadcastDuplicateDetected(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    this.channel.broadcast({ t: "duplicate", playerId, oldPeerId, newPeerId });
    this.registerActiveDuplicate(playerId, oldPeerId, newPeerId);
    this.emitChanged();
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
    this.emitChanged();
  }

  private emitChanged(): void {
    for (const handler of this.changeHandlers) handler();
  }

  // The newcomer's peerId if `departedPeerId` was the old side of a disputed
  // pair and the newcomer is still in the room.
  private findSurvivorReplacing(departedPeerId: SignalingPeerId): SignalingPeerId | undefined {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.oldPeerId !== departedPeerId) continue;
      const stillThere = this.session.getPlayers().some((p) => p.peerId === duplicate.newPeerId);
      return stillThere ? duplicate.newPeerId : undefined;
    }
    return undefined;
  }
}

function readPlayerId(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.playerId === "string" ? metadata.playerId : undefined;
}
