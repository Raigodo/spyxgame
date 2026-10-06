import { shortId, type IdGenerator, type Logger } from "@/shared/kernel";
import { ActiveRtcConnection } from "./active-rtc-connection";
import type { RtcDataChannelPort } from "./ports/rtc-data-channel-port";
import type {
  IceCandidate,
  RtcPeerConnectionPort,
  SessionDescription,
} from "./ports/rtc-peer-connection-port";

export interface RtcLinkNegotiatorDeps {
  connection: RtcPeerConnectionPort;
  ids: IdGenerator;
  logger: Logger;
}

// Negotiates ONE link: offer/answer/ICE, then hands over an ActiveRtcConnection once the data
// channel opens. Host side calls initiateOffer(); guest side calls applyOffer().
export class RtcLinkNegotiator {
  private offerCreatedHandler?: (offer: SessionDescription) => void;
  private answerCreatedHandler?: (answer: SessionDescription) => void;
  private iceCandidateCreatedHandler?: (candidate: IceCandidate) => void;
  private connectedHandler?: (connection: ActiveRtcConnection) => void;

  private closed = false;
  private remoteDescriptionSet = false;
  private readonly queuedCandidates: IceCandidate[] = [];

  constructor(private readonly deps: RtcLinkNegotiatorDeps) {
    deps.connection.onIceCandidate((candidate) => {
      deps.logger.debug("ICE candidate created");
      this.iceCandidateCreatedHandler?.(candidate);
    });

    deps.connection.onDataChannel((channel) => {
      deps.logger.debug("Data channel received (guest)");
      this.attachDataChannelHandlers(channel);
    });
  }

  // ─── Callbacks ────────────────────────────────────────────────────────────

  onOfferCreated(handler: (offer: SessionDescription) => void): void {
    this.offerCreatedHandler = handler;
  }

  onAnswerCreated(handler: (answer: SessionDescription) => void): void {
    this.answerCreatedHandler = handler;
  }

  onIceCandidateCreated(handler: (candidate: IceCandidate) => void): void {
    this.iceCandidateCreatedHandler = handler;
  }

  onConnected(handler: (connection: ActiveRtcConnection) => void): void {
    this.connectedHandler = handler;
  }

  // ─── Host ─────────────────────────────────────────────────────────────────

  async initiateOffer(): Promise<void> {
    this.assertNotClosed();
    const { connection, logger } = this.deps;
    logger.debug("Creating offer");

    this.attachDataChannelHandlers(connection.createDataChannel("data"));

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    logger.debug("Offer created");
    this.offerCreatedHandler?.(offer);
  }

  // ─── Guest ────────────────────────────────────────────────────────────────

  async applyOffer(offer: SessionDescription): Promise<void> {
    this.assertNotClosed();
    const { connection, logger } = this.deps;
    logger.debug("Applying offer");
    await connection.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;
    await this.drainQueuedCandidates();

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    logger.debug("Answer created");
    this.answerCreatedHandler?.(answer);
  }

  // ─── Both sides ───────────────────────────────────────────────────────────

  async applyAnswer(answer: SessionDescription): Promise<void> {
    this.assertNotClosed();
    this.deps.logger.debug("Applying answer");
    await this.deps.connection.setRemoteDescription(answer);
    this.remoteDescriptionSet = true;
    await this.drainQueuedCandidates();
  }

  async applyIceCandidate(candidate: IceCandidate): Promise<void> {
    this.assertNotClosed();
    if (!this.remoteDescriptionSet) {
      this.deps.logger.debug("Queuing ICE candidate: remote description not set yet");
      this.queuedCandidates.push(candidate);
      return;
    }
    this.deps.logger.debug("Applying ICE candidate");
    await this.deps.connection.addIceCandidate(candidate);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queuedCandidates.length = 0;
    this.deps.logger.debug("Closed before connection established");
    this.deps.connection.close();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async drainQueuedCandidates(): Promise<void> {
    if (this.queuedCandidates.length === 0) return;
    this.deps.logger.debug(`Draining ${this.queuedCandidates.length} queued ICE candidates`);
    for (const candidate of this.queuedCandidates.splice(0)) {
      await this.deps.connection.addIceCandidate(candidate);
    }
  }

  private attachDataChannelHandlers(channel: RtcDataChannelPort): void {
    const { connection, ids, logger } = this.deps;

    channel.onOpen(() => {
      logger.debug("Data channel open, handing off ActiveRtcConnection");
      const active = new ActiveRtcConnection({
        connection,
        channel,
        ids,
        logger: logger.child("active"),
      });
      this.connectedHandler?.(active);
    });

    channel.onError((error) => logger.warn("Data channel error", error));
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error("[RtcLinkNegotiator] Already closed.");
  }
}
