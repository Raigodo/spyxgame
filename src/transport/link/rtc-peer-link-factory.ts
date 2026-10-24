import type { IceServer, LinkConfig } from "../config";
import type { PeerId } from "@/kernel";
import { Clock, shortId, type IdGenerator, type Logger } from "@/kernel";
import type { SignalingSession } from "../signaling";
import type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
import { RtcLinkNegotiator } from "./rtc-link-negotiator";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { PeerEntry } from "./types";
import { RtcSignal } from "./rtc-signal";
import { IceBatcher } from "./ice-batcher";
import { classifyProbe, LinkProbe, PROBE_PONG } from "./link-probe";

export interface RtcPeerLinkFactoryDeps {
  signaling: SignalingSession;
  registry: RtcPeerRegistry;
  connections: RtcConnectionProvider;
  iceServers: readonly IceServer[];
  ids: IdGenerator;
  clock: Clock;
  config: LinkConfig;
  logger: Logger;
  onMessage: (message: string, from: PeerId) => void;
  onConnectionDied: (signalingPeerId: PeerId) => void;
  isHost: () => boolean;
  isLeaving: () => boolean;
}

export class RtcPeerLinkFactory {
  constructor(private readonly deps: RtcPeerLinkFactoryDeps) {}

  create(signalingPeerId: PeerId): PeerEntry {
    const { signaling, registry, connections, ids, logger, isHost, isLeaving } = this.deps;
    const peer = shortId(signalingPeerId);
    logger.debug(`Creating link for peer=${peer}`);

    const negotiator = new RtcLinkNegotiator({
      connection: connections.create(this.deps.iceServers),
      ids,
      logger: logger.child("negotiator"),
      clock: this.deps.clock,
      disconnectGraceMs: this.deps.config.disconnectGraceMs,
    });
    const entry: PeerEntry = { negotiator, connection: null, status: "connecting" };

    // Candidates leave in batches. A batch for a link that was replaced or removed, or sent
    // while leaving, is dropped.
    const batcher = new IceBatcher({
      clock: this.deps.clock,
      windowMs: this.deps.config.iceBatchWindowMs,
      maxBatch: this.deps.config.iceMaxBatch,
      send: (candidates) => {
        if (isLeaving() || registry.get(signalingPeerId) !== entry) return;
        logger.debug(`ICE batch of ${candidates.length} for peer=${peer}`);
        void signaling
          .sendSignal(
            signalingPeerId,
            { type: "ice-batch", candidates } satisfies RtcSignal,
            isHost() ? "remove" : "do-nothing"
          )
          .catch(this.logSendFailure("ICE batch", signalingPeerId));
      },
    });

    negotiator.onIceCandidateCreated((candidate) => {
      if (!isLeaving()) batcher.add(candidate);
    });

    negotiator.onAnswerCreated((answer) => {
      if (isLeaving()) return;
      logger.debug(`Answer created for peer=${peer}`);
      void signaling
        .sendSignal(
          signalingPeerId,
          { type: "answer", sdp: answer.sdp } satisfies RtcSignal,
          "do-nothing"
        )
        .catch(this.logSendFailure("answer", signalingPeerId));
    });

    negotiator.onConnected((connection) => {
      if (isLeaving()) return;
      logger.debug(`Connected to peer=${peer}`);

      entry.connection = connection;
      batcher.cancel(); // the channel is open: connectivity is established, pending candidates are moot
      registry.setStatus(signalingPeerId, "active");

      let declaredDead = false;
      const probe = new LinkProbe({
        clock: this.deps.clock,
        config: this.deps.config,
        logger: logger.child("probe"),
        isActive: () => isHost(),
        send: (text) => {
          try {
            connection.send(text);
          } catch {
            // the link is going away; the state handler deals with it
          }
        },
        onDead: () => {
          declaredDead = true; // closing the link below fires a state change we must not repeat
          logger.warn(`Link to peer=${peer} is silent, treating it as dead`);
          this.deps.onConnectionDied(signalingPeerId);
        },
      });

      connection.onMessage((message) => {
        probe.noteInbound();
        const control = classifyProbe(message);
        if (control === "ping") {
          try {
            connection.send(PROBE_PONG);
          } catch {
            // see above
          }
        }
        if (control) return;
        this.deps.onMessage(message, signalingPeerId);
      });

      connection.onStateChange((state) => {
        logger.debug(`Connection state changed peer=${peer} state=${state}`);
        if (state === "disconnected" || state === "failed") {
          probe.stop();
          if (!declaredDead) this.deps.onConnectionDied(signalingPeerId);
        }
      });
    });

    return entry;
  }

  async initiateOffer(signalingPeerId: PeerId, entry: PeerEntry): Promise<void> {
    const { signaling, logger, isHost, isLeaving } = this.deps;
    logger.debug(`Initiating offer to peer=${shortId(signalingPeerId)}`);

    entry.negotiator.onOfferCreated((offer) => {
      if (isLeaving()) return;
      logger.debug(`Offer created for peer=${shortId(signalingPeerId)}`);
      void signaling
        .sendSignal(
          signalingPeerId,
          { type: "offer", sdp: offer.sdp } satisfies RtcSignal,
          isHost() ? "remove" : "do-nothing",
          { requireMember: true }
        )
        .catch(this.logSendFailure("offer", signalingPeerId));
    });

    await entry.negotiator.initiateOffer();
  }

  // A peer can leave the room between creating a signal and sending it. Expected, not an error.
  private logSendFailure(kind: string, peerId: PeerId) {
    return (error: unknown) =>
      this.deps.logger.warn(`Could not send ${kind} to peer=${shortId(peerId)}`, error);
  }
}
