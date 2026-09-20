// rtc-peer-entry-factory.ts

import { RtcConnectionFactory } from "./rtc-connection-factory";
import type { PeerEntry, RtcPeerRegistry } from "./rtc-peer-registry";
import type { SignalingPeerId } from "@infrastructure/signaling";
import type { FirestoreSignalingServiceRoot } from "@infrastructure/signaling/firestore-signaling-service-root";

type MessageHandler = (message: string, from: SignalingPeerId) => void;
type ConnectionDiedHandler = (signalingPeerId: SignalingPeerId) => void;

export class RtcPeerEntryFactory {
  constructor(
    private readonly signalingService: FirestoreSignalingServiceRoot,
    private readonly registry: RtcPeerRegistry,
    private readonly onMessage: MessageHandler,
    private readonly onConnectionDied: ConnectionDiedHandler,
    private readonly isHost: () => boolean,
    private readonly isLeaving: () => boolean,
  ) {}

  create(signalingPeerId: SignalingPeerId): PeerEntry {
    console.log(
      `[RtcPeerEntryFactory] Creating entry for peer=${short(signalingPeerId)}`,
    );

    const factory = new RtcConnectionFactory();
    const entry: PeerEntry = {
      factory,
      connection: null,
      status: "connecting",
    };

    factory.onIceCandidateCreated((candidate) => {
      if (this.isLeaving()) return;
      console.log(
        `[RtcPeerEntryFactory] ICE candidate for peer=${short(signalingPeerId)}`,
      );
      void this.signalingService.sendIceCandidateToPeer(
        signalingPeerId,
        candidate,
        this.isHost() ? "remove" : "do-nothing",
      );
    });

    factory.onAnswerCreated((answer) => {
      if (this.isLeaving()) return;
      console.log(
        `[RtcPeerEntryFactory] Answer created for peer=${short(signalingPeerId)}`,
      );
      void this.signalingService.sendAnswerToPeer(
        signalingPeerId,
        answer.sdp!,
        "do-nothing",
      );
    });

    factory.onConnected((connection) => {
      if (this.isLeaving()) return;
      console.log(
        `[RtcPeerEntryFactory] Connected to peer=${short(signalingPeerId)}`,
      );

      entry.connection = connection;
      this.registry.setStatus(signalingPeerId, "active");

      connection.onMessage((message) => {
        this.onMessage(message, signalingPeerId);
      });

      connection.onStateChange((state) => {
        console.log(
          `[RtcPeerEntryFactory] Connection state changed peer=${short(signalingPeerId)} state=${state}`,
        );
        if (state === "disconnected" || state === "failed") {
          this.onConnectionDied(signalingPeerId);
        }
      });
    });

    return entry;
  }

  async initiateOffer(
    signalingPeerId: SignalingPeerId,
    entry: PeerEntry,
  ): Promise<void> {
    console.log(
      `[RtcPeerEntryFactory] Initiating offer to peer=${short(signalingPeerId)}`,
    );

    entry.factory.onOfferCreated((offer) => {
      if (this.isLeaving()) return;
      console.log(
        `[RtcPeerEntryFactory] Offer created for peer=${short(signalingPeerId)}`,
      );
      void this.signalingService.sendOfferToPeer(
        signalingPeerId,
        offer.sdp!,
        this.isHost() ? "remove" : "do-nothing",
      );
    });

    await entry.factory.initiateOffer();
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
