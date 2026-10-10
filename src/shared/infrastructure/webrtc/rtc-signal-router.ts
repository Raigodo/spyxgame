import { shortId, type Logger } from "@/shared/kernel";
import type { SignalingPeerId, WebRtcSignal } from "../signaling";
import type { IceCandidate } from "./ports/rtc-peer-connection-port";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import type { RtcPeerRegistry } from "./rtc-peer-registry";

export interface RtcSignalRouterDeps {
  registry: RtcPeerRegistry;
  linkFactory: RtcPeerLinkFactory;
  logger: Logger;
}

// Routes one incoming signal (offer, answer, ICE candidate) to the link negotiator it belongs to.
export class RtcSignalRouter {
  constructor(private readonly deps: RtcSignalRouterDeps) {}

  async handle(from: SignalingPeerId, signal: WebRtcSignal): Promise<void> {
    this.deps.logger.debug(`Signal from peer=${shortId(from)} type=${signal.type}`);

    switch (signal.type) {
      case "offer":
        await this.handleOffer(from, signal.sdp);
        break;
      case "answer":
        await this.handleAnswer(from, signal.sdp);
        break;
      case "ice-candidate":
        await this.handleIceCandidate(from, signal.candidate);
        break;
      default:
        this.deps.logger.warn(`Unknown signal type from peer=${shortId(from)}`);
    }
  }

  private async handleOffer(from: SignalingPeerId, sdp: string): Promise<void> {
    const { registry, linkFactory, logger } = this.deps;
    let entry = registry.get(from);

    if (!entry) {
      logger.debug(`Creating entry for peer=${shortId(from)} on offer arrival`);
      entry = linkFactory.create(from);
      registry.add(from, entry);
    }

    await entry.negotiator.applyOffer({ type: "offer", sdp });
  }

  private async handleAnswer(from: SignalingPeerId, sdp: string): Promise<void> {
    const entry = this.deps.registry.get(from);
    if (!entry) {
      this.deps.logger.warn(`Answer from unknown peer=${shortId(from)}, ignoring`);
      return;
    }
    await entry.negotiator.applyAnswer({ type: "answer", sdp });
  }

  private async handleIceCandidate(from: SignalingPeerId, candidate: IceCandidate): Promise<void> {
    const entry = this.deps.registry.get(from);
    if (!entry) {
      this.deps.logger.warn(`ICE candidate from unknown peer=${shortId(from)}, ignoring`);
      return;
    }
    await entry.negotiator.applyIceCandidate(candidate);
  }
}
