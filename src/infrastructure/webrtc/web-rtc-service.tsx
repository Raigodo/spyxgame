// web-rtc-service.ts

import { SignalingServiceRoot } from "@infrastructure/signaling";
import { RtcConnectionFactory } from "./rtc-connection-factory";
import type { ActiveRtcConnection } from "./active-rtc-connection";
import type { RtcPeerStatus } from "@infrastructure/webrtc/types";
import type { SignalingPeerId, RoomId } from "@infrastructure/signaling";

interface RtcPeer {
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}

interface PeerEntry {
  factory: RtcConnectionFactory;
  connection: ActiveRtcConnection | null;
  status: RtcPeerStatus;
}

type RtcPeerHandler = (peer: RtcPeer) => void;
type RtcMessageHandler = (message: string, from: SignalingPeerId) => void;

function short(id: string): string {
  return id.slice(0, 8);
}

export class WebRtcService {
  async setRole(isHost: boolean): Promise<void> {
    if (this.isHost === isHost) return;

    console.log(
      `[WebRtcService] Role changing: ${this.isHost ? "host" : "guest"} → ${isHost ? "host" : "guest"}`,
    );

    this.isHost = isHost;

    if (!isHost) {
      // Becoming guest — abandon all connections.
      // New host will reach out with fresh offers.
      console.log("[WebRtcService] Became guest — disposing all peer entries");
      for (const [signalingPeerId, entry] of this.peers) {
        this.disposeEntry(entry);
        this.peers.delete(signalingPeerId);
        this.notifyPeerLeft(signalingPeerId, entry);
      }
      return;
    }

    // Becoming host — keep existing connections, create missing ones.
    console.log(
      "[WebRtcService] Became host — connecting to any unconnected peers",
    );

    for (const peer of this.signalingService.getSignalingPeers()) {
      if (this.peers.has(peer.peerId)) {
        console.log(
          `[WebRtcService] Already have entry for peer=${short(peer.peerId)}, keeping`,
        );
        continue;
      }

      console.log(
        `[WebRtcService] No entry for peer=${short(peer.peerId)}, creating and offering`,
      );
      const entry = this.createEntry(peer.peerId);
      this.peers.set(peer.peerId, entry);
      this.notifyPeerJoined(peer.peerId, entry);
      await this.initiateOffer(peer.peerId, entry);
    }
  }

  private readonly signalingService = new SignalingServiceRoot();
  private readonly peers = new Map<SignalingPeerId, PeerEntry>();

  private readonly peerJoinedHandlers = new Set<RtcPeerHandler>();
  private readonly peerLeftHandlers = new Set<RtcPeerHandler>();
  private readonly messageHandlers = new Set<RtcMessageHandler>();

  private readonly cleanupFns: Array<() => void> = [];

  private leaving = false;
  private isHost = false;
  private joined = false;

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(roomId: RoomId): Promise<void> {
    if (this.joined) {
      throw new Error("[WebRtcService] Already joined a room.");
    }
    this.joined = true;
    this.isHost = false; // always start as guest, role assigned via setRole

    console.log(`[WebRtcService] Joining room=${roomId}`);
    await this.signalingService.joinRoom(roomId);

    this.cleanupFns.push(
      this.signalingService.onSignalingPeerJoined((peer) => {
        console.log(`[WebRtcService] Signaling peer joined: ${peer.peerId}`);
        void this.handlePeerJoined(peer.peerId);
      }),

      this.signalingService.onSignalingPeerLeft((peer) => {
        console.log(`[WebRtcService] Signaling peer left: ${peer.peerId}`);
        this.handlePeerLeft(peer.peerId);
      }),

      this.signalingService.onSignalReceived((message) => {
        void this.handleSignalReceived(
          message.fromPeerId,
          message.payload as SignalingPayload,
        );
      }),
    );

    // Connect to peers already in the room.
    for (const peer of this.signalingService.getSignalingPeers()) {
      console.log(`[WebRtcService] Found existing peer: ${peer.peerId}`);
      void this.handlePeerJoined(peer.peerId);
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.joined) return;

    this.leaving = true; // ← set before any disposal
    console.log("[WebRtcService] Leaving room");

    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;

    for (const [signalingPeerId, entry] of this.peers) {
      console.log(`[WebRtcService] Disposing peer=${signalingPeerId}`);
      this.disposeEntry(entry);
    }
    this.peers.clear();

    await this.signalingService.leaveRoom();

    this.joined = false;
    this.leaving = false;
  }

  getRtcPeers(): RtcPeer[] {
    return Array.from(this.peers.entries(), ([signalingPeerId, entry]) => ({
      signalingPeerId,
      status: entry.status,
    }));
  }

  sendMessageToPeer(signalingPeerId: SignalingPeerId, message: string): void {
    const entry = this.peers.get(signalingPeerId);

    if (!entry) {
      console.warn(
        `[WebRtcService] No peer found for signalingPeerId=${signalingPeerId}`,
      );
      return;
    }

    if (entry.status !== "active" || !entry.connection) {
      console.warn(
        `[WebRtcService] Peer=${signalingPeerId} is not active (status=${entry.status}), cannot send`,
      );
      return;
    }

    entry.connection.send(message);
  }

  broadcastMessage(message: string): void {
    for (const [signalingPeerId, entry] of this.peers) {
      if (entry.status !== "active" || !entry.connection) {
        console.warn(
          `[WebRtcService] Skipping broadcast to peer=${signalingPeerId}, status=${entry.status}`,
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

  // ─── Signaling peer events ────────────────────────────────────────────────

  private async handlePeerJoined(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    if (!this.isHost) {
      // Guests never initiate — they only respond to offers.
      // Entry will be created in handleOffer when the host reaches out.
      return;
    }

    if (this.peers.has(signalingPeerId)) {
      console.warn(
        `[WebRtcService] Peer=${signalingPeerId} already exists, skipping`,
      );
      return;
    }

    const entry = this.createEntry(signalingPeerId);
    this.peers.set(signalingPeerId, entry);
    this.notifyPeerJoined(signalingPeerId, entry);

    if (this.isHost) {
      await this.initiateOffer(signalingPeerId, entry);
    }
    // Guest does nothing — waits for an offer via onSignalReceived.
  }

  private handlePeerLeft(signalingPeerId: SignalingPeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;

    this.disposeEntry(entry);
    this.peers.delete(signalingPeerId);
    this.notifyPeerLeft(signalingPeerId, entry);
  }

  // ─── Signal handling ──────────────────────────────────────────────────────

  private async handleSignalReceived(
    signalingPeerId: SignalingPeerId,
    signal: SignalingPayload,
  ): Promise<void> {
    console.log(
      `[WebRtcService] Signal from peer=${signalingPeerId} type=${signal.type}`,
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
          `[WebRtcService] Unknown signal type from peer=${signalingPeerId}`,
        );
    }
  }

  private async handleOffer(
    signalingPeerId: SignalingPeerId,
    sdp: string,
  ): Promise<void> {
    // If no entry yet, create one — offer can arrive before signaling peer event.
    let entry = this.peers.get(signalingPeerId);

    if (!entry) {
      console.log(
        `[WebRtcService] Creating entry for peer=${signalingPeerId} on offer arrival`,
      );
      entry = this.createEntry(signalingPeerId);
      this.peers.set(signalingPeerId, entry);
      this.notifyPeerJoined(signalingPeerId, entry);
    }

    await entry.factory.applyOffer({ type: "offer", sdp });
  }

  private async handleAnswer(
    signalingPeerId: SignalingPeerId,
    sdp: string,
  ): Promise<void> {
    const entry = this.peers.get(signalingPeerId);

    if (!entry) {
      console.warn(
        `[WebRtcService] Answer from unknown peer=${signalingPeerId}, ignoring`,
      );
      return;
    }

    await entry.factory.applyAnswer({ type: "answer", sdp });
  }

  private async handleIceCandidate(
    signalingPeerId: SignalingPeerId,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const entry = this.peers.get(signalingPeerId);

    if (!entry) {
      console.warn(
        `[WebRtcService] ICE candidate from unknown peer=${signalingPeerId}, ignoring`,
      );
      return;
    }

    await entry.factory.applyIceCandidate(candidate);
  }

  // ─── Entry management ─────────────────────────────────────────────────────

  private createEntry(signalingPeerId: SignalingPeerId): PeerEntry {
    console.log(`[WebRtcService] Creating factory for peer=${signalingPeerId}`);

    const factory = new RtcConnectionFactory();
    const entry: PeerEntry = {
      factory,
      connection: null,
      status: "connecting",
    };

    factory.onIceCandidateCreated((candidate) => {
      console.log(`[WebRtcService] ICE candidate for peer=${signalingPeerId}`);
      void this.signalingService.sendIceCandidateToPeer(
        signalingPeerId,
        candidate,
        this.isHost ? "remove" : "do-nothing", // ← same here
      );
    });

    factory.onAnswerCreated((answer) => {
      console.log(`[WebRtcService] Answer created for peer=${signalingPeerId}`);
      void this.signalingService.sendAnswerToPeer(
        signalingPeerId,
        answer.sdp!,
        "do-nothing",
      );
    });

    factory.onConnected((connection) => {
      console.log(`[WebRtcService] Connected to peer=${signalingPeerId}`);
      entry.connection = connection;
      this.setEntryStatus(signalingPeerId, entry, "active");

      connection.onMessage((message) => {
        for (const handler of this.messageHandlers) {
          handler(message, signalingPeerId);
        }
      });

      connection.onStateChange((state) => {
        console.log(
          `[WebRtcService] Connection state changed peer=${signalingPeerId} state=${state}`,
        );

        if (state === "disconnected" || state === "failed") {
          void this.handleConnectionDied(signalingPeerId);
        }
      });
    });

    return entry;
  }

  private async handleConnectionDied(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    if (this.leaving) {
      console.log(
        `[WebRtcService] Ignoring connection death during leave for peer=${short(signalingPeerId)}`,
      );
      return;
    }

    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;

    console.warn(
      `[WebRtcService] Connection died for peer=${short(signalingPeerId)}`,
    );

    this.disposeEntry(entry);

    if (this.isHost) {
      // Host recreates the connection and sends a new offer.
      const newEntry = this.createEntry(signalingPeerId);
      newEntry.status = "reconnecting";
      this.peers.set(signalingPeerId, newEntry);
      this.setEntryStatus(signalingPeerId, newEntry, "reconnecting");
      await this.initiateOffer(signalingPeerId, newEntry);
      return;
    }

    // Guest — mark as reconnecting and wait 5s for the host to reach out.
    // If no offer arrives within that window, remove the entry entirely.
    const reconnectingEntry = this.createEntry(signalingPeerId);
    reconnectingEntry.status = "reconnecting";
    this.peers.set(signalingPeerId, reconnectingEntry);
    this.setEntryStatus(signalingPeerId, reconnectingEntry, "reconnecting");

    console.log(
      `[WebRtcService] Guest waiting 5s for new offer from peer=${short(signalingPeerId)}`,
    );

    setTimeout(() => {
      const current = this.peers.get(signalingPeerId);

      // If the entry is still reconnecting, no offer arrived — remove it.
      if (current && current.status === "reconnecting") {
        console.warn(
          `[WebRtcService] No offer received from peer=${short(signalingPeerId)} — removing`,
        );
        this.disposeEntry(current);
        this.peers.delete(signalingPeerId);
        this.notifyPeerLeft(signalingPeerId, current);
      }
    }, 5_000);
  }

  private async initiateOffer(
    signalingPeerId: SignalingPeerId,
    entry: PeerEntry,
  ): Promise<void> {
    console.log(`[WebRtcService] Initiating offer to peer=${signalingPeerId}`);

    entry.factory.onOfferCreated((offer) => {
      console.log(`[WebRtcService] Offer created for peer=${signalingPeerId}`);
      void this.signalingService.sendOfferToPeer(
        signalingPeerId,
        offer.sdp!,
        this.isHost ? "remove" : "do-nothing", // ← host removes dead peers
      );
    });

    await entry.factory.initiateOffer();
  }

  private disposeEntry(entry: PeerEntry): void {
    entry.connection?.close();
    entry.factory.close();
    entry.connection = null;
  }

  private setEntryStatus(
    signalingPeerId: SignalingPeerId,
    entry: PeerEntry,
    status: RtcPeerStatus,
  ): void {
    if (entry.status === status) return;
    console.log(
      `[WebRtcService] Peer=${signalingPeerId} status: ${entry.status} → ${status}`,
    );
    entry.status = status;
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  private notifyPeerJoined(
    signalingPeerId: SignalingPeerId,
    entry: PeerEntry,
  ): void {
    for (const handler of this.peerJoinedHandlers) {
      handler({ signalingPeerId, status: entry.status });
    }
  }

  private notifyPeerLeft(
    signalingPeerId: SignalingPeerId,
    entry: PeerEntry,
  ): void {
    for (const handler of this.peerLeftHandlers) {
      handler({ signalingPeerId, status: entry.status });
    }
  }
}

// ─── Signal payload types ─────────────────────────────────────────────────────

type SignalingPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit };
