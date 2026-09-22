// web-rtc-service.ts

import {
  createSignalingSession,
  type RoomId,
  type SignalingPeerId,
} from "@infrastructure/signaling";
import { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import type { RtcPeer } from "./rtc-peer-registry";
import { RtcPeerRegistry } from "./rtc-peer-registry";
import { RtcReconnectionManager } from "./rtc-reconnection-manager";

type RtcPeerHandler = (peer: RtcPeer) => void;
type RtcMessageHandler = (message: string, from: SignalingPeerId) => void;

type SignalingPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit };

export class WebRtcService {
  private readonly session = createSignalingSession();
  private readonly registry = new RtcPeerRegistry();

  private readonly peerJoinedHandlers = new Set<RtcPeerHandler>();
  private readonly peerLeftHandlers = new Set<RtcPeerHandler>();
  private readonly messageHandlers = new Set<RtcMessageHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  private leaving = false;
  private isHost = false;
  private joined = false;

  private readonly linkFactory: RtcPeerLinkFactory;
  private readonly reconnectionManager: RtcReconnectionManager;

  constructor() {
    this.linkFactory = new RtcPeerLinkFactory(
      this.session,
      this.registry,
      (message, from) => {
        for (const handler of this.messageHandlers) handler(message, from);
      },
      (signalingPeerId) => {
        void this.reconnectionManager.handleConnectionDied(signalingPeerId);
      },
      () => this.isHost,
      () => this.leaving,
    );

    // Lazy access to session.host — it only exists after joinRoom().
    this.reconnectionManager = new RtcReconnectionManager(
      this.registry,
      this.linkFactory,
      () => this.session.host,
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
    await this.session.joinRoom(roomId);

    this.reconnectionManager.start();

    this.cleanupFns.push(
      this.registry.onPeerJoined((peer) => {
        for (const handler of this.peerJoinedHandlers) handler(peer);
      }),

      this.registry.onPeerLeft((peer) => {
        for (const handler of this.peerLeftHandlers) handler(peer);
      }),

      this.session.onPeerJoined((peer) => {
        console.log(
          `[WebRtcService] Signaling peer joined: ${short(peer.peerId)}`,
        );
        void this.handleSignalingPeerJoined(peer.peerId);
      }),

      this.session.onPeerLeft((peer) => {
        console.log(
          `[WebRtcService] Signaling peer left: ${short(peer.peerId)}`,
        );
        this.handleSignalingPeerLeft(peer.peerId);
      }),

      this.session.onSignalReceived((message) => {
        void this.handleSignalReceived(
          message.fromPeerId,
          message.payload as SignalingPayload,
        );
      }),

      this.session.host.onHostChanged((host) => {
        console.log(
          `[WebRtcService] Host changed → ${host ? short(host.signalingPeerId) : "null"}`,
        );
        void this.handleHostChanged(host);
      }),
    );

    const currentHost = await this.session.host.currentHost();

    if (!currentHost) {
      console.log("[WebRtcService] No host on join — triggering election");
      await this.session.host.electNextHost();
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

    this.reconnectionManager.stop();

    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;

    this.registry.disposeAndRemoveAll();

    await this.session.leaveRoom();

    this.joined = false;
    this.leaving = false;
  }

  getPeers(): RtcPeer[] {
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

  onPeerJoined(handler: RtcPeerHandler): () => void {
    this.peerJoinedHandlers.add(handler);
    return () => this.peerJoinedHandlers.delete(handler);
  }

  onPeerLeft(handler: RtcPeerHandler): () => void {
    this.peerLeftHandlers.add(handler);
    return () => this.peerLeftHandlers.delete(handler);
  }

  onMessage(handler: RtcMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ─── Host role ────────────────────────────────────────────────────────────

  private async handleHostChanged(
    host: { signalingPeerId: SignalingPeerId } | null,
  ): Promise<void> {
    if (this.leaving) return;

    if (!host) {
      console.log(
        "[WebRtcService] Host document cleared — triggering election",
      );
      await this.session.host.electNextHost();
      return;
    }

    const localPeerId = this.session.peerId;
    const iAmHost = host.signalingPeerId === localPeerId;

    console.log(
      `[WebRtcService] Host is ${short(host.signalingPeerId)}${iAmHost ? " (me)" : ""}`,
    );

    await this.setRole(iAmHost);

    if (!iAmHost) {
      this.reconnectionManager.watchForOffer(host.signalingPeerId);
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
    for (const peer of this.session.getPeers()) {
      if (this.registry.has(peer.peerId)) {
        console.log(
          `[WebRtcService] Already have entry for peer=${short(peer.peerId)}, keeping`,
        );
        continue;
      }
      console.log(
        `[WebRtcService] No entry for peer=${short(peer.peerId)}, creating and offering`,
      );
      const entry = this.linkFactory.create(peer.peerId);
      this.registry.add(peer.peerId, entry);
      await this.linkFactory.initiateOffer(peer.peerId, entry);
    }
  }

  // ─── Signaling peer events ─────────────────────────────────────────────────

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

    const entry = this.linkFactory.create(signalingPeerId);
    this.registry.add(signalingPeerId, entry);
    await this.linkFactory.initiateOffer(signalingPeerId, entry);
  }

  private handleSignalingPeerLeft(signalingPeerId: SignalingPeerId): void {
    this.reconnectionManager.stopWatchingForOffer(signalingPeerId);

    if (!this.registry.has(signalingPeerId)) return;
    const entry = this.registry.get(signalingPeerId)!;
    this.registry.disposeEntry(entry);
    this.registry.remove(signalingPeerId);
  }

  // ─── Signal handling ────────────────────────────────────────────────────────

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
      entry = this.linkFactory.create(signalingPeerId);
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

function short(id: string): string {
  return id.slice(0, 8);
}
