import { SignalingPeerId } from "../signaling";
import type { RtcMessage, RtcPeerId } from "./types";

type RtcMessageHandler = (
  message: RtcMessage,
  from: { rtcPeerId: RtcPeerId; signalingPeerId: SignalingPeerId },
) => void;

export class RtcMessageRouter {
  private readonly handlers = new Set<RtcMessageHandler>();

  route(
    message: RtcMessage,
    from: { rtcPeerId: RtcPeerId; signalingPeerId: SignalingPeerId },
  ): void {
    console.log(
      `[RtcMessageRouter] Message from signalingPeer=${from.signalingPeerId} rtcPeer=${from.rtcPeerId}`,
    );
    for (const handler of this.handlers) {
      handler(message, from);
    }
  }

  onMessage(handler: RtcMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispose(): void {
    this.handlers.clear();
  }
}
