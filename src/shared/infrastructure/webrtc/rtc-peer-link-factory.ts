// rtc-peer-link-factory.ts

import { SignalingPeerId, SignalingSession } from "../signaling";
import { RtcConnectionFactory } from "./rtc-connection-factory";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { PeerEntry } from "./types";

type MessageHandler = (message: string, from: SignalingPeerId) => void;
type ConnectionDiedHandler = (signalingPeerId: SignalingPeerId) => void;

export class RtcPeerLinkFactory {
  constructor(
    private readonly signalingSession: SignalingSession,
    private readonly registry: RtcPeerRegistry,
    private readonly onMessage: MessageHandler,
    private readonly onConnectionDied: ConnectionDiedHandler,
    private readonly isHost: () => boolean,
    private readonly isLeaving: () => boolean
  ) {}

  create(signalingPeerId: SignalingPeerId): PeerEntry {
    console.log(`[RtcPeerLinkFactory] Creating link for peer=${short(signalingPeerId)}`);

    const factory = new RtcConnectionFactory();
    const entry: PeerEntry = {
      factory,
      connection: null,
      status: "connecting",
    };

    factory.onIceCandidateCreated((candidate) => {
      if (this.isLeaving()) return;
      console.log(`[RtcPeerLinkFactory] ICE candidate for peer=${short(signalingPeerId)}`);
      void this.signalingSession
        .sendIceCandidate(signalingPeerId, candidate, this.isHost() ? "remove" : "do-nothing")
        .catch(logSendFailure("ICE candidate", signalingPeerId));
    });

    factory.onAnswerCreated((answer) => {
      if (this.isLeaving()) return;
      console.log(`[RtcPeerLinkFactory] Answer created for peer=${short(signalingPeerId)}`);
      void this.signalingSession
        .sendAnswer(signalingPeerId, answer.sdp!, "do-nothing")
        .catch(logSendFailure("answer", signalingPeerId));
    });

    factory.onConnected((connection) => {
      if (this.isLeaving()) return;
      console.log(`[RtcPeerLinkFactory] Connected to peer=${short(signalingPeerId)}`);

      entry.connection = connection;
      this.registry.setStatus(signalingPeerId, "active");

      connection.onMessage((message) => {
        this.onMessage(message, signalingPeerId);
      });

      connection.onStateChange((state) => {
        console.log(
          `[RtcPeerLinkFactory] Connection state changed peer=${short(signalingPeerId)} state=${state}`
        );
        if (state === "disconnected" || state === "failed") {
          this.onConnectionDied(signalingPeerId);
        }
      });
    });

    return entry;
  }

  async initiateOffer(signalingPeerId: SignalingPeerId, entry: PeerEntry): Promise<void> {
    console.log(`[RtcPeerLinkFactory] Initiating offer to peer=${short(signalingPeerId)}`);

    entry.factory.onOfferCreated((offer) => {
      if (this.isLeaving()) return;
      console.log(`[RtcPeerLinkFactory] Offer created for peer=${short(signalingPeerId)}`);
      void this.signalingSession
        .sendOffer(signalingPeerId, offer.sdp!, this.isHost() ? "remove" : "do-nothing")
        .catch(logSendFailure("offer", signalingPeerId));
    });

    await entry.factory.initiateOffer();
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}

// A peer can leave the room between creating a signal and sending it. That is expected, not an error.
function logSendFailure(kind: string, peerId: string) {
  return (error: unknown) =>
    console.warn(`[RtcPeerLinkFactory] Could not send ${kind} to peer=${short(peerId)}`, error);
}
