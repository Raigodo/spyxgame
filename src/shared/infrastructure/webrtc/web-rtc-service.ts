import {
  Emitter,
  logFailure,
  shortId,
  type Clock,
  type IdGenerator,
  type Logger,
  type WebRtcConfig,
} from "@/shared/kernel";
import type { RoomId, SignalingPeerId, SignalingSession } from "../signaling";
import { HostReclaimController } from "./host-reclaim-controller";
import type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
import { RtcHostRole } from "./rtc-host-role";
import { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcReconnectionManager } from "./rtc-reconnection-manager";
import { RtcSignalRouter } from "./rtc-signal-router";
import type { FormerHost, HostTransferResult, RtcPeer } from "./types";

export interface WebRtcServiceDeps {
  session: SignalingSession;
  connections: RtcConnectionProvider;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: WebRtcConfig;
}

// Thin shell: wires the signaling session to the link machinery and owns the join/leave
// lifecycle and the host-change sequence. Host role, reclaim and signal routing live in their
// own classes.
export class WebRtcService {
  private readonly registry: RtcPeerRegistry;
  private readonly linkFactory: RtcPeerLinkFactory;
  private readonly reconnectionManager: RtcReconnectionManager;
  private readonly hostRole: RtcHostRole;
  private readonly reclaim: HostReclaimController;
  private readonly signalRouter: RtcSignalRouter;

  private readonly peerJoined = new Emitter<RtcPeer>();
  private readonly peerLeft = new Emitter<{ signalingPeerId: SignalingPeerId }>();
  private readonly messageReceived = new Emitter<{ message: string; from: SignalingPeerId }>();
  private readonly hostChanged = new Emitter<SignalingPeerId | undefined>();
  private readonly cleanupFns: Array<() => void> = [];

  private leaving = false;
  private joined = false;
  private currentHostPeerId?: SignalingPeerId;
  private leavePromise?: Promise<void>;

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
      isHost: () => this.hostRole.isHost(),
      isLeaving: () => this.leaving,
    });

    this.reconnectionManager = new RtcReconnectionManager({
      registry: this.registry,
      linkFactory: this.linkFactory,
      getHostElection: () => session.host,
      isHost: () => this.hostRole.isHost(),
      isLeaving: () => this.leaving,
      getHostPeerId: () => this.currentHostPeerId,
      clock,
      logger: logger.child("reconnect"),
      config,
    });

    this.hostRole = new RtcHostRole({
      session,
      registry: this.registry,
      linkFactory: this.linkFactory,
      logger: logger.child("role"),
    });

    this.reclaim = new HostReclaimController({
      session,
      clock,
      logger: logger.child("reclaim"),
      config,
    });

    this.signalRouter = new RtcSignalRouter({
      registry: this.registry,
      linkFactory: this.linkFactory,
      logger: logger.child("signals"),
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
    this.hostRole.reset();

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
        void this.hostRole
          .offerToNewPeer(peer.peerId)
          .catch(logFailure(this.log, "handle peer joined"));
      }),

      this.session.onPeerLeft((peer) => {
        this.log.debug(`Signaling peer left: ${shortId(peer.peerId)}`);
        this.handleSignalingPeerLeft(peer.peerId);
      }),

      this.session.onSignalReceived((message) => {
        void this.signalRouter
          .handle(message.fromPeerId, message.payload)
          .catch(logFailure(this.log, "handle signal"));
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
      this.reclaim.start(former);
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
    if (!this.hostRole.isHost() || this.leaving) return "not-host";
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
      role: this.hostRole.isHost() ? "host" : "guest",
      joined: this.joined,
      leaving: this.leaving,
      hostPeerId: this.currentHostPeerId,
      reclaimFormer: this.reclaim.former ?? null,
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
    return this.hostRole.isHost();
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
    this.reclaim.stop();
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

  // ─── Host changes ─────────────────────────────────────────────────────────

  private async handleHostChanged(
    host: { signalingPeerId: SignalingPeerId } | null
  ): Promise<void> {
    if (this.leaving) return;

    // The seat went to someone else (or was cleared): the reclaim window is over.
    this.reclaim.onHostDocument(host?.signalingPeerId);

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

    await this.hostRole.setRole(iAmHost);

    this.hostChanged.emit(host.signalingPeerId);

    if (!iAmHost) this.reconnectionManager.watchForOffer(host.signalingPeerId);
  }

  // ─── Signaling peer events ────────────────────────────────────────────────

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
}
