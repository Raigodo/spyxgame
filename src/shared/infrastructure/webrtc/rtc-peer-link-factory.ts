import { shortId, type IdGenerator, type Logger } from "@/shared/kernel";
import type { SignalingPeerId, SignalingSession } from "../signaling";
import type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
import { RtcLinkNegotiator } from "./rtc-link-negotiator";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { PeerEntry } from "./types";

export interface RtcPeerLinkFactoryDeps {
  signaling: SignalingSession;
  registry: RtcPeerRegistry;
  connections: RtcConnectionProvider;
  ids: IdGenerator;
  logger: Logger;
  onMessage: (message: string, from: SignalingPeerId) => void;
  onConnectionDied: (signalingPeerId: SignalingPeerId) => void;
  isHost: () => boolean;
  isLeaving: () => boolean;
}

export class RtcPeerLinkFactory {
  constructor(private readonly deps: RtcPeerLinkFactoryDeps) {}

  create(signalingPeerId: SignalingPeerId): PeerEntry {
    const { signaling, registry, connections, ids, logger, isHost, isLeaving } = this.deps;
    const peer = shortId(signalingPeerId);
    logger.debug(`Creating link for peer=${peer}`);

    const negotiator = new RtcLinkNegotiator({
      connection: connections.create(),
      ids,
      logger: logger.child("negotiator"),
    });
    const entry: PeerEntry = { negotiator, connection: null, status: "connecting" };

    negotiator.onIceCandidateCreated((candidate) => {
      if (isLeaving()) return;
      logger.debug(`ICE candidate for peer=${peer}`);
      void signaling
        .sendIceCandidate(signalingPeerId, candidate, isHost() ? "remove" : "do-nothing")
        .catch(this.logSendFailure("ICE candidate", signalingPeerId));
    });

    negotiator.onAnswerCreated((answer) => {
      if (isLeaving()) return;
      logger.debug(`Answer created for peer=${peer}`);
      void signaling
        .sendAnswer(signalingPeerId, answer.sdp, "do-nothing")
        .catch(this.logSendFailure("answer", signalingPeerId));
    });

    negotiator.onConnected((connection) => {
      if (isLeaving()) return;
      logger.debug(`Connected to peer=${peer}`);

      entry.connection = connection;
      registry.setStatus(signalingPeerId, "active");

      connection.onMessage((message) => this.deps.onMessage(message, signalingPeerId));

      connection.onStateChange((state) => {
        logger.debug(`Connection state changed peer=${peer} state=${state}`);
        if (state === "disconnected" || state === "failed") {
          this.deps.onConnectionDied(signalingPeerId);
        }
      });
    });

    return entry;
  }

  async initiateOffer(signalingPeerId: SignalingPeerId, entry: PeerEntry): Promise<void> {
    const { signaling, logger, isHost, isLeaving } = this.deps;
    logger.debug(`Initiating offer to peer=${shortId(signalingPeerId)}`);

    entry.negotiator.onOfferCreated((offer) => {
      if (isLeaving()) return;
      logger.debug(`Offer created for peer=${shortId(signalingPeerId)}`);
      void signaling
        .sendOffer(signalingPeerId, offer.sdp, isHost() ? "remove" : "do-nothing")
        .catch(this.logSendFailure("offer", signalingPeerId));
    });

    await entry.negotiator.initiateOffer();
  }

  // A peer can leave the room between creating a signal and sending it. Expected, not an error.
  private logSendFailure(kind: string, peerId: SignalingPeerId) {
    return (error: unknown) =>
      this.deps.logger.warn(`Could not send ${kind} to peer=${shortId(peerId)}`, error);
  }
}
