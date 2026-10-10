import {
  Emitter,
  logFailure,
  shortId,
  type Clock,
  type IdGenerator,
  type Logger,
  type WebRtcConfig,
} from "@/shared/kernel";
import type { RoomId, SignalingPeerId, SignalingSession, WebRtcSignal } from "../signaling";
import type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
import type { IceCandidate } from "./ports/rtc-peer-connection-port";
import { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcReconnectionManager } from "./rtc-reconnection-manager";
import type { FormerHost, HostTransferResult, RtcPeer } from "./types";

export interface WebRtcServiceDeps {
  session: SignalingSession;
  connections: RtcConnectionProvider;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: WebRtcConfig;
}

export class WebRtcService {
  private readonly registry: RtcPeerRegistry;
  private readonly linkFactory: RtcPeerLinkFactory;
  private readonly reconnectionManager: RtcReconnectionManager;

  private readonly peerJoined = new Emitter<RtcPeer>();
  private readonly peerLeft = new Emitter<{ signalingPeerId: SignalingPeerId }>();
  private readonly messageReceived = new Emitter<{ message: string; from: SignalingPeerId }>();
  private readonly hostChanged = new Emitter<SignalingPeerId | undefined>();
  private readonly cleanupFns: Array<() => void> = [];

  private leaving = false;
  private isHostRole = false;
  private joined = false;
  private currentHostPeerId?: SignalingPeerId;
  private leavePromise?: Promise<void>;
  private reclaim?: { former: SignalingPeerId; stop: () => void };

  constructor(private readonly deps: WebRtcServiceDeps) {
    const { session, connections, clock, ids, logger, config } = deps;

    this.registry = new RtcPeerRegistry({ logger: logger.child("registry") });

    this.linkFactory = new RtcPeerLinkFactory({
      signaling: session,
      registry: this.registry,
      connections,
      ids,
      logger: logger.child("link"),
      onMessage: (message, from) => this.messageReceived.emit({ message, from }),
      onConnectionDied: (signalingPeerId) => {
        void this.reconnectionManager
          .handleConnectionDied(signalingPeerId)
          .catch(logFailure(logger, "handle dead connection"));
      },
      isHost: () => this.isHostRole,
      isLeaving: () => this.leaving,
    });

    this.reconnectionManager = new RtcReconnectionManager({
      registry: this.registry,
      linkFactory: this.linkFactory,
      getHostElection: () => session.host,
      isHost: () => this.isHostRole,
      isLeaving: () => this.leaving,
      getHostPeerId: () => this.currentHostPeerId,
      clock,
      logger: logger.child("reconnect"),
      config,
    });
  }

  private get session(): SignalingSession {
    return this.deps.session;
  }

  private get log(): Logger {
    return this.deps.logger;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(
    roomId: RoomId,
    peerId?: SignalingPeerId,
    options: { formerHost?: FormerHost } = {}
  ): Promise<void> {
    if (this.joined) throw new Error("[WebRtcService] Already joined a room.");
    this.joined = true;
    this.isHostRole = false;

    this.log.debug(`Joining room=${roomId}`);
    try {
      await this.session.joinRoom(roomId, peerId);
    } catch (error) {
      this.joined = false;
      throw error;
    }

    this.reconnectionManager.start();

    this.cleanupFns.push(
      this.registry.onPeerJoined((peer) => this.peerJoined.emit(peer)),
      this.registry.onPeerLeft((peer) =>
        this.peerLeft.emit({ signalingPeerId: peer.signalingPeerId })
      ),

      this.session.onPeerJoined((peer) => {
        this.log.debug(`Signaling peer joined: ${shortId(peer.peerId)}`);
        void this.handleSignalingPeerJoined(peer.peerId).catch(
          logFailure(this.log, "handle peer joined")
        );
      }),

      this.session.onPeerLeft((peer) => {
        this.log.debug(`Signaling peer left: ${shortId(peer.peerId)}`);
        this.handleSignalingPeerLeft(peer.peerId);
      }),

      this.session.onSignalReceived((message) => {
        void this.handleSignalReceived(message.fromPeerId, message.payload).catch(
          logFailure(this.log, "handle signal")
        );
      }),

      this.session.host.onHostChanged((host) => {
        this.log.debug(`Host changed → ${host ? shortId(host.signalingPeerId) : "null"}`);
        void this.handleHostChanged(host).catch(logFailure(this.log, "handle host change"));
      })
    );

    const currentHost = await this.session.host.currentHost();

    if (!currentHost) {
      this.log.debug("No host on join, triggering election");
      await this.session.host.electNextHost();
    } else {
      this.log.debug(`Host already exists: ${shortId(currentHost.signalingPeerId)}`);
      await this.handleHostChanged(currentHost);
    }

    // A refreshed host: its previous incarnation is still named in the host document.
    const former = options.formerHost;
    if (currentHost && former?.peerId === currentHost.signalingPeerId) {
      this.startReclaim(former);
    }
  }

  leaveRoom(): Promise<void> {
    if (!this.joined) return Promise.resolve();
    this.leavePromise ??= this.doLeave().finally(() => {
      this.leavePromise = undefined;
    });
    return this.leavePromise;
  }

  async removePeer(signalingPeerId: SignalingPeerId): Promise<void> {
    await this.session.removePeer(signalingPeerId);
    // The membership snapshot may never fire (the doc could already be gone), so clean up
    // locally now. Idempotent: the snapshot event, if it comes, finds nothing left to do.
    this.handleSignalingPeerLeft(signalingPeerId);
  }

  // Host only. Hands the host role to a peer we have an active link to. One atomic write: it
  // succeeds only while the host document still names us. Everyone then follows the normal role
  // change; the new host recovers state from the guests (including us, now a guest).
  async transferHost(targetPeerId: SignalingPeerId): Promise<HostTransferResult> {
    if (!this.isHostRole || this.leaving) return "not-host";
    const entry = this.registry.get(targetPeerId);
    if (
      targetPeerId === this.session.peerId ||
      !entry ||
      entry.status !== "active" ||
      !entry.connection
    ) {
      return "target-unavailable";
    }
    return (await this.session.host.transferHost(targetPeerId)) ? "transferred" : "host-changed";
  }

  getPeers(): RtcPeer[] {
    return this.registry.getAll();
  }

  inspect(): Record<string, unknown> {
    return {
      role: this.isHostRole ? "host" : "guest",
      joined: this.joined,
      leaving: this.leaving,
      hostPeerId: this.currentHostPeerId,
      reclaimFormer: this.reclaim?.former ?? null,
      links: this.registry.inspect(),
      reconnection: this.reconnectionManager.inspect(),
      signaling: this.session.inspect(),
    };
  }

  /** Peer ids currently in the room's membership (not the same as having a link). */
  getMemberPeerIds(): SignalingPeerId[] {
    return this.session.getPeers().map((p) => p.peerId);
  }

  getLocalPeerId(): SignalingPeerId | undefined {
    return this.session.peerId;
  }

  getHostPeerId(): SignalingPeerId | undefined {
    return this.currentHostPeerId;
  }

  isHost(): boolean {
    return this.isHostRole;
  }

  sendMessageToPeer(signalingPeerId: SignalingPeerId, message: string): void {
    const entry = this.registry.get(signalingPeerId);
    if (!entry || entry.status !== "active" || !entry.connection) {
      this.log.warn(`Peer=${shortId(signalingPeerId)} not active, dropping message`);
      return;
    }
    try {
      entry.connection.send(message);
    } catch (error) {
      this.log.warn(`Send failed to peer=${shortId(signalingPeerId)}`, error);
    }
  }

  broadcastMessage(message: string): void {
    for (const [signalingPeerId, entry] of this.registry.entries()) {
      if (entry.status !== "active" || !entry.connection) continue;
      try {
        entry.connection.send(message);
      } catch (error) {
        this.log.warn(`Broadcast failed to peer=${shortId(signalingPeerId)}`, error);
      }
    }
  }

  onPeerJoined(handler: (peer: RtcPeer) => void): () => void {
    return this.peerJoined.on(handler);
  }

  onPeerLeft(handler: (peer: { signalingPeerId: SignalingPeerId }) => void): () => void {
    return this.peerLeft.on(handler);
  }

  // Fires on connecting/active/reconnecting transitions, so consumers never poll getPeers().
  onPeerStatusChanged(handler: (peer: RtcPeer) => void): () => void {
    return this.registry.onStatusChanged(handler);
  }

  onMessage(handler: (message: string, from: SignalingPeerId) => void): () => void {
    return this.messageReceived.on(({ message, from }) => handler(message, from));
  }

  onHostChanged(handler: (hostPeerId: SignalingPeerId | undefined) => void): () => void {
    return this.hostChanged.on(handler);
  }

  // ─── Leaving ──────────────────────────────────────────────────────────────

  private async doLeave(): Promise<void> {
    this.reclaim?.stop();
    if (!this.joined) return;

    this.leaving = true;
    this.log.debug("Leaving room");

    this.reconnectionManager.stop();

    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;

    this.registry.disposeAndRemoveAll();

    await this.session.leaveRoom();

    this.joined = false;
    this.leaving = false;
    this.currentHostPeerId = undefined;
  }

  // ─── Host role ────────────────────────────────────────────────────────────

  // A refreshed host returns with a fresh peerId. While the host document still names its
  // previous incarnation, take the seat back as soon as that peer is gone from the room. When
  // pagehide already told us the old page is gone, remove it ourselves instead of waiting for
  // the guests to notice. If the document names anyone else first, the window is over.
  private startReclaim(former: FormerHost): void {
    this.reclaim?.stop();
    const formerId = former.peerId;

    let done = false;
    let busy = false;
    let retry = false;

    const stop = () => {
      if (done) return;
      done = true;
      cancelTimer();
      offLeft();
      if (this.reclaim?.former === formerId) this.reclaim = undefined;
    };

    const attempt = async (final: boolean): Promise<void> => {
      if (done) return;
      if (busy) {
        retry = true;
        return;
      }
      busy = true;
      try {
        const result = await this.session.host.claimHost(formerId);
        this.log.debug(`Host reclaim: ${result}`);
        if (result !== "former-present" || final) stop();
      } catch (error) {
        this.log.warn("Host reclaim failed", error);
        stop();
      } finally {
        busy = false;
        if (retry && !done) {
          retry = false;
          void attempt(final);
        }
      }
    };

    const offLeft = this.session.onPeerLeft((peer) => {
      if (peer.peerId === formerId) void attempt(false);
    });
    const cancelTimer = this.deps.clock.after(this.deps.config.reclaimWindowMs, () => {
      void attempt(true);
    });
    this.reclaim = { former: formerId, stop };

    if (former.confirmedGone) {
      void this.session
        .removePeer(formerId)
        .catch((error) => this.log.warn("Failed to remove former host", error))
        .then(() => attempt(false));
    } else {
      void attempt(false);
    }
  }

  private async handleHostChanged(
    host: { signalingPeerId: SignalingPeerId } | null
  ): Promise<void> {
    if (this.leaving) return;

    // The seat went to someone else (or was cleared): the reclaim window is over.
    if (this.reclaim && host?.signalingPeerId !== this.reclaim.former) this.reclaim.stop();

    if (!host) {
      this.reconnectionManager.clearAllOfferWatches();
      this.currentHostPeerId = undefined;
      this.hostChanged.emit(undefined);
      this.log.debug("Host document cleared, triggering election");
      await this.session.host.electNextHost();
      return;
    }

    this.currentHostPeerId = host.signalingPeerId;

    // Offer watches belong to one specific host. A stale one firing after the host has moved on
    // would report a live peer as dead.
    this.reconnectionManager.clearAllOfferWatches();

    const iAmHost = host.signalingPeerId === this.session.peerId;
    this.log.debug(`Host is ${shortId(host.signalingPeerId)}${iAmHost ? " (me)" : ""}`);

    await this.setRole(iAmHost);

    this.hostChanged.emit(host.signalingPeerId);

    if (!iAmHost) this.reconnectionManager.watchForOffer(host.signalingPeerId);
  }

  private async setRole(isHost: boolean): Promise<void> {
    if (this.isHostRole === isHost) return;

    this.log.debug(
      `Role changing: ${this.isHostRole ? "host" : "guest"} → ${isHost ? "host" : "guest"}`
    );
    this.isHostRole = isHost;

    if (!isHost) return; // links to everyone except the new host are left open on purpose

    this.log.debug("Became host, connecting to unconnected peers");
    for (const peer of this.session.getPeers()) {
      if (this.registry.has(peer.peerId)) {
        this.log.debug(`Already have entry for peer=${shortId(peer.peerId)}, keeping`);
        continue;
      }
      this.log.debug(`No entry for peer=${shortId(peer.peerId)}, creating and offering`);
      const entry = this.linkFactory.create(peer.peerId);
      this.registry.add(peer.peerId, entry);
      await this.linkFactory.initiateOffer(peer.peerId, entry);
    }
  }

  // ─── Signaling peer events ────────────────────────────────────────────────

  private async handleSignalingPeerJoined(signalingPeerId: SignalingPeerId): Promise<void> {
    if (!this.isHostRole) return;
    if (this.registry.has(signalingPeerId)) {
      this.log.warn(`Peer=${shortId(signalingPeerId)} already exists, skipping`);
      return;
    }

    const entry = this.linkFactory.create(signalingPeerId);
    this.registry.add(signalingPeerId, entry);
    await this.linkFactory.initiateOffer(signalingPeerId, entry);
  }

  private handleSignalingPeerLeft(signalingPeerId: SignalingPeerId): void {
    this.reconnectionManager.stopWatchingForOffer(signalingPeerId);

    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      // No link, but the roster may still list this peer (e.g. a freshly promoted host).
      this.peerLeft.emit({ signalingPeerId });
      return;
    }
    // Remove first: closing the link below fires "connection died", which must find nothing to reconnect.
    this.registry.remove(signalingPeerId);
    this.registry.disposeEntry(entry);
  }

  // ─── Signal handling ──────────────────────────────────────────────────────

  private async handleSignalReceived(
    signalingPeerId: SignalingPeerId,
    signal: WebRtcSignal
  ): Promise<void> {
    this.log.debug(`Signal from peer=${shortId(signalingPeerId)} type=${signal.type}`);

    switch (signal.type) {
      case "offer":
        await this.handleOffer(signalingPeerId, signal.sdp);
        break;
      case "answer":
        await this.handleAnswer(signalingPeerId, signal.sdp);
        break;
      case "ice-candidate":
        await this.handleIceCandidate(signalingPeerId, signal.candidate);
        break;
      default:
        this.log.warn(`Unknown signal type from peer=${shortId(signalingPeerId)}`);
    }
  }

  private async handleOffer(signalingPeerId: SignalingPeerId, sdp: string): Promise<void> {
    let entry = this.registry.get(signalingPeerId);

    if (!entry) {
      this.log.debug(`Creating entry for peer=${shortId(signalingPeerId)} on offer arrival`);
      entry = this.linkFactory.create(signalingPeerId);
      this.registry.add(signalingPeerId, entry);
    }

    await entry.negotiator.applyOffer({ type: "offer", sdp });
  }

  private async handleAnswer(signalingPeerId: SignalingPeerId, sdp: string): Promise<void> {
    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      this.log.warn(`Answer from unknown peer=${shortId(signalingPeerId)}, ignoring`);
      return;
    }
    await entry.negotiator.applyAnswer({ type: "answer", sdp });
  }

  private async handleIceCandidate(
    signalingPeerId: SignalingPeerId,
    candidate: IceCandidate
  ): Promise<void> {
    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      this.log.warn(`ICE candidate from unknown peer=${shortId(signalingPeerId)}, ignoring`);
      return;
    }
    await entry.negotiator.applyIceCandidate(candidate);
  }
}
