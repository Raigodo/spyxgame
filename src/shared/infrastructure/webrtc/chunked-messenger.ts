import {
  Emitter,
  type Cancel,
  type Clock,
  type IdGenerator,
  type WebRtcConfig,
} from "@/shared/kernel";
import type { SignalingPeerId } from "../signaling";
import { ChunkReassembler, classifyIncoming, splitMessage } from "./chunking";
import type { WebRtcService } from "./web-rtc-service";

/** The part of WebRtcService the messenger needs. A test fake only implements these. */
export type RawMessaging = Pick<
  WebRtcService,
  "onMessage" | "sendMessageToPeer" | "broadcastMessage"
>;

export interface ChunkedMessengerDeps {
  rtc: RawMessaging;
  clock: Clock;
  ids: IdGenerator;
  config: WebRtcConfig;
}

// Makes "send a string of any size, reliably" possible over WebRtcService's raw messaging.
// Data channels are ordered and reliable per connection, so chunks of one message never arrive
// out of order relative to each other.
export class ChunkedMessenger {
  private readonly reassembler: ChunkReassembler;
  private readonly messageReceived = new Emitter<{ message: string; from: SignalingPeerId }>();
  private cancelCleanup?: Cancel;
  private readonly unsubscribeFromRtc: () => void;

  constructor(private readonly deps: ChunkedMessengerDeps) {
    this.reassembler = new ChunkReassembler(deps.config.chunkBufferTtlMs);
    this.unsubscribeFromRtc = deps.rtc.onMessage((raw, from) => this.handleIncoming(raw, from));
  }

  start(): void {
    this.cancelCleanup?.();
    this.cancelCleanup = this.deps.clock.every(this.deps.config.chunkBufferTtlMs, () =>
      this.reassembler.dropExpired(this.deps.clock.now())
    );
  }

  /** Stops timers, drops partial messages and detaches from the transport. */
  stop(): void {
    this.cancelCleanup?.();
    this.cancelCleanup = undefined;
    this.reassembler.clear();
    this.unsubscribeFromRtc();
  }

  sendToPeer(peerId: SignalingPeerId, message: string): void {
    for (const chunk of this.split(message)) this.deps.rtc.sendMessageToPeer(peerId, chunk);
  }

  broadcast(message: string): void {
    for (const chunk of this.split(message)) this.deps.rtc.broadcastMessage(chunk);
  }

  onMessage(handler: (message: string, from: SignalingPeerId) => void): () => void {
    return this.messageReceived.on(({ message, from }) => handler(message, from));
  }

  private split(message: string): string[] {
    return splitMessage(message, this.deps.config.maxChunkSize, this.deps.ids.next());
  }

  private handleIncoming(raw: string, from: SignalingPeerId): void {
    const incoming = classifyIncoming(raw, this.deps.config.maxChunksPerMessage);
    if (incoming.kind === "plain") {
      this.messageReceived.emit({ message: raw, from });
    } else if (incoming.kind === "chunk") {
      const full = this.reassembler.accept(from, incoming.envelope, this.deps.clock.now());
      if (full !== undefined) this.messageReceived.emit({ message: full, from });
    }
  }
}
