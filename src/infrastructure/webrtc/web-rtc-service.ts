import { RoomId, SignalingPeerId } from "../signaling";
import { FirestoreSignalingServiceRoot } from "../signaling/firestore-signaling-service-root";
import { RtcConnectionFactory } from "./rtc-connection-factory";
import { RtcMessageRouter } from "./rtc-message-router";
import { RtcPeerConnection } from "./rtc-peer-connection";

import type { RtcMessage, RtcPeerInfo, RtcPeerId } from "./types";

type RtcPeerHandler = (peer: RtcPeerInfo) => void;

export class WebRtcService {
  private readonly signalingService: FirestoreSignalingServiceRoot;
  private readonly factory: RtcConnectionFactory;
  private readonly messageRouter: RtcMessageRouter;
  private readonly pendingSignals = new Map<
    SignalingPeerId,
    Array<{ type: string; sdp?: string; candidate?: RTCIceCandidateInit }>
  >();

  // signalingPeerId → RtcPeerConnection
  private readonly peerConnections = new Map<
    SignalingPeerId,
    RtcPeerConnection
  >();

  private readonly peerJoinedHandlers = new Set<RtcPeerHandler>();
  private readonly peerLeftHandlers = new Set<RtcPeerHandler>();

  private readonly cleanupFns: Array<() => void> = [];

  private isHost: boolean = false;
  private joined = false;

  constructor() {
    this.signalingService = new FirestoreSignalingServiceRoot();
    this.factory = new RtcConnectionFactory();
    this.messageRouter = new RtcMessageRouter();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async joinRoom(roomId: RoomId, isHost: boolean): Promise<void> {
    if (this.joined) {
      throw new Error("[WebRtcService] Already joined a room.");
    }

    this.isHost = isHost;
    this.joined = true;

    console.log(`[WebRtcService] Joining room=${roomId} isHost=${isHost}`);

    await this.signalingService.joinRoom(roomId);

    this.cleanupFns.push(
      this.signalingService.onSignalingPeerJoined((peer) => {
        console.log(`[WebRtcService] Signaling peer joined: ${peer.peerId}`);
        void this.handleSignalingPeerJoined(peer.peerId);
      }),

      this.signalingService.onSignalingPeerLeft((peer) => {
        console.log(`[WebRtcService] Signaling peer left: ${peer.peerId}`);
        this.handleSignalingPeerLeft(peer.peerId);
      }),

      this.signalingService.onSignalReceived((message) => {
        void this.handleSignalReceived(message.fromPeerId, message.payload);
      }),
    );

    // Connect to peers already in the room.
    for (const peer of this.signalingService.getSignalingPeers()) {
      console.log(`[WebRtcService] Existing signaling peer: ${peer.peerId}`);
      void this.handleSignalingPeerJoined(peer.peerId);
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.joined) {
      return;
    }

    console.log("[WebRtcService] Leaving room");

    // Unsubscribe from signaling events.
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns.length = 0;

    // Dispose all peer connections — closes RTCPeerConnection + sockets.
    for (const [signalingPeerId, conn] of this.peerConnections) {
      console.log(
        `[WebRtcService] Disposing connection for signalingPeer=${signalingPeerId}`,
      );
      conn.dispose();
    }
    this.peerConnections.clear();
    this.pendingSignals.clear(); // add after peerConnections.clear()
    this.messageRouter.dispose();

    await this.signalingService.leaveRoom();

    this.joined = false;
  }

  getRtcPeers(): RtcPeerInfo[] {
    return Array.from(this.peerConnections.values(), (conn) =>
      this.toRtcPeerInfo(conn),
    );
  }

  getRtcPeer(signalingPeerId: SignalingPeerId): RtcPeerInfo | undefined {
    const conn = this.peerConnections.get(signalingPeerId);
    return conn ? this.toRtcPeerInfo(conn) : undefined;
  }

  onRtcPeerJoined(handler: RtcPeerHandler): () => void {
    this.peerJoinedHandlers.add(handler);
    return () => this.peerJoinedHandlers.delete(handler);
  }

  onRtcPeerLeft(handler: RtcPeerHandler): () => void {
    this.peerLeftHandlers.add(handler);
    return () => this.peerLeftHandlers.delete(handler);
  }

  onRtcMessage(
    handler: (
      message: RtcMessage,
      from: { rtcPeerId: RtcPeerId; signalingPeerId: SignalingPeerId },
    ) => void,
  ): () => void {
    return this.messageRouter.onMessage(handler);
  }

  sendRtcMessage(signalingPeerId: SignalingPeerId, message: RtcMessage): void {
    const conn = this.peerConnections.get(signalingPeerId);
    if (!conn) {
      throw new Error(
        `[WebRtcService] No connection for signalingPeer=${signalingPeerId}`,
      );
    }
    conn.send(message);
  }

  broadcastRtcMessage(message: RtcMessage): void {
    for (const [signalingPeerId, conn] of this.peerConnections) {
      if (conn.status !== "active") {
        console.warn(
          `[WebRtcService] Skipping broadcast to signalingPeer=${signalingPeerId}, status=${conn.status}`,
        );
        continue;
      }
      conn.send(message);
    }
  }

  // ─── Signaling peer events ───────────────────────────────────────────────

  private async handleSignalingPeerJoined(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    if (this.peerConnections.has(signalingPeerId)) {
      console.warn(
        `[WebRtcService] Connection already exists for signalingPeer=${signalingPeerId}, skipping`,
      );
      return;
    }

    const conn = this.createPeerConnection(signalingPeerId);

    // State is set before any event fires — no race possible.
    this.peerConnections.set(signalingPeerId, conn);

    for (const handler of this.peerJoinedHandlers) {
      handler(this.toRtcPeerInfo(conn));
    }

    if (this.isHost) {
      await this.initiateOffer(signalingPeerId, conn);
    }
    // Guest waits for an offer to arrive via onSignalReceived.
  }

  private handleSignalingPeerLeft(signalingPeerId: SignalingPeerId): void {
    this.pendingSignals.delete(signalingPeerId); // add this line
    const conn = this.peerConnections.get(signalingPeerId);
    if (!conn) {
      return;
    }

    conn.dispose();
    this.peerConnections.delete(signalingPeerId);

    for (const handler of this.peerLeftHandlers) {
      handler(this.toRtcPeerInfo(conn));
    }
  }

  // ─── Signal handling ─────────────────────────────────────────────────────

  private async handleSignalReceived(
    signalingPeerId: SignalingPeerId,
    signal: unknown,
  ): Promise<void> {
    const webRtcSignal = signal as {
      type: string;
      sdp?: string;
      candidate?: RTCIceCandidateInit;
    };

    console.log(
      `[WebRtcService] Signal received from signalingPeer=${signalingPeerId} type=${webRtcSignal.type}`,
    );

    // For ICE candidates: if connection exists but remote description isn't set yet,
    // RtcPeerConnection handles the queue internally.
    // For offers/answers: if no connection exists yet, queue the signal.
    const conn = this.peerConnections.get(signalingPeerId);

    if (!conn && webRtcSignal.type === "ice-candidate") {
      console.log(
        `[WebRtcService] Queuing ICE candidate for unknown peer=${signalingPeerId}`,
      );
      this.enqueueSignal(signalingPeerId, webRtcSignal);
      return;
    }

    switch (webRtcSignal.type) {
      case "offer": {
        if (!webRtcSignal.sdp) {
          console.warn("[WebRtcService] Offer missing SDP");
          return;
        }

        // Guest receives offer — peer may not be in tracker yet, that's fine.
        // We create the connection here; tracker will catch up via reconcilePeers.
        const guestConn =
          conn ??
          (() => {
            const newConn = this.createPeerConnection(signalingPeerId);
            this.peerConnections.set(signalingPeerId, newConn);
            // Don't fire peerJoined here — reconcilePeers will do it when tracker catches up.
            return newConn;
          })();

        const answer = await (guestConn.status === "dead"
          ? guestConn.reconnectAsGuest({ type: "offer", sdp: webRtcSignal.sdp })
          : guestConn.receiveOffer({ type: "offer", sdp: webRtcSignal.sdp }));

        await this.signalingService.sendAnswerToPeer(
          signalingPeerId,
          answer.sdp!,
          "do-nothing",
        );

        // Drain any signals that arrived before the offer.
        await this.drainPendingSignals(signalingPeerId);
        break;
      }

      case "answer": {
        if (!conn || !webRtcSignal.sdp) {
          console.warn(
            `[WebRtcService] Unexpected answer from signalingPeer=${signalingPeerId}`,
          );
          return;
        }
        await conn.receiveAnswer({ type: "answer", sdp: webRtcSignal.sdp });
        await this.drainPendingSignals(signalingPeerId);
        break;
      }

      case "ice-candidate": {
        if (!conn || !webRtcSignal.candidate) {
          console.warn(
            `[WebRtcService] ICE candidate for unknown peer=${signalingPeerId}, queuing`,
          );
          this.enqueueSignal(signalingPeerId, webRtcSignal);
          return;
        }
        await conn.addIceCandidate(webRtcSignal.candidate);
        break;
      }

      default:
        console.warn(
          `[WebRtcService] Unknown signal type: ${webRtcSignal.type}`,
        );
    }
  }

  private enqueueSignal(
    signalingPeerId: SignalingPeerId,
    signal: { type: string; sdp?: string; candidate?: RTCIceCandidateInit },
  ): void {
    if (!this.pendingSignals.has(signalingPeerId)) {
      this.pendingSignals.set(signalingPeerId, []);
    }
    this.pendingSignals.get(signalingPeerId)!.push(signal);
  }

  private async drainPendingSignals(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    const queued = this.pendingSignals.get(signalingPeerId);
    if (!queued || queued.length === 0) {
      return;
    }

    console.log(
      `[WebRtcService] Draining ${queued.length} pending signals for signalingPeer=${signalingPeerId}`,
    );

    this.pendingSignals.delete(signalingPeerId);

    for (const signal of queued) {
      await this.handleSignalReceived(signalingPeerId, signal);
    }
  }

  // ─── Connection creation ─────────────────────────────────────────────────

  private createPeerConnection(
    signalingPeerId: SignalingPeerId,
  ): RtcPeerConnection {
    console.log(
      `[WebRtcService] Creating RtcPeerConnection for signalingPeer=${signalingPeerId}`,
    );

    return new RtcPeerConnection(signalingPeerId, this.factory, {
      onStatusChanged: (status) => {
        console.log(
          `[WebRtcService] Peer status changed signalingPeer=${signalingPeerId} status=${status}`,
        );
      },

      onMessage: (message) => {
        const conn = this.peerConnections.get(signalingPeerId);
        if (!conn) return;
        this.messageRouter.route(message, {
          rtcPeerId: conn.rtcPeerId,
          signalingPeerId,
        });
      },

      onIceCandidate: (candidate) => {
        void this.signalingService.sendIceCandidateToPeer(
          signalingPeerId,
          candidate,
          "do-nothing",
        );
      },

      onDead: () => {
        console.warn(
          `[WebRtcService] Connection dead for signalingPeer=${signalingPeerId}`,
        );
        if (this.isHost) {
          void this.initiateOffer(
            signalingPeerId,
            this.peerConnections.get(signalingPeerId)!,
          );
        }
        // Guest waits — host will send a new offer.
      },
    });
  }

  private async initiateOffer(
    signalingPeerId: SignalingPeerId,
    conn: RtcPeerConnection,
  ): Promise<void> {
    console.log(
      `[WebRtcService] Initiating offer to signalingPeer=${signalingPeerId}`,
    );

    const offer = await (conn.status === "dead"
      ? conn.reconnectAsHost()
      : conn.initAsHost());

    await this.signalingService.sendOfferToPeer(
      signalingPeerId,
      offer.sdp!,
      "do-nothing",
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private toRtcPeerInfo(conn: RtcPeerConnection): RtcPeerInfo {
    return {
      rtcPeerId: conn.rtcPeerId,
      signalingPeerId: conn.signalingPeerId,
      status: conn.status,
    };
  }
}
