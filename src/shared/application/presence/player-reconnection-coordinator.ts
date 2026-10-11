import {
  Emitter,
  listenerFailure,
  shortId,
  type Clock,
  type IdGenerator,
  type Logger,
  type PresenceConfig,
} from "@/shared/kernel";
import type { EventChannel, RoomBus, StateChannel } from "@/shared/application/messaging";
import type { PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { DuplicateArbiter } from "./duplicate-arbiter";
import { DuplicateView } from "./duplicate-view";
import { readPlayerId } from "./duplicate-rules";
import { PresenceBook } from "./presence-book";
import { parsePresenceEvent, type PresenceEvent } from "./presence-events";
import type { PlayerPresence } from "./types";
import {
  findEntry,
  missingKeys,
  parseEntry,
  parseHistory,
  rememberEntry,
  type HistoryEntry,
  type HistoryState,
} from "./presence-history";

export interface PlayerReconnectionCoordinatorDeps {
  session: PlayerSession;
  bus: RoomBus;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: PresenceConfig;
}

// The presence event dispatcher. The only place in the app that knows about connection status,
// "have we seen this playerId before" history, and the same-playerId-live-twice case, split into:
//  - PresenceBook: the data (host statuses, returning peers, history, the host's last status map).
//  - DuplicateView: every peer's hiding/reveal of a disputed pair.
//  - DuplicateArbiter: host only, decides which duplicate survives.
// This class wires them to the session and the "presence" event channel. Wrapped by
// PlayerPresenceService.
//
//  - Connection status: host-only. The host is the only peer with a direct link to everyone, so
//    it broadcasts that state.
//  - Returning players: host-only. On departure, the player's metadata is snapshotted under their
//    durable playerId; when that playerId rejoins, the host replays it.
//  - Duplicate sessions: host-only, liveness-based. Also runs on promotion.
export class PlayerReconnectionCoordinator {
  private readonly session: PlayerSession;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly config: PresenceConfig;

  private readonly book = new PresenceBook();
  private readonly view: DuplicateView;
  private readonly arbiter: DuplicateArbiter;

  private readonly onListenerError = listenerFailure(() => this.log);
  private readonly changed = new Emitter(this.onListenerError);
  private readonly superseded = new Emitter(this.onListenerError);
  private readonly kicked = new Emitter(this.onListenerError);
  private readonly farewell = new Emitter<string>(this.onListenerError);
  private readonly revealed = new Emitter<SignalingPeerId>(this.onListenerError);
  private readonly cleanupFns: Array<() => void> = [];

  private readonly channel: EventChannel<PresenceEvent>;
  // Departed players' metadata, replicated by the bus so it survives a host change.
  private readonly history: StateChannel<HistoryState>;
  private wasHost: boolean;
  private selfRestored = false;
  private selfRestoreUntil = 0;

  constructor(deps: PlayerReconnectionCoordinatorDeps) {
    this.session = deps.session;
    this.clock = deps.clock;
    this.log = deps.logger;
    this.config = deps.config;
    const { session, bus } = deps;

    // Registered before bus.start(), like every channel.
    this.channel = bus.eventChannel<PresenceEvent>({
      id: "presence",
      validate: parsePresenceEvent,
    });
    this.wasHost = session.isHost();

    this.history = bus.stateChannel<HistoryState>({
      id: "presence:history",
      initial: [],
      validate: parseHistory,
      resolveSender: (peerId) => {
        const profile = session.getPlayers().find((p) => p.peerId === peerId);
        return profile && readPlayerId(profile.metadata);
      },
    });
    this.history.handle<HistoryEntry>("remember", {
      validate: parseEntry,
      authorize: ({ playerId }) => (playerId === undefined ? "unknown-sender" : undefined),
      reduce: (state, entry) => ({ ok: true, state: rememberEntry(state, entry) }),
    });
    if (this.wasHost) this.armSelfRestore();

    this.view = new DuplicateView({
      clock: deps.clock,
      config: deps.config,
      isPresent: (peerId) => session.getPlayers().some((p) => p.peerId === peerId),
      getPresentPeerIds: () => new Set(session.getPlayers().map((p) => p.peerId)),
      onReveal: (peerId) => this.revealed.emit(peerId),
      onChanged: () => this.changed.emit(),
    });
    this.arbiter = new DuplicateArbiter({
      session,
      clock: deps.clock,
      ids: deps.ids,
      logger: deps.logger,
      config: deps.config,
      channel: this.channel,
      announce: (playerId, oldPeerId, newPeerId) =>
        this.broadcastDuplicateDetected(playerId, oldPeerId, newPeerId),
      reject: (peerId) => this.reject(peerId),
    });

    const localPeerId = session.getLocalPlayer()?.peerId;
    for (const profile of session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      const status = session.getPeerConnectionStatus(profile.peerId);
      if (status) this.book.setStatus(profile.peerId, status);
    }
    if (session.isHost()) this.arbiter.arbitrateExisting();

    this.cleanupFns.push(
      session.onPeerConnectionStatusChanged((peer) => {
        if (!session.isHost()) {
          if (peer.status === "active" && peer.signalingPeerId === session.getHostPeerId()) {
            this.sayHelloIfPending();
          }
          return;
        }
        this.book.setStatus(peer.signalingPeerId, peer.status);
        this.syncAndBroadcast();
      }),

      session.onHostChanged(() => this.handleHostChanged()),

      session.onPlayerJoined((profile) => {
        if (!session.isHost()) return;
        this.arbiter.arbitrateIfDuplicate(profile);

        this.book.setStatus(
          profile.peerId,
          session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
        );

        const playerId = readPlayerId(profile.metadata);
        const remembered = playerId ? this.recall(playerId) : undefined;
        if (remembered) {
          this.book.markReturning(profile.peerId);
          this.channel.sendTo(profile.peerId, { t: "restore", metadata: remembered });
        }

        this.syncAndBroadcast();
      }),

      session.onPlayerLeft((profile) => {
        const playerId = readPlayerId(profile.metadata);
        this.rememberDeparture(profile.peerId, playerId, profile.metadata);

        // Refresh case: the ghost (old peer) leaves while its replacement is already in the
        // room. The join-time restore found nothing in history back then, so hand the ghost's
        // metadata to the survivor now. Must run BEFORE view.resolveDeparted, which fires the
        // reveal that decides joined-vs-rejoined from `returning`.
        if (session.isHost() && playerId) {
          const survivor = this.view.survivorReplacing(profile.peerId);
          if (survivor) {
            this.book.markReturning(survivor);
            this.channel.sendTo(survivor, { t: "restore", metadata: { ...profile.metadata } });
          }
        }

        this.view.resolveDeparted(profile.peerId);

        if (session.isHost()) {
          this.book.forgetPeer(profile.peerId);
          this.syncAndBroadcast();
        }
      }),

      this.channel.onEvent((event, from) => this.handleEvent(event, from)),
      this.history.onChange(() => this.tryRestoreSelf())
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
    this.arbiter.cancelAll();
    this.view.dispose();
    this.book.dispose();
  }

  inspect(): Record<string, unknown> {
    return {
      wasHost: this.wasHost,
      ...this.book.inspect(),
      historyPlayerIds: this.history.get().map((e) => e.playerId), // ids only: no metadata in dumps
      activeDuplicates: this.view.inspect(),
      ...this.arbiter.inspect(),
    };
  }

  getPresence(targetPeerId: SignalingPeerId): PlayerPresence {
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    if (targetPeerId === localPeerId) {
      return { status: "self", returning: this.book.remote(targetPeerId)?.returning ?? false };
    }

    if (this.view.isReconnecting(targetPeerId)) {
      return { status: "reconnecting", returning: this.book.isReturning(targetPeerId) };
    }

    if (this.session.isHost()) {
      return {
        status: this.book.statusOf(targetPeerId) ?? "connecting",
        returning: this.book.isReturning(targetPeerId),
      };
    }

    if (targetPeerId === this.session.getHostPeerId()) {
      return {
        status: this.session.getPeerConnectionStatus(targetPeerId) ?? "connecting",
        returning: this.book.remote(targetPeerId)?.returning ?? false,
      };
    }

    const remote = this.book.remote(targetPeerId);
    return { status: remote?.status ?? "connecting", returning: remote?.returning ?? false };
  }

  // True for the newcomer's peerId while its duplicate is being arbitrated.
  isHiddenDuringArbitration(peerId: SignalingPeerId): boolean {
    return this.view.isHidden(peerId);
  }

  // True while the local (guest) peer is still being acknowledged by the host or is the newcomer
  // in a duplicate-session arbitration. Local state-changing actions wait until this is false,
  // so a pending restore can never overwrite something the user just did.
  isLocalPending(): boolean {
    if (this.session.isHost()) return false;
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!localPeerId) return false;

    if (this.book.remote(localPeerId) === undefined) return true; // host hasn't acknowledged us yet
    return this.view.isHidden(localPeerId);
  }

  onChanged(handler: () => void): () => void {
    return this.changed.on(handler);
  }

  // Fires on whichever side the host's arbitration rejects.
  onSuperseded(handler: () => void): () => void {
    return this.superseded.on(handler);
  }

  // Fires on the player the host removed.
  onKicked(handler: () => void): () => void {
    return this.kicked.on(handler);
  }

  /** Fires on every peer (the host included) when the host removed a player on purpose. */
  onFarewell(handler: (playerId: string) => void): () => void {
    return this.farewell.on(handler);
  }

  // Fires with a peerId that was hidden as a newcomer-under-arbitration and has now been
  // confirmed as the surviving side.
  onPeerRevealed(handler: (peerId: SignalingPeerId) => void): () => void {
    return this.revealed.on(handler);
  }

  // Host only. Tells everyone the player is gone for good, tells the player why, then removes them.
  kick(peerId: SignalingPeerId): boolean {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!this.session.isHost() || peerId === localPeerId) return false;
    const target = this.session.getPlayers().find((p) => p.peerId === peerId);
    if (!target) return false;
    const playerId = readPlayerId(target.metadata);
    // Delivered locally too, so the host's own presence service learns it as well.
    if (playerId) this.channel.broadcast({ t: "farewell", playerId });
    this.reject(peerId, "kicked");
    return true;
  }

  // ─── Incoming events ──────────────────────────────────────────────────────

  // Branch order is load-bearing: see the pong comment.
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

    if (event.t === "farewell" && from === hostPeerId) {
      this.farewell.emit(event.playerId);
      return;
    }

    if (event.t === "duplicate" && from === hostPeerId) {
      this.view.register(event.playerId, event.oldPeerId, event.newPeerId);
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
      if (this.session.isHost()) this.arbiter.handlePong(from, event.nonce);
      return;
    }

    if (from === localPeerId) return; // our own broadcast, echoed back
    if (from !== hostPeerId) return; // everything else is host-only

    if (event.t === "status") {
      this.book.setRemote(event.presence);
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
    this.armSelfRestore();
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    for (const profile of this.session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      this.book.setStatus(
        profile.peerId,
        this.session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
      );
    }
    this.syncAndBroadcast();
    this.arbiter.arbitrateExisting();
  }

  // Lost the host role: drop host-only bookkeeping. Guests learn presence from the new host.
  private onDemoted(): void {
    this.arbiter.cancelAll();
    this.book.clearHostState();
  }

  // ─── History ──────────────────────────────────────────────────────────────

  private recall(playerId: string): Record<string, unknown> | undefined {
    return findEntry(this.history.get(), playerId)?.metadata;
  }

  // Every peer reports a departure to the host: after a host change only the guests remember
  // what the old host's profile looked like. Queued by the bus until a host link is up and held
  // by a recovering host, so ordering with promotion needs no special handling here.
  private rememberDeparture(
    peerId: SignalingPeerId,
    playerId: string | undefined,
    metadata: Record<string, unknown>
  ): void {
    if (playerId === undefined || peerId === this.session.getLocalPlayer()?.peerId) return;
    void this.history.send("remember", { playerId, metadata: { ...metadata } }).then((result) => {
      if (!result.ok) this.log.debug(`History entry not recorded: ${result.reason}`);
    });
  }

  private armSelfRestore(): void {
    this.selfRestored = false;
    this.selfRestoreUntil = this.clock.now() + this.config.linkWaitMs;
  }

  // A host that just took the seat (a refreshed host reclaiming it) has no one to send it a
  // restore. It reads its own entry from the replicated history, once, filling only the keys its
  // profile lacks, so a promoted guest's current ready/team is never overwritten.
  private tryRestoreSelf(): void {
    if (this.selfRestored || !this.session.isHost()) return;
    if (this.clock.now() > this.selfRestoreUntil) return;
    const local = this.session.getLocalPlayer();
    const playerId = local && readPlayerId(local.metadata);
    if (!local || playerId === undefined) return;
    const remembered = this.recall(playerId);
    if (!remembered) return;
    this.selfRestored = true;
    const patch = missingKeys(remembered, local.metadata);
    if (patch) this.session.updateLocalProfile({ metadata: patch });
  }

  // ─── Host-side actions ────────────────────────────────────────────────────

  private reject(peerId: SignalingPeerId, notice: "rejected" | "kicked" = "rejected"): void {
    this.log.debug(`Removing peer=${shortId(peerId)} (${notice})`);
    this.channel.sendTo(peerId, { t: notice }); // best-effort courtesy notice
    this.session
      .hostRemovePeer(peerId)
      .catch((error) => this.log.warn("Failed to remove peer", error));
  }

  // Broadcasts the "hide this pair" signal to every OTHER peer, and applies it to our own state.
  private broadcastDuplicateDetected(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    this.channel.broadcast({ t: "duplicate", playerId, oldPeerId, newPeerId });
    this.view.register(playerId, oldPeerId, newPeerId);
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
    if (!this.book.has(peerId)) {
      this.book.setStatus(peerId, this.session.getPeerConnectionStatus(peerId) ?? "connecting");
    }
    this.channel.sendTo(peerId, { t: "status", presence: this.book.buildMap() });
  }

  private syncAndBroadcast(): void {
    this.channel.broadcast({ t: "status", presence: this.book.buildMap() });
    this.changed.emit();
  }
}
