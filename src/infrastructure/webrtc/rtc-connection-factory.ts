// rtc-connection-factory.ts

import { ActiveRtcConnection } from "./active-rtc-connection";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export class RtcConnectionFactory {
  private readonly connection: RTCPeerConnection;

  private offerCreatedHandler?: (offer: RTCSessionDescriptionInit) => void;
  private answerCreatedHandler?: (answer: RTCSessionDescriptionInit) => void;
  private iceCandidateCreatedHandler?: (candidate: RTCIceCandidateInit) => void;
  private connectedHandler?: (connection: ActiveRtcConnection) => void;

  private dataChannel?: RTCDataChannel;
  private closed = false;
  private remoteDescriptionSet = false; // ← add
  private readonly queuedCandidates: RTCIceCandidateInit[] = []; // ← add

  constructor() {
    this.connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      console.log("[RtcConnectionFactory] ICE candidate created");
      this.iceCandidateCreatedHandler?.(event.candidate.toJSON());
    };

    this.connection.ondatachannel = (event) => {
      console.log("[RtcConnectionFactory] Data channel received (guest)");
      this.dataChannel = event.channel;
      this.attachDataChannelHandlers(event.channel);
    };
  }

  // ─── Callbacks ────────────────────────────────────────────────────────────

  onOfferCreated(handler: (offer: RTCSessionDescriptionInit) => void): void {
    this.offerCreatedHandler = handler;
  }

  onAnswerCreated(handler: (answer: RTCSessionDescriptionInit) => void): void {
    this.answerCreatedHandler = handler;
  }

  onIceCandidateCreated(
    handler: (candidate: RTCIceCandidateInit) => void,
  ): void {
    this.iceCandidateCreatedHandler = handler;
  }

  onConnected(handler: (connection: ActiveRtcConnection) => void): void {
    this.connectedHandler = handler;
  }

  // ─── Host ─────────────────────────────────────────────────────────────────

  async initiateOffer(): Promise<void> {
    this.assertNotClosed();

    console.log("[RtcConnectionFactory] Creating offer");

    this.dataChannel = this.connection.createDataChannel("data");
    this.attachDataChannelHandlers(this.dataChannel);

    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);

    console.log("[RtcConnectionFactory] Offer created");
    this.offerCreatedHandler?.(offer);
  }

  // ─── Guest ────────────────────────────────────────────────────────────────

  async applyOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    this.assertNotClosed();
    console.log("[RtcConnectionFactory] Applying offer");
    await this.connection.setRemoteDescription(offer);
    this.remoteDescriptionSet = true; // ← add
    await this.drainQueuedCandidates(); // ← add

    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    console.log("[RtcConnectionFactory] Answer created");
    this.answerCreatedHandler?.(answer);
  }

  // ─── Both sides ───────────────────────────────────────────────────────────

  async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    this.assertNotClosed();
    console.log("[RtcConnectionFactory] Applying answer");
    await this.connection.setRemoteDescription(answer);
    this.remoteDescriptionSet = true; // ← add
    await this.drainQueuedCandidates(); // ← add
  }

  async applyIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.assertNotClosed();
    if (!this.remoteDescriptionSet) {
      console.log(
        "[RtcConnectionFactory] Queuing ICE candidate — remote description not set yet",
      );
      this.queuedCandidates.push(candidate); // ← add
      return;
    }
    console.log("[RtcConnectionFactory] Applying ICE candidate");
    await this.connection.addIceCandidate(candidate);
  }

  private async drainQueuedCandidates(): Promise<void> {
    if (this.queuedCandidates.length === 0) return;
    console.log(
      `[RtcConnectionFactory] Draining ${this.queuedCandidates.length} queued ICE candidates`,
    );
    const candidates = this.queuedCandidates.splice(0);
    for (const candidate of candidates) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queuedCandidates.length = 0; // ← add
    console.log("[RtcConnectionFactory] Closed before connection established");
    this.connection.close();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private attachDataChannelHandlers(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log(
        "[RtcConnectionFactory] Data channel open — handing off ActiveRtcConnection",
      );
      const active = new ActiveRtcConnection(this.connection, channel);
      this.connectedHandler?.(active);
    };

    channel.onerror = (event) => {
      console.warn("[RtcConnectionFactory] Data channel error", event);
    };
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error("[RtcConnectionFactory] Already closed.");
    }
  }
}
