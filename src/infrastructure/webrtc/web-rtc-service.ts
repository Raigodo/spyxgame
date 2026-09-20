// web-rtc-service.ts

import { FirestoreSignalingServiceRoot } from "@infrastructure/signaling/firestore-signaling-service-root";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcPeerEntryFactory } from "./rtc-peer-entry-factory";
import { RtcConnectionHandler } from "./rtc-connection-handler";
import { RtcHostElectionCoordinator } from "./rtc-host-election-coordinator";
import type { RtcPeer } from "./rtc-peer-registry";
import type { SignalingPeerId, RoomId } from "@infrastructure/signaling";

type RtcPeerHandler = (peer: RtcPeer) => void;
type RtcMessageHandler = (message: string, from: SignalingPeerId) => void;

const HOST_OFFER_TIMEOUT_MS = 5_000;

function short(id: string): string {
  return id.slice(0, 8);
}

export class WebRtcService {
  private readonly signalingService = new FirestoreSignalingServiceRoot();
  private readonly registry = new RtcPeerRegistry();

  private readonly peerJoinedHandlers = new Set<RtcPeerHandler>();
  private readonly peerLeftHandlers = new Set<RtcPeerHandler>();
  private readonly messageHandlers = new Set<RtcMessageHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  // Tracks "no offer received" timers — one per suspected dead host.
  private readonly offerTimeouts = new Map<
    SignalingPeerId,
    ReturnType<typeof setTimeout>
  >();

  private leaving = false;
  private isHost = false;
  private joined = false;

  private readonly entryFactory: RtcPeerEntryFactory;
  private readonly connectionHandler: RtcConnectionHandler;
  private readonly electionCoordinator: RtcHostElectionCoordinator;

  constructor() {
    // electionCoordinator uses a getter so it can access hostService
    // after joinRoom initializes it — avoids chicken-and-egg problem.
    this.electionCoordinator = new RtcHostElectionCoordinator(
      () => this.signalingService.host,
      this.registry,
    );

    this.entryFactory = new RtcPeerEntryFactory(
      this.signalingService,
      this.registry,
      (message, from) => {
        for (const handler of this.messageHandlers) handler(message, from);
      },
      (signalingPeerId) => {
        void this.connectionHandler.handleConnectionDied(signalingPeerId);
      },
      () => this.isHost,
      () => this.leaving,
    );

    this.connectionHandler = new RtcConnectionHandler(
      this.registry,
      this.entryFactory,
      this.electionCoordinator,
      () => this.isHost,
      () => this.leaving,
    );
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(roomId: RoomId): Promise<void> {
    if (this.joined) {
      throw new Error("[WebRtcService] Already joined a room.");
    }
    this.joined = true;
    this.isHost = false;

    console.log(`[WebRtcService] Joining room=${roomId}`);
    await this.signalingService.joinRoom(roomId);

    // Start coordinator after joinRoom so hostService is available.
    this.electionCoordinator.start();

    this.cleanupFns.push(
      this.registry.onPeerJoined((peer) => {
        for (const handler of this.peerJoinedHandlers) handler(peer);
      }),

      this.registry.onPeerLeft((peer) => {
        for (const handler of this.peerLeftHandlers) handler(peer);
      }),

      this.signalingService.onSignalingPeerJoined((peer) => {
        console.log(
          `[WebRtcService] Signaling peer joined: ${short(peer.peerId)}`,
        );
        void this.handleSignalingPeerJoined(peer.peerId);
      }),

      this.signalingService.onSignalingPeerLeft((peer) => {
        console.log(
          `[WebRtcService] Signaling peer left: ${short(peer.peerId)}`,
        );
        this.handleSignalingPeerLeft(peer.peerId);
      }),

      this.signalingService.onSignalReceived((message) => {
        void this.handleSignalReceived(
          message.fromPeerId,
          message.payload as SignalingPayload,
        );
      }),

      this.signalingService.host.onHostChanged((host) => {
        console.log(
          `[WebRtcService] Host changed → ${host ? short(host.signalingPeerId) : "null"}`,
        );
        void this.handleHostChanged(host);
      }),
    );

    // React to initial host state.
    const currentHost = await this.signalingService.host.currentHost();

    if (!currentHost) {
      console.log("[WebRtcService] No host on join — triggering election");
      await this.signalingService.host.electNextHost();
    } else {
      console.log(
        `[WebRtcService] Host already exists: ${short(currentHost.signalingPeerId)}`,
      );
      await this.handleHostChanged(currentHost);
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.joined) return;

    this.leaving = true;
    console.log("[WebRtcService] Leaving room");

    this.electionCoordinator.stop();
    this.clearAllOfferTimeouts();

    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;

    this.registry.disposeAndRemoveAll();

    await this.signalingService.leaveRoom();

    this.joined = false;
    this.leaving = false;
  }

  getRtcPeers(): RtcPeer[] {
    return this.registry.getAll();
  }

  sendMessageToPeer(signalingPeerId: SignalingPeerId, message: string): void {
    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      console.warn(
        `[WebRtcService] No peer for signalingPeerId=${short(signalingPeerId)}`,
      );
      return;
    }
    if (entry.status !== "active" || !entry.connection) {
      console.warn(
        `[WebRtcService] Peer=${short(signalingPeerId)} not active (status=${entry.status})`,
      );
      return;
    }
    entry.connection.send(message);
  }

  broadcastMessage(message: string): void {
    for (const [signalingPeerId, entry] of this.registry.entries()) {
      if (entry.status !== "active" || !entry.connection) {
        console.warn(
          `[WebRtcService] Skipping broadcast to peer=${short(signalingPeerId)}, status=${entry.status}`,
        );
        continue;
      }
      entry.connection.send(message);
    }
  }

  onRtcPeerJoined(handler: RtcPeerHandler): () => void {
    this.peerJoinedHandlers.add(handler);
    return () => this.peerJoinedHandlers.delete(handler);
  }

  onRtcPeerLeft(handler: RtcPeerHandler): () => void {
    this.peerLeftHandlers.add(handler);
    return () => this.peerLeftHandlers.delete(handler);
  }

  onRtcMessage(handler: RtcMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ─── Host election ────────────────────────────────────────────────────────

  private async handleHostChanged(
    host: { signalingPeerId: SignalingPeerId } | null,
  ): Promise<void> {
    if (this.leaving) return;

    if (!host) {
      // Host document cleared — cancel any countdown and elect next.
      this.electionCoordinator.cancelCountdown();
      console.log(
        "[WebRtcService] Host document cleared — triggering election",
      );
      await this.signalingService.host.electNextHost();
      return;
    }

    const localPeerId = this.signalingService.peerid;
    const iAmHost = host.signalingPeerId === localPeerId;

    console.log(
      `[WebRtcService] Host is ${short(host.signalingPeerId)}${iAmHost ? " (me)" : ""}`,
    );

    await this.setRole(iAmHost);

    // Guest sees a host document — start timeout in case host is already dead.
    if (!iAmHost) {
      this.startOfferTimeout(host.signalingPeerId);
    }
  }

  private async setRole(isHost: boolean): Promise<void> {
    if (this.isHost === isHost) return;

    console.log(
      `[WebRtcService] Role changing: ${this.isHost ? "host" : "guest"} → ${isHost ? "host" : "guest"}`,
    );
    this.isHost = isHost;

    if (!isHost) {
      console.log("[WebRtcService] Became guest — disposing all peer entries");
      this.registry.disposeAndRemoveAll();
      return;
    }

    console.log(
      "[WebRtcService] Became host — connecting to unconnected peers",
    );
    for (const peer of this.signalingService.getSignalingPeers()) {
      if (this.registry.has(peer.peerId)) {
        console.log(
          `[WebRtcService] Already have entry for peer=${short(peer.peerId)}, keeping`,
        );
        continue;
      }
      console.log(
        `[WebRtcService] No entry for peer=${short(peer.peerId)}, creating and offering`,
      );
      const entry = this.entryFactory.create(peer.peerId);
      this.registry.add(peer.peerId, entry);
      await this.entryFactory.initiateOffer(peer.peerId, entry);
    }
  }

  // ─── Offer timeout ────────────────────────────────────────────────────────

  // Guest sees a host document but may not receive an offer if host is dead.
  // Start a timer — if no connection becomes active within the window,
  // tell the coordinator to start the election countdown.
  private startOfferTimeout(hostPeerId: SignalingPeerId): void {
    this.clearOfferTimeout(hostPeerId);

    console.log(
      `[WebRtcService] Starting offer timeout for host=${short(hostPeerId)}`,
    );

    const timeout = setTimeout(() => {
      if (this.leaving) return;
      if (this.isHost) return;

      const entry = this.registry.get(hostPeerId);
      if (entry?.status === "active") return;

      console.warn(
        `[WebRtcService] No offer from host=${short(hostPeerId)} within timeout — suspecting dead`,
      );
      this.connectionHandler.suspectHostDead(hostPeerId);
    }, HOST_OFFER_TIMEOUT_MS);

    this.offerTimeouts.set(hostPeerId, timeout);

    // Also cancel when connection to any peer becomes active.
    const unsub = this.registry.onAnyStatusChanged((status) => {
      if (status === "active") {
        this.clearOfferTimeout(hostPeerId);
        unsub();
      }
    });
  }

  private clearOfferTimeout(hostPeerId: SignalingPeerId): void {
    const existing = this.offerTimeouts.get(hostPeerId);
    if (existing) {
      clearTimeout(existing);
      this.offerTimeouts.delete(hostPeerId);
    }
  }

  private clearAllOfferTimeouts(): void {
    for (const timeout of this.offerTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.offerTimeouts.clear();
  }

  // ─── Signaling peer events ────────────────────────────────────────────────

  private async handleSignalingPeerJoined(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    if (!this.isHost) return;
    if (this.registry.has(signalingPeerId)) {
      console.warn(
        `[WebRtcService] Peer=${short(signalingPeerId)} already exists, skipping`,
      );
      return;
    }

    const entry = this.entryFactory.create(signalingPeerId);
    this.registry.add(signalingPeerId, entry);
    await this.entryFactory.initiateOffer(signalingPeerId, entry);
  }

  private handleSignalingPeerLeft(signalingPeerId: SignalingPeerId): void {
    this.clearOfferTimeout(signalingPeerId);

    if (!this.registry.has(signalingPeerId)) return;
    const entry = this.registry.get(signalingPeerId)!;
    this.registry.disposeEntry(entry);
    this.registry.remove(signalingPeerId);
  }

  // ─── Signal handling ──────────────────────────────────────────────────────

  private async handleSignalReceived(
    signalingPeerId: SignalingPeerId,
    signal: SignalingPayload,
  ): Promise<void> {
    console.log(
      `[WebRtcService] Signal from peer=${short(signalingPeerId)} type=${signal.type}`,
    );

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
        console.warn(
          `[WebRtcService] Unknown signal type from peer=${short(signalingPeerId)}`,
        );
    }
  }

  private async handleOffer(
    signalingPeerId: SignalingPeerId,
    sdp: string,
  ): Promise<void> {
    let entry = this.registry.get(signalingPeerId);

    if (!entry) {
      console.log(
        `[WebRtcService] Creating entry for peer=${short(signalingPeerId)} on offer arrival`,
      );
      entry = this.entryFactory.create(signalingPeerId);
      this.registry.add(signalingPeerId, entry);
    }

    await entry.factory.applyOffer({ type: "offer", sdp });
  }

  private async handleAnswer(
    signalingPeerId: SignalingPeerId,
    sdp: string,
  ): Promise<void> {
    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      console.warn(
        `[WebRtcService] Answer from unknown peer=${short(signalingPeerId)}, ignoring`,
      );
      return;
    }
    await entry.factory.applyAnswer({ type: "answer", sdp });
  }

  private async handleIceCandidate(
    signalingPeerId: SignalingPeerId,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const entry = this.registry.get(signalingPeerId);
    if (!entry) {
      console.warn(
        `[WebRtcService] ICE candidate from unknown peer=${short(signalingPeerId)}, ignoring`,
      );
      return;
    }
    await entry.factory.applyIceCandidate(candidate);
  }
}

// ─── Signal payload types ─────────────────────────────────────────────────────

type SignalingPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit };
