import {
  Cell,
  Emitter,
  Scope,
  batch,
  createThrottledWarn,
  listenerFailure,
  logFailure,
  shortId,
  type Clock,
  type IdGenerator,
  type Logger,
  type PeerId,
  type RoomId,
  type Store,
  type ThrottledWarn,
} from "@/kernel";
import type { IceServer, LinkConfig } from "../config";
import type { LinkState } from "../model";
import type { SignalingSession } from "../signaling";
import { HostReclaimController } from "./host-reclaim-controller";
import type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
import { RtcHostRole } from "./rtc-host-role";
import { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcReconnectionManager } from "./rtc-reconnection-manager";
import { createSignalParser, type RtcSignal } from "./rtc-signal";
import { RtcSignalRouter } from "./rtc-signal-router";
import type { FormerHost, HostTransferResult } from "./types";

export interface LinkServiceDeps {
  session: SignalingSession;
  connections: RtcConnectionProvider;
  /** Resolved once per join (see resolveIceServers). */
  iceServers: readonly IceServer[];
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: LinkConfig;
}

// Wires the signaling session to the link machinery and owns the join/leave lifecycle and the
// host-change sequence. Host role, reclaim and signal routing live in their own classes.
export class LinkService {
  private readonly registry: RtcPeerRegistry;
  private readonly linkFactory: RtcPeerLinkFactory;
  private readonly reconnectionManager: RtcReconnectionManager;
  private readonly hostRole: RtcHostRole;
  private readonly reclaim: HostReclaimController;
  private readonly signalRouter: RtcSignalRouter;
  private readonly warnBadSignal: ThrottledWarn;
  private readonly parseSignal: (raw: unknown) => RtcSignal | undefined;

  private readonly messageReceived: Emitter<{ message: string; from: PeerId }>;
  private readonly roleCell = new Cell<"guest" | "host">("guest");
  private readonly hostCell = new Cell<PeerId | undefined>(undefined);
  private scope?: Scope;

  private leaving = false;
  private joined = false;
  private currentHostPeerId?: PeerId;
  private leavePromise?: Promise<void>;

  constructor(private readonly deps: LinkServiceDeps) {
    const { session, connections, iceServers, clock, ids, logger, config } = deps;
    this.messageReceived = new Emitter(listenerFailure(() => logger));

    this.registry = new RtcPeerRegistry({ logger: logger.child("registry") });

    this.linkFactory = new RtcPeerLinkFactory({
      signaling: session,
      registry: this.registry,
      connections,
      iceServers,
      ids,
      clock,
      config,
      logger: logger.child("link"),
      onMessage: (message, from) => this.messageReceived.emit({ message, from }),
      onConnectionDied: (peerId) => {
        void this.reconnectionManager
          .handleConnectionDied(peerId)
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

    this.warnBadSignal = createThrottledWarn(logger, clock);
    this.parseSignal = createSignalParser(config);
  }

  private get session(): SignalingSession {
    return this.deps.session;
  }

  private get log(): Logger {
    return this.deps.logger;
  }

  // ─── State ────────────────────────────────────────────────────────────────

  /** Changes together with `host`, in one batch. */
  get role(): Store<"guest" | "host"> {
    return this.roleCell;
  }

  get host(): Store<PeerId | undefined> {
    return this.hostCell;
  }

  /** Every registered link. The transport facade narrows it by role (guest: only the host's). */
  get links(): Store<ReadonlyMap<PeerId, LinkState>> {
    return this.registry.links;
  }

  get localPeerId(): PeerId | undefined {
    return this.session.peerId;
  }

  isHost(): boolean {
    return this.hostRole.isHost();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(
    roomId: RoomId,
    peerId?: PeerId,
    options: { formerHost?: FormerHost } = {}
  ): Promise<void> {
    if (this.joined) throw new Error("[LinkService] Already joined a room.");
    this.joined = true;
    this.hostRole.reset();

    this.log.debug(`Joining room=${roomId}`);
    try {
      await this.session.joinRoom(roomId, peerId);
    } catch (error) {
      this.joined = false;
      throw error;
    }

    this.session.setAckTimeoutVeto((id) => this.vetoAckRemoval(id));
    this.reconnectionManager.start();

    const scope = new Scope({ onError: (e) => this.log.error("Cleanup failed", e) });
    this.scope = scope;
    scope.add(
      this.session.onPeerJoined((peer) => {
        this.log.debug(`Signaling peer joined: ${shortId(peer.peerId)}`);
        void this.hostRole
          .offerToNewPeer(peer.peerId)
          .catch(logFailure(this.log, "handle peer joined"));
      })
    );
    scope.add(
      this.session.onPeerLeft((peer) => {
        this.log.debug(`Signaling peer left: ${shortId(peer.peerId)}`);
        this.handleSignalingPeerLeft(peer.peerId);
      })
    );
    scope.add(
      this.session.onSignalReceived((message) => {
        const signal = this.parseSignal(message.payload);
        if (!signal) {
          this.warnBadSignal(`signal:${message.fromPeerId}`, "Dropped invalid signal", {
            from: message.fromPeerId,
          });
          return;
        }
        void this.signalRouter
          .handle(message.fromPeerId as PeerId, signal)
          .catch(logFailure(this.log, "handle signal"));
      })
    );
    scope.add(
      this.session.host.onHostChanged((host) => {
        const hostId = host ? (host.signalingPeerId as PeerId) : undefined;
        this.log.debug(`Host changed → ${hostId ? shortId(hostId) : "null"}`);
        void this.handleHostChanged(hostId).catch(logFailure(this.log, "handle host change"));
      })
    );

    const currentHost = await this.session.host.currentHost();

    if (!currentHost) {
      this.log.debug("No host on join, triggering election");
      await this.session.host.electNextHost();
    } else {
      const hostId = currentHost.signalingPeerId as PeerId;
      this.log.debug(`Host already exists: ${shortId(hostId)}`);
      await this.handleHostChanged(hostId);
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

  /** Host side of `drop`: remove from membership, then clean up the local link. */
  async removePeer(peerId: PeerId): Promise<void> {
    await this.session.removePeer(peerId);
    // The membership snapshot may never fire (the doc could already be gone), so clean up
    // locally now. Idempotent: the snapshot event, if it comes, finds nothing left to do.
    this.handleSignalingPeerLeft(peerId);
  }

  // Host only. Hands the host role to a peer we have an active link to. One atomic write: it
  // succeeds only while the host document still names us.
  async transferHost(targetPeerId: PeerId): Promise<HostTransferResult> {
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

  sendMessageToPeer(peerId: PeerId, message: string): void {
    const entry = this.registry.get(peerId);
    if (!entry || entry.status !== "active" || !entry.connection) {
      this.log.warn(`Peer=${shortId(peerId)} not active, dropping message`);
      return;
    }
    try {
      entry.connection.send(message);
    } catch (error) {
      this.log.warn(`Send failed to peer=${shortId(peerId)}`, error);
    }
  }

  broadcastMessage(message: string): void {
    for (const [peerId, entry] of this.registry.entries()) {
      if (entry.status !== "active" || !entry.connection) continue;
      try {
        entry.connection.send(message);
      } catch (error) {
        this.log.warn(`Broadcast failed to peer=${shortId(peerId)}`, error);
      }
    }
  }

  onMessage(handler: (message: string, from: PeerId) => void): () => void {
    return this.messageReceived.on(({ message, from }) => handler(message, from));
  }

  // A signal to this peer went unanswered. If its data channel is active it is alive by another
  // route: keep it. A really dead link is caught by the connection-state handler.
  private vetoAckRemoval(peerId: PeerId): boolean {
    const entry = this.registry.get(peerId);
    if (!entry || !entry.connection || entry.status !== "active") return false;
    this.log.warn(`Peer=${shortId(peerId)} ignored a signal but its link is active: keeping it`);
    return true;
  }

  // ─── Leaving ──────────────────────────────────────────────────────────────

  private async doLeave(): Promise<void> {
    this.reclaim.stop();
    if (!this.joined) return;

    this.leaving = true;
    this.log.debug("Leaving room");

    this.reconnectionManager.stop();
    this.scope?.dispose();
    this.scope = undefined;
    this.registry.disposeAndRemoveAll();

    await this.session.leaveRoom();

    this.joined = false;
    this.leaving = false;
    this.currentHostPeerId = undefined;
    batch(() => {
      this.roleCell.set("guest");
      this.hostCell.set(undefined);
    });
  }

  // ─── Host changes ─────────────────────────────────────────────────────────

  private async handleHostChanged(hostPeerId: PeerId | undefined): Promise<void> {
    if (this.leaving) return;

    // The seat went to someone else (or was cleared): the reclaim window is over.
    this.reclaim.onHostDocument(hostPeerId);

    if (!hostPeerId) {
      this.reconnectionManager.clearAllOfferWatches();
      this.currentHostPeerId = undefined;
      this.hostCell.set(undefined);
      this.log.debug("Host document cleared, triggering election");
      await this.session.host.electNextHost();
      return;
    }

    this.currentHostPeerId = hostPeerId;

    // Offer watches belong to one specific host. A stale one firing after the host has moved on
    // would report a live peer as dead.
    this.reconnectionManager.clearAllOfferWatches();

    const iAmHost = hostPeerId === this.session.peerId;
    this.log.debug(`Host is ${shortId(hostPeerId)}${iAmHost ? " (me)" : ""}`);

    await this.hostRole.setRole(iAmHost);

    batch(() => {
      this.roleCell.set(iAmHost ? "host" : "guest");
      this.hostCell.set(hostPeerId);
    });

    if (!iAmHost) this.reconnectionManager.watchForOffer(hostPeerId);
  }

  // ─── Signaling peer events ────────────────────────────────────────────────

  private handleSignalingPeerLeft(peerId: PeerId): void {
    this.reconnectionManager.stopWatchingForOffer(peerId);
    this.registry.remove(peerId); // also closes the link, in the safe order; no-op without an entry
  }
}
